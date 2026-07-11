// Engine verification: runs the exact browser modules in Node.
//  1. staircase invariants — heights must reproduce the assigned shades
//  2. litematic integrity — gunzip, parse NBT, unpack every bit-packed entry
//     and compare against an independently derived expected world.
import { gunzipSync } from 'node:zlib';
import { BLOCKS, BASE_COLORS, MC_DATA_VERSION, shadeRGB } from '../js/palette.js';
import { buildMapData, buildPalette } from '../js/mapart.js';
import { buildLitematicNBT, gzipBytes } from '../js/litematic.js';

let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error('  FAIL:', msg); }
};

// ── synthetic test image: gradients, shapes, hard edges, transparency ────────
function makeImage(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      data[i] = (x / (w - 1)) * 255;
      data[i + 1] = (y / (h - 1)) * 255;
      data[i + 2] = 255 - (x / (w - 1)) * 255;
      data[i + 3] = 255;
      const dx = x - w / 2, dy = y - h / 2;
      if (dx * dx + dy * dy < (w / 6) ** 2) { data[i] = 250; data[i + 1] = 210; data[i + 2] = 40; }
      if (x > w * 0.8 && y < h * 0.15) data[i + 3] = 0;              // transparent patch
      if (y === Math.floor(h / 2) && x % 9 < 3) data[i + 3] = 0;     // scattered gaps mid-column
    }
  }
  return { width: w, height: h, data };
}

const allBlocks = BLOCKS.map(b => b.id);
const img = makeImage(128, 128);

// ── 1. palette sanity ────────────────────────────────────────────────────────
console.log('palette…');
{
  const flat = buildPalette(allBlocks, 'flat');
  const stair = buildPalette(allBlocks, 'staircase');
  const colorIds = new Set(flat.map(e => e.colorId));
  check(colorIds.size === Object.keys(BASE_COLORS).length, `flat palette covers ${colorIds.size}/61 base colors`);
  check(stair.length === flat.length * 3, 'staircase palette has 3 shades per color');
  check(flat.every(e => e.shade === 1), 'flat palette uses only the normal shade');
  const s = stair.find(e => e.colorId === 8 && e.shade === 2);
  check(s && s.rgb.join() === '255,255,255', 'SNOW bright shade is pure white');
  const d = stair.find(e => e.colorId === 8 && e.shade === 0);
  check(d && d.rgb.join() === '180,180,180', 'SNOW dark shade is 180,180,180');
}

// ── 2. staircase invariants ──────────────────────────────────────────────────
console.log('staircase solver…');
function checkShadeConsistency(map, label) {
  const { width, height, grid, palette, heights, noob } = map;
  let bad = 0, checked = 0;
  for (let x = 0; x < width; x++) {
    for (let z = 0; z < height; z++) {
      const gi = z * width + x;
      if (grid[gi] < 0) continue;
      const shade = palette[grid[gi]].shade;
      let northH = null;
      if (z === 0) northH = noob[x] >= 0 ? noob[x] : null;
      else if (grid[(z - 1) * width + x] >= 0) northH = heights[(z - 1) * width + x];
      if (northH === null) continue; // post-gap segment start: shade is free
      checked++;
      const h = heights[gi];
      const expected = h > northH ? 2 : h < northH ? 0 : 1;
      if (expected !== shade) bad++;
    }
  }
  check(bad === 0, `${label}: ${bad}/${checked} pixels violate the shade/height relation`);
  check(checked > 10000, `${label}: enough pixels checked (${checked})`);
  let min = Infinity;
  for (let x = 0; x < width; x++) for (let z = 0; z < height; z++) {
    const gi = z * width + x;
    if (grid[gi] >= 0 && heights[gi] < min) min = heights[gi];
  }
  check(min >= 0, `${label}: no negative heights`);
}

const base = { enabledBlocks: allBlocks, dither: 'floyd', ditherStrength: 1 };
const valley = buildMapData(img, { ...base, mode: 'staircase', staircaseStyle: 'valley' });
const classic = buildMapData(img, { ...base, mode: 'staircase', staircaseStyle: 'classic' });
const flatMap = buildMapData(img, { ...base, mode: 'flat', dither: 'none' });

