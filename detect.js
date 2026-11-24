// Content script (every frame): finds videos from page markup and page data, without
// waiting for playback. The popup and the page button call globalThis.videoSaverDetect().
//
// Returns items like:
//   { type: "file"|"hls"|"dash", url, referrer, inFrame }           plain <video> sources
//   { type: "embed", kind: "wistia"|"vimeo"|"loom", embedId, hash?, referrer, inFrame }
//   { type: "youtube", embedId, referrer, inFrame }                   (shown as unsupported)

(() => {
  const PATTERNS = [
    // Wistia: iframe/player URLs and media JSON/JSONP URLs
    { kind: "wistia", re: /(?:fast\.wistia\.(?:net|com)|[\w-]+\.wistia\.com)\/embed\/(?:iframe|medias)\/([a-z0-9]{10})/gi },
    // Vimeo: player.vimeo.com/video/<id>?h=<hash>, vimeo.com/<id>/<hash>
    { kind: "vimeo", re: /player\.vimeo\.com\/video\/(\d+)(?:[^"'\s<>]*?[?&](?:amp;)?h=([0-9a-f]+))?/gi },
    { kind: "vimeo", re: /(?<![\w.])vimeo\.com\/(\d{6,})(?:\/([0-9a-f]{6,}))?/gi },
    // Loom: share and embed links
    { kind: "loom", re: /loom\.com\/(?:share|embed)\/([0-9a-f]{32})/gi },
    // YouTube (reported so the popup can say it isn't supported)
    { kind: "youtube", re: /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=)|youtu\.be\/)([\w-]{11})/gi },
  ];

  function fromText(text, out) {
    if (!text) return;
    // JSON page data escapes slashes ("https:\/\/..."); undo that first.
    const t = text.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(t))) out.push({ kind, embedId: m[1], hash: m[2] || undefined });
    }
  }

  function detect() {
    const found = [];
    const here = location.href;
    const inFrame = window !== top;

    // 1. <video> elements with real (non-blob) sources
    for (const v of document.querySelectorAll("video")) {
      const srcs = new Set([v.currentSrc, v.src, ...[...v.querySelectorAll("source")].map((s) => s.src)]);
      for (const s of srcs) {
        if (s && /^https?:/i.test(s)) found.push({ type: "url", url: s, referrer: here, inFrame });
      }
    }

    // 2. Embedded players: iframe URLs, Wistia's class/element forms, links
    const hits = [];
    for (const f of document.querySelectorAll("iframe[src]")) fromText(f.src, hits);
    for (const el of document.querySelectorAll("[class*='wistia_async_']")) {
      const m = /wistia_async_([a-z0-9]{10})/.exec(el.className);
      if (m) hits.push({ kind: "wistia", embedId: m[1] });
    }
    for (const el of document.querySelectorAll("wistia-player[media-id]")) {
      hits.push({ kind: "wistia", embedId: el.getAttribute("media-id") });
    }
    for (const a of document.querySelectorAll("a[href*='loom.com/share/'], a[href*='vimeo.com/']")) fromText(a.href, hits);

    // 3. Page data (Next.js and similar), e.g. lesson video links on course sites
    for (const s of document.querySelectorAll("script#__NEXT_DATA__, script[type='application/json'], script[type='application/ld+json']")) {
      if (s.textContent.length < 5_000_000) fromText(s.textContent, hits);
    }

    // The player page itself (we're inside the player iframe)
    fromText(here, hits);

    const seen = new Set();
    for (const h of hits) {
      const id = `${h.kind}:${h.embedId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (h.kind === "youtube") found.push({ type: "youtube", embedId: h.embedId, referrer: here, inFrame });
      else found.push({ type: "embed", kind: h.kind, embedId: h.embedId, hash: h.hash, referrer: here, inFrame });
    }
    return found;
  }

  globalThis.videoSaverDetect = detect;
})();
