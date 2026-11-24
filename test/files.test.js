// Guards against broken source files: every extension file must be valid UTF-8
// and every script must parse (ES modules checked as modules).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.join(__dirname, "..");
const files = fs.readdirSync(root).filter((f) => /\.(js|html|css|json|md)$/.test(f));
const modules = new Set(["saver.js", "mux.js"]);

for (const f of files) {
  test(`${f} is valid UTF-8`, () => {
    const buf = fs.readFileSync(path.join(root, f));
    assert.ok(buf.equals(Buffer.from(buf.toString("utf8"), "utf8")), `${f} contains invalid UTF-8`);
  });
  if (f.endsWith(".js")) {
    test(`${f} parses`, () => {
      const args = modules.has(f) ? ["--input-type=module", "--check"] : ["--check", path.join(root, f)];
      execFileSync(process.execPath, args, {
        input: modules.has(f) ? fs.readFileSync(path.join(root, f)) : undefined,
        stdio: ["pipe", "pipe", "pipe"],
      });
    });
  }
}
