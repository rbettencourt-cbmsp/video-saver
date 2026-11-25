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

  // The JSON text of the object in `json` whose id is `id` (without its child lessons), or null.
  function findById(json, id) {
    let data;
    try {
      data = JSON.parse(json);
    } catch {
      return null;
    }
    const stack = [data];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (!Array.isArray(node) && node.id === id) {
        // Keep the lesson's own fields; drop nested lists (sub-lessons, comments).
        const own = {};
        for (const [k, v] of Object.entries(node)) if (!Array.isArray(v)) own[k] = v;
        return JSON.stringify(own);
      }
      for (const v of Array.isArray(node) ? node : Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
    return null;
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

    // 3. Page data (Next.js and similar), e.g. lesson video links on course sites.
    // Course pages (Skool) keep every lesson's video link here, not just the open one,
    // so: use only the current lesson's entry when the URL names it, and otherwise
    // only fall back to page data when the page shows no player of its own.
    const playerOnPage = hits.length > 0 || found.length > 0;
    const pageHits = [];
    const lessonId = new URL(here).searchParams.get("md");
    for (const s of document.querySelectorAll("script#__NEXT_DATA__, script[type='application/json'], script[type='application/ld+json']")) {
      if (s.textContent.length >= 5_000_000) continue;
      const lesson = lessonId && findById(s.textContent, lessonId);
      if (lesson) fromText(lesson, pageHits);
      else if (!lessonId && !playerOnPage) fromText(s.textContent, pageHits);
    }
    hits.push(...pageHits);

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
