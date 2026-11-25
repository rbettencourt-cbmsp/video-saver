// detect.js page-data rules, run against a minimal stand-in for the DOM.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "detect.js"), "utf8");

function detectOn({ url, iframes = [], nextData }) {
  const nodes = {
    "iframe[src]": iframes.map((src) => ({ src })),
    "script#__NEXT_DATA__, script[type='application/json'], script[type='application/ld+json']":
      nextData ? [{ textContent: JSON.stringify(nextData) }] : [],
  };
  const document = { querySelectorAll: (sel) => nodes[sel] || [] };
  const win = {};
  const ctx = { document, location: { href: url }, URL, JSON, globalThis: null };
  ctx.globalThis = ctx;
  ctx.window = win;
  ctx.top = win;
  vm.runInNewContext(SRC, ctx);
  return Array.from(ctx.videoSaverDetect(), (x) => x).map((i) => (i.type === "youtube" ? `youtube:${i.embedId}` : `${i.kind}:${i.embedId}`)).sort();
}

const loom = (n) => `https://www.loom.com/share/${String(n).repeat(32).slice(0, 32)}`;
// Skool-like classroom data: every lesson's video link, the open one named by ?md=.
const classroom = {
  props: {
    pageProps: {
      course: {
        children: [
          { course: { id: "aaa", metadata: { title: "Lesson 1", videoLink: loom(1) } }, children: [] },
          { course: { id: "bbb", metadata: { title: "Lesson 2", videoLink: "https://youtu.be/dQw4w9WgXcQ" } } },
          { course: { id: "ccc", metadata: { title: "Lesson 3", videoLink: loom(3) } } },
          { course: { id: "ddd", metadata: { title: "Lesson 4 (text only)" } } },
        ],
      },
    },
  },
};
const base = "https://www.skool.com/group/classroom/x1";

test("course page: only the open lesson's video, not every lesson's", () => {
  assert.deepStrictEqual(detectOn({ url: `${base}?md=bbb`, nextData: classroom }), ["youtube:dQw4w9WgXcQ"]);
  assert.deepStrictEqual(detectOn({ url: `${base}?md=ccc`, nextData: classroom }), ["loom:33333333333333333333333333333333"]);
});

test("open lesson without a video finds nothing from page data", () => {
  assert.deepStrictEqual(detectOn({ url: `${base}?md=ddd`, nextData: classroom }), []);
});

test("page data is ignored when the page already shows a player", () => {
  assert.deepStrictEqual(
    detectOn({ url: base, iframes: ["https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0"], nextData: classroom }),
    ["youtube:dQw4w9WgXcQ"]
  );
});

test("page data is used when no player is on the page and no lesson is named", () => {
  assert.deepStrictEqual(detectOn({ url: base, nextData: classroom }), [
    "loom:11111111111111111111111111111111",
    "loom:33333333333333333333333333333333",
    "youtube:dQw4w9WgXcQ",
  ]);
});
