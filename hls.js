// Minimal HLS playlist parser (RFC 8216 subset). No dependencies.
// Segments are { url, start?, end? } where start/end are inclusive byte offsets
// (present only for #EXT-X-BYTERANGE streams).

const hlsResolve = typeof resolveUrl === "function" ? resolveUrl : require("./common.js").resolveUrl;

function parseAttributes(str) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    attrs[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  }
  return attrs;
}

// "<length>[@<offset>]" -> { length, offset|null }
function parseByteRange(str) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(str).trim());
  if (!m) throw new Error(`Bad BYTERANGE "${str}"`);
  return { length: Number(m[1]), offset: m[2] != null ? Number(m[2]) : null };
}

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== "#EXTM3U") throw new Error("Not an HLS playlist");

  const abs = (u) => hlsResolve(u, baseUrl);
  const variants = [];
  const audio = [];
  const segments = [];
  let init = null;
  let encrypted = false;
  let pendingVariant = null;
  let pendingRange = null;
  const lastEnd = new Map(); // url -> next offset, for ranges without "@offset"

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
      if (a.TYPE === "AUDIO" && a.URI) {
        audio.push({ group: a["GROUP-ID"], name: a.NAME, isDefault: a.DEFAULT === "YES", uri: abs(a.URI) });
      }
    } else if (line.startsWith("#EXT-X-KEY:")) {
      const a = parseAttributes(line.slice(11));
      if (a.METHOD && a.METHOD !== "NONE") encrypted = true;
    } else if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttributes(line.slice(11));
      if (a.URI) {
        init = { url: abs(a.URI) };
        if (a.BYTERANGE) {
          const r = parseByteRange(a.BYTERANGE);
          const start = r.offset ?? 0;
          Object.assign(init, { start, end: start + r.length - 1 });
        }
      }
    } else if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17));
    } else if (!line.startsWith("#")) {
      if (pendingVariant) {
        variants.push({ ...pendingVariant, uri: abs(line) });
        pendingVariant = null;
        continue;
      }
      const seg = { url: abs(line) };
      if (pendingRange) {
        const start = pendingRange.offset ?? lastEnd.get(seg.url) ?? 0;
        seg.start = start;
        seg.end = start + pendingRange.length - 1;
        lastEnd.set(seg.url, seg.end + 1);
        pendingRange = null;
      }
      segments.push(seg);
    }
  }

  if (variants.length) return { kind: "master", variants, audio };
  return { kind: "media", segments, init, encrypted };
}

function bestVariant(variants) {
  return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

function audioFor(variant, audio) {
  if (!variant.audioGroup) return null;
  const group = audio.filter((a) => a.group === variant.audioGroup);
  return group.find((a) => a.isDefault) || group[0] || null;
}

if (typeof module !== "undefined") {
  module.exports = { parsePlaylist, parseAttributes, parseByteRange, bestVariant, audioFor };
}
