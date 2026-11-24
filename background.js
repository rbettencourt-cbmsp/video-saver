// Watches network responses and remembers media URLs seen in each tab (including
// inside embedded player iframes). State lives in chrome.storage.session so it
// survives service-worker restarts. The toolbar badge shows how many were found.

importScripts("common.js");

const MAX_PER_TAB = 50;
// Pieces of a segmented stream, not whole videos.
const SEGMENT_RE = /(?:^|[\/_-])(?:seg(?:ment)?|chunk|frag(?:ment)?|part)[-_]?\d+\.(?:mp4|m4[sva])$/i;

let queue = Promise.resolve();
function serialize(fn) {
  queue = queue.then(fn, fn);
  return queue;
}

const key = (tabId) => `tab:${tabId}`;

function setBadge(tabId, count) {
  chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a73e8" }).catch(() => {});
}

// The page that embeds the player is what the CDN expects as Referer.
async function frameUrl(tabId, frameId, fallback) {
  try {
    const f = await chrome.webNavigation.getFrame({ tabId, frameId });
    if (f?.url && /^https?:/.test(f.url)) return f.url;
  } catch {}
  return fallback;
}

function addMedia(details, type) {
  const url = type === "file" ? stripRangeParams(details.url) : details.url;
  const { tabId, frameId } = details;
  return serialize(async () => {
    const k = key(tabId);
    const { [k]: list = [] } = await chrome.storage.session.get(k);
    if (list.some((m) => m.url === url)) return;
    const referrer = await frameUrl(tabId, frameId, details.initiator ? details.initiator + "/" : "");
    list.push({ url, type, referrer, inFrame: frameId > 0, source: "network", seen: Date.now() });
    const kept = list.slice(-MAX_PER_TAB);
    await chrome.storage.session.set({ [k]: kept });
    setBadge(tabId, kept.length);
  });
}

function clearTab(tabId) {
  setBadge(tabId, 0);
  return serialize(() => chrome.storage.session.remove(key(tabId)));
}

// Response headers let us catch manifests whose URLs don't end in .m3u8/.mpd.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (details.initiator?.startsWith("chrome-extension://")) return; // our own saver
    if (details.statusCode >= 400) return;
    const ct = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value || "";
    const type = mediaKind(details.url, ct);
    if (!type) return;
    if (type === "file" && SEGMENT_RE.test(new URL(details.url).pathname)) return;
    addMedia(details, type);
  },
  { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
  ["responseHeaders"]
);

// A full page load starts a fresh list; in-app (pushState) navigation keeps it.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0) clearTab(d.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => chrome.storage.session.remove(key(tabId)));
});

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
