// Watches network requests and remembers media URLs seen in each tab.
// State lives in chrome.storage.session so it survives service-worker restarts.

const MEDIA_RE = /\.(m3u8|mp4|webm|mov)$/i;
const MAX_PER_TAB = 50;

let queue = Promise.resolve();
function serialize(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

const key = (tabId) => `tab:${tabId}`;

function addMedia(tabId, url) {
  return serialize(async () => {
    const k = key(tabId);
    const { [k]: list = [] } = await chrome.storage.session.get(k);
    if (list.some((m) => m.url === url)) return;
    const type = /\.m3u8$/i.test(new URL(url).pathname) ? "hls" : "file";
    list.push({ url, type, source: "network", seen: Date.now() });
    await chrome.storage.session.set({ [k]: list.slice(-MAX_PER_TAB) });
  });
}

function clearTab(tabId) {
  return serialize(() => chrome.storage.session.remove(key(tabId)));
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    let path;
    try {
      path = new URL(details.url).pathname;
    } catch {
      return;
    }
    if (MEDIA_RE.test(path)) addMedia(details.tabId, details.url);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
);

// A full page load starts a fresh list; in-app (pushState) navigation keeps it.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) clearTab(d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => clearTab(tabId));

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getMedia") {
    serialize(async () => {
      const k = key(msg.tabId);
      const { [k]: list = [] } = await chrome.storage.session.get(k);
      sendResponse(list);
    });
    return true; // async response
  }
  if (msg?.type === "clearMedia") {
    clearTab(msg.tabId).then(() => sendResponse(true));
    return true;
  }
});
