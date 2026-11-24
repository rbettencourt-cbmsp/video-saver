// Minimal MPEG-DASH (.mpd) parser for static, unencrypted manifests.
// Produces the same track shape as hls.js: { init, segments: [{url,start?,end?}], encrypted, ext }.
// Uses the browser's DOMParser (saver/popup pages); pass a Document to parseMpdDoc in tests.

const dashResolve = typeof resolveUrl === "function" ? resolveUrl : require("./common.js").resolveUrl;

function parseIsoDuration(str) {
  if (!str) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(str.trim());
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(s);
}

const kids = (el, name) => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el, name) => kids(el, name)[0] || null;
const num = (v, d = null) => (v == null || v === "" ? d : Number(v));

// "$RepresentationID$", "$Number%05d$", "$Time$", "$Bandwidth$", "$$"
function fillTemplate(tpl, vars) {
  return tpl.replace(/\$(RepresentationID|Number|Time|Bandwidth|)(?:%0(\d+)d)?\$/g, (_, name, width) => {
    if (name === "") return "$";
    const v = String(vars[name] ?? "");
    return width ? v.padStart(Number(width), "0") : v;
  });
}

function parseRange(str) {
  const m = /^(\d+)-(\d+)$/.exec(String(str || "").trim());
  return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
}

// Merges attributes and SegmentTimeline of the same element type across levels
// (Period -> AdaptationSet -> Representation; later levels win).
function mergeLevels(levels, name) {
  const found = levels.map((l) => kid(l, name)).filter(Boolean);
  if (!found.length) return null;
  const attrs = {};
  let timeline = null;
  let initEl = null;
  let urls = null;
  for (const el of found) {
    for (const a of el.attributes) attrs[a.name] = a.value;
    timeline = kid(el, "SegmentTimeline") || timeline;
    initEl = kid(el, "Initialization") || initEl;
    const segUrls = kids(el, "SegmentURL");
    if (segUrls.length) urls = segUrls;
  }
  return { attrs, timeline, initEl, urls };
}

function baseUrlFor(levels, manifestUrl) {
  let base = manifestUrl;
  for (const l of levels) {
    const b = kid(l, "BaseURL");
    if (b && b.textContent.trim()) base = dashResolve(b.textContent.trim(), base);
  }
  return base;
}

function buildTrack(levels, rep, periodSeconds, manifestUrl) {
  const base = baseUrlFor(levels, manifestUrl);
  const abs = (u) => dashResolve(u, base);
  const mime = rep.getAttribute("mimeType") || levels[2].getAttribute("mimeType") || "";
  const ext = /webm/i.test(mime) ? "webm" : "mp4";
  const encrypted = levels.some((l) => kids(l, "ContentProtection").length > 0);
  const vars = { RepresentationID: rep.getAttribute("id") || "", Bandwidth: rep.getAttribute("bandwidth") || "" };

  const tpl = mergeLevels(levels, "SegmentTemplate");
  if (tpl) {
    const a = tpl.attrs;
    const timescale = num(a.timescale, 1);
    let number = num(a.startNumber, 1);
    const init = a.initialization ? { url: abs(fillTemplate(a.initialization, vars)) } : null;
    const segments = [];
    if (!a.media) throw new Error("DASH SegmentTemplate has no media attribute.");
    if (tpl.timeline) {
      let time = 0;
      const ss = kids(tpl.timeline, "S");
      ss.forEach((s, i) => {
        time = num(s.getAttribute("t"), time);
        const d = num(s.getAttribute("d"));
        let r = num(s.getAttribute("r"), 0);
        if (r < 0) {
          const next = ss[i + 1] ? num(ss[i + 1].getAttribute("t")) : null;
          const endTime = next ?? Math.round(periodSeconds * timescale);
          r = Math.ceil((endTime - time) / d) - 1;
        }
        for (let k = 0; k <= r; k++) {
          segments.push({ url: abs(fillTemplate(a.media, { ...vars, Number: number++, Time: time })) });
          time += d;
        }
      });
    } else {
      const dur = num(a.duration);
      if (!dur || !periodSeconds) throw new Error("DASH template has no timeline or duration.");
      const count = Math.ceil((periodSeconds * timescale) / dur - 1e-9);
      for (let k = 0; k < count; k++) {
        segments.push({ url: abs(fillTemplate(a.media, { ...vars, Number: number, Time: (number - num(a.startNumber, 1)) * dur })) });
        number++;
      }
      // Durations are often rounded down; try one more segment and skip it if missing.
      segments.push({ url: abs(fillTemplate(a.media, { ...vars, Number: number, Time: (number - num(a.startNumber, 1)) * dur })), optional: true });
    }
    return { init, segments, encrypted, ext };
  }

  const list = mergeLevels(levels, "SegmentList");
  if (list && list.urls) {
    let init = null;
    if (list.initEl) {
      init = { url: abs(list.initEl.getAttribute("sourceURL") || base), ...parseRange(list.initEl.getAttribute("range")) };
    }
    const segments = list.urls.map((u) => ({
      url: abs(u.getAttribute("media") || base),
      ...parseRange(u.getAttribute("mediaRange")),
    }));
    return { init, segments, encrypted, ext };
  }

  // SegmentBase or nothing: the representation is one self-contained file.
  return { init: null, segments: [{ url: base }], encrypted, ext };
}

