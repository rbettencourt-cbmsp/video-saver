// Draws the extension icon (blue circle, white download arrow) as PNGs. No dependencies.
// Usage: node scripts/make-icons.js
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Coverage with 4x4 supersampling for smooth edges.
function icon(x, y, s) {
  let circle = 0, arrow = 0;
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      const u = (x + (sx + 0.5) / 4) / s; // 0..1
      const v = (y + (sy + 0.5) / 4) / s;
      const inCircle = (u - 0.5) ** 2 + (v - 0.5) ** 2 <= 0.47 ** 2;
      if (!inCircle) continue;
      circle++;
      const stem = Math.abs(u - 0.5) <= 0.075 && v >= 0.2 && v <= 0.58;
      const head = v >= 0.42 && v <= 0.66 && Math.abs(u - 0.5) <= (0.66 - v) * 1.15;
      const bar = v >= 0.72 && v <= 0.8 && u >= 0.27 && u <= 0.73;
      if (stem || head || bar) arrow++;
    }
  }
  if (!circle) return [0, 0, 0, 0];
  const a = Math.round((circle / 16) * 255);
  const t = arrow / circle; // white amount
  const mix = (c) => Math.round(c * (1 - t) + 255 * t);
  return [mix(0x1a), mix(0x73), mix(0xe8), a];
}

const out = path.join(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, `icon${size}.png`), png(size, icon));
console.log("icons written to", out);
