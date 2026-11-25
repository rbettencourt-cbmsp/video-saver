// Toolbar popup, also shown inside pages by the floating button (popup.html?tabId=…&embedded=1).
// Lists every video source for the tab with a quality choice; Save adds it to the download queue.

const params = new URLSearchParams(location.search);
const embedded = params.has("embedded");
if (embedded) document.body.classList.add("embedded");

const statusEl = document.getElementById("status");
const listEl = document.getElementById("list");
const send = (msg) => chrome.runtime.sendMessage(msg);
let resolvers = null; // loaded on demand (ES module)

async function getTab() {
  if (params.has("tabId")) return chrome.tabs.get(Number(params.get("tabId")));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function fetchOk(url, as = "text", init = {}) {
  const res = await fetch(url, { credentials: "include", ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return as === "json" ? res.json() : res.text();
}

// Some hosts (Skool/Mux) only serve a stream's manifest to requests from the page's own
// site. If the extension's request is refused, fetch it from inside the page instead.
async function fetchManifest(url, tab) {
  try {
    return await fetchOk(url);
  } catch (err) {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      // Try without cookies first: CDNs that allow any site ("*") refuse cookie-carrying requests.
      func: async (u) => {
        for (const credentials of ["omit", "include"]) {
          try {
            const res = await fetch(u, { credentials });
            if (res.ok) return await res.text();
          } catch {}
        }
        return null;
      },
      args: [url],
    });
    if (typeof r?.result !== "string") throw err;
    return r.result;
  }
}

const urlKey = (u) => {
  try {
    const x = new URL(u);
    return x.origin + x.pathname;
  } catch {
    return u;
  }
};

// --- Collect -------------------------------------------------------------------

async function collect(tab) {
  const found = new Map();
  const network = await send({ type: "getMedia", tabId: tab.id });
  for (const m of Array.isArray(network) ? network : []) found.set(m.url, { ...m });

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => globalThis.videoSaverDetect?.() || [],
    });
    for (const r of results) {
      for (const hit of r.result || []) {
        if (hit.type === "url") {
          const type = mediaKind(hit.url) || "file";
          const url = type === "file" ? stripRangeParams(hit.url) : hit.url;
          if (!found.has(url)) found.set(url, { ...hit, url, type, source: "page" });
        } else {
          const id = `${hit.type}:${hit.kind || ""}:${hit.embedId}`;
          if (!found.has(id)) found.set(id, { ...hit, source: "page" });
        }
      }
    }
  } catch {
    // chrome:// pages, the Web Store, etc. can't be scripted; network results still apply.
  }

  let items = [...found.values()];
  await Promise.all(items.map((i) => classify(i, tab).catch(() => Object.assign(i, { label: "Video", rank: 3 }))));
  // A full stream lists its own video and audio tracks; once it's found, don't list those
  // tracks separately (saving one gives video without sound, or sound only).
  const parts = new Set(items.flatMap((i) => i.parts || []));
  items = items.filter((i) => !i.url || !parts.has(urlKey(i.url)));
  // Only call a stream "video only" when a separate audio stream is on the page too;
  // otherwise it's most likely the whole video with sound (e.g. Fathom's video.m3u8).
  const separateAudio = items.some((i) => i.track === "audio");
  for (const i of items) {
    if (i.track === "audio") Object.assign(i, { label: "Stream (audio only)", rank: 2 });
    else if (i.track === "video" && separateAudio) Object.assign(i, { label: "Stream (video only)", rank: 2 });
  }
  return items.sort((a, b) => a.rank - b.rank || (b.seen || 0) - (a.seen || 0));
}

const YT_QUALITIES = [
  { yt: "best", text: "Best" },
  { yt: "1080", text: "1080p" },
  { yt: "720", text: "720p" },
  { yt: "480", text: "480p" },
  { yt: "audio", text: "MP3" },
];
const PREVIEW_RE = /thumbnail|preview|poster|sprite|storyboard/i;
const PLAYER_NAMES = { wistia: "Wistia player", vimeo: "Vimeo player", loom: "Loom player" };
const heightOf = (res) => Number(String(res || "").split("x")[1]) || 0;

