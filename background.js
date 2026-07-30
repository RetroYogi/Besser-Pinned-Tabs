// Diagnostics. Set to true to trace the service worker in the extension's console:
// browser detection, what the tab sync sees, and every close decision. Left in place
// because this extension's behaviour depends on browser-specific tab handling that can
// only be diagnosed on the machine where it misbehaves.
const DEBUG = false;
const log = (...args) => DEBUG && console.log('[BPT]', ...args);

log('service worker evaluated — version', chrome.runtime.getManifest().version);

// Which browser this copy is running in, and whether that browser already protects
// pinned tabs from the close shortcut by itself.
//
// Chrome now asks for a second Cmd-W/Ctrl-W before closing a pinned tab. That is a
// better protection than this extension can offer — it *prevents* the close, where the
// extension can only reopen the tab afterwards — so once the tab does close on Chrome
// the user has confirmed twice and putting it back would override a deliberate choice.
// Every other Chromium port tested (Brave, Edge) still closes a pinned tab on the first
// press, so there the reopen behaviour is still wanted.
let browserInfo = { id: 'chromium', protectsPinnedTabs: false };

async function detectBrowser() {
  const uaData = navigator.userAgentData;
  const brands = (uaData && uaData.brands) || [];
  const brandNames = brands.map((b) => b.brand);
  const ua = navigator.userAgent || '';

  // Brave deliberately reports Chrome's brands and user agent to resist fingerprinting,
  // so the only reliable signal is the navigator.brave API it injects.
  let isBrave = false;
  try {
    isBrave = !!(navigator.brave && (await navigator.brave.isBrave()));
  } catch (e) {
    isBrave = false;
  }

  let id = 'chromium';
  if (isBrave) {
    id = 'brave';
  } else if (brandNames.some((n) => /Microsoft Edge/i.test(n)) || /\bEdg\//.test(ua)) {
    id = 'edge';
  } else if (brandNames.some((n) => /Google Chrome/i.test(n))) {
    id = 'chrome';
  }

  browserInfo = { id, protectsPinnedTabs: id === 'chrome' };

  log(
    'browser detected',
    JSON.stringify({ ...browserInfo, brands: brandNames, hasBraveApi: !!navigator.brave, ua })
  );
}

// Store pinned tabs - persist to chrome.storage to survive service worker dormancy
let pinnedTabs = {};

// Keep track of recent redirects by URL per tab
let tabRedirects = {};

// Load state from storage when the service worker starts.
//
// This is the critical part of the extension's lifecycle. An MV3 service worker is
// evicted after a short idle period and re-evaluated from scratch when an event wakes
// it — and the queued event is dispatched as soon as this script finishes evaluating,
// which is *before* any asynchronous storage read has resolved. Every listener below
// therefore awaits `ready` before touching `pinnedTabs` / `tabRedirects`; without that,
// a tab closed on a cold worker is seen with empty state and never comes back.
const ready = chrome.storage.local
  .get(['pinnedTabs', 'tabRedirects'])
  .then((result) => {
    if (result.pinnedTabs) {
      pinnedTabs = result.pinnedTabs;
    }
    if (result.tabRedirects) {
      tabRedirects = result.tabRedirects;
    }
  })
  .catch(() => {
    // Storage unavailable: carry on with empty state rather than leaving every
    // listener permanently blocked on a rejected promise.
  })
  .then(() => syncWithOpenTabs())
  // Write the freshly-synced snapshot back immediately. The worker is restarted for
  // practically every event, so whatever the sync just learned is lost unless it reaches
  // storage during this same instance — and the sync is the only thing that sees a
  // pinned tab that no individual event told us about.
  .then(() => persistState())
  .then(() => detectBrowser())
  .catch((e) => {
    // Detection must never break startup: an unrecognised browser keeps the reopen
    // behaviour, which is the safe default for every port except current Chrome.
    log('browser detection failed, keeping defaults:', e && e.message);
  })
  .then(() => log('state ready, pinned tabs:', JSON.stringify(pinnedTabs)));

// Fold the tabs that are actually open into the restored state. Live tabs win, so a
// pinned tab that moved or navigated while the worker was asleep is recorded correctly.
// Entries for tabs that no longer exist are deliberately kept: when the worker was woken
// *by* a tab closing, that tab is already gone and its entry is the only thing that lets
// onRemoved put it back.
let lastSync = 0;

