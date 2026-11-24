// Tests for the yt-dlp native messaging host: input validation, argument building,
// and the real stdin/stdout protocol (spawned the way Chrome spawns it).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { youtubeId, safeName, safeFolder, buildArgs, parseProgress } = require("../native-host/host.js");

const HOST = path.join(__dirname, "..", "native-host", "host.js");
const YTDLP = path.join(__dirname, "..", "yt-dlp.exe");
const ORIGIN = "chrome-extension://doocigjijigkklclednoibneaenlmmnj/";

test("youtubeId accepts real video URLs only", () => {
  const id = "dQw4w9WgXcQ";
  for (const u of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://www.youtube.com/watch?v=${id}&list=PL123&t=42s`,
    `https://m.youtube.com/watch?v=${id}`,
    `https://youtube.com/shorts/${id}`,
    `https://youtu.be/${id}?si=abc`,
  ]) assert.equal(youtubeId(u), id, u);
  for (const u of [
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ--exec",
    "https://www.youtube.com/playlist?list=PL123",
    "file:///C:/Windows/system32/calc.exe",
    "--exec calc",
    "",
  ]) assert.equal(youtubeId(u), null, u);
});

test("safeName strips paths and template syntax", () => {
  assert.equal(safeName("My Video: Part 1/2"), "My Video Part 1 2");
  assert.equal(safeName("..\\..\\Windows\\evil"), "Windows evil");
  assert.equal(safeName("%(id)s %(title)s"), "(id)s (title)s");
  assert.equal(safeName("clip.mp4"), "clip");
  assert.equal(safeName("CON"), "CON_");
  assert.equal(safeName("   "), null);
});

test("safeFolder needs an existing absolute local folder", () => {
  assert.equal(safeFolder(os.tmpdir()), path.resolve(os.tmpdir()));
  assert.equal(safeFolder("relative\\folder"), null);
  assert.equal(safeFolder("\\\\server\\share"), null);
  assert.equal(safeFolder(path.join(os.tmpdir(), "does-not-exist-vs")), null);
  assert.equal(safeFolder(123), null);
});

test("buildArgs: fixed options, canonical URL after --, escaped folder", () => {
  const folder = "C:\\Users\\me\\100% Videos";
  const a = buildArgs({ id: "dQw4w9WgXcQ", quality: "720", folder, name: "My clip", hasFfmpeg: true, ffmpegPath: "" });
  assert.deepEqual(a.slice(-2), ["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
  assert.ok(a.includes("--ignore-config") && a.includes("--no-exec") && a.includes("--no-playlist"));
  assert.equal(a[a.indexOf("-o") + 1], "C:\\Users\\me\\100%% Videos\\My clip.%(ext)s");
  assert.equal(a[a.indexOf("-f") + 1], "bestvideo[height<=720]+bestaudio/best[height<=720]");
  const audio = buildArgs({ id: "dQw4w9WgXcQ", quality: "audio", folder: "C:\\x", name: null, hasFfmpeg: true });
  assert.ok(audio.includes("-x") && audio[audio.indexOf("--audio-format") + 1] === "mp3");
  const noFf = buildArgs({ id: "dQw4w9WgXcQ", quality: "best", folder: "C:\\x", name: null, hasFfmpeg: false });
  assert.ok(!noFf.includes("--merge-output-format"));
});

test("parseProgress reads our progress template", () => {
  assert.deepEqual(parseProgress("VSPROGRESS  42.5%| 1.20MiB/s|00:12|137"), { percent: 42.5, speed: "1.20MiB/s", eta: "00:12", format: "137" });
  assert.equal(parseProgress("[download] Destination: x.mp4"), null);
});

// --- Protocol: spawn the host like Chrome does --------------------------------------

function startHost(origin, config) {
  const cfgPath = path.join(os.tmpdir(), `vs-host-test-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify(config));
  const child = spawn(process.execPath, [HOST, origin], { env: { ...process.env, VS_HOST_CONFIG: cfgPath } });
  let buf = Buffer.alloc(0);
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      messages.push(msg);
      waiters.splice(0).forEach((w) => w());
    }
  });
  const post = (msg) => {
    const body = Buffer.from(JSON.stringify(msg));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([h, body]));
  };
  const next = async (pred, ms = 60000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const i = messages.findIndex(pred);
      if (i >= 0) return messages.splice(i, 1)[0];
      if (Date.now() > deadline) throw new Error("timed out waiting for host message");
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 200);
      });
    }
  };
  const stop = () => {
    child.stdin.end();
    child.kill();
    fs.rmSync(cfgPath, { force: true });
  };
  return { child, post, next, stop };
}

test("host accepts Firefox-style arguments (manifest path, then add-on ID)", { skip: !fs.existsSync(YTDLP) && "yt-dlp.exe not present" }, async () => {
  const FF_ID = "video-saver@rbettencourt-cbmsp";
  const cfgPath = path.join(os.tmpdir(), `vs-host-ff-${process.pid}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ytDlpPath: YTDLP, allowedOrigins: [ORIGIN, FF_ID] }));
  const child = spawn(process.execPath, [HOST, "C:\\x\\com.videosaver.ytdlp.firefox.json", FF_ID], {
    env: { ...process.env, VS_HOST_CONFIG: cfgPath },
  });
  const reply = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0))));
    });
    setTimeout(() => reject(new Error("no reply")), 30000);
    const body = Buffer.from(JSON.stringify({ type: "ping", reqId: "f" }));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([h, body]));
  });
  child.kill();
  fs.rmSync(cfgPath, { force: true });
  assert.equal(reply.type, "pong", reply.error);
});