function qualitiesFromHls(text, url) {
  const pl = parsePlaylist(text, url);
  if (pl.kind !== "master") return [];
  return pl.variants
    .map((v) => ({ height: heightOf(v.resolution), bandwidth: v.bandwidth }))
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

// Sets item.label, item.rank (0 best … 5 can't save) and item.qualities.
// Ranks: 0 full stream/player, 1 file, 2 single track, 3 unknown, 4 preview clip, 5 unsupported.
async function classify(item, tab) {
  if (item.type === "youtube") {
    // Saved by the yt-dlp helper (see README: "YouTube downloads").
    Object.assign(item, { title: "YouTube player", label: "Full video (YouTube helper)", rank: 0, qualities: YT_QUALITIES });
    return;
  }

  if (item.type === "embed") {
    item.title = PLAYER_NAMES[item.kind] || "Video player";
    Object.assign(item, { label: "Video player", rank: 0 });
    resolvers ||= await import(chrome.runtime.getURL("resolvers.js"));
    try {
      if (item.kind === "wistia") {
        item.qualities = (await resolvers.wistiaQualities(item.embedId, fetchOk)).map(({ height, bandwidth }) => ({ height, bandwidth }));
      } else {
        const r = await resolvers.resolveEmbed(item, fetchOk);
        if (r.kind === "hls") item.qualities = qualitiesFromHls(await fetchOk(r.url), r.url);
        else if (r.kind === "dash") item.qualities = parseMpd(await fetchOk(r.url), r.url).qualities;
      }
      item.label = "Full video (recommended)";
    } catch {
      // Private or domain-locked: resolving may still work from the downloads tab,
      // which sends the page as Referer.
      item.label = "Player found (play it if saving fails)";
      item.rank = 2;
    }
    return;
  }

  if (item.type === "file") {
    const preview = PREVIEW_RE.test(new URL(item.url).pathname);
    item.label = preview ? "Preview clip (not the full video)" : extFromUrl(item.url).toUpperCase();
    item.rank = preview ? 4 : 1;
    return;
  }

  let text;
  try {
    text = await fetchManifest(item.url, tab);
  } catch {
    Object.assign(item, { label: `Stream (${item.type.toUpperCase()})`, rank: 3 });
    return;
  }

  if (item.type === "dash") {
    try {
      const mpd = parseMpd(text, item.url);
      item.qualities = mpd.qualities;
      if (mpd.video?.encrypted || mpd.audio?.encrypted) Object.assign(item, { label: "DRM-protected (can’t save)", rank: 5 });
      else if (mpd.video && mpd.audio) Object.assign(item, { label: "Full stream (recommended)", rank: 0 });
      else Object.assign(item, { label: mpd.video ? "Stream (video only)" : "Stream (audio only)", rank: 2 });
    } catch (err) {
      Object.assign(item, { label: /Live/.test(err.message) ? "Live stream (not supported)" : "Stream (DASH)", rank: /Live/.test(err.message) ? 5 : 3 });
    }
    return;
  }

  // HLS
  if (/#EXT-X-(SESSION-)?KEY:METHOD=(?!NONE)/.test(text)) {
    Object.assign(item, { label: "Encrypted (can’t save)", rank: 5 });
  } else if (/#EXT-X-STREAM-INF/.test(text)) {
    Object.assign(item, { label: "Full stream (recommended)", rank: 0, qualities: qualitiesFromHls(text, item.url) });
    try {
      const pl = parsePlaylist(text, item.url);
      item.parts = [...pl.variants.map((v) => v.uri), ...pl.audio.map((a) => a.uri)].map(urlKey);
    } catch {}
  } else {
    // A stream without a quality list: either the whole video, or one track of a stream
    // that sends picture and sound separately. The link name is only a hint; collect()
    // settles the label once it has seen every stream on the page.
    item.track = /audio/i.test(item.url) || /#EXT-X-MAP:URI="[^"]*audio/i.test(text) ? "audio" : /video/i.test(item.url) ? "video" : "";
    Object.assign(item, { label: "Stream", rank: 1 });
  }
}

// --- Render --------------------------------------------------------------------

function qualityLabel(q) {
  if (q.text) return q.text;
  if (q.height) return `${q.height}p`;
  if (q.bandwidth) return `${Math.round(q.bandwidth / 1000)} kbps`;
  return "Auto";
}

async function saveYouTube(item, tab, quality, btn) {
  btn.disabled = true;
  const { ytFolder, ytUseSignIn } = await chrome.storage.local.get(["ytFolder", "ytUseSignIn"]);
  const res = await send({
    type: "ytStart",
    queue: true,
    tabId: tab.id,
    url: `https://www.youtube.com/watch?v=${item.embedId}`,
    quality: quality?.yt || "best",
    folder: ytFolder || "",
    filename: safeFilename(tab.title, ""),
    title: tab.title || "YouTube video",
    useSignIn: ytUseSignIn === true,
    pageUrl: tab.url,
  });
  btn.textContent = res?.error ? "Failed" : "Added ✓";
  if (res?.error) btn.title = res.notInstalled ? "The YouTube helper isn't installed on this computer (see the README)." : res.error;
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Save";
  }, 2000);
}

async function save(item, tab, quality, btn) {
  if (item.type === "youtube") return saveYouTube(item, tab, quality, btn);
  const job = {
    kind: item.type === "embed" ? item.kind : item.type,
    url: item.url,
    embedId: item.embedId,
    hash: item.hash,
    name: safeFilename(tab.title),
    referrer: item.referrer || tab.url || "",
    pageUrl: tab.url,
    quality,
  };
  btn.disabled = true;
  const res = await send({ type: "enqueue", job });
  btn.textContent = res?.error ? "Failed" : "Added ✓";
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = "Save";
  }, 2000);
}

