#!/usr/bin/env node
// Video Saver native messaging host: a narrow bridge from the extension to yt-dlp.exe.
//
// Chrome starts this process (via host.bat) when the extension calls
// chrome.runtime.connectNative("com.videosaver.ytdlp"). Messages are JSON framed with
// a 4-byte little-endian length on stdin/stdout.
//
// Security model:
//  * Chrome only lets extensions listed in the host manifest's allowed_origins connect;
//    this host also checks the caller origin Chrome passes as the first argument.
//  * Only these commands exist: ping, pickFolder, download, cancel. There is no way
//    to pass arbitrary arguments or run other programs.
//  * The video URL is reduced to an 11-character YouTube video ID and rebuilt as
//    https://www.youtube.com/watch?v=<id>. Quality is one of a fixed list. The folder
//    must be an existing absolute directory; the filename is sanitised (no paths,
//    no template syntax). yt-dlp runs with --ignore-config and without a shell.
//  * Nothing here bypasses DRM, logins or access controls. By default no cookies are
//    passed, so yt-dlp sees what any signed-out viewer sees. If the user turns on
//    "Use my YouTube sign-in", the extension sends that browser's youtube.com cookies;
//    they are checked (youtube.com only), written to a private temp file for this one
//    download, given to yt-dlp with --cookies, and deleted when it ends.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn, execFile } = require("node:child_process");

const HOST_DIR = __dirname;
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
// VS_HOST_CONFIG is for the test suite; Chrome starts the host without it.
const CONFIG_PATH = process.env.VS_HOST_CONFIG || path.join(HOST_DIR, "config.json");
const LOG_PATH = path.join(HOST_DIR, "host.log");

// --- Config ------------------------------------------------------------------

function loadConfig() {
  let cfg = {};
  try {
    // Windows PowerShell writes UTF-8 with a byte-order mark, which JSON.parse rejects.
    cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8").replace(/^﻿/, ""));
  } catch (err) {
    if (err.code !== "ENOENT") log("couldn't read config.json:", err.message);
  }
  return {
    ytDlpPath: cfg.ytDlpPath || path.join(HOST_DIR, "..", IS_WIN ? "yt-dlp.exe" : "yt-dlp"),
    ffmpegPath: cfg.ffmpegPath || "", // optional: folder or ffmpeg.exe; otherwise PATH is used
    allowedOrigins: Array.isArray(cfg.allowedOrigins) ? cfg.allowedOrigins : [],
    defaultFolder: cfg.defaultFolder || path.join(os.homedir(), "Downloads", "Video Saver"),
  };
}

