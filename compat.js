// Loaded first in every page, the background and content scripts.
// Firefox has promise-based extension APIs on `browser`; Chrome on `chrome`. The shared
// code uses promises, so on Firefox `chrome` is pointed at `browser`.
(() => {
  const ff = typeof globalThis.browser !== "undefined" && globalThis.browser?.runtime?.id;
  if (ff) globalThis.chrome = globalThis.browser;
  globalThis.VS_IS_FIREFOX = !!ff && String(globalThis.browser.runtime.getURL("")).startsWith("moz-extension:");
})();
