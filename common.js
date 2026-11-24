// Shared helpers for background, popup and saver pages. No dependencies.

function safeFilename(name, fallback = "video") {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 100);
  return cleaned || fallback;
}

function extFromUrl(url, fallback = "mp4") {
  try {
    const m = new URL(url).pathname.match(/\.([a-z0-9]{2,4})$/i);
    return m ? m[1].toLowerCase() : fallback;
  } catch {
    return fallback;
  }
}

// Resolves a manifest-relative URL. Signed-URL CDNs (e.g. CloudFront) put the
// signature on the manifest URL and expect players to reuse it for same-origin
// resources listed without their own query string.
function resolveUrl(ref, baseUrl) {
  const base = new URL(baseUrl);
  const url = new URL(ref, base);
  if (!url.search && base.search && url.origin === base.origin) url.search = base.search;
  return url.href;
}

// Query params some CDNs use to request just a slice of a file (Facebook/Instagram
// use bytestart/byteend). Removing them gets the whole file.
const RANGE_PARAMS = ["bytestart", "byteend", "range", "byterange"];

function stripRangeParams(url) {
  try {
    const u = new URL(url);
    let changed = false;
    for (const p of RANGE_PARAMS) {
      if (u.searchParams.has(p)) {
        u.searchParams.delete(p);
        changed = true;
      }
    }
    return changed ? u.href : url;
  } catch {
    return url;
  }
}

const MANIFEST_TYPES = {
  "application/vnd.apple.mpegurl": "hls",
  "application/x-mpegurl": "hls",
  "audio/mpegurl": "hls",
  "audio/x-mpegurl": "hls",
  "application/dash+xml": "dash",
};

// Classifies a URL (and optional Content-Type) as "hls", "dash", "file" or null.
function mediaKind(url, contentType = "") {
  const ct = String(contentType).split(";")[0].trim().toLowerCase();
  if (MANIFEST_TYPES[ct]) return MANIFEST_TYPES[ct];
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  if (/\.m3u8$/i.test(path)) return "hls";
  if (/\.mpd$/i.test(path)) return "dash";
  if (/\.(mp4|webm|mov|m4v)$/i.test(path)) return "file";
  return null;
}

if (typeof module !== "undefined") {
  module.exports = { safeFilename, extFromUrl, resolveUrl, stripRangeParams, mediaKind };
}
