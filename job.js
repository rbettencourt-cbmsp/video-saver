// Runs one download job end to end:
//   resolve (Wistia/Vimeo/Loom ids → stream URL) → read manifest → pick quality →
//   download tracks to disk → merge to MP4 in chunks → hand the file to the browser.
// Nothing large is held in memory, so multi-hour videos work.
// Needs common.js, hls.js and dash.js loaded first (classic scripts).
import { mergeToMp4 } from "./mux.js";
import { createScratch, removeScratch, orderedDownload } from "./store.js";
import { resolveEmbed } from "./resolvers.js";

const CONCURRENCY = 4;
const RETRIES = 3;
export const SAVE_FOLDER = "Video Saver";

/**
 * @param {object} job        { id, url, kind, name, referrer, quality?: {height?, bandwidth?} }
 * @param {object} ctx        { signal, report({progress, bytes, message, warn}), tabId? }
 * @returns {Promise<{downloadId:number, filename:string}>}
 */
export async function runJob(job, { signal, report }) {
  const scratch = [];
  const checkCancelled = () => {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  };
  const ruleIds = new Set();
  const say = (message, progress) => report({ message, ...(progress != null ? { progress } : {}) });
  let bytes = 0;
  const countBytes = (n) => report({ bytes: (bytes += n) });

  // --- Referer: a session rule adds it to our own requests to the media hosts.
  const referrer = job.referrer || "";
  const hostsWithRule = new Set();
  let ruleReady = Promise.resolve();
  function ensureReferer(url) {
    if (!referrer || !chrome.declarativeNetRequest) return;
    const host = new URL(url).hostname;
    if (!hostsWithRule.has(host)) {
      hostsWithRule.add(host);
      const hosts = [...hostsWithRule];
      ruleReady = ruleReady.then(() => installRule(hosts));
    }
    return ruleReady;
  }
  async function installRule(hosts) {
    const id = ruleIdFor(job.id);
    ruleIds.add(id);
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id],
      addRules: [{
        id,
        priority: 1,
        action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: referrer }] },
        condition: {
          requestDomains: hosts,
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: ["xmlhttprequest"],
        },
      }],
    });
  }

  async function fetchOk(seg, as, init = {}) {
    const { url, start, end } = typeof seg === "string" ? { url: seg } : seg;
    await ensureReferer(url);
    const ranged = start != null;
    const headers = ranged ? { Range: `bytes=${start}-${end ?? ""}` } : {};
    let lastErr;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      try {
        const res = await fetch(url, { credentials: "include", signal, ...init, headers: { ...headers, ...init.headers } });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status}`);
          if ([401, 403, 404, 410].includes(res.status)) err.fatal = true;
          throw err;
        }
        if (as === "text") return await res.text();
        if (as === "json") return await res.json();
        const buf = await res.arrayBuffer();
        countBytes(buf.byteLength);
        if (ranged && res.status === 200) return buf.slice(start, end != null ? end + 1 : undefined);
        return buf;
      } catch (err) {
        if (err.name === "AbortError") throw err;
        lastErr = err;
        if (err.fatal) break;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
    const hint = /HTTP 40[13]|HTTP 410/.test(lastErr.message)
      ? " (the link may have expired: reload the page, play the video, and try again)"
      : "";
    throw new Error(`Failed to fetch ${url.split("?")[0]}: ${lastErr.message}${hint}`);
  }

  async function scratchFile(suffix) {
    const name = `${job.id}-${suffix}`;
    scratch.push(name);
    return createScratch(name);
  }

  // Downloads a track to disk; returns the layout mergeToMp4 needs.
  async function downloadTrack(track, label, progressFrom, progressTo) {
    if (track.encrypted) throw new Error("This stream is encrypted (DRM), which Video Saver does not support.");
    if (!track.segments.length) throw new Error(`The ${label} track has no segments.`);
    checkCancelled();
    const writer = await scratchFile(label);
    const items = track.init ? [track.init, ...track.segments] : track.segments;
    const sizes = new Array(items.length).fill(0);
    let done = 0;
    await orderedDownload(
      items,
      async (seg) => {
        try {
          return await fetchOk(seg);
        } catch (err) {
          if (seg.optional && err.name !== "AbortError") return new ArrayBuffer(0);
          throw err;
        }
      },
      writer,
      {
        concurrency: CONCURRENCY,
        onItem: (i, size) => {
          sizes[i] = size;
          done++;
          say(
            items.length === 1 ? `Downloading ${label}…` : `Downloading ${label}: segment ${done} of ${items.length}`,
            progressFrom + ((progressTo - progressFrom) * done) / items.length
          );
        },
      }
    ).catch(async (err) => {
      await writer.abort();
      throw err;
    });
    await writer.close();
    const initSize = track.init ? sizes[0] : 0;
    let offset = initSize;
    const segs = track.segments.map((s, i) => {
      const size = sizes[track.init ? i + 1 : i];
      const seg = { offset, size, duration: s.duration || 0 };
      offset += size;
      return seg;
    });
    return { file: await writer.file(), segs, initSize, ext: track.ext };
  }

  async function downloadWholeFile(url) {
    await ensureReferer(url);
    const res = await fetch(url, { credentials: "include", signal });
    if (!res.ok) {
      const hint = [401, 403, 410].includes(res.status) ? " (reload the page, play the video, and try again)" : "";
      throw new Error(`Failed to fetch ${url.split("?")[0]}: HTTP ${res.status}${hint}`);
    }
    const total = Number(res.headers.get("content-length")) || 0;
    const writer = await scratchFile("file");
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await writer.append(value);
        countBytes(value.byteLength);
        say(`Downloading… ${mb(writer.size)}${total ? ` of ${mb(total)}` : ""}`, total ? (0.98 * writer.size) / total : undefined);
      }
    } catch (err) {
      await writer.abort();
      throw err;
    }
    await writer.close();
    return writer.file();
  }

  async function save(file, filename) {
    const url = URL.createObjectURL(file);
    try {
      return await saveUrl(url, `${SAVE_FOLDER}/${filename}`);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  try {
    // 1. Embedded players identified from page data (no stream seen yet).
    let { url, kind } = job;
    let ext = null;
    if (!["hls", "dash", "file"].includes(kind)) {
      say("Finding the video stream…", 0);
      const found = await resolveEmbed(job, fetchOk);
      ({ url, kind } = found);
      ext = found.ext || null;
      if (found.label) report({ qualityLabel: found.label });
    }
    const base = safeFilename(job.name);

    // 2. Plain file: stream it to disk and save.
    if (kind === "file") {
      const file = await downloadWholeFile(url);
      say("Saving…", 0.99);
      return await save(file, `${base}.${ext || extFromUrl(url)}`);
    }

    // 3. Stream: read manifest(s) and pick the quality.
    say("Reading manifest…", 0);
    const tracks = kind === "dash" ? await dashTracks(url, job.quality, fetchOk) : await hlsTracks(url, job.quality, fetchOk);
    if (tracks.label) report({ qualityLabel: tracks.label });
    if (tracks.warn) report({ warn: tracks.warn });

    const video = await downloadTrack(tracks.video, tracks.audio ? "video" : "stream", 0, tracks.audio ? 0.6 : 0.85);
    const audio = tracks.audio ? await downloadTrack(tracks.audio, "audio", 0.6, 0.85) : null;

    // 4. Merge on disk, then save.
    checkCancelled();
    const out = await scratchFile("out.mp4");
    try {
      await mergeToMp4({ video, audio }, out, {
        ...(job.chunkBytes ? { chunkBytes: job.chunkBytes } : {}), // tests force small chunks
        signal,
        onStatus: (msg, f) => say(msg, f != null ? 0.85 + 0.14 * f : undefined),
      });
      await out.close();
    } catch (err) {
      await out.abort();
      if (err.name === "AbortError") throw err;
      console.error(err);
      report({ warn: `Couldn't merge into MP4 (${err.message.split("\n")[0]}). Saved the original tracks instead.` });
      const first = await save(video.file, `${base}${audio ? ".video" : ""}.${video.ext}`);
      if (audio) await save(audio.file, `${base}.audio.${audio.ext}`);
      return first;
    }
    say("Saving…", 0.99);
    return await save(await out.file(), `${base}.mp4`);
  } finally {
    if (ruleIds.size && chrome.declarativeNetRequest) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [...ruleIds] }).catch(() => {});
    }
    for (const name of scratch) await removeScratch(name);
  }
}

