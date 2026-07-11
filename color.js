// Perceptual color math. Matching happens in OKLab so "closest block" means
// closest to the eye, not closest in raw RGB — the main lever for color
// preservation. Error diffusion happens in linear light to avoid the
// darkening/banding you get diffusing gamma-encoded values.

const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function srgb8ToLinear(v) { return LIN[v | 0]; }

export function linearToSrgb8(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 255;
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
}

// linear RGB → OKLab (Björn Ottosson's reference matrices)
export function linearToOklab(r, g, b, out) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return out;
}

export function rgb8ToOklab(r, g, b, out = [0, 0, 0]) {
  return linearToOklab(LIN[r | 0], LIN[g | 0], LIN[b | 0], out);
}

export function rgbToHex([r, g, b]) {
  return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
