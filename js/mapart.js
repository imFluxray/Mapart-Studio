// Core pipeline: palette building → perceptual matching + dithering →
// staircase height solving → materials. Pure data in/out (no DOM) so the
// exact same code runs in the browser and in the Node verification tests.

import { BASE_COLORS, BLOCKS, BLOCK_BY_ID, shadeRGB } from './palette.js';
import { srgb8ToLinear, linearToSrgb8, linearToOklab, rgb8ToOklab } from './color.js';

export const SHADE_NAMES = ['dark', 'normal', 'bright'];

// ── Palette ──────────────────────────────────────────────────────────────────
// One entry per (map color, shade). When several enabled blocks share a map
// color, the first one in BLOCKS order represents it (cheap blocks first).
export function buildPalette(enabledIds, mode) {
  const enabled = new Set(enabledIds);
  const byColor = new Map();
  for (const b of BLOCKS) {
    if (enabled.has(b.id) && !byColor.has(b.color)) byColor.set(b.color, b);
  }
  const shades = mode === 'flat' ? [1] : [0, 1, 2];
  const entries = [];
  for (const [colorId, block] of byColor) {
    const base = BASE_COLORS[colorId].rgb;
    for (const shade of shades) {
      const rgb = shadeRGB(base, shade);
      entries.push({ block, colorId, shade, rgb, lab: rgb8ToOklab(rgb[0], rgb[1], rgb[2]) });
    }
  }
  return entries;
}

// ── Matching ─────────────────────────────────────────────────────────────────
function makeMatcher(palette) {
  const labs = new Float32Array(palette.length * 3);
  palette.forEach((e, i) => { labs[i * 3] = e.lab[0]; labs[i * 3 + 1] = e.lab[1]; labs[i * 3 + 2] = e.lab[2]; });
  const cache = new Map();
  const tmp = [0, 0, 0];
  return (lr, lg, lb) => {
    const r8 = linearToSrgb8(lr), g8 = linearToSrgb8(lg), b8 = linearToSrgb8(lb);
    const key = (r8 << 16) | (g8 << 8) | b8;
    let best = cache.get(key);
    if (best !== undefined) return best;
    linearToOklab(srgb8ToLinear(r8), srgb8ToLinear(g8), srgb8ToLinear(b8), tmp);
    const [L, A, Bb] = tmp;
    let bd = Infinity; best = 0;
    for (let i = 0; i < palette.length; i++) {
      const dL = L - labs[i * 3], dA = A - labs[i * 3 + 1], dB = Bb - labs[i * 3 + 2];
      const d = dL * dL + dA * dA + dB * dB;
      if (d < bd) { bd = d; best = i; }
    }
    cache.set(key, best);
    return best;
  };
}

// Error-diffusion kernels: [dx, dy, weight]
const KERNELS = {
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  jarvis: [[1, 0, 7 / 48], [2, 0, 5 / 48], [-2, 1, 3 / 48], [-1, 1, 5 / 48], [0, 1, 7 / 48], [1, 1, 5 / 48], [2, 1, 3 / 48],
           [-2, 2, 1 / 48], [-1, 2, 3 / 48], [0, 2, 5 / 48], [1, 2, 1 / 48]],
};
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 5, 13, 7].map(v => v / 16 - 0.5);

