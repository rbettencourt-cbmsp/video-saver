// Minimal HLS playlist parser (RFC 8216 subset). No dependencies.

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Not an HLS playlist");

  const abs = (u) => new URL(u, baseUrl).href;
  const variants = [];
  const audio = [];
  const segments = [];
  let init = null;
  let encrypted = false;
  let byteRange = false;
  let pendingVariant = null;

  for (const line of lines) {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttributes(line.slice(18));
      pendingVariant = {
        bandwidth: Number(a.BANDWIDTH) || 0,
        resolution: a.RESOLUTION || "",
        audioGroup: a.AUDIO || null,
      };
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttributes(line.slice(13));
      if (a.TYPE === "AUDIO" && a.URI) audio.push({ group: a["GROUP-ID"], name: a.NAME, uri: abs(a.URI) });
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(11));
      if (a.METHOD && a.METHOD !== "NONE") encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) init = abs(a.URI);
      if (a.BYTERANGE) byteRange = true;
    } else if (line.startsWith("#EXT-X-BYTERANGE")) {
      byteRange = true;
    } else if (!line.startsWith("#")) {
      if (pendingVariant) {
        variants.push({ ...pendingVariant, uri: abs(line) });
        pendingVariant = null;
      } else {
        segments.push(abs(line));
      }
    }
  }

  if (variants.length) return { kind: "master", variants, audio };
  return { kind: "media", segments, init, encrypted, byteRange };
}

function bestVariant(variants) {
  return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

if (typeof module !== "undefined") module.exports = { parsePlaylist, parseAttributes, bestVariant };
