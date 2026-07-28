// Store pinned tabs - persist to chrome.storage to survive service worker dormancy
let pinnedTabs = {};

// Keep track of recent redirects by URL per tab
let tabRedirects = {};

// Load state from storage when service worker starts
chrome.storage.local.get(['pinnedTabs', 'tabRedirects'], (result) => {
  if (result.pinnedTabs) {
    pinnedTabs = result.pinnedTabs;
  }
  if (result.tabRedirects) {
    tabRedirects = result.tabRedirects;
  }
});

// Persist state to storage
function persistState() {
  chrome.storage.local.set({ pinnedTabs, tabRedirects });
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

// Function to update pinned tabs upon extension activation
function updatePinnedTabs() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.pinned) {
        pinnedTabs[tab.id] = { url: tab.url, index: tab.index };
      }
    }
  });
}

// Call this function after background script loads
updatePinnedTabs();

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.pinned) {
    // Only update stored URL if this is same-domain navigation
    // This preserves the "canonical" pinned URL for bookmark click detection
    // Cross-domain navigation attempts are blocked by onBeforeNavigate before reaching here
    if (changeInfo.url) {
      const storedUrl = pinnedTabs[tabId] ? pinnedTabs[tabId].url : null;

      // If no stored URL yet, or if same domain, update it
      if (!storedUrl || !isDifferentDomain(storedUrl, tab.url)) {
        pinnedTabs[tabId] = { url: tab.url, index: tab.index };
      } else {
        // Different domain - this means redirect loop fix allowed navigation
        // Update canonical URL to new domain to stay in sync
        pinnedTabs[tabId] = { url: tab.url, index: tab.index };
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

      persistState();
    } else if (!pinnedTabs[tabId]) {
      // Tab just became pinned, store initial state
      pinnedTabs[tabId] = { url: tab.url, index: tab.index };
      persistState();
    }
  } else {
    delete pinnedTabs[tabId]; // Remove from pinnedTabs if unpinned
    delete tabRedirects[tabId]; // Clean up redirect tracking
    persistState();
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (pinnedTabs[tabId]) {
    chrome.tabs.create(
      { url: pinnedTabs[tabId].url, pinned: true, index: pinnedTabs[tabId].index },
      (newTab) => {
        pinnedTabs[newTab.id] = { url: newTab.url, index: newTab.index };
        delete pinnedTabs[tabId];
        persistState();
      }
    );
  }

  // Clean up tracking data
  delete tabRedirects[tabId];
  persistState();
});

// Listen for tab creation
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.pinned) {
    pinnedTabs[tab.id] = { url: tab.url, index: tab.index };
    persistState();
  }
});

// Listen for tab moves to keep index up-to-date
chrome.tabs.onMoved.addListener((tabId, moveInfo) => {
  if (pinnedTabs[tabId]) {
    pinnedTabs[tabId].index = moveInfo.toIndex;
    persistState();
  }
});

// Listen for navigation events - this now handles both address bar navigation
// and link clicks
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return; // Only handle main frame navigation

  chrome.tabs.get(details.tabId, (tab) => {
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

        persistState();
      }
    }
  });
});