function repKind(adaptation, rep) {
  const ct = adaptation.getAttribute("contentType") || "";
  const mime = rep.getAttribute("mimeType") || adaptation.getAttribute("mimeType") || "";
  const t = (ct || mime.split("/")[0]).toLowerCase();
  if (t === "video" || t === "audio") return t;
  const codecs = rep.getAttribute("codecs") || adaptation.getAttribute("codecs") || "";
  if (/^(avc|hev|hvc|vp0?[89]|av01)/i.test(codecs)) return "video";
  if (/^(mp4a|opus|ac-3|ec-3|vorbis|flac)/i.test(codecs)) return "audio";
  return null;
}

function parseMpdDoc(doc, manifestUrl) {
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== "MPD") throw new Error("Not a DASH manifest");
  if (mpd.getAttribute("type") === "dynamic") throw new Error("Live DASH streams are not supported.");

  const periods = kids(mpd, "Period");
  if (!periods.length) throw new Error("DASH manifest has no Period.");
  const period = periods[0];
  const periodSeconds =
    parseIsoDuration(period.getAttribute("duration")) ?? parseIsoDuration(mpd.getAttribute("mediaPresentationDuration"));

  const best = { video: null, audio: null };
  for (const as of kids(period, "AdaptationSet")) {
    for (const rep of kids(as, "Representation")) {
      const kind = repKind(as, rep);
      if (!kind) continue;
      const score = num(rep.getAttribute("bandwidth"), 0) + num(rep.getAttribute("height"), 0) * 1e9;
      if (!best[kind] || score > best[kind].score) best[kind] = { as, rep, score };
    }
  }
  if (!best.video && !best.audio) throw new Error("DASH manifest has no audio or video.");

  const track = (b) => b && buildTrack([mpd, period, b.as, b.rep], b.rep, periodSeconds, manifestUrl);
  const info = best.video
    ? [best.video.rep.getAttribute("width"), best.video.rep.getAttribute("height")].filter(Boolean).join("x")
    : "";
  return { video: track(best.video), audio: track(best.audio), resolution: info, multiPeriod: periods.length > 1 };
}

function parseMpd(text, manifestUrl) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("DASH manifest is not valid XML.");
  return parseMpdDoc(doc, manifestUrl);
}

if (typeof module !== "undefined") module.exports = { parseMpd, parseMpdDoc, parseIsoDuration, fillTemplate };
