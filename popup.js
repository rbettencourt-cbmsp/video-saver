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

  const items = [...found.values()];
  await Promise.all(items.map(classify));
  return items.sort((a, b) => a.rank - b.rank || (b.seen || 0) - (a.seen || 0));
}

const PREVIEW_RE = /thumbnail|preview|poster|sprite|storyboard/i;

// Adds a label and sort rank. Full HLS streams (video + audio) first, previews last.
async function classify(item) {
  if (item.type !== "hls") {
    const preview = PREVIEW_RE.test(new URL(item.url).pathname);
    item.label = preview ? "Preview clip (not the full video)" : extFromUrl(item.url).toUpperCase();
    item.rank = preview ? 4 : 1;
    return;
  }
  try {
    const res = await fetch(item.url, { credentials: "include" });
    const text = await res.text();
    if (/#EXT-X-STREAM-INF/.test(text)) {
      item.label = "Full stream (recommended)";
      item.rank = 0;
    } else {
      const hint = /audio/i.test(item.url) ? "audio only" : /video/i.test(item.url) ? "video only" : "single track";
      item.label = `Stream (${hint})`;
      item.rank = 2;
    }
  } catch {
    item.label = "Stream (HLS)";
    item.rank = 3;
  }
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
    const shown = item.url.split("?")[0];
    url.textContent = shown.length > 160 ? shown.slice(0, 160) + "…" : shown;
    url.title = item.url;

    const meta = document.createElement("div");
    meta.className = "meta";
    const tag = document.createElement("span");
    tag.className = "tag";
    tag.textContent = item.label;
    if (item.rank === 0) tag.classList.add("best");
    if (item.rank === 4) li.classList.add("dim");
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
