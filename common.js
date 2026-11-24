// Shared helpers for popup and saver pages.

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

if (typeof module !== "undefined") module.exports = { safeFilename, extFromUrl };