// --- Manifests → { video, audio, label } ----------------------------------

function pickByQuality(options, quality, bw = (o) => o.bandwidth, h = (o) => o.height) {
  if (!options.length) return null;
  const sorted = [...options].sort((a, b) => (h(b) || 0) - (h(a) || 0) || bw(b) - bw(a));
  if (!quality) return sorted[0];
  if (quality.bandwidth) {
    const exact = sorted.find((o) => bw(o) === quality.bandwidth);
    if (exact) return exact;
  }
  if (quality.height) return sorted.find((o) => (h(o) || 0) <= quality.height) || sorted.at(-1);
  return sorted[0];
}

export const heightOf = (resolution) => Number(String(resolution || "").split("x")[1]) || 0;

async function hlsTracks(url, quality, fetchOk) {
  const top = parsePlaylist(await fetchOk(url, "text"), url);
  let videoUrl = url;
  let audioUrl = null;
  let label = "";
  if (top.kind === "master") {
    const v = pickByQuality(top.variants, quality, (o) => o.bandwidth, (o) => heightOf(o.resolution));
    videoUrl = v.uri;
    audioUrl = audioFor(v, top.audio)?.uri || null;
    label = heightOf(v.resolution) ? `${heightOf(v.resolution)}p` : `${Math.round(v.bandwidth / 1000)} kbps`;
  }
  const media = async (u) => {
    const pl = parsePlaylist(await fetchOk(u, "text"), u);
    if (pl.kind !== "media") throw new Error("Expected an HLS media playlist.");
    return { init: pl.init, segments: pl.segments, encrypted: pl.encrypted, ext: pl.init ? "mp4" : "ts" };
  };
  return { video: await media(videoUrl), audio: audioUrl ? await media(audioUrl) : null, label };
}

async function dashTracks(url, quality, fetchOk) {
  const mpd = parseMpd(await fetchOk(url, "text"), url, quality);
  return {
    video: mpd.video || mpd.audio,
    audio: mpd.video ? mpd.audio : null,
    label: mpd.height ? `${mpd.height}p` : "",
    warn: mpd.multiPeriod ? "This stream has several parts (periods); only the first was saved." : "",
  };
}

// --- helpers ----------------------------------------------------------------

export function ruleIdFor(jobId) {
  let h = 0;
  for (const c of String(jobId)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return 10000 + (Math.abs(h) % 1000000);
}

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

function saveUrl(url, filename) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download({ url, filename, saveAs: false, conflictAction: "uniquify" }, (id) => {
      if (chrome.runtime.lastError || id == null) {
        reject(new Error(`Download failed: ${chrome.runtime.lastError?.message || "unknown error"}`));
        return;
      }
      const listener = (delta) => {
        if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
          chrome.downloads.onChanged.removeListener(listener);
          if (delta.state.current === "complete") resolve({ downloadId: id, filename });
          else reject(new Error("Saving was cancelled."));
        }
      };
      chrome.downloads.onChanged.addListener(listener);
    });
  });
}
