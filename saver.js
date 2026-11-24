// Downloads an HLS stream segment by segment and joins it into one file.
// Plain-TS streams become .ts; fMP4 streams (with an init segment) become .mp4.
// If audio is a separate track, it is saved as a second file alongside the video.
// Encrypted/DRM streams are deliberately not supported.

const params = new URLSearchParams(location.search);
const srcUrl = params.get("url");
const baseName = safeFilename(params.get("name"));

const $ = (id) => document.getElementById(id);
const setStatus = (text, cls = "") => {
  $("status").textContent = text;
  $("status").className = cls;
};

const CONCURRENCY = 4;
const RETRIES = 3;

async function fetchOk(url, as) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        if (res.status === 403 || res.status === 404) throw Object.assign(err, { fatal: true });
        throw err;
      }
      return as === "text" ? await res.text() : await res.arrayBuffer();
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const short = url.split("?")[0];
  const hint = lastErr.message === "HTTP 403" ? " (the link may have expired: reload the page and try again)" : "";
  throw new Error(`Failed to fetch ${short}: ${lastErr.message}${hint}`);
}

async function downloadAll(urls, onProgress) {
  const parts = new Array(urls.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      parts[i] = await fetchOk(urls[i]);
      onProgress(++done, urls.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
  return parts;
}

// Fetches one media playlist and all its segments; returns a Blob plus its extension.
async function fetchTrack(playlistUrl, label) {
  setStatus(`Reading ${label} playlist…`);
  const pl = parsePlaylist(await fetchOk(playlistUrl, "text"), playlistUrl);
  if (pl.kind !== "media") throw new Error(`Expected a ${label} media playlist.`);
  if (pl.encrypted) throw new Error("This stream is encrypted, which Video Saver does not support.");
  if (pl.byteRange) throw new Error("Byte-range HLS streams are not supported yet.");
  if (!pl.segments.length) throw new Error(`The ${label} playlist has no segments.`);

  const urls = pl.init ? [pl.init, ...pl.segments] : pl.segments;
  const bar = $("bar");
  bar.value = 0;
  bar.max = urls.length;
  const parts = await downloadAll(urls, (done, total) => {
    bar.value = done;
    setStatus(`Downloading ${label}: segment ${done} of ${total}…`);
  });
  const ext = pl.init ? "mp4" : "ts";
  const type = pl.init ? "video/mp4" : "video/mp2t";
  return { blob: new Blob(parts, { type }), ext };
}

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

const mb = (blob) => `${(blob.size / 1048576).toFixed(1)} MB`;

async function run() {
  if (!srcUrl) throw new Error("No stream URL given.");
  $("src").textContent = srcUrl.split("?")[0];
  $("title").textContent = `Saving: ${baseName}`;

  setStatus("Reading playlist…");
  const top = parsePlaylist(await fetchOk(srcUrl, "text"), srcUrl);

  let videoUrl = srcUrl;
  let audioUrl = null;
  if (top.kind === "master") {
    const v = bestVariant(top.variants);
    videoUrl = v.uri;
    audioUrl = audioFor(v, top.audio)?.uri || null;
    $("title").textContent = `Saving: ${baseName} (${v.resolution || Math.round(v.bandwidth / 1000) + " kbps"})`;
  }

  const video = await fetchTrack(videoUrl, "video");
  const audio = audioUrl ? await fetchTrack(audioUrl, "audio") : null;

  if (!audio) {
    setStatus(`Choose where to save the file (${mb(video.blob)})…`);
    await saveBlob(video.blob, `${baseName}.${video.ext}`);
    setStatus("Saved. You can close this tab.");
    return;
  }

  const vName = `${baseName}.video.${video.ext}`;
  const aName = `${baseName}.audio.${audio.ext}`;
  setStatus(`Choose where to save the video track (${mb(video.blob)})…`);
  await saveBlob(video.blob, vName);
  setStatus(`Choose where to save the audio track (${mb(audio.blob)})…`);
  await saveBlob(audio.blob, aName);
  setStatus("Saved video and audio as two files. You can close this tab.");
  $("warn").textContent =
    "This stream keeps audio separate. To merge them into one MP4, run in the folder you saved to:";
  const cmd = document.createElement("pre");
  cmd.textContent = `ffmpeg -i "${vName}" -i "${aName}" -c copy "${baseName}.mp4"`;
  $("warn").after(cmd);
}

run().catch((err) => setStatus(err.message, "error"));
