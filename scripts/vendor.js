// Copies ffmpeg.wasm into vendor/ so the unpacked extension can load it locally.
// Runs automatically after `npm install`.
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const copies = [
  ["node_modules/@ffmpeg/ffmpeg/dist/esm", "vendor/ffmpeg", (f) => f.endsWith(".js")],
  ["node_modules/@ffmpeg/core/dist/esm", "vendor/core", () => true],
];

for (const [from, to, keep] of copies) {
  const src = path.join(root, from);
  const dst = path.join(root, to);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const f of fs.readdirSync(src).filter(keep)) {
    fs.copyFileSync(path.join(src, f), path.join(dst, f));
  }
  console.log(`vendored ${from} -> ${to}`);
}
