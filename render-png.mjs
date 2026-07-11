// Renders the pipeline output to PNGs so a human can eyeball color quality.
// Usage: node test/render-png.mjs <outdir>
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS } from '../js/palette.js';
import { buildMapData } from '../js/mapart.js';

const outDir = process.argv[2] || '.';
mkdirSync(outDir, { recursive: true });

// ── tiny PNG encoder (RGBA8, no filtering) ───────────────────────────────────
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── procedural "sunset lake" source (pure math, mirrors the app's samples) ───
function sunset(s) {
  const d = new Uint8ClampedArray(s * s * 4);
  const lerp = (a, b, t) => a + (b - a) * t;
  const horizon = s * 0.62;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 4;
      let r, g, b;
      if (y < horizon) {
        const t = y / horizon;
        r = lerp(24, 244, t ** 1.6); g = lerp(30, 120, t ** 1.9); b = lerp(72, 70, t);
        // sun
        const dx = x - s * 0.5, dy = y - horizon * 0.88;
        const dist = Math.hypot(dx, dy);
        if (dist < s * 0.09) { r = 255; g = 214; b = 120; }
        else if (dist < s * 0.13) { r = lerp(r, 255, .5); g = lerp(g, 200, .4); b = lerp(b, 120, .3); }
      } else {
        const t = (y - horizon) / (s - horizon);
        r = lerp(200, 16, t ** .7); g = lerp(100, 24, t ** .8); b = lerp(80, 60, t ** .6);
        if ((x + y * 3) % 17 < 3) { r = lerp(r, 255, .25); g = lerp(g, 210, .2); } // ripples
      }
      // mountain silhouettes
      const m1 = horizon - Math.abs(Math.sin(x / 43)) * s * 0.10 - Math.sin(x / 11) * 6;
      const m2 = horizon - Math.abs(Math.sin(x / 71 + 2)) * s * 0.17;
      if (y > m2 && y < horizon) { r = 46; g = 34; b = 56; }
      if (y > m1 && y < horizon) { r = 24; g = 18; b = 34; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
    }
  }
  return { width: s, height: s, data: d };
}

const img = sunset(128);
writeFileSync(join(outDir, '0-source.png'), encodePNG(128, 128, img.data));

const all = BLOCKS.map(b => b.id);
const wool = BLOCKS.filter(b => b.cat === 'wool').map(b => b.id);
const runs = [
  ['1-staircase-floyd', { mode: 'staircase', dither: 'floyd', enabledBlocks: all }],
  ['2-flat-floyd', { mode: 'flat', dither: 'floyd', enabledBlocks: all }],
  ['3-staircase-nodither', { mode: 'staircase', dither: 'none', enabledBlocks: all }],
  ['4-wool-only-staircase', { mode: 'staircase', dither: 'floyd', enabledBlocks: wool }],
];
for (const [name, opts] of runs) {
  const r = buildMapData(img, { ditherStrength: 1, staircaseStyle: 'valley', ...opts });
  writeFileSync(join(outDir, `${name}.png`), encodePNG(r.width, r.height, r.previewRGBA));
  console.log(`${name}: maxHeight=${r.maxHeight} blocks=${r.totalBlocks} colors=${new Set([...r.grid].filter(v => v >= 0).map(v => r.palette[v].colorId)).size}`);
}
console.log('done →', outDir);
