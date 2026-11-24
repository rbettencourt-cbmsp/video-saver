// Builds ready-to-install packages (no dependencies; needs `npm install` first for vendor/).
//
//   npm run build            → both browsers
//   npm run build:chrome     → dist/chrome + dist/video-saver-chrome-<version>.zip
//   npm run build:firefox    → dist/firefox + dist/video-saver-firefox-<version>.zip
//
// Chrome/Edge/Brave: unzip and "Load unpacked". The ZIP also contains native-host/ for the
// optional YouTube helper. Firefox: the folder loads as a temporary add-on; the ZIP is what
// you upload to addons.mozilla.org for signing.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.join(__dirname, "..");
const dist = path.join(root, "dist");
const GECKO_ID = "video-saver@rbettencourt-cbmsp";
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const version = manifest.version;

if (!fs.existsSync(path.join(root, "vendor", "core", "ffmpeg-core.wasm"))) {
  console.error("vendor/ is missing. Run `npm install` first.");
  process.exit(1);
}

// Files the extension loads at runtime, plus licences and the README.
const RUNTIME_FILES = fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f));
const COMMON_DIRS = ["icons", "vendor", "licenses"];
const DOCS = ["LICENSE", "README.md"];
const NATIVE_HOST = ["host.js", "install-host.ps1", "uninstall-host.ps1", "install-host.sh", "uninstall-host.sh"].map(
  (f) => `native-host/${f}`
);

function copyInto(out, extra = []) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const f of [...RUNTIME_FILES, ...DOCS, ...extra]) {
    fs.mkdirSync(path.dirname(path.join(out, f)), { recursive: true });
    fs.copyFileSync(path.join(root, f), path.join(out, f));
  }
  for (const d of COMMON_DIRS) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });
}

function buildChrome() {
  const out = path.join(dist, "chrome");
  copyInto(out, NATIVE_HOST);
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return out;
}

function buildFirefox() {
  const out = path.join(dist, "firefox");
  copyInto(out);
  const m = structuredClone(manifest);
  delete m.key; // Chrome-only
  m.background = { scripts: ["compat.js", "common.js", "background.js"] };
  m.permissions = [...new Set([...m.permissions, "webRequestBlocking"])];
  m.browser_specific_settings = {
    gecko: { id: GECKO_ID, strict_min_version: "128.0", data_collection_permissions: { required: ["none"] } },
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  return out;
}

// The YouTube helper on its own, for Firefox users (the Firefox package can't contain it).
// The installer reads manifest.json next to native-host/ to work out the Chrome extension ID.
function buildHelper() {
  const out = path.join(dist, "youtube-helper");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "native-host"), { recursive: true });
  for (const f of [...NATIVE_HOST, "LICENSE"]) fs.copyFileSync(path.join(root, f), path.join(out, f));
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ name: manifest.name, version, key: manifest.key }, null, 2) + "\n");
  fs.writeFileSync(
    path.join(out, "README.txt"),
    [
      "Video Saver: YouTube helper (Windows, macOS, Linux)",
      "",
      "Lets the YouTube Download button use yt-dlp on this computer, in Chrome, Edge, Brave and Firefox.",
      "",
      "Windows: put yt-dlp.exe in this folder, open PowerShell here, and run:",
      "  powershell -ExecutionPolicy Bypass -File .\\native-host\\install-host.ps1",
      "",
      "macOS: brew install node ffmpeg yt-dlp   then, in Terminal in this folder:",
      "  bash native-host/install-host.sh",
      "",
      "Linux: install node, ffmpeg and yt-dlp, then in a terminal in this folder:",
      "  bash native-host/install-host.sh",
      "",
      "Full steps: https://github.com/rbettencourt-cbmsp/video-saver#youtube-setup-optional-windows",
      "",
    ].join("\r\n")
  );
  return out;
}

// --- Minimal ZIP writer (deflate), so the build works the same on Windows and in CI ---

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  });
}

function zipDir(dir, zipPath) {
  const parts = [];
  const central = [];
  let offset = 0;
  // Fixed timestamp (2026-01-01) so the same input gives the same ZIP.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const name of listFiles(dir).sort()) {
    const data = fs.readFileSync(path.join(dir, name));
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...parts, cenBuf, end]));
  return central.length / 2;
}

// --- Main ---------------------------------------------------------------------------

const which = process.argv[2] || "all";
const targets = { chrome: buildChrome, firefox: buildFirefox, "youtube-helper": buildHelper };
for (const [name, build] of Object.entries(targets)) {
  if (which !== "all" && which !== name) continue;
  const out = build();
  const zipPath = path.join(dist, `video-saver-${name}-${version}.zip`);
  const count = zipDir(out, zipPath);
  const mb = (fs.statSync(zipPath).size / 1048576).toFixed(1);
  console.log(`${name}: ${path.relative(root, out)} and ${path.relative(root, zipPath)} (${count} files, ${mb} MB)`);
}
