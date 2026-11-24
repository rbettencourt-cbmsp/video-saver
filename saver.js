// Downloads an HLS stream segment by segment and joins it into one file.
// Plain-TS streams become a .ts file; fMP4 streams (with an init segment) become .mp4.
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "text" ? await res.text() : await res.arrayBuffer();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`Failed to fetch ${url}: ${lastErr.message}`);
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

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, (id) => {
    if (chrome.runtime.lastError) {
      setStatus(`Download failed: ${chrome.runtime.lastError.message}`, "error");
      return;
    }
    const listener = (delta) => {
      if (delta.id === id && delta.state && delta.state.current !== "in_progress") {
        chrome.downloads.onChanged.removeListener(listener);
        URL.revokeObjectURL(url);
        setStatus(delta.state.current === "complete" ? "Saved. You can close this tab." : "Download was cancelled.");
      }
    };
    chrome.downloads.onChanged.addListener(listener);
  });
}

async function run() {
  if (!srcUrl) throw new Error("No stream URL given.");
  $("src").textContent = srcUrl;
  $("title").textContent = `Saving: ${baseName}`;

  setStatus("Reading playlist…");
  let playlistUrl = srcUrl;
  let pl = parsePlaylist(await fetchOk(playlistUrl, "text"), playlistUrl);

  if (pl.kind === "master") {
    const v = bestVariant(pl.variants);
    if (v.audioGroup && pl.audio.some((a) => a.group === v.audioGroup)) {
      $("warn").textContent =
        "This stream keeps audio in a separate track. The saved file may have no sound.";
    }
    playlistUrl = v.uri;
    setStatus(`Picked quality ${v.resolution || v.bandwidth + " bps"}…`);
    pl = parsePlaylist(await fetchOk(playlistUrl, "text"), playlistUrl);
  }

  if (pl.encrypted) throw new Error("This stream is encrypted, which Video Saver does not support.");
  if (pl.byteRange) throw new Error("Byte-range HLS streams are not supported yet.");
  if (!pl.segments.length) throw new Error("The playlist has no segments.");

  const urls = pl.init ? [pl.init, ...pl.segments] : pl.segments;
  const bar = $("bar");
  bar.max = urls.length;
  let bytes = 0;
  const parts = await downloadAll(urls, (done, total) => {
    bar.value = done;
    setStatus(`Downloading segment ${done} of ${total}…`);
  });
  for (const p of parts) bytes += p.byteLength;

  const ext = pl.init ? "mp4" : "ts";
  const type = pl.init ? "video/mp4" : "video/mp2t";
  setStatus(`Joining ${(bytes / 1048576).toFixed(1)} MB…`);
  saveBlob(new Blob(parts, { type }), `${baseName}.${ext}`);
  setStatus("Choose where to save the file…");
}

run().catch((err) => setStatus(err.message, "error"));