function render(allItems, tab) {
  listEl.replaceChildren();
  // On youtube.com the Download panel under the video does this job; elsewhere,
  // embedded YouTube players are listed and saved through the yt-dlp helper.
  const onYouTube = /(^|\.)youtube\.com$/.test(new URL(tab.url || "about:blank").hostname || "");
  const items = onYouTube ? allItems.filter((i) => i.type !== "youtube") : allItems;
  const usable = items.filter((i) => i.rank < 5).length;

  if (onYouTube && items.length < allItems.length) {
    const note = document.createElement("li");
    note.className = "notice";
    note.textContent = "YouTube video: use the Download button under the video.";
    listEl.append(note);
  }
  if (!items.length) {
    statusEl.textContent = onYouTube ? "" : "No videos found yet. Play the video, then click Rescan.";
    statusEl.hidden = !statusEl.textContent;
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = `${usable} video source${usable === 1 ? "" : "s"} found`;
  for (const item of items) {
    const li = document.createElement("li");
    li.className = "item";
    if (item.rank >= 4) li.classList.add("dim");

    if (item.title) {
      const t = document.createElement("div");
      t.className = "title";
      t.textContent = item.title;
      li.append(t);
    }
    if (item.url) {
      const url = document.createElement("div");
      url.className = "url";
      const shown = item.url.split("?")[0];
      url.textContent = shown.length > 140 ? shown.slice(0, 140) + "…" : shown;
      url.title = item.url;
      li.append(url);
    }

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
    meta.append(tag, host);

    let select = null;
    if (item.qualities?.length > 1) {
      select = document.createElement("select");
      select.title = "Quality";
      item.qualities.forEach((q, i) => {
        const o = document.createElement("option");
        o.value = String(i);
        o.textContent = qualityLabel(q);
        select.append(o);
      });
      meta.append(select);
    }

    const btn = document.createElement("button");
    btn.className = "save";
    btn.textContent = "Save";
    btn.disabled = item.rank === 5;
    btn.addEventListener("click", () => save(item, tab, select ? item.qualities[Number(select.value)] : null, btn));
    meta.append(btn);
    li.append(meta);
    listEl.append(li);
  }
}

// --- Download queue (compact) ------------------------------------------------------

const fmt = (n) => `${(n / 1048576).toFixed(1)} MB`;

function renderJobs(jobs) {
  const recent = jobs.filter((j) => j.status !== "cancelled").slice(-5).reverse();
  document.getElementById("queue").hidden = !recent.length;
  const ul = document.getElementById("jobs");
  ul.replaceChildren();
  for (const j of recent) {
    const li = document.createElement("li");
    li.className = "job";
    const row = document.createElement("div");
    row.className = "row";
    const n = document.createElement("span");
    n.className = "n";
    n.textContent = j.name;
    const s = document.createElement("span");
    s.className = `s ${j.status === "error" ? "error" : ""}`;
    s.textContent =
      j.status === "running" ? `${Math.round((j.progress || 0) * 100)}%${j.speed ? ` · ${fmt(j.speed)}/s` : ""}`
      : j.status === "queued" ? "waiting"
      : j.status === "done" ? "saved ✓"
      : j.status === "error" ? "failed"
      : j.status;
    if (j.status === "error") s.title = j.error;
    row.append(n, s);
    li.append(row);
    if (j.status === "running") {
      const p = document.createElement("progress");
      p.max = 1;
      p.value = j.progress || 0;
      li.append(p);
    }
    ul.append(li);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.jobs) renderJobs(changes.jobs.newValue || []);
});

// --- Start -----------------------------------------------------------------------

async function refresh() {
  statusEl.textContent = "Scanning…";
  const tab = await getTab();
  if (!tab) return;
  render(await collect(tab), tab);
}

document.getElementById("refresh").addEventListener("click", refresh);
document.getElementById("open-downloads").addEventListener("click", (e) => {
  e.preventDefault();
  send({ type: "openManager" });
});

// Firefox lets people switch off an add-on's site access; without it nothing can be found.
async function checkSiteAccess() {
  const has = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true);
  if (has) return;
  const el = document.getElementById("update");
  el.hidden = false;
  el.replaceChildren("Video Saver needs access to websites to find videos. ");
  const b = document.createElement("button");
  b.textContent = "Allow access to all sites";
  b.addEventListener("click", async () => {
    if (await chrome.permissions.request({ origins: ["<all_urls>"] })) location.reload();
  });
  el.append(b);
}

(async () => {
  await checkSiteAccess();
  const { jobs = [] } = await chrome.storage.session.get("jobs");
  renderJobs(jobs);
  const update = await send({ type: "getUpdate" });
  if (update?.version) {
    const el = document.getElementById("update");
    el.hidden = false;
    el.innerHTML = "";
    const a = document.createElement("a");
    a.href = update.url;
    a.target = "_blank";
    a.textContent = `Version ${update.version} is available`;
    el.append(a);
  }
})();
refresh();