function log(...args) {
  try {
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${args.join(" ")}\n`);
  } catch {}
}

// --- Validation (exported for tests) ---------------------------------------------

const QUALITIES = ["best", "1080", "720", "480", "audio"];

/** Returns the 11-char video ID from a YouTube URL, or null. */
function youtubeId(input) {
  let u;
  try {
    u = new URL(String(input));
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  let id = null;
  if (["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = /^\/(?:shorts|live|embed)\/([^/?#]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  } else if (host === "youtu.be") {
    id = u.pathname.slice(1).split("/")[0];
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

/** Makes a safe file name (no folders, no yt-dlp template syntax). Empty → null. */
function safeName(name) {
  const cleaned = String(name || "")
    .replace(/\.(mp4|mkv|webm|mp3|m4a)$/i, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f%]+/g, " ")
    .replace(/(^|\s)\.+(?=\s|$)/g, " ") // leftover ".." pieces
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 150);
  if (!cleaned) return null;
  // Windows reserved device names
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(cleaned)) return `${cleaned}_`;
  return cleaned;
}

/** Validates an absolute, existing directory. */
function safeFolder(folder) {
  if (typeof folder !== "string" || !folder || folder.length > 400) return null;
  if (!path.isAbsolute(folder) || folder.startsWith("\\\\")) return null; // no relative or UNC paths
  const resolved = path.resolve(folder);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Validates cookies sent by the extension: Netscape cookie-file text where every cookie
 * belongs to youtube.com. Returns the cleaned text, or null if anything is off.
 */
const MAX_COOKIE_BYTES = 256 * 1024;
function validCookieText(text) {
  if (typeof text !== "string" || !text || Buffer.byteLength(text) > MAX_COOKIE_BYTES) return null;
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "# Netscape HTTP Cookie File") return null;
  const out = [lines[0]];
  let count = 0;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const fields = line.replace(/^#HttpOnly_/, "").split("\t");
    if (line.startsWith("#") && !line.startsWith("#HttpOnly_")) return null; // no stray comments
    if (fields.length !== 7) return null;
    const [domain, sub, cpath, secure, expires, name] = fields;
    if (!/^\.?([a-z0-9-]+\.)*youtube\.com$/i.test(domain)) return null;
    if (!/^(TRUE|FALSE)$/.test(sub) || !/^(TRUE|FALSE)$/.test(secure) || !/^\d+$/.test(expires)) return null;
    if (!cpath.startsWith("/") || !name || /[\r\n]/.test(line)) return null;
    out.push(line);
    count++;
  }
  return count ? out.join("\n") + "\n" : null;
}

/** Builds the yt-dlp argument list. Every value is fixed or validated. */
function buildArgs({ id, quality, folder, name, hasFfmpeg, ffmpegPath, jsRuntime, cookiesFile }) {
  // "%" is yt-dlp template syntax, so a literal "%" in the folder must be doubled.
  const output = path.join(folder.replace(/%/g, "%%"), `${name ? name : "%(title).150B [%(id)s]"}.%(ext)s`);
  const args = [
    "--ignore-config", "--no-exec", "--no-playlist", "--no-cookies-from-browser",
    "--newline", "--progress", "--no-colors", "--restrict-filenames",
    "--progress-template", "download:VSPROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(info.format_id)s",
    "--print", "after_move:VSFILE %(filepath)s",
    "--no-simulate",
    "--no-overwrites", "--windows-filenames",
    "-o", output,
  ];
  if (ffmpegPath) args.push("--ffmpeg-location", ffmpegPath);
  // Recent yt-dlp needs a JavaScript runtime for YouTube; Node (which runs this host) works.
  if (jsRuntime) args.push("--js-runtimes", jsRuntime);
  // Only when the user opted in: a private temp file the host wrote from validated cookies.
  if (cookiesFile) args.push("--cookies", cookiesFile);
  if (name) args.splice(args.indexOf("--restrict-filenames"), 1); // keep the user's chosen spaces

  if (quality === "audio") {
    if (hasFfmpeg) args.push("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "0");
    else args.push("-f", "bestaudio[ext=m4a]/bestaudio");
  } else {
    const h = quality === "best" ? "" : `[height<=${quality}]`;
    if (hasFfmpeg) {
      args.push("-f", `bestvideo${h}+bestaudio/best${h}`, "--merge-output-format", "mp4");
      // Prefer MP4-friendly codecs (H.264/AAC) when the quality is the same.
      args.push("-S", "res,vcodec:h264,acodec:m4a");
    } else {
      args.push("-f", `best${h}[acodec!=none][vcodec!=none]/best${h}`);
    }
  }
  args.push("--", `https://www.youtube.com/watch?v=${id}`);
  return args;
}

/** Parses a yt-dlp progress line (from our --progress-template). */
function parseProgress(line) {
  const m = /^VSPROGRESS\s+([\d.]+)%\|([^|]*)\|([^|]*)\|(.*)$/.exec(line.trim());
  if (!m) return null;
  return { percent: Number(m[1]), speed: m[2].trim(), eta: m[3].trim(), format: m[4].trim() };
}

// --- yt-dlp version / JS runtime --------------------------------------------------

let versionCache = null;
function ytDlpVersion(cfg) {
  if (versionCache) return versionCache;
  versionCache = new Promise((resolve) =>
    execFile(cfg.ytDlpPath, ["--version"], { windowsHide: true, timeout: 20000 }, (err, out) => resolve(err ? "" : out.trim()))
  );
  return versionCache;
}

/** "--js-runtimes" arrived in yt-dlp 2025.11; older versions would reject the option. */
function jsRuntimeFor(version) {
  const m = /^(\d{4})\.(\d{2})\.(\d{2})/.exec(version || "");
  if (!m) return null;
  const n = Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  return n >= 20251101 ? `node:${process.execPath}` : null;
}

// --- ffmpeg discovery --------------------------------------------------------------

function findFfmpeg(cfg) {
  return new Promise((resolve) => {
    if (cfg.ffmpegPath) {
      const p = fs.existsSync(cfg.ffmpegPath) ? cfg.ffmpegPath : "";
      return resolve(p ? { found: true, location: p } : { found: false });
    }
    const beside = path.join(path.dirname(cfg.ytDlpPath), IS_WIN ? "ffmpeg.exe" : "ffmpeg");
    if (fs.existsSync(beside)) return resolve({ found: true, location: "" }); // yt-dlp finds it itself
    // Windows: `where`; macOS/Linux: `which` (host.sh puts Homebrew's folders on PATH first).
    execFile(IS_WIN ? "where" : "which", ["ffmpeg"], { windowsHide: true }, (err, stdout) => {
      resolve(!err && stdout.trim() ? { found: true, location: "" } : { found: false });
    });
  });
}

// --- Native messaging framing ---------------------------------------------------------

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function readMessages(onMessage) {
  let buf = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > 1024 * 1024) {
        log("message too large; exiting");
        process.exit(1);
      }
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        send({ type: "error", error: "Bad message." });
        continue;
      }
      onMessage(msg);
    }
  });
  process.stdin.on("end", () => shutdown());
}

