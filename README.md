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

**A closed pinned tab is reopened, not stopped from closing.** Chrome gives extensions no
way to cancel a tab closing. The tab genuinely closes and is recreated immediately at the
same position with the same address — so the page reloads, and anything unsaved on it
(scroll position, half-filled forms) is lost. Visually the tab barely flinches, but this
is a restore, not a prevention, and it cannot be made into one from an extension.

The same applies to links: a navigation is caught as it begins rather than beforehand, so
the pinned page may briefly flash as it is put back.

Also worth knowing: Chrome's internal pages (`chrome://`, `about:`) are not covered, the
browser's Home button is not intercepted, and when a site bounces through another domain
— as sign-in pages often do — the second attempt is let through, so that signing in
cannot spawn tabs endlessly.

This extension is built and tested for **Google Chrome**. Other Chromium-based browsers
(Brave, Vivaldi, Helium, …) implement tab and navigation handling their own way and may
behave differently; problems that only occur there cannot be fixed from here.

## There is also a Firefox version

Firefox already refuses to close a pinned tab with Ctrl-W/Cmd-W on its own, so the
Firefox build has no reopen feature and concentrates on link handling instead — where it
can optionally send *every* link to a new tab, not only links to another site.

→ [gerardkieffer/besser-pinned-tabs-firefox](https://github.com/gerardkieffer/besser-pinned-tabs-firefox)
· [Install from addons.mozilla.org](https://addons.mozilla.org/en-US/firefox/addon/besser-pinned-tabs/)

## Development

Manifest V3, plain JavaScript, no build step and no dependencies.

Load it with `chrome://extensions/` → Developer mode → **Load unpacked** → select this
folder. After an edit, click the reload icon on the extension's card. The background
console is behind the "service worker" link.
