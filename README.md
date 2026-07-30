# Besser Pinned Tabs — Chrome

Protects the tabs you keep pinned. Close one by accident and it comes straight back;
follow a link to another site and it opens in a new tab instead of taking over your
pinned page.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/besser-pinned-tabs/ehcbfmgehpmmjbpcnpkbjnpoplefekok)**

## What it does

- **Reopens a pinned tab that gets closed** — by Cmd-W, Ctrl-W, the close button or the
  context menu — at the same position, showing the same site.
- **Sends links to other sites to a new tab**, so the pinned page stays put. Links within
  the same site load normally.
- **Sends a newly typed address to a new tab** as well.
- Runs in the background. Nothing to configure.
- **No data collection**, and no host permissions: the extension never gets access to the
  content of the pages you visit.

Clicking the toolbar icon opens an About page explaining all of this, including the
limitations below.

## The one thing worth understanding

**The pinned page always reloads in two cases: when you type a new address in a pinned
tab, and when you close a pinned tab with a keyboard shortcut.** In both, the tab is put
back rather than held in place, so the page loads again and anything unsaved on it
(scroll position, half-filled forms) is lost.

That follows from what an extension is allowed to do. **A closed pinned tab is reopened,
not stopped from closing** — the browser gives extensions no way to cancel a tab closing,
so the tab genuinely closes and is recreated at the same position. Visually it barely
flinches, but this is a restore, not a prevention, and it cannot be made into one from an
extension. The same applies to a typed address: the navigation is caught as it begins
rather than beforehand, and the pinned page is then put back.

Clicking a link to another site does *not* reload the pinned page — that one is handled
before the pinned tab goes anywhere.

Also worth knowing: internal browser pages (`chrome://`, `about:`) are not covered, the
browser's Home button is not intercepted, and when a site bounces through another domain
— as sign-in pages often do — the second attempt is let through, so that signing in
cannot spawn tabs endlessly.

## Browser support

Built and tested for **Google Chrome**, **Brave** and **Microsoft Edge**.

Chrome now asks you to press Cmd-W/Ctrl-W a second time before it closes a pinned tab.
That prevents the close outright, which is better than reopening the tab afterwards, so
on Chrome the extension detects this and leaves the close alone — once you have confirmed
twice, the tab stays closed. Brave and Edge still close a pinned tab on the first press,
so there the tab is reopened as described above.

Other Chromium-based browsers (Vivaldi, Helium, …) implement tab handling their own way
and are treated like Brave and Edge. Problems that only occur there may not be fixable
from here.

## There is also a Firefox version

Firefox handles two of the three cases above by itself: it refuses to close a pinned tab
with Ctrl-W/Cmd-W, and it already sends links to another site into a new tab. The Firefox
build therefore does one thing only — an address typed in a pinned tab and leading to
another site opens in a new tab.

→ [gerardkieffer/besser-pinned-tabs-firefox](https://github.com/gerardkieffer/besser-pinned-tabs-firefox)
· [Install from addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/besser-pinned-tabs/)

## Development

Manifest V3, plain JavaScript, no build step and no dependencies.

Load it with `chrome://extensions/` → Developer mode → **Load unpacked** → select this
folder. After an edit, click the reload icon on the extension's card. The background
console is behind the "service worker" link.

Set `DEBUG = true` at the top of `background.js` to trace the service worker in that
console: which browser was detected, what the tab sync sees, and every close decision.
This is the only practical way to diagnose a problem that happens in one Chromium port
and not another, since the behaviour depends on how that browser handles tabs.

Two things about the service worker are worth knowing before changing `background.js`.
It is destroyed and re-evaluated for practically every event, so nothing survives in
memory between events and a `chrome.storage` write that is not awaited is simply
discarded. And a tab's ID is not stable — the browser recreates tabs on prerender,
instant and memory-saver discard — so nothing important should be keyed on it. Reopening
a closed pinned tab therefore does not rely on tracked state at all: `chrome.sessions`
is asked what was just closed, after the fact.