// --- Commands ------------------------------------------------------------------------

const children = new Map(); // jobId -> ChildProcess

function killTree(child) {
  if (!child || child.exitCode != null) return;
  // yt-dlp may have started ffmpeg; end the whole tree.
  if (IS_WIN) {
    execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    return;
  }
  // macOS/Linux: yt-dlp runs in its own process group (spawned detached), so signal the group.
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

function shutdown() {
  for (const c of children.values()) killTree(c);
  setTimeout(() => {
    // Remove any sign-in temp files this process wrote (normally already gone).
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(`video-saver-cookies-${process.pid}-`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
      }
    } catch {}
    process.exit(0);
  }, 300);
}

async function ping(cfg, reqId) {
  const exists = fs.existsSync(cfg.ytDlpPath);
  const version = exists ? await ytDlpVersion(cfg) : "";
  const ff = await findFfmpeg(cfg);
  send({
    type: "pong", reqId, ok: exists && !!version, ytDlpPath: cfg.ytDlpPath, ytDlpVersion: version,
    ffmpeg: ff.found, defaultFolder: cfg.defaultFolder,
    error: !exists ? `yt-dlp not found at ${cfg.ytDlpPath}. Run the setup again, or edit native-host/config.json.` : !version ? "yt-dlp did not run." : undefined,
    platform: process.platform,
  });
}