async function syncWithOpenTabs() {
  try {
    // Two independent sources of truth, because they do not always agree.
    //
    // On at least one Chromium port the `pinned` property came back false for tabs that
    // were plainly pinned, so the sync recorded nothing at all and every close was then
    // seen with empty state. Query the pinned set explicitly as well and treat a tab as
    // pinned if EITHER source says so; a tab is only dropped when both agree it is not.
    const all = await chrome.tabs.query({});
    let pinnedOnly = [];
    try {
      pinnedOnly = await chrome.tabs.query({ pinned: true });
    } catch (e) {
      pinnedOnly = [];
    }

    const pinnedById = new Map();
    for (const tab of pinnedOnly) pinnedById.set(tab.id, tab);
    for (const tab of all) if (tab.pinned) pinnedById.set(tab.id, tab);

    log(
      'sync: query saw',
      JSON.stringify({
        total: all.length,
        pinnedProperty: all.filter((t) => t.pinned).length,
        pinnedQuery: pinnedOnly.length,
        tabs: all.map((t) => ({
          id: t.id,
          pinned: t.pinned,
          windowId: t.windowId,
          url: (t.url || t.pendingUrl || '').slice(0, 60)
        }))
      })
    );

    const before = Object.keys(pinnedTabs).length;

    for (const tab of all) {
      if (!pinnedById.has(tab.id)) {
        delete pinnedTabs[tab.id];
      }
    }
    for (const [id, tab] of pinnedById) {
      pinnedTabs[id] = {
        url: tab.url || tab.pendingUrl,
        index: tab.index,
        windowId: tab.windowId
      };
    }

    lastSync = Date.now();
    const after = Object.keys(pinnedTabs).length;
    if (after !== before) {
      log('sync: tracked pinned tabs', before, '->', after, JSON.stringify(pinnedTabs));
    }
  } catch (e) {
    // Ignore: an unreadable tab list just means we rely on the stored state.
    log('sync failed:', e && e.message);
  }
}

// Keep the snapshot fresh from ordinary browsing activity.
//
// Tracking used to depend on catching the one event that pinned a tab. If that event was
// missed — the service worker asleep, a session restore, a port that reports pinning
// differently — the tab stayed invisible to the extension for as long as it existed, and
// closing it did nothing. A pinned tab that is closed cannot be inspected afterwards, so
// the snapshot has to be right *before* the close; re-reading the tab list on ordinary
// activity is what makes it self-correcting. Throttled, since onUpdated is noisy.
const SYNC_THROTTLE_MS = 2000;

async function refreshSnapshot(force = false) {
  await ready;
  if (!force && Date.now() - lastSync < SYNC_THROTTLE_MS) return;
  await syncWithOpenTabs();
  await persistState();
}

// Guarded: a missing event on some Chromium port must not throw during evaluation and
// take the whole service worker down with it.
if (chrome.tabs.onActivated) {
  chrome.tabs.onActivated.addListener(() => refreshSnapshot());
}
if (chrome.windows && chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(() => refreshSnapshot());
}

// Tab IDs are only unique within a browser session, so state carried over from the
// previous run could make an unrelated new tab look like a pinned one. Start each
// browser session from the tabs that are really there.
chrome.runtime.onStartup.addListener(async () => {
  await ready;
  pinnedTabs = {};
  tabRedirects = {};
  await syncWithOpenTabs();
  await persistState();
});

// Persist state to storage.
//
// This MUST be awaited by every caller. The service worker is torn down aggressively —
// in testing it was restarted for every single tab event — and a storage write that is
// still in flight when the worker dies is simply discarded. Fire-and-forget writes meant
// the record of a pinned tab was lost before the tab was ever closed, so the close was
// then seen with no state at all. Awaiting also keeps the worker alive until the write
// lands, because a pending extension API call defers termination.
async function persistState() {
  try {
    await chrome.storage.local.set({ pinnedTabs, tabRedirects });
  } catch (e) {
    log('persist failed:', e && e.message);
  }
}

// Clicking the toolbar icon opens the About page. The action declares no default_popup,
// which is what makes onClicked fire at all; the page itself is registered as the
// extension's options page so it is also reachable from chrome://extensions.
chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

// Helper function to check if a URL is from a different domain
function isDifferentDomain(url1, url2) {
  try {
    const domain1 = new URL(url1).hostname;
    const domain2 = new URL(url2).hostname;
    return domain1 !== domain2;
  } catch (e) {
    return false;
  }
}

// Helper to get domain from URL string
function getDomain(urlString) {
  try {
    return new URL(urlString).hostname;
  } catch (e) {
    return "";
  }
}