checkShadeConsistency(valley, 'valley');
checkShadeConsistency(classic, 'classic');
check(valley.maxHeight <= classic.maxHeight, `valley max height (${valley.maxHeight}) ≤ classic (${classic.maxHeight})`);
check(flatMap.maxHeight === 0 && flatMap.heights.every(v => v === 0), 'flat mode is flat');
check(flatMap.palette.every(e => e.shade === 1), 'flat mode only normal shades');
console.log(`  valley max height: ${valley.maxHeight}, classic: ${classic.maxHeight}`);

// materials sum equals total blocks
{
  const sum = valley.materials.reduce((a, r) => a + r.count, 0);
  check(sum === valley.totalBlocks, `materials sum (${sum}) === totalBlocks (${valley.totalBlocks})`);
}

// ── 3. NBT parse + litematic integrity ───────────────────────────────────────
console.log('litematic…');
function parseNBT(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 0;
  const readStr = () => {
    const len = view.getUint16(pos); pos += 2;
    const s = new TextDecoder().decode(buf.subarray(pos, pos + len)); pos += len;
    return s;
  };
  function payload(type) {
    switch (type) {
      case 1: return view.getInt8(pos++);
      case 2: { const v = view.getInt16(pos); pos += 2; return v; }
      case 3: { const v = view.getInt32(pos); pos += 4; return v; }
      case 4: { const v = view.getBigInt64(pos); pos += 8; return v; }
      case 5: { const v = view.getFloat32(pos); pos += 4; return v; }
      case 6: { const v = view.getFloat64(pos); pos += 8; return v; }
      case 7: { const n = view.getInt32(pos); pos += 4 + n; return null; }
      case 8: return readStr();
      case 9: {
        const et = view.getUint8(pos++); const n = view.getInt32(pos); pos += 4;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(payload(et));
        return arr;
      }
      case 10: {
        const obj = {};
        for (;;) {
          const t = view.getUint8(pos++);
          if (t === 0) return obj;
          obj[readStr()] = payload(t);
        }
      }
      case 11: { const n = view.getInt32(pos); pos += 4; const a = []; for (let i = 0; i < n; i++) { a.push(view.getInt32(pos)); pos += 4; } return a; }
      case 12: { const n = view.getInt32(pos); pos += 4; const a = new BigInt64Array(n); for (let i = 0; i < n; i++) { a[i] = view.getBigInt64(pos); pos += 8; } return a; }
      default: throw new Error('bad tag ' + type);
    }
  }
  const rootType = view.getUint8(pos++);
  readStr();
  return payload(rootType);
}

const nbtBytes = buildLitematicNBT(valley, { name: 'verify_art', author: 'test' });
const gz = await gzipBytes(nbtBytes);
check(gz[0] === 0x1f && gz[1] === 0x8b, 'gzip magic bytes present');
const roundTrip = gunzipSync(Buffer.from(gz));
check(Buffer.compare(roundTrip, Buffer.from(nbtBytes)) === 0, 'gzip round-trip is lossless');

const root = parseNBT(nbtBytes);
check(root.MinecraftDataVersion === MC_DATA_VERSION, `DataVersion === ${MC_DATA_VERSION}`);
check(root.Version === 6, 'litematic Version === 6');
const region = root.Regions.verify_art;
check(!!region, 'region present under its name');
const { x: sx, y: sy, z: sz } = region.Size;
check(sx === 128 && sz === 129, `region size ${sx}×${sy}×${sz} (z includes noobline row)`);
check(sy === valley.ySize, 'region Y matches computed ySize');
check(region.BlockStatePalette[0].Name === 'minecraft:air', 'palette[0] is air');
check(root.Metadata.EnclosingSize.x === sx, 'EnclosingSize matches');

// independently rebuild the expected world and compare EVERY entry
const stateOf = s => s.Name + (s.Properties ? JSON.stringify(Object.fromEntries(Object.entries(s.Properties).sort())) : '');
const stateIdx = new Map(region.BlockStatePalette.map((s, i) => [stateOf(s), i]));
const keyFor = b => b.mc + (b.props ? JSON.stringify(Object.fromEntries(Object.entries(Object.fromEntries(Object.entries(b.props).map(([k, v]) => [k, v]))).sort())) : '');

