// Minimal big-endian NBT writer — just enough for litematic files.
// Longs are handled as [lo32, hi32] word pairs so no BigInt is needed in the
// hot path (BlockStates packing writes 32-bit words directly).

export const Byte = v => ({ type: 1, value: v });
export const Short = v => ({ type: 2, value: v });
export const Int = v => ({ type: 3, value: v });
export const LongNum = v => ({ type: 4, value: v }); // plain JS number (< 2^53)
export const Float = v => ({ type: 5, value: v });
export const Double = v => ({ type: 6, value: v });
export const Str = v => ({ type: 8, value: v });
export const List = (elementType, values) => ({ type: 9, elementType, value: values });
export const Compound = obj => ({ type: 10, value: obj });
export const IntArray = arr => ({ type: 11, value: arr });
// words: Uint32Array [lo0, hi0, lo1, hi1, ...], count = number of longs
export const LongArrayWords = (words, count) => ({ type: 12, words, count });

class Out {
  constructor() {
    this.buf = new Uint8Array(1 << 20);
    this.view = new DataView(this.buf.buffer);
    this.len = 0;
    this.enc = new TextEncoder();
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v) { this.ensure(1); this.view.setUint8(this.len, v); this.len += 1; }
  i16(v) { this.ensure(2); this.view.setInt16(this.len, v); this.len += 2; }
  i32(v) { this.ensure(4); this.view.setInt32(this.len, v); this.len += 4; }
  f32(v) { this.ensure(4); this.view.setFloat32(this.len, v); this.len += 4; }
  f64(v) { this.ensure(8); this.view.setFloat64(this.len, v); this.len += 8; }
  u32(v) { this.ensure(4); this.view.setUint32(this.len, v); this.len += 4; }
  str(s) {
    const bytes = this.enc.encode(s);
    this.ensure(2 + bytes.length);
    this.view.setUint16(this.len, bytes.length); this.len += 2;
    this.buf.set(bytes, this.len); this.len += bytes.length;
  }
}

function writePayload(out, tag) {
  switch (tag.type) {
    case 1: out.u8(tag.value & 0xff); break;
    case 2: out.i16(tag.value); break;
    case 3: out.i32(tag.value); break;
    case 4: { // number → two 32-bit halves (values here are ≥ 0 and < 2^53)
      const v = tag.value;
      out.u32(Math.floor(v / 4294967296));
      out.u32(v >>> 0 === v ? v : v % 4294967296);
      break;
    }
    case 5: out.f32(tag.value); break;
    case 6: out.f64(tag.value); break;
    case 8: out.str(tag.value); break;
    case 9:
      out.u8(tag.value.length === 0 ? 0 : tag.elementType);
      out.i32(tag.value.length);
      for (const v of tag.value) writePayload(out, v);
      break;
    case 10:
      for (const [name, sub] of Object.entries(tag.value)) {
        out.u8(sub.type);
        out.str(name);
        writePayload(out, sub);
      }
      out.u8(0);
      break;
    case 11:
      out.i32(tag.value.length);
      for (const v of tag.value) out.i32(v);
      break;
    case 12:
      out.i32(tag.count);
      for (let i = 0; i < tag.count; i++) {
        out.u32(tag.words[i * 2 + 1]); // hi word first (big-endian long)
        out.u32(tag.words[i * 2]);
      }
      break;
    default: throw new Error(`unknown tag type ${tag.type}`);
  }
}

export function writeNBT(rootCompound) {
  const out = new Out();
  out.u8(10);
  out.str('');
  writePayload(out, rootCompound);
  return out.buf.slice(0, out.len);
}
