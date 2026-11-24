import { toMp4 } from "./mux.js";

// Saves one video. Query params:
//   url       manifest or file URL
//   kind      "hls" | "dash" | "file"
//   name      base filename
//   referrer  page (or player frame) the video came from; sent as Referer
// Streams are fetched segment by segment (byte ranges supported), then the video
// and any separate audio track are packed into one MP4 without re-encoding.
// Encrypted/DRM streams are deliberately not supported.

const params = new URLSearchParams(location.search);
const srcUrl = params.get("url");
const kind = params.get("kind") || mediaKind(srcUrl) || "file";
const baseName = safeFilename(params.get("name"));
const referrer = params.get("referrer") || "";

const $ = (id) => document.getElementById(id);
const setStatus = (text, cls = "") => {
  $("status").textContent = text;
  $("status").className = cls;
};
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

const CONCURRENCY = 4;
const RETRIES = 3;

// --- Referer header -------------------------------------------------------
// fetch() can't set Referer, so a session rule adds it to this tab's requests.
// Some CDNs (TikTok and others) refuse requests without the page's Referer.
let ruleId = null;

async function useReferrer(ref) {
  if (!ref || !chrome.declarativeNetRequest) return;
  const tab = await chrome.tabs.getCurrent();
  if (!tab) return;
  ruleId = 1000 + tab.id;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: ref }] },
      condition: { tabIds: [tab.id], resourceTypes: ["xmlhttprequest"] },
    }],
  });
}

function dropReferrer() {
  if (ruleId != null) chrome.declarativeNetRequest?.updateSessionRules({ removeRuleIds: [ruleId] });
  ruleId = null;
}
addEventListener("pagehide", dropReferrer);

// --- Fetching -------------------------------------------------------------
// seg: string URL or { url, start?, end? } (inclusive byte range)
async function fetchOk(seg, as) {
  const { url, start, end } = typeof seg === "string" ? { url: seg } : seg;
  const ranged = start != null;
  const headers = ranged ? { Range: `bytes=${start}-${end ?? ""}` } : {};
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { credentials: "include", headers });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        if ([401, 403, 404, 410].includes(res.status)) err.fatal = true;
        throw err;
      }
      if (as === "text") return await res.text();
      const buf = await res.arrayBuffer();
      // Server ignored the Range header and sent the whole file: cut out our part.
      if (ranged && res.status === 200) return buf.slice(start, end != null ? end + 1 : undefined);
      return buf;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const short = url.split("?")[0];
  const hint = /HTTP 40[13]|HTTP 410/.test(lastErr.message)
    ? " (the link may have expired: reload the page, play the video, and try again)"
    : "";
  throw new Error(`Failed to fetch ${short}: ${lastErr.message}${hint}`);
}

async function downloadAll(segs, onProgress) {
  const parts = new Array(segs.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < segs.length) {
      const i = next++;
      try {
        parts[i] = await fetchOk(segs[i]);
      } catch (err) {
        if (!segs[i].optional) throw err;
        parts[i] = new ArrayBuffer(0); // speculative extra segment that does not exist
      }
      onProgress(++done, segs.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, segs.length) }, worker));
  return parts;
}

// Downloads a parsed track ({ init, segments, encrypted, ext }) into a Blob.
async function downloadTrack(track, label) {
  if (track.encrypted) throw new Error("This stream is encrypted (DRM), which Video Saver does not support.");
  if (!track.segments.length) throw new Error(`The ${label} track has no segments.`);
  const segs = track.init ? [track.init, ...track.segments] : track.segments;
  const bar = $("bar");
  bar.value = 0;
  bar.max = segs.length;
  const parts = await downloadAll(segs, (done, total) => {
    bar.value = done;
    setStatus(total === 1 ? `Downloading ${label}…` : `Downloading ${label}: segment ${done} of ${total}…`);
  });
  return { blob: new Blob(parts), ext: track.ext };
}

// Single file with live byte progress.
async function downloadFile(url) {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    const hint = [401, 403, 410].includes(res.status) ? " (reload the page, play the video, and try again)" : "";
    throw new Error(`Failed to fetch ${url.split("?")[0]}: HTTP ${res.status}${hint}`);
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const bar = $("bar");
  bar.max = total || 1;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (total) bar.value = got;
    setStatus(`Downloading… ${mb(got)}${total ? ` of ${mb(total)}` : ""}`);
  }
  return new Blob(chunks, { type: res.headers.get("content-type") || "" });
}

