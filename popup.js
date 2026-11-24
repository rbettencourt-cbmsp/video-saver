const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

// Runs inside the page: collects plain (non-blob) <video> sources.
function scanPage() {
  const out = [];
  for (const v of document.querySelectorAll("video")) {
    const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map((s) => s.src)];
    for (const s of srcs) {
      if (s && /^https?:/i.test(s)) out.push(s);
    }
  }
  return out;
}

async function collect(tab) {
  const found = new Map();

  const network = await chrome.runtime.sendMessage({ type: "getMedia", tabId: tab.id });
  for (const m of network || []) found.set(m.url, m);

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: scanPage,
    });
    for (const r of results) {
      for (const url of r.result || []) {
        if (!found.has(url)) {
          const type = /\.m3u8(\?|$)/i.test(url) ? "hls" : "file";
          found.set(url, { url, type, source: "page" });
        }
      }
    }
  } catch {
    // Pages like chrome:// or the Web Store can't be scripted; network results still apply.
  }

  // HLS first (usually the real lesson), then newest.
  return [...found.values()].sort(
    (a, b) => (a.type === "hls" ? 0 : 1) - (b.type === "hls" ? 0 : 1) || (b.seen || 0) - (a.seen || 0)
  );
}

function save(item, tab) {
  const base = safeFilename(tab.title);
  if (item.type === "hls") {
    const params = new URLSearchParams({ url: item.url, name: base });
    chrome.tabs.create({ url: chrome.runtime.getURL(`saver.html?${params}`) });
  } else {
    chrome.downloads.download({
      url: item.url,
      filename: `${base}.${extFromUrl(item.url)}`,
      saveAs: true,
    });
  }
}

function render(items, tab) {
  listEl.replaceChildren();
  if (!items.length) {
    statusEl.textContent = "No videos found yet. Play the video, then click Rescan.";
    return;
  }
  statusEl.textContent = `${items.length} video source${items.length > 1 ? "s" : ""} found`;
  for (const item of items) {
    const li = document.createElement("li");
    const url = document.createElement("div");
    url.className = "url";
    url.textContent = item.url.length > 160 ? item.url.slice(0, 160) + "…" : item.url;
    url.title = item.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.type === "hls" ? "Stream (HLS)" : extFromUrl(item.url).toUpperCase();
    const btn = document.createElement("button");
    btn.className = "save";
    btn.textContent = "Save";
    btn.addEventListener("click", () => save(item, tab));
    meta.append(tag, btn);

    li.append(url, meta);
    listEl.append(li);
  }
}

async function refresh() {
  statusEl.textContent = "Scanning…";
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  render(await collect(tab), tab);
}

document.getElementById("refresh").addEventListener("click", refresh);
refresh();
