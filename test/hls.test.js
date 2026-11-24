const test = require("node:test");
const assert = require("node:assert");
const { parsePlaylist, bestVariant } = require("../hls.js");
const { safeFilename, extFromUrl } = require("../common.js");

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
  assert.deepEqual(pl.segments, [
    "https://cdn.example.com/v/high/seg0.ts",
    "https://other.example.com/seg1.ts?token=a,b",
  ]);
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
  assert.equal(pl.init, "https://x.example/a/init.mp4");
  assert.equal(pl.encrypted, true);
});

test("METHOD=NONE is not encrypted", () => {
  const pl = parsePlaylist("#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXTINF:4,\na.ts", "https://x.example/p.m3u8");
  assert.equal(pl.encrypted, false);
});

test("rejects non-playlists", () => {
  assert.throws(() => parsePlaylist("<html>", "https://x.example/"), /Not an HLS playlist/);
});

test("filename helpers", () => {
  assert.equal(safeFilename('Lesson 1: Intro / "Basics"?'), "Lesson 1 Intro Basics");
  assert.equal(safeFilename("..."), "video");
  assert.equal(extFromUrl("https://a.example/v/clip.WEBM?x=1"), "webm");
  assert.equal(extFromUrl("https://a.example/v/stream"), "mp4");
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
  assert.deepEqual(pl.segments, [
    "https://cdn.example.com/hls/media-clip0-video-0.ts?Policy=p&Signature=s&Key-Pair-Id=k",
    "https://cdn.example.com/hls/own.ts?sig=x",
    "https://elsewhere.example/c.ts",
  ]);
});

test("audioFor picks the default rendition of the variant's group", () => {
  const { audioFor } = require("../hls.js");
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