// --- Manifests → { video, audio } tracks -----------------------------------

async function hlsTracks() {
  const top = parsePlaylist(await fetchOk(srcUrl, "text"), srcUrl);
  let videoUrl = srcUrl;
  let audioUrl = null;
  if (top.kind === "master") {
    const v = bestVariant(top.variants);
    videoUrl = v.uri;
    audioUrl = audioFor(v, top.audio)?.uri || null;
    $("title").textContent = `Saving: ${baseName} (${v.resolution || Math.round(v.bandwidth / 1000) + " kbps"})`;
  }
  const media = async (url) => {
    const pl = parsePlaylist(await fetchOk(url, "text"), url);
    if (pl.kind !== "media") throw new Error("Expected an HLS media playlist.");
    return { init: pl.init, segments: pl.segments, encrypted: pl.encrypted, ext: pl.init ? "mp4" : "ts" };
  };
  return { video: await media(videoUrl), audio: audioUrl ? await media(audioUrl) : null };
}

async function dashTracks() {
  const mpd = parseMpd(await fetchOk(srcUrl, "text"), srcUrl);
  if (mpd.resolution) $("title").textContent = `Saving: ${baseName} (${mpd.resolution})`;
  if (mpd.multiPeriod) $("warn").textContent = "This stream has several parts (periods); only the first is saved.";
  return { video: mpd.video || mpd.audio, audio: mpd.video ? mpd.audio : null };
}

// --- Saving ---------------------------------------------------------------

function saveBlob(blob, filename) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
      if (chrome.runtime.lastError) {
        URL.revokeObjectURL(url);
        reject(new Error(`Download failed: ${chrome.runtime.lastError.message}`));
        return;
      }
      const listener = (delta) => {
        if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(listener);
          URL.revokeObjectURL(url);
          if (delta.state.current === "complete") resolve();
          else reject(new Error("Download was cancelled."));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}

async function saveTracks(video, audio) {
  let mp4 = null;
  try {
    mp4 = await toMp4(video, audio, (msg) => setStatus(msg));
  } catch (err) {
    console.error(err);
    $("warn").textContent = `Couldn't merge into MP4 (${err.message.split("\n")[0]}). Saving the original files instead.`;
  }

  if (mp4) {
    setStatus(`Choose where to save the MP4 (${mb(mp4.size)})…`);
    await saveBlob(mp4, `${baseName}.mp4`);
    return;
  }

  // Fallback: save the raw tracks as they came from the server.
  if (!audio) {
    setStatus(`Choose where to save the file (${mb(video.blob.size)})…`);
    await saveBlob(video.blob, `${baseName}.${video.ext}`);
    return;
  }
  const vName = `${baseName}.video.${video.ext}`;
  const aName = `${baseName}.audio.${audio.ext}`;
  setStatus(`Choose where to save the video track (${mb(video.blob.size)})…`);
  await saveBlob(video.blob, vName);
  setStatus(`Choose where to save the audio track (${mb(audio.blob.size)})…`);
  await saveBlob(audio.blob, aName);
  const cmd = document.createElement("pre");
  cmd.textContent = `ffmpeg -i "${vName}" -i "${aName}" -c copy "${baseName}.mp4"`;
  $("warn").after(cmd);
}

async function run() {
  if (!srcUrl) throw new Error("No video URL given.");
  $("src").textContent = srcUrl.split("?")[0];
  $("title").textContent = `Saving: ${baseName}`;
  await useReferrer(referrer);

  if (kind === "file") {
    const blob = await downloadFile(srcUrl);
    setStatus(`Choose where to save the file (${mb(blob.size)})…`);
    await saveBlob(blob, `${baseName}.${extFromUrl(srcUrl)}`);
  } else {
    setStatus("Reading manifest…");
    const tracks = kind === "dash" ? await dashTracks() : await hlsTracks();
    const video = await downloadTrack(tracks.video, tracks.audio ? "video" : "stream");
    const audio = tracks.audio ? await downloadTrack(tracks.audio, "audio") : null;
    await saveTracks(video, audio);
  }
  setStatus("Saved. You can close this tab.");
}

run()
  .catch((err) => setStatus(err.message, "error"))
  .finally(dropReferrer);
