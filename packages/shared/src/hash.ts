// Murmur3 fmix32 chain. Bit-for-bit port of the prototype grid_hash.gd.
// All inputs are integers; negative coordinates are taken modulo 2^32.

export function fmix32(h: number): number {
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function u32(seed: number, x: number, y: number, salt: number): number {
  let h = fmix32((seed ^ Math.imul(salt, 0x9e3779b1)) >>> 0);
  h = fmix32((h ^ (x >>> 0)) >>> 0);
  return fmix32((h ^ (y >>> 0)) >>> 0);
}

// Float in [0, 1).
export function unit(seed: number, x: number, y: number, salt: number): number {
  return (u32(seed, x, y, salt) >>> 8) / 16777216;
}

// Integer in [lo, hi], inclusive.
export function rangeI(seed: number, x: number, y: number, salt: number, lo: number, hi: number): number {
  return lo + (u32(seed, x, y, salt) % (hi - lo + 1));
}

// One hashed point per coarse cell, in tile coordinates.
export function anchorX(seed: number, cx: number, cy: number, salt: number, cw: number): number {
  return cx * cw + (u32(seed, cx, cy, salt * 2) % cw);
}

export function anchorY(seed: number, cx: number, cy: number, salt: number, ch: number): number {
  return cy * ch + (u32(seed, cx, cy, salt * 2 + 1) % ch);
}

export function anchor(
  seed: number, cx: number, cy: number, salt: number, cw: number, ch: number,
): { x: number; y: number } {
  return { x: anchorX(seed, cx, cy, salt, cw), y: anchorY(seed, cx, cy, salt, ch) };
}
