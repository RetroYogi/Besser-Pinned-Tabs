// Fill in the version number from the manifest so this page can never drift out of sync
// with the released version. The markup carries the current version as a fallback, so a
// failure here degrades to stale text rather than a blank. Inline scripts are forbidden
// by the Manifest V3 content security policy, which is why this lives in its own file.
document.addEventListener('DOMContentLoaded', () => {
  const target = document.getElementById('version');
  if (!target) return;
  try {
    target.textContent = chrome.runtime.getManifest().version;
  } catch (error) {
    // Leave the fallback text in place.
  }
});
