// Builds the Firefox version into dist/firefox (run: npm run build:firefox).
// Same code as the Chrome version; only the manifest differs:
//  * background "scripts" (Firefox) instead of a "service_worker" (Chrome)
//  * a fixed add-on ID in browser_specific_settings, instead of Chrome's "key"
//  * webRequestBlocking, used to send Referer on Firefox (see background.js)
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist", "firefox");
const GECKO_ID = "video-saver@rbettencourt-cbmsp";

if (!fs.existsSync(path.join(root, "vendor", "core", "ffmpeg-core.wasm"))) {
  console.error("vendor/ is missing. Run `npm install` first.");
  process.exit(1);
}

// Everything the extension loads at runtime.
const FILES = fs.readdirSync(root).filter((f) => /\.(js|html|css)$/.test(f));
const DIRS = ["icons", "vendor"];
const EXTRA = ["LICENSE", "README.md"];

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of [...FILES, ...EXTRA]) fs.copyFileSync(path.join(root, f), path.join(out, f));
for (const d of DIRS) fs.cpSync(path.join(root, d), path.join(out, d), { recursive: true });

const m = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
delete m.key;
m.background = { scripts: ["compat.js", "common.js", "background.js"] };
m.permissions = [...new Set([...m.permissions, "webRequestBlocking"])];
m.browser_specific_settings = {
  gecko: {
    id: GECKO_ID,
    strict_min_version: "128.0",
    data_collection_permissions: { required: ["none"] },
  },
};
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 2) + "\n");

console.log(`Firefox build ready: ${path.relative(root, out)} (add-on ID ${GECKO_ID})`);
console.log("Load it in Firefox: about:debugging#/runtime/this-firefox → Load Temporary Add-on… → dist/firefox/manifest.json");