// Listen for tab updates
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;

  if (tab.pinned) {
    // Only update stored URL if this is same-domain navigation
    // This preserves the "canonical" pinned URL for bookmark click detection
    // Cross-domain navigation attempts are blocked by onBeforeNavigate before reaching here
    if (changeInfo.url) {
      const storedUrl = pinnedTabs[tabId] ? pinnedTabs[tabId].url : null;

      // If no stored URL yet, or if same domain, update it
      if (!storedUrl || !isDifferentDomain(storedUrl, tab.url)) {
        pinnedTabs[tabId] = { url: tab.url, index: tab.index, windowId: tab.windowId };
      } else {
        // Different domain - this means redirect loop fix allowed navigation
        // Update canonical URL to new domain to stay in sync
        pinnedTabs[tabId] = { url: tab.url, index: tab.index, windowId: tab.windowId };
      }

      // Clean up redirect tracking for current domain
      const currentDomain = getDomain(tab.url);
      if (tabRedirects[tabId]) {
        delete tabRedirects[tabId][currentDomain];

        // Memory leak fix: Clear entire redirect tracking if empty
        if (Object.keys(tabRedirects[tabId]).length === 0) {
          delete tabRedirects[tabId];
        }
      }

      await persistState();
    } else if (!pinnedTabs[tabId]) {
      // Tab just became pinned, store initial state
      pinnedTabs[tabId] = { url: tab.url, index: tab.index };
      await persistState();
    }
  } else {
    delete pinnedTabs[tabId]; // Remove from pinnedTabs if unpinned
    delete tabRedirects[tabId]; // Clean up redirect tracking
    await persistState();
  }

  // Any tab activity is a chance to notice a pinned tab we never recorded.
  refreshSnapshot();
});

// A tab's ID is not stable. The browser destroys and recreates the underlying tab in
// several situations — prerendering, instant, and discarding a tab to save memory — and
// the replacement carries a new ID. When that happens to a pinned tab, everything keyed
// on the old ID goes stale, and the close of that tab is then reported under an ID this
// extension has never seen. That is exactly what the diagnostic log showed: a pinned tab
// closed under one ID while the tracked entry sat under another.
//
// onReplaced is the browser's own notification of such a swap, so move the entry across.
//
// Not every Chromium port implements this event, and an unguarded addListener on a
// missing event throws during evaluation — which would take the whole service worker
// down and disable all three features, not just this one. Where it is missing the
// URL-based recovery below still covers the case.
if (chrome.tabs.onReplaced) {
  chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
    await ready;

    if (pinnedTabs[removedTabId]) {
      pinnedTabs[addedTabId] = pinnedTabs[removedTabId];
      delete pinnedTabs[removedTabId];
    }

    if (tabRedirects[removedTabId]) {
      tabRedirects[addedTabId] = tabRedirects[removedTabId];
      delete tabRedirects[removedTabId];
    }

    log('onReplaced', { removedTabId, addedTabId });
    await persistState();
  });
} else {
  log('tabs.onReplaced unavailable — relying on URL-based recovery');
}

// Last-resort recovery for an ID change the extension was never told about.
//
// The tab is already gone, so it cannot be inspected; instead, work out which tracked
// pinned tab is missing. Any entry whose URL no longer belongs to a live pinned tab in
// that window must be the one that just closed. This is deliberately independent of tab
// IDs, so it holds however the ID came to change.
async function findOrphanedEntry(windowId) {
  let livePinned = [];
  try {
    livePinned = await chrome.tabs.query({ pinned: true, windowId });
  } catch (e) {
    return null; // Window is gone; nothing to restore into anyway.
  }

  const liveUrls = new Set(livePinned.map((t) => t.url));

  for (const [id, entry] of Object.entries(pinnedTabs)) {
    const sameWindow = entry.windowId === undefined || entry.windowId === windowId;
    if (sameWindow && !liveUrls.has(entry.url)) {
      return { staleId: id, entry };
    }
  }

  return null;
}

// Ask the browser what it just closed.
//
// This is the primary path, and it exists because the tracking map cannot be trusted.
// The service worker is destroyed after nearly every event, so a record gathered before
// a tab closed may never survive to the moment the close is handled — that failure was
// observed repeatedly. The sessions API sidesteps the problem entirely: it is read
// *after* the close and reports the tab as it was, including whether it was pinned.
//
// Only the most recent entry is considered. Anything older is a tab the user closed
// earlier and has not asked to have back.
async function findClosedPinnedTab(tabId) {
  if (!chrome.sessions || !chrome.sessions.getRecentlyClosed) return null;

  // The entry is not always recorded by the time onRemoved fires, so allow one retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    let sessions = [];
    try {
      sessions = await chrome.sessions.getRecentlyClosed({ maxResults: 1 });
    } catch (e) {
      log('sessions lookup failed:', e && e.message);
      return null;
    }

    const entry = sessions[0];
    const tab = entry && entry.tab;

    if (tab && tab.pinned && (tab.id === tabId || attempt > 0)) {
      log('sessions: closed tab was pinned', JSON.stringify({ url: tab.url, index: tab.index }));
      return { sessionId: tab.sessionId, url: tab.url, index: tab.index };
    }

    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    } else {
      log('sessions: most recent closed entry was not a pinned tab');
    }
  }

  return null;
}