const expected = new Map(); // linear index → palette index
const put = (x, y, z, idx) => expected.set((y * sz + z) * sx + x, idx);
const supportKey = 'minecraft:' + valley.supportBlock;
const supportIdx = stateIdx.get(supportKey);
check(supportIdx !== undefined, 'support block present in palette');
for (let x = 0; x < 128; x++) {
  if (valley.noob[x] >= 0) put(x, valley.noob[x] + valley.yOffset, 0, supportIdx);
}
let missingState = 0;
for (let z = 0; z < 128; z++) {
  for (let x = 0; x < 128; x++) {
    const gi = z * 128 + x;
    if (valley.grid[gi] < 0) continue;
    const block = valley.palette[valley.grid[gi]].block;
    const idx = stateIdx.get(keyFor(block));
    if (idx === undefined) { missingState++; continue; }
    const y = valley.heights[gi] + valley.yOffset;
    put(x, y, z + 1, idx);
    if (valley.needsSupport(block) && y > 0) put(x, y - 1, z + 1, supportIdx);
  }
}
check(missingState === 0, `all art block states found in palette (${missingState} missing)`);

const bits = Math.max(2, 32 - Math.clz32(Math.max(1, region.BlockStatePalette.length - 1)));
const longs = region.BlockStates;
const mask = (1n << BigInt(bits)) - 1n;
function entryAt(i) {
  const bitPos = i * bits;
  const j = bitPos >> 6, off = BigInt(bitPos & 63);
  let v = (BigInt.asUintN(64, longs[j]) >> off) & mask;
  if ((bitPos & 63) + bits > 64) v |= (BigInt.asUintN(64, longs[j + 1]) << (64n - off)) & mask;
  return Number(v);
}
const volume = sx * sy * sz;
check(longs.length === Math.ceil(volume * bits / 64), 'BlockStates long count correct');
let wrong = 0, nonAir = 0;
for (let i = 0; i < volume; i++) {
  const got = entryAt(i);
  const want = expected.get(i) ?? 0;
  if (got !== want) wrong++;
  if (got !== 0) nonAir++;
}
check(wrong === 0, `every packed entry matches expectation (${wrong} wrong of ${volume})`);
check(nonAir === expected.size, `non-air count ${nonAir} === expected ${expected.size}`);
check(root.Metadata.TotalBlocks === nonAir, `Metadata.TotalBlocks (${root.Metadata.TotalBlocks}) === ${nonAir}`);
console.log(`  ${nonAir} blocks, ${region.BlockStatePalette.length} palette states, ${bits} bits/entry, ${gz.length} bytes gzipped`);

// ── 4. flat map litematic quick check ────────────────────────────────────────
{
  const nbt = buildLitematicNBT(flatMap, { name: 'flat_art' });
  const r = parseNBT(nbt);
  check(r.Regions.flat_art.Size.y === 1, 'flat map region is 1 block tall');
}

// ── 5. gravity supports (powder-only palette forces gravity blocks) ──────────
{
  const powders = BLOCKS.filter(b => b.cat === 'powder').map(b => b.id);
  const m = buildMapData(img, { ...base, enabledBlocks: powders, mode: 'staircase', supports: 'gravity', supportBlock: 'netherrack' });
  const supRow = m.materials.find(r => r.isSupport);
  const art = m.materials.filter(r => !r.isSupport).reduce((a, r) => a + r.count, 0);
  check(!!supRow && supRow.supportCount === art, 'every powder block gets a support');
  check(m.yOffset === 1, 'yOffset shifts art up when a support sits below y=0');
  const nbt = buildLitematicNBT(m, { name: 'powder' });
  const r = parseNBT(nbt);
  check(r.Metadata.TotalBlocks === m.totalBlocks, 'litematic TotalBlocks matches (with supports)');
  check(r.Regions.powder.Size.y === m.ySize, 'region grew for the support layer');
}

// ── 6. valley solver beats classic on drop-reset patterns ────────────────────
{
  const { computeHeights } = await import('../js/mapart.js');
  // single column: 10 bright, 1 dark, 10 bright  (classic peaks ~19, valley 10)
  const shades = [1, ...Array(10).fill(2), 0, ...Array(10).fill(2)];
  const stub = shades.map(s => ({ shade: s }));
  const grid = new Int32Array(shades.map((_, i) => i));
  const v = computeHeights(1, shades.length, grid, stub, { mode: 'staircase', staircaseStyle: 'valley' });
  const c = computeHeights(1, shades.length, grid, stub, { mode: 'staircase', staircaseStyle: 'classic' });
  check(v.maxHeight < c.maxHeight, `valley (${v.maxHeight}) strictly lower than classic (${c.maxHeight}) on reset pattern`);
  check(v.maxHeight === 10, `valley reaches optimal height 10 (got ${v.maxHeight})`);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECKS FAILED`);
process.exit(failures ? 1 : 0);
