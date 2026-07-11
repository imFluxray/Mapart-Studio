// Litematica schematic exporter (format version 6, Minecraft 1.21.11).
// Layout: the noobline sits at z = 0 (one row north of the art, outside the
// rendered map area — it fixes the shade of the first art row), art occupies
// z = 1 … height. Block index = (y * sizeZ + z) * sizeX + x, entries packed
// bits-tight into 64-bit longs (entries may span long boundaries).

import { MC_DATA_VERSION } from './palette.js';
import { writeNBT, Int, LongNum, Str, List, Compound, LongArrayWords } from './nbt.js';

function stateKey(mc, props) {
  return props ? mc + JSON.stringify(props) : mc;
}

export function buildLitematicNBT(map, { name = 'Map Art', author = 'Mapsmith', description = '' } = {}) {
  const { width, height, grid, palette, heights, noob, yOffset, ySize } = map;
  const sizeX = width, sizeY = ySize, sizeZ = height + 1;
  const volume = sizeX * sizeY * sizeZ;

  // block state palette (air first)
  const states = [{ mc: 'minecraft:air' }];
  const stateIndex = new Map([['minecraft:air', 0]]);
  const idxOf = (mc, props) => {
    const key = stateKey(mc, props);
    let i = stateIndex.get(key);
    if (i === undefined) {
      i = states.length;
      states.push({ mc, props });
      stateIndex.set(key, i);
    }
    return i;
  };

  const supportMc = `minecraft:${map.supportBlock}`;

  // Register every state up front so the packing bit-width is final.
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] < 0) continue;
    const b = palette[grid[i]].block;
    idxOf(b.mc, b.props);
  }
  let needsSupportBlock = false;
  for (let x = 0; x < width; x++) if (noob[x] >= 0) { needsSupportBlock = true; break; }
  if (!needsSupportBlock) {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] >= 0 && map.needsSupport(palette[grid[i]].block)) { needsSupportBlock = true; break; }
    }
  }
  if (needsSupportBlock) idxOf(supportMc, undefined);

  const realBits = Math.max(2, 32 - Math.clz32(Math.max(1, states.length - 1)));
  const longCount = Math.ceil(volume * realBits / 64);
  const words = new Uint32Array(longCount * 2);
  const setBlock = (x, y, z, idx) => {
    const li = (y * sizeZ + z) * sizeX + x;
    const bitPos = li * realBits;
    const w = bitPos >>> 5, off = bitPos & 31;
    words[w] |= (idx << off) >>> 0;
    const spill = off + realBits - 32;
    if (spill > 0) words[w + 1] |= idx >>> (realBits - spill);
  };

  let totalBlocks = 0;
  const supportIdx = needsSupportBlock ? stateIndex.get(stateKey(supportMc, undefined)) : -1;
  for (let x = 0; x < width; x++) {
    if (noob[x] >= 0) { setBlock(x, noob[x] + yOffset, 0, supportIdx); totalBlocks++; }
  }
  for (let z = 0; z < height; z++) {
    for (let x = 0; x < width; x++) {
      const gi = z * width + x;
      if (grid[gi] < 0) continue;
      const entry = palette[grid[gi]];
      const y = heights[gi] + yOffset;
      setBlock(x, y, z + 1, idxOf(entry.block.mc, entry.block.props));
      totalBlocks++;
      if (map.needsSupport(entry.block) && y > 0) { setBlock(x, y - 1, z + 1, supportIdx); totalBlocks++; }
    }
  }

  const now = Date.now();
  const paletteNBT = states.map(s => {
    const c = { Name: Str(s.mc) };
    if (s.props) c.Properties = Compound(Object.fromEntries(Object.entries(s.props).map(([k, v]) => [k, Str(v)])));
    return Compound(c);
  });

  const region = Compound({
    Position: Compound({ x: Int(0), y: Int(0), z: Int(0) }),
    Size: Compound({ x: Int(sizeX), y: Int(sizeY), z: Int(sizeZ) }),
    BlockStatePalette: List(10, paletteNBT),
    BlockStates: LongArrayWords(words, longCount),
    Entities: List(10, []),
    TileEntities: List(10, []),
    PendingBlockTicks: List(10, []),
    PendingFluidTicks: List(10, []),
  });

  const root = Compound({
    MinecraftDataVersion: Int(MC_DATA_VERSION),
    Version: Int(6),
    Metadata: Compound({
      Name: Str(name),
      Author: Str(author),
      Description: Str(description),
      RegionCount: Int(1),
      TotalVolume: Int(volume),
      TotalBlocks: Int(totalBlocks),
      TimeCreated: LongNum(now),
      TimeModified: LongNum(now),
      EnclosingSize: Compound({ x: Int(sizeX), y: Int(sizeY), z: Int(sizeZ) }),
    }),
    Regions: Compound({ [name]: region }),
  });

  return writeNBT(root);
}

export async function gzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildLitematicFile(map, meta) {
  return gzipBytes(buildLitematicNBT(map, meta));
}