test("host rejects a Firefox add-on ID that isn't allowed", async () => {
  const h = startHost("C:\\x\\manifest.json", { ytDlpPath: YTDLP, allowedOrigins: [ORIGIN] });
  const m = await h.next(() => true, 10000);
  assert.match(m.error, /isn't allowed/);
  h.stop();
});

test("host rejects extensions that aren't allowed", async () => {
  const h = startHost("chrome-extension://someoneelse/", { ytDlpPath: YTDLP, allowedOrigins: [ORIGIN] });
  const m = await h.next(() => true, 10000);
  assert.match(m.error, /isn't allowed/);
  await new Promise((r) => h.child.on("exit", r));
  h.stop();
});

test("host accepts a config.json saved with a UTF-8 BOM (Windows PowerShell)", { skip: !fs.existsSync(YTDLP) && "yt-dlp.exe not present" }, async () => {
  const cfgPath = path.join(os.tmpdir(), `vs-host-bom-${process.pid}.json`);
  fs.writeFileSync(cfgPath, "﻿" + JSON.stringify({ ytDlpPath: YTDLP, allowedOrigins: [ORIGIN] }));
  const child = spawn(process.execPath, [HOST, ORIGIN], { env: { ...process.env, VS_HOST_CONFIG: cfgPath } });
  const reply = await new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    child.stdout.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0))));
    });
    setTimeout(() => reject(new Error("no reply")), 30000);
    const body = Buffer.from(JSON.stringify({ type: "ping", reqId: "b" }));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    child.stdin.write(Buffer.concat([h, body]));
  });
  child.kill();
  fs.rmSync(cfgPath, { force: true });
  assert.equal(reply.type, "pong", reply.error);
  assert.equal(reply.ok, true);
});

test("host protocol: ping, bad input, unknown command", { skip: !fs.existsSync(YTDLP) && "yt-dlp.exe not present" }, async () => {
  const h = startHost(ORIGIN, { ytDlpPath: YTDLP, allowedOrigins: [ORIGIN], defaultFolder: os.tmpdir() });
  try {
    h.post({ type: "ping", reqId: "r1" });
    const pong = await h.next((m) => m.type === "pong");
    assert.equal(pong.ok, true, pong.error);
    assert.match(pong.ytDlpVersion, /^\d{4}\.\d{2}\.\d{2}/);

    h.post({ type: "download", jobId: "j1", url: "https://evil.example/watch?v=dQw4w9WgXcQ", quality: "best" });
    assert.match((await h.next((m) => m.jobId === "j1")).error, /isn't a YouTube video URL/);

    h.post({ type: "download", jobId: "j2", url: "https://youtu.be/dQw4w9WgXcQ", quality: "--exec calc" });
    assert.match((await h.next((m) => m.jobId === "j2")).error, /Unknown quality/);

    h.post({ type: "download", jobId: "j3", url: "https://youtu.be/dQw4w9WgXcQ", quality: "best", folder: "C:\\nope\\missing" });
    assert.match((await h.next((m) => m.jobId === "j3")).error, /folder doesn't exist/);

    h.post({ type: "download", jobId: "../../x", url: "https://youtu.be/dQw4w9WgXcQ", quality: "best" });
    assert.match((await h.next((m) => m.type === "error" && /job id/.test(m.error))).error, /Bad job id/);

    h.post({ type: "run", cmd: "calc.exe" });
    assert.match((await h.next((m) => m.type === "error" && /Unknown command/.test(m.error))).error, /Unknown command/);
  } finally {
    h.stop();
  }
});