function pickFolder(cfg, initial, reqId) {
  const start = safeFolder(initial) || safeFolder(cfg.defaultFolder) || os.homedir();
  const reply = (stdout) => {
    const chosen = safeFolder(String(stdout || "").trim().replace(/\/$/, "") || "");
    send({ type: "folder", reqId, folder: chosen || null, cancelled: !chosen });
  };
  const opts = { env: { ...process.env, VS_START_FOLDER: start }, timeout: 10 * 60 * 1000 };

  if (IS_MAC) {
    // Fixed AppleScript; the start folder comes from an environment variable. Cancel → error -128 → empty.
    const script = [
      'set startFolder to POSIX file (system attribute "VS_START_FOLDER")',
      'POSIX path of (choose folder with prompt "Choose where Video Saver puts YouTube downloads" default location startFolder)',
    ];
    return execFile("osascript", script.flatMap((l) => ["-e", l]), opts, (err, stdout) => reply(err ? "" : stdout));
  }
  if (!IS_WIN) {
    // Linux: zenity (GNOME and most desktops), else kdialog (KDE).
    return execFile("zenity", ["--file-selection", "--directory", "--title=Choose where Video Saver puts YouTube downloads", `--filename=${start}/`], opts, (err, stdout) => {
      if (!err || err.code === 1) return reply(err ? "" : stdout); // 1 = cancelled
      execFile("kdialog", ["--getexistingdirectory", start], opts, (err2, stdout2) => {
        if (err2 && err2.code === "ENOENT") {
          return send({ type: "folder", reqId, folder: null, cancelled: true, error: "No folder picker found. Install zenity, or set defaultFolder in native-host/config.json." });
        }
        reply(err2 ? "" : stdout2);
      });
    });
  }
  // Fixed PowerShell script; the start folder is passed through an environment variable, not the command line.
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$d.Description = 'Choose where Video Saver puts YouTube downloads'",
    "$d.SelectedPath = $env:VS_START_FOLDER",
    "$d.ShowNewFolderButton = $true",
    "$f = New-Object System.Windows.Forms.Form -Property @{TopMost=$true; ShowInTaskbar=$false; WindowState='Minimized'}",
    "if ($d.ShowDialog($f) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
  ].join("; ");
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    { windowsHide: false, env: { ...process.env, VS_START_FOLDER: start }, timeout: 10 * 60 * 1000 },
    (err, stdout) => {
      const chosen = safeFolder(stdout.trim());
      send({ type: "folder", reqId, folder: chosen || null, cancelled: !chosen });
    }
  );
}

