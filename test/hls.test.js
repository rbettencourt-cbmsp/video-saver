const test = require("node:test");
const assert = require("node:assert");
const { parsePlaylist, bestVariant, audioFor, parseByteRange } = require("../hls.js");
const { safeFilename, extFromUrl, resolveUrl, stripRangeParams, mediaKind } = require("../common.js");

const urls = (segs) => segs.map((s) => s.url);

test("parses a master playlist and picks the best variant", () => {
  const txt = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="en",URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360
low/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,AUDIO="aud"
high/index.m3u8`;
  const pl = parsePlaylist(txt, "https://cdn.example.com/v/master.m3u8");
  assert.equal(pl.kind, "master");
  assert.equal(pl.variants.length, 2);
  const best = bestVariant(pl.variants);
  assert.equal(best.uri, "https://cdn.example.com/v/high/index.m3u8");
  assert.equal(best.audioGroup, "aud");
  assert.equal(pl.audio[0].uri, "https://cdn.example.com/v/audio/en.m3u8");
});

test("parses a TS media playlist", () => {
  const txt = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXTINF:6.0,
seg0.ts
#EXTINF:6.0,
https://other.example.com/seg1.ts?token=a,b
#EXT-X-ENDLIST`;
  const pl = parsePlaylist(txt, "https://cdn.example.com/v/high/index.m3u8");
  assert.equal(pl.kind, "media");
  assert.deepEqual(urls(pl.segments), [
    "https://cdn.example.com/v/high/seg0.ts",
    "https://other.example.com/seg1.ts?token=a,b",
  ]);
  assert.equal(pl.segments[0].start, undefined);
  assert.equal(pl.init, null);
  assert.equal(pl.encrypted, false);
});

test("detects fMP4 init and encryption", () => {
  const txt = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXT-X-KEY:METHOD=AES-128,URI="key.bin"
#EXTINF:4,
s1.m4s`;
  const pl = parsePlaylist(txt, "https://x.example/a/b.m3u8");
  assert.deepEqual(pl.init, { url: "https://x.example/a/init.mp4" });
  assert.equal(pl.encrypted, true);
});

test("METHOD=NONE is not encrypted", () => {
  const pl = parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts", "https://x.example/p.m3u8");
  assert.equal(pl.encrypted, false);
});

test("rejects non-playlists", () => {
  assert.throws(() => parsePlaylist("<html>", "https://x.example/"), /Not an HLS playlist/);
});

test("byte-range segments: explicit and implied offsets, ranged init", () => {
  const txt = `#EXTM3U
#EXT-X-MAP:URI="main.mp4",BYTERANGE="720@0"
#EXTINF:4,
#EXT-X-BYTERANGE:1000@720
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:500
main.mp4
#EXTINF:4,
#EXT-X-BYTERANGE:300
main.mp4`;
  const pl = parsePlaylist(txt, "https://x.example/v/p.m3u8?sig=1");
  assert.deepEqual(pl.init, { url: "https://x.example/v/main.mp4?sig=1", start: 0, end: 719 });
  assert.deepEqual(
    pl.segments.map((s) => [s.start, s.end]),
    [[720, 1719], [1720, 2219], [2220, 2519]]
  );
  assert.ok(pl.segments.every((s) => s.url === "https://x.example/v/main.mp4?sig=1"));
});

test("parseByteRange", () => {
  assert.deepEqual(parseByteRange("10@5"), { length: 10, offset: 5 });
  assert.deepEqual(parseByteRange("10"), { length: 10, offset: null });
  assert.throws(() => parseByteRange("x"));
});

test("segments inherit the playlist's signed query when they have none", () => {
  const txt = `#EXTM3U
#EXTINF:4,
media-clip0-video-0.ts
#EXTINF:4,
own.ts?sig=x
#EXTINF:4,
https://elsewhere.example/c.ts`;
  const pl = parsePlaylist(txt, "https://cdn.example.com/hls/mediaplaylist-video.m3u8?Policy=p&Signature=s&Key-Pair-Id=k");
  assert.deepEqual(urls(pl.segments), [
    "https://cdn.example.com/hls/media-clip0-video-0.ts?Policy=p&Signature=s&Key-Pair-Id=k",
    "https://cdn.example.com/hls/own.ts?sig=x",
    "https://elsewhere.example/c.ts",
  ]);
});

test("audioFor picks the default rendition of the variant's group", () => {
  const txt = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="alt",URI="alt.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="main",DEFAULT=YES,URI="main.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=3200000,AUDIO="a"
mediaplaylist-video.m3u8`;
  const pl = parsePlaylist(txt, "https://cdn.example.com/hls/playlist.m3u8?sig=1");
  const a = audioFor(bestVariant(pl.variants), pl.audio);
  assert.equal(a.uri, "https://cdn.example.com/hls/main.m3u8?sig=1");
  assert.equal(audioFor({ audioGroup: null }, pl.audio), null);
});

test("filename helpers", () => {
  assert.equal(safeFilename('Lesson 1: Intro / "Basics"?'), "Lesson 1 Intro Basics");
  assert.equal(safeFilename("..."), "video");
  assert.equal(extFromUrl("https://a.example/v/clip.WEBM?x=1"), "webm");
  assert.equal(extFromUrl("https://a.example/v/stream"), "mp4");
});

test("resolveUrl only inherits the query on the same origin", () => {
  assert.equal(resolveUrl("a.ts", "https://x.example/p/m.m3u8?s=1"), "https://x.example/p/a.ts?s=1");
  assert.equal(resolveUrl("https://y.example/a.ts", "https://x.example/m.m3u8?s=1"), "https://y.example/a.ts");
});

test("stripRangeParams removes Facebook-style byte slices only", () => {
  assert.equal(
    stripRangeParams("https://video.fbcdn.example/v.mp4?_nc=1&bytestart=0&byteend=999&oh=abc"),
    "https://video.fbcdn.example/v.mp4?_nc=1&oh=abc"
  );
  const plain = "https://x.example/v.mp4?token=1";
  assert.equal(stripRangeParams(plain), plain);
});

test("mediaKind uses extension or content type", () => {
  assert.equal(mediaKind("https://x.example/a/master.m3u8?x"), "hls");
  assert.equal(mediaKind("https://x.example/a/manifest.mpd"), "dash");
  assert.equal(mediaKind("https://x.example/a/clip.MP4"), "file");
  assert.equal(mediaKind("https://x.example/manifest", "application/vnd.apple.mpegurl; charset=utf-8"), "hls");
  assert.equal(mediaKind("https://x.example/manifest", "application/dash+xml"), "dash");
  assert.equal(mediaKind("https://x.example/page.html", "text/html"), null);
});