// Listen for tab removal
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  log('onRemoved fired', { tabId, removeInfo, knownBeforeAwait: !!pinnedTabs[tabId] });

  await ready;

  let closedTab = pinnedTabs[tabId];
  delete pinnedTabs[tabId];
  delete tabRedirects[tabId];

  log('onRemoved after await', {
    tabId,
    wasPinned: !!closedTab,
    entry: closedTab,
    allKnownIds: JSON.stringify(pinnedTabs)
  });

  // Two reasons never to reopen, whatever the tab was: the whole window is going away
  // (putting it back would resurrect a window the user just closed), or the browser
  // already asked for confirmation before closing a pinned tab, in which case the close
  // was deliberate and reopening would override the user.
  if (removeInfo.isWindowClosing || browserInfo.protectsPinnedTabs) {
    log(
      'no restore —',
      removeInfo.isWindowClosing
        ? 'window is closing'
        : `${browserInfo.id} protects pinned tabs itself`
    );
    await persistState();
    return;
  }

  // Primary path: ask the browser what it just closed.
  const closedSession = await findClosedPinnedTab(tabId);

  if (closedSession && closedSession.sessionId) {
    try {
      await chrome.sessions.restore(closedSession.sessionId);
      log('restored via sessions API:', closedSession.url);
      await refreshSnapshot(true);
      return;
    } catch (e) {
      log('sessions restore FAILED, falling back:', e && e.message);
    }
  }

  // Fallback: the tracking map, for ports without a usable sessions API.
  if (!closedTab && closedSession) {
    closedTab = { url: closedSession.url, index: closedSession.index };
  }

  if (!closedTab) {
    const orphan = await findOrphanedEntry(removeInfo.windowId);
    if (orphan) {
      closedTab = orphan.entry;
      delete pinnedTabs[orphan.staleId];
      log('recovered by URL — stale id', orphan.staleId, '->', closedTab.url);
    }
  }

  if (closedTab) {
    try {
      const newTab = await chrome.tabs.create({
        url: closedTab.url,
        pinned: true,
        index: closedTab.index,
        windowId: removeInfo.windowId
      });
      pinnedTabs[newTab.id] = {
        url: closedTab.url,
        index: newTab.index,
        windowId: newTab.windowId
      };
      log('restored as tab', newTab.id, 'at index', newTab.index);
    } catch (e) {
      // The window may have disappeared between the two calls; nothing to restore into.
      log('restore FAILED:', e && e.message);
    }
  } else {
    log('no restore — closed tab was not pinned');
  }

  await persistState();
});

// Listen for tab creation
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;

  if (tab.pinned) {
    pinnedTabs[tab.id] = { url: tab.url, index: tab.index };
    await persistState();
  }
});

// Listen for tab moves to keep index up-to-date
chrome.tabs.onMoved.addListener(async (tabId, moveInfo) => {
  await ready;

  if (pinnedTabs[tabId]) {
    pinnedTabs[tabId].index = moveInfo.toIndex;
    await persistState();
  }
});

// Listen for navigation events - this now handles both address bar navigation
// and link clicks
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return; // Only handle main frame navigation

  await ready;

  chrome.tabs.get(details.tabId, async (tab) => {
    // Error handling: tab might be closed or invalid
    if (chrome.runtime.lastError || !tab) {
      return;
    }

    if (tab.pinned) {
      // Use stored URL for comparison to handle bookmark clicks correctly
      // Fall back to tab.url if not yet stored (handles race conditions)
      const canonicalUrl = pinnedTabs[tab.id] ? pinnedTabs[tab.id].url : tab.url;

      if (isDifferentDomain(canonicalUrl, details.url)) {
        // Initialize tracking for this tab if needed
        if (!tabRedirects[tab.id]) {
          tabRedirects[tab.id] = {};
        }

        // Extract domain for tracking
        const targetDomain = getDomain(details.url);

        // Check if we've seen this domain before in this tab
        if (tabRedirects[tab.id][targetDomain]) {
          // This is at least the second attempt to navigate to this domain
          // Allow the navigation to proceed (by doing nothing)
          // This breaks potential redirect loops
          return;
        }

        // First time seeing this domain, mark it as seen
        tabRedirects[tab.id][targetDomain] = true;

        // Cancel the navigation in the pinned tab
        chrome.tabs.update(details.tabId, { url: canonicalUrl });

        // Open the new URL in a new tab
        chrome.tabs.create({ url: details.url, index: tab.index + 1 });

        await persistState();
      }
    }
  });
});