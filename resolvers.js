// Turns embedded players found in page markup into stream URLs, so a video can be
// saved without playing it first. Pure functions over an injected `fetchOk(url, as, init?)`.
//
// Embed descriptors (from detect.js): { kind: "wistia"|"vimeo"|"loom", embedId, hash? }

export const EMBED_KINDS = ["wistia", "vimeo", "loom"];

export async function resolveEmbed(job, fetchOk) {
  switch (job.kind) {
    case "wistia":
      return resolveWistia(job.embedId, fetchOk, job.quality);
    case "vimeo":
      return resolveVimeo(job.embedId, job.hash, fetchOk);
    case "loom":
      return resolveLoom(job.embedId, fetchOk);
    default:
      throw new Error(`Unknown video type "${job.kind}".`);
  }
}

// Wistia's media JSON lists a plain MP4 for every quality.
export async function wistiaQualities(id, fetchOk) {
  const data = await fetchOk(`https://fast.wistia.com/embed/medias/${encodeURIComponent(id)}.json`, "json");
  const assets = (data?.media?.assets || []).filter(
    (a) => a.url && /video/.test(a.type || "") && (a.container === "mp4" || a.ext === "mp4")
  );
  if (!assets.length) {
    throw new Error("Wistia didn't share this video (it may be private). Play it on the page, then use the stream that appears.");
  }
  return assets
    .map((a) => ({ url: a.url, height: a.height || parseInt(a.display_name, 10) || 0, width: a.width || 0, bandwidth: a.bitrate ? a.bitrate * 1000 : 0 }))
    .sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
}

async function resolveWistia(id, fetchOk, quality) {
  const list = await wistiaQualities(id, fetchOk);
  const pick = (quality?.height && list.find((q) => q.height <= quality.height)) || list[0];
  return { url: pick.url, kind: "file", ext: "mp4", label: pick.height ? `${pick.height}p` : "" };
}

async function resolveVimeo(id, hash, fetchOk) {
  const q = hash ? `?h=${encodeURIComponent(hash)}` : "";
  let config;
  try {
    config = await fetchOk(`https://player.vimeo.com/video/${encodeURIComponent(id)}/config${q}`, "json");
  } catch (err) {
    throw new Error(`Vimeo didn't share this video's details (${err.message}). Play it on the page, then use the stream that appears.`);
  }
  const files = config?.request?.files || {};
  const pickCdn = (f) => f?.cdns?.[f.default_cdn]?.url || Object.values(f?.cdns || {})[0]?.url;
  const hls = pickCdn(files.hls);
  if (hls) return { url: hls, kind: "hls" };
  const progressive = [...(files.progressive || [])].sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  if (progressive?.url) return { url: progressive.url, kind: "file" };
  throw new Error("Vimeo returned no downloadable stream for this video.");
}

async function resolveLoom(id, fetchOk) {
  const post = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };
  for (const endpoint of ["transcoded-url", "raw-url"]) {
    try {
      const data = await fetchOk(`https://www.loom.com/api/campaigns/sessions/${encodeURIComponent(id)}/${endpoint}`, "json", post);
      if (data?.url) {
        // Loom answers with an HLS playlist, a DASH manifest or a plain MP4.
        const path = new URL(data.url).pathname;
        const kind = /\.m3u8$/i.test(path) ? "hls" : /\.mpd$/i.test(path) ? "dash" : "file";
        return { url: data.url, kind };
      }
    } catch {}
  }
  throw new Error("Loom didn't return a stream for this video. Play it on the page, then use the stream that appears.");
}