// ── Preprocessing ────────────────────────────────────────────────────────────
export function applyAdjustments(data, { brightness = 0, contrast = 0, saturation = 0 } = {}) {
  if (!brightness && !contrast && !saturation) return;
  const br = brightness * 0.8;
  const c = contrast * 1.28;
  const cf = (259 * (c + 255)) / (255 * (259 - c));
  const sf = 1 + saturation / 100;
  for (let i = 0; i < data.length; i += 4) {
    let r = data[i], g = data[i + 1], b = data[i + 2];
    r = cf * (r - 128) + 128 + br;
    g = cf * (g - 128) + 128 + br;
    b = cf * (b - 128) + 128 + br;
    if (sf !== 1) {
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * sf;
      g = luma + (g - luma) * sf;
      b = luma + (b - luma) * sf;
    }
    data[i] = r < 0 ? 0 : r > 255 ? 255 : r;
    data[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    data[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

// ── Quantization + dithering ─────────────────────────────────────────────────
// Returns Int32Array of palette indices (-1 = transparent/air).
export function matchImage({ width, height, data }, palette, { dither = 'floyd', ditherStrength = 1 } = {}) {
  const match = makeMatcher(palette);
  const out = new Int32Array(width * height).fill(-1);
  const kernel = KERNELS[dither];

  if (kernel) {
    // error buffers in linear light, serpentine scan
    const errR = new Float32Array(width * height);
    const errG = new Float32Array(width * height);
    const errB = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const ltr = y % 2 === 0;
      for (let step = 0; step < width; step++) {
        const x = ltr ? step : width - 1 - step;
        const i = y * width + x;
        if (data[i * 4 + 3] < 128) continue;
        const lr = clamp01(srgb8ToLinear(data[i * 4]) + errR[i]);
        const lg = clamp01(srgb8ToLinear(data[i * 4 + 1]) + errG[i]);
        const lb = clamp01(srgb8ToLinear(data[i * 4 + 2]) + errB[i]);
        const pi = match(lr, lg, lb);
        out[i] = pi;
        const p = palette[pi].rgb;
        const eR = (lr - srgb8ToLinear(p[0])) * ditherStrength;
        const eG = (lg - srgb8ToLinear(p[1])) * ditherStrength;
        const eB = (lb - srgb8ToLinear(p[2])) * ditherStrength;
        for (const [dx, dy, w] of kernel) {
          const nx = x + (ltr ? dx : -dx), ny = y + dy;
          if (nx < 0 || nx >= width || ny >= height) continue;
          const ni = ny * width + nx;
          errR[ni] += eR * w; errG[ni] += eG * w; errB[ni] += eB * w;
        }
      }
    }
  } else {
    const ordered = dither === 'bayer';
    const amp = 0.09 * ditherStrength;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (data[i * 4 + 3] < 128) continue;
        let t = 0;
        if (ordered) t = BAYER4[(y & 3) * 4 + (x & 3)] * amp;
        const lr = clamp01(srgb8ToLinear(data[i * 4]) + t);
        const lg = clamp01(srgb8ToLinear(data[i * 4 + 1]) + t);
        const lb = clamp01(srgb8ToLinear(data[i * 4 + 2]) + t);
        out[i] = match(lr, lg, lb);
      }
    }
  }
  return out;
}

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// ── Staircase height solver ──────────────────────────────────────────────────
// Shade → relation to the block one north: dark(0) → strictly lower,
// normal(1) → equal, bright(2) → strictly higher (by exactly 1 when rising;
// drops can be any size, which the "valley" solver exploits to reset to y=0).
function solveSegment(rels, style) {
  const n = rels.length + 1;
  const h = new Int32Array(n);
  if (style === 'classic') {
    let min = 0;
    for (let i = 1; i < n; i++) {
      h[i] = h[i - 1] + rels[i - 1];
      if (h[i] < min) min = h[i];
    }
    if (min < 0) for (let i = 0; i < n; i++) h[i] -= min;
    return h;
  }
  // valley: minimal peak height
  for (let i = 1; i < n; i++) {
    const r = rels[i - 1];
    if (r === 0) h[i] = h[i - 1];
    else if (r === 1) h[i] = h[i - 1] + 1;
    else {
      if (h[i - 1] === 0) {
        // No room to drop: raise the trailing run by 1. Stop at a previous
        // drop with slack ≥ 2 (its constraint survives the raise), else raise
        // the whole prefix.
        let j = i - 1;
        while (j >= 1 && !(rels[j - 1] === -1 && h[j - 1] - h[j] >= 2)) j--;
        for (let k = j; k <= i - 1; k++) h[k]++;
      }
      h[i] = 0;
    }
  }
  return h;
}

const REL_BY_SHADE = [-1, 0, 1]; // shade idx → height relation vs north block

// Computes per-block heights and the noobline (anchor row north of the map).
export function computeHeights(width, height, grid, palette, { mode, staircaseStyle = 'valley' }) {
  const heights = new Int16Array(width * height);
  const noob = new Int16Array(width).fill(-1);
  let maxHeight = 0;
  if (mode === 'flat') {
    for (let x = 0; x < width; x++) if (grid[x] >= 0) noob[x] = 0;
    return { heights, noob, maxHeight: 0 };
  }
  for (let x = 0; x < width; x++) {
    let z = 0;
    while (z < height) {
      if (grid[z * width + x] < 0) { z++; continue; }
      const start = z;
      while (z < height && grid[z * width + x] >= 0) z++;
      const end = z; // segment [start, end)
      const anchored = start === 0;
      const rels = [];
      if (anchored) rels.push(REL_BY_SHADE[palette[grid[start * width + x]].shade]);
      for (let i = start + 1; i < end; i++) rels.push(REL_BY_SHADE[palette[grid[i * width + x]].shade]);
      const h = solveSegment(rels, staircaseStyle);
      let hi = 0;
      if (anchored) noob[x] = h[hi++];
      for (let i = start; i < end; i++) {
        heights[i * width + x] = h[hi];
        if (h[hi] > maxHeight) maxHeight = h[hi];
        hi++;
      }
      if (anchored && noob[x] > maxHeight) maxHeight = noob[x];
    }
  }
  return { heights, noob, maxHeight };
}

// ── Full build ───────────────────────────────────────────────────────────────
export function buildMapData(image, opts) {
  const { width, height } = image;
  const {
    mode = 'staircase', staircaseStyle = 'valley', dither = 'floyd', ditherStrength = 1,
    adjustments = {}, enabledBlocks, supports = 'none', supportBlock = 'cobblestone',
  } = opts;

  const palette = buildPalette(enabledBlocks, mode);
  if (palette.length === 0) return null;

  const data = new Uint8ClampedArray(image.data); // don't mutate caller's copy
  applyAdjustments(data, adjustments);
  const grid = matchImage({ width, height, data }, palette, { dither, ditherStrength });
  const { heights, noob, maxHeight } = computeHeights(width, height, grid, palette, { mode, staircaseStyle });

  // Supports: 's'-flagged blocks (glow lichen) always need one; gravity blocks
  // need one under 'gravity' mode; every block gets one under 'all'.
  const needsSupport = (block) => !!block.s || (supports === 'all') || (supports === 'gravity' && !!block.g);
  let anySupportAtZero = false;
  const materials = new Map();
  let totalBlocks = 0, supportCount = 0, noobCount = 0;

  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) continue;
    const block = palette[grid[i]].block;
    materials.set(block.id, (materials.get(block.id) || 0) + 1);
    totalBlocks++;
    if (needsSupport(block)) {
      supportCount++;
      if (heights[i] === 0) anySupportAtZero = true;
    }
  }
  for (let x = 0; x < width; x++) if (noob[x] >= 0) noobCount++;
  totalBlocks += supportCount + noobCount;

  const yOffset = anySupportAtZero ? 1 : 0;
  const ySize = Math.max(1, maxHeight + 1 + yOffset);

  // preview pixels (exact final map colors)
  const previewRGBA = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) continue;
    const [r, g, b] = palette[grid[i]].rgb;
    previewRGBA[i * 4] = r; previewRGBA[i * 4 + 1] = g; previewRGBA[i * 4 + 2] = b; previewRGBA[i * 4 + 3] = 255;
  }

  const materialRows = [...materials.entries()]
    .map(([id, count]) => ({ block: BLOCK_BY_ID.get(id), count }))
    .sort((a, b) => b.count - a.count);
  const extra = supportCount + noobCount;
  if (extra > 0) {
    const sb = BLOCK_BY_ID.get(supportBlock) || { id: supportBlock, name: supportBlock };
    materialRows.push({ block: sb, count: extra, isSupport: true, noobCount, supportCount });
  }

  return {
    width, height, grid, palette, heights, noob, maxHeight,
    yOffset, ySize, materials: materialRows, totalBlocks,
    supports, supportBlock, needsSupport, previewRGBA, mode,
  };
}
