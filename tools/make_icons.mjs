// Generates icon-180.png and icon-512.png with no dependencies.
// Run: node tools/make_icons.mjs
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // rgba
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b], a = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size || a <= 0) return;
    const i = (y * size + x) * 4;
    const inv = 1 - a;
    px[i] = px[i] * inv + r * a;
    px[i + 1] = px[i + 1] * inv + g * a;
    px[i + 2] = px[i + 2] * inv + b * a;
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * a));
  };

  const deep = [16, 43, 36];
  const top = [30, 79, 64];
  const cream = [244, 241, 234];
  const seal = [178, 106, 74];

  // Background with a soft vertical lift.
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const c = [0, 1, 2].map((k) => Math.round(top[k] + (deep[k] - top[k]) * t));
    for (let x = 0; x < size; x++) put(x, y, c, 1);
  }

  // Envelope geometry.
  const w = Math.round(size * 0.58);
  const h = Math.round(w * 0.68);
  const x0 = Math.round((size - w) / 2);
  const y0 = Math.round((size - h) / 2 + size * 0.02);
  const r = Math.max(2, Math.round(size * 0.025));

  const inRounded = (x, y) => {
    const cx = Math.min(Math.max(x, x0 + r), x0 + w - r);
    const cy = Math.min(Math.max(y, y0 + r), y0 + h - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  };

  // Antialiased fill by 3x3 supersampling of the rounded rectangle.
  for (let y = y0 - 2; y <= y0 + h + 2; y++) {
    for (let x = x0 - 2; x <= x0 + w + 2; x++) {
      let hits = 0;
      for (let sy = 0; sy < 3; sy++) {
        for (let sx = 0; sx < 3; sx++) {
          if (inRounded(x + (sx + 0.5) / 3 - 0.5, y + (sy + 0.5) / 3 - 0.5)) hits++;
        }
      }
      if (hits) put(x, y, cream, hits / 9);
    }
  }

  // The flap: two strokes from the top corners down to the middle.
  const thick = Math.max(1.4, size * 0.022);
  const apexY = y0 + h * 0.5;
  const apexX = x0 + w / 2;
  const stroke = (ax, ay, bx, by) => {
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 3);
    for (let s = 0; s <= steps; s++) {
      const cx = ax + ((bx - ax) * s) / steps;
      const cy = ay + ((by - ay) * s) / steps;
      for (let y = Math.floor(cy - thick); y <= Math.ceil(cy + thick); y++) {
        for (let x = Math.floor(cx - thick); x <= Math.ceil(cx + thick); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= thick) put(x, y, deep, Math.min(1, (thick - d) * 1.6));
        }
      }
    }
  };
  stroke(x0 + thick, y0 + thick, apexX, apexY);
  stroke(x0 + w - thick, y0 + thick, apexX, apexY);

  // A small wax seal so the icon reads as mail, not as a generic email app.
  const sr = size * 0.075;
  for (let y = Math.floor(apexY - sr - 1); y <= Math.ceil(apexY + sr + 1); y++) {
    for (let x = Math.floor(apexX - sr - 1); x <= Math.ceil(apexX + sr + 1); x++) {
      const d = Math.hypot(x - apexX, y - apexY);
      if (d <= sr) put(x, y, seal, Math.min(1, (sr - d) * 2));
    }
  }
  return px;
}

for (const size of [180, 512]) {
  writeFileSync(join(root, `icon-${size}.png`), png(size, draw(size)));
  console.log(`wrote icon-${size}.png`);
}
