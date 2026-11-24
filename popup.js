const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");

// Runs inside the page and every frame: collects plain (non-blob) <video> sources.
function scanPage() {
  const out = [];
  for (const v of document.querySelectorAll("video")) {
    const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map((s) => s.src)];
    for (const s of srcs) {
      if (s && /^https?:/i.test(s)) out.push({ url: s, referrer: location.href, inFrame: window !== top });
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
      for (const hit of r.result || []) {
        const type = mediaKind(hit.url) || "file";
        const url = type === "file" ? stripRangeParams(hit.url) : hit.url;
        if (!found.has(url)) found.set(url, { ...hit, url, type, source: "page" });
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

// Adds a label and sort rank:
// 0 full stream, 1 file, 2 single track, 3 unknown stream, 4 preview clip, 5 DRM (can't save).
async function classify(item) {
  if (item.type === "file") {
    const preview = PREVIEW_RE.test(new URL(item.url).pathname);
    item.label = preview ? "Preview clip (not the full video)" : extFromUrl(item.url).toUpperCase();
    item.rank = preview ? 4 : 1;
    return;
  }

  let text;
  try {
    const res = await fetch(item.url, { credentials: "include" });
    text = await res.text();
  } catch {
    [item.label, item.rank] = [`Stream (${item.type.toUpperCase()})`, 3];
    return;
  }

  if (item.type === "dash") {
    try {
      const mpd = parseMpd(text, item.url);
      const res = mpd.resolution ? `, ${mpd.resolution}` : "";
      if (mpd.video?.encrypted || mpd.audio?.encrypted) [item.label, item.rank] = ["DRM-protected (can’t save)", 5];
      else if (mpd.video && mpd.audio) [item.label, item.rank] = [`Full stream (recommended${res})`, 0];
      else [item.label, item.rank] = [mpd.video ? `Stream (video only${res})` : "Stream (audio only)", 2];
    } catch (err) {
      [item.label, item.rank] = [/Live/.test(err.message) ? "Live stream (not supported)" : "Stream (DASH)", 3];
    }
    return;
  }

  // HLS
  if (/#EXT-X-(SESSION-)?KEY:METHOD=(?!NONE)/.test(text)) {
    [item.label, item.rank] = ["Encrypted (can’t save)", 5];
  } else if (/#EXT-X-STREAM-INF/.test(text)) {
    [item.label, item.rank] = ["Full stream (recommended)", 0];
  } else {
    const hint = /audio/i.test(item.url) ? "audio only" : /video/i.test(item.url) ? "video only" : "single track";
    [item.label, item.rank] = [`Stream (${hint})`, 2];
  }
}

// Every save goes through the saver tab so it can send the right Referer,
// show progress, and merge separate audio/video into one MP4.
function save(item, tab) {
  const params = new URLSearchParams({
    url: item.url,
    kind: item.type,
    name: safeFilename(tab.title),
    referrer: item.referrer || tab.url || "",
  });
  chrome.tabs.create({ url: chrome.runtime.getURL(`saver.html?${params}`) });
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
    if (item.rank >= 4) li.classList.add("dim");

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
    const host = document.createElement("span");
    host.className = "host";
    if (item.inFrame && item.referrer) {
      try {
        host.textContent = `in player from ${new URL(item.referrer).host}`;
      } catch {}
    }
    const btn = document.createElement("button");
    btn.className = "save";
    btn.textContent = "Save";
    btn.disabled = item.rank === 5;
    btn.addEventListener("click", () => save(item, tab));
    meta.append(tag, host, btn);

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
