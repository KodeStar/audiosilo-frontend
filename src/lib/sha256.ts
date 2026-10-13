/**
 * SHA-256 (FIPS 180-4) in plain JS, synchronous. The profile PIN hash iterates it 10,000
 * times (`profile-pin.ts`): through expo-crypto that is 10,000 asynchronous native calls
 * (or SubtleCrypto promises on the web, where `crypto.subtle` exists only in a secure
 * context, so a player served over plain HTTP on the LAN has none). Those rounds go through
 * `chainSalted`, a one-block SHA-256 that allocates nothing per round: about 170 ms for all
 * 10,000 without a JIT on an M-class Mac (Hermes on a phone is slower, a mid-range Android
 * several times so), which is why `hashPin` runs them in chunks that let the UI paint. The
 * general `sha256` is for one-off digests. Both are checked against the standard's test
 * vectors and node's `crypto` (`sha256.test.ts`).
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** UTF-8 bytes of `s` (TextEncoder where the runtime has it). */
export function utf8(s: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s);
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return new Uint8Array(out);
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** The SHA-256 digest of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  const bitLen = data.length * 8;
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  // Lengths here are far below 2^32 bits: the high word stays 0.
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

// --- The PIN chain: one fixed block per round ----------------------------------------------

/** The initial hash value (FIPS 180-4 5.3.3), as signed 32-bit words. */
const IV = new Int32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);
/** The message schedule, reused by every round (`chainSalted` never awaits). */
const W = new Int32Array(64);

/** `bytes` as big-endian 32-bit words (a length that is a multiple of 4). */
export function wordsOf(bytes: Uint8Array): Int32Array {
  const out = new Int32Array(bytes.length >> 2);
  for (let i = 0; i < out.length; i++) {
    const o = i * 4;
    out[i] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
  }
  return out;
}

/** 32-bit words as lowercase hex, big-endian (a digest's usual spelling). */
export function hexOfWords(words: Int32Array): string {
  let out = '';
  for (let i = 0; i < words.length; i++) out += (words[i] >>> 0).toString(16).padStart(8, '0');
  return out;
}

/**
 * `rounds` more links of a salted chain, in place: `digest` (8 words) becomes
 * SHA-256(salt + digest), `rounds` times over. The salt is 4 words (16 bytes), so the
 * message is always 48 bytes: ONE block, padded the same way every round (the 0x80 byte,
 * then the length, 384 bits). So a round is one compression over a schedule array reused
 * for all of them, with no allocation, no DataView and no destructuring, which is what the
 * general `sha256` spends most of a short message's time on.
 */
export function chainSalted(salt: Int32Array, digest: Int32Array, rounds: number): void {
  const w = W;
  for (let r = 0; r < rounds; r++) {
    w[0] = salt[0];
    w[1] = salt[1];
    w[2] = salt[2];
    w[3] = salt[3];
    for (let i = 0; i < 8; i++) w[4 + i] = digest[i];
    w[12] = 0x80000000 | 0;
    w[13] = 0;
    w[14] = 0;
    w[15] = 384;
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = IV[0];
    let b = IV[1];
    let c = IV[2];
    let d = IV[3];
    let e = IV[4];
    let f = IV[5];
    let g = IV[6];
    let h = IV[7];
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    digest[0] = (IV[0] + a) | 0;
    digest[1] = (IV[1] + b) | 0;
    digest[2] = (IV[2] + c) | 0;
    digest[3] = (IV[3] + d) | 0;
    digest[4] = (IV[4] + e) | 0;
    digest[5] = (IV[5] + f) | 0;
    digest[6] = (IV[6] + g) | 0;
    digest[7] = (IV[7] + h) | 0;
  }
}