async function download(cfg, msg) {
  const jobId = String(msg.jobId || "").slice(0, 64);
  const fail = (error) => send({ type: "error", jobId, error });
  if (!/^[\w-]{1,64}$/.test(jobId)) return fail("Bad job id.");
  if (children.has(jobId)) return fail("That download is already running.");

  const id = youtubeId(msg.url);
  if (!id) return fail("That isn't a YouTube video URL.");
  if (!QUALITIES.includes(msg.quality)) return fail("Unknown quality option.");
  let folder = safeFolder(msg.folder);
  if (!folder && !msg.folder) {
    try {
      fs.mkdirSync(cfg.defaultFolder, { recursive: true });
      folder = safeFolder(cfg.defaultFolder);
    } catch {}
  }
  if (!folder) return fail("The download folder doesn't exist. Choose another folder.");
  const name = msg.filename ? safeName(msg.filename) : null;
  if (msg.filename && !name) return fail("That file name can't be used.");
  if (!fs.existsSync(cfg.ytDlpPath)) return fail(`yt-dlp not found at ${cfg.ytDlpPath}. Run the setup again, or edit native-host/config.json.`);

  // Opt-in sign-in: write the validated youtube.com cookies to a private temp file.
  let cookiesFile = null;
  if (msg.cookies != null) {
    const text = validCookieText(msg.cookies);
    if (!text) return fail("The YouTube sign-in data wasn't valid. Sign in to YouTube in this browser and try again.");
    cookiesFile = path.join(os.tmpdir(), `video-saver-cookies-${process.pid}-${jobId}.txt`);
    try {
      fs.writeFileSync(cookiesFile, text, { mode: 0o600 });
    } catch (err) {
      return fail(`Couldn't prepare the YouTube sign-in: ${err.message}`);
    }
  }
  const removeCookies = () => {
    if (cookiesFile) fs.rm(cookiesFile, { force: true }, () => {});
  };

  const ff = await findFfmpeg(cfg);
  const jsRuntime = jsRuntimeFor(await ytDlpVersion(cfg));
  const args = buildArgs({ id, quality: msg.quality, folder, name, hasFfmpeg: ff.found, ffmpegPath: ff.location, jsRuntime, cookiesFile });
  log("download", jobId, id, msg.quality, folder, cookiesFile ? "(signed in)" : "");
  send({ type: "started", jobId, videoId: id, ffmpeg: ff.found });

  // detached on macOS/Linux puts yt-dlp (and the ffmpeg it starts) in its own process group,
  // so cancel can stop them together; on Windows taskkill /T does that.
  const child = spawn(cfg.ytDlpPath, args, { windowsHide: true, shell: false, detached: !IS_WIN });
  children.set(jobId, child);
  let lastFile = "";
  const errors = [];
  let stage = 0; // separate video+audio downloads count as two stages
  let lastPercent = 0;

  const onLine = (line) => {
    const p = parseProgress(line);
    if (p) {
      if (p.percent < lastPercent - 50) stage++;
      lastPercent = p.percent;
      send({ type: "progress", jobId, ...p, stage });
      // yt-dlp's own "[Merger]" lines are hidden by --print, so announce the finishing step here.
      if (p.percent >= 100) send({ type: "status", jobId, message: "Finishing (merging/converting)…" });
      return;
    }
    const f = /^VSFILE (.+)$/.exec(line.trim());
    if (f) lastFile = f[1];
    else if (/\[Merger\]|\[ExtractAudio\]|\[FixupM3u8\]/.test(line)) send({ type: "status", jobId, message: "Finishing (merging/converting)…" });
    else if (/has already been downloaded/.test(line)) send({ type: "status", jobId, message: "Already downloaded." });
  };
  const lines = (stream, cb) => {
    let rest = "";
    stream.setEncoding("utf8");
    stream.on("data", (d) => {
      rest += d;
      const parts = rest.split(/\r?\n/);
      rest = parts.pop();
      parts.forEach(cb);
    });
    stream.on("end", () => rest && cb(rest));
  };
  lines(child.stdout, onLine);
  lines(child.stderr, (l) => {
    if (/ERROR:|WARNING:/.test(l)) errors.push(l.trim());
    onLine(l);
  });

  child.on("error", (err) => {
    children.delete(jobId);
    removeCookies();
    fail(`Couldn't start yt-dlp: ${err.message}`);
  });
  child.on("close", (code) => {
    const wasCancelled = child.__cancelled;
    children.delete(jobId);
    removeCookies();
    if (wasCancelled) return send({ type: "cancelled", jobId });
    if (code === 0) {
      return send({ type: "done", jobId, file: lastFile, warning: ff.found ? undefined : "ffmpeg wasn't found, so the best single-file format was used (often lower quality, and audio stays M4A)." });
    }
    const err = errors.filter((e) => e.startsWith("ERROR")).pop() || errors.pop() || `yt-dlp exited with code ${code}`;
    fail(err.replace(/^ERROR:\s*/, "").slice(0, 500));
  });
}

function cancel(msg) {
  const child = children.get(String(msg.jobId || ""));
  if (!child) return send({ type: "error", jobId: msg.jobId, error: "No such download." });
  child.__cancelled = true;
  killTree(child);
}

// --- Main ----------------------------------------------------------------------------

function main() {
  const cfg = loadConfig();
  // Who is calling: Chrome passes the extension origin ("chrome-extension://<id>/") as the
  // first argument; Firefox passes the host manifest path and then the add-on ID.
  const args = process.argv.slice(2);
  const caller = args.find((a) => cfg.allowedOrigins.includes(a));
  if (!caller) {
    log("rejected caller", JSON.stringify(args.filter((a) => !a.startsWith("--parent-window")).join(" ")));
    send({ type: "error", error: "This extension isn't allowed to use the yt-dlp helper." });
    setTimeout(() => process.exit(1), 100);
    return;
  }
  readMessages((msg) => {
    switch (msg?.type) {
      case "ping":
        return ping(cfg, msg.reqId);
      case "pickFolder":
        return pickFolder(cfg, msg.initial, msg.reqId);
      case "download":
        return download(cfg, msg);
      case "cancel":
        return cancel(msg);
      default:
        return send({ type: "error", error: "Unknown command." });
    }
  });
}

if (require.main === module) main();
module.exports = { youtubeId, safeName, safeFolder, buildArgs, parseProgress, jsRuntimeFor, validCookieText, QUALITIES };
