/**
 * The seek bar's bars (STYLEGUIDE section 8, "Seek bar"): owner decision, STYLISED bars.
 * They are a texture, not audio - a deterministic, speech-like envelope seeded by the
 * book and chapter, so a chapter always looks the same and two chapters look different,
 * without pretending to show the sound. When the server can compute real peaks, they
 * replace the texture through the same bar count (`resamplePeaks`), no redesign.
 *
 * Pure, so it is unit-tested; the component only draws `barsPath`.
 */

/** Bar pitch (bar + gap) the count is derived from: 56 bars at a phone's 350 points,
 * capped at 96 (the desktop player). */
const BAR_PITCH = 6.25;
const MIN_BARS = 24;
export const MAX_BARS = 96;
/** The gap between bars, points. */
export const BAR_GAP = 2;

/** How many bars fit `width` points (0 before the first layout). */
export function barCountFor(width: number): number {
  if (!(width > 0)) return 0;
  return Math.max(MIN_BARS, Math.min(MAX_BARS, Math.round(width / BAR_PITCH)));
}

/** FNV-1a, 32-bit: a stable seed from a string. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a small, good-enough deterministic PRNG over [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const textures = new Map<string, readonly number[]>();
/** Textures kept (a session plays a handful of chapters per minute at most). */
const TEXTURE_CACHE = 64;

/**
 * `n` bar heights in [0.12, 1] for `key` (e.g. the book and the chapter): speech-like -
 * a level that wanders from bar to bar with short pauses between phrases. Same key and
 * count, same bars (cached).
 */
export function seekTexture(key: string, n: number): readonly number[] {
  if (n <= 0) return [];
  const id = `${n}|${key}`;
  const hit = textures.get(id);
  if (hit) return hit;
  const random = seededRandom(hashString(key));
  const out: number[] = [];
  let prev = 0.5;
  for (let i = 0; i < n; i++) {
    const pause = random() < 0.07;
    const level = pause
      ? 0.12
      : Math.max(0.15, Math.min(1, prev * 0.45 + (0.25 + random() * 0.75) * 0.55));
    prev = level;
    out.push(level);
  }
  if (textures.size >= TEXTURE_CACHE) textures.delete(textures.keys().next().value!);
  textures.set(id, out);
  return out;
}

/**
 * Real peaks (any length, any scale) as `n` bar heights in [0.08, 1]: each bar is the
 * loudest peak in its slice, scaled to the loudest overall. Null when there is nothing
 * usable, so the caller falls back to the texture.
 */
export function resamplePeaks(peaks: readonly number[], n: number): number[] | null {
  if (n <= 0 || peaks.length === 0) return null;
  const top = Math.max(...peaks.map((p) => (Number.isFinite(p) ? Math.abs(p) : 0)));
  if (!(top > 0)) return null;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * peaks.length) / n);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
    let max = 0;
    for (let j = from; j < to && j < peaks.length; j++) {
      const v = Number.isFinite(peaks[j]) ? Math.abs(peaks[j]) : 0;
      if (v > max) max = v;
    }
    out.push(Math.max(0.08, max / top));
  }
  return out;
}

/** The bar heights to draw: the peaks when they are usable, else the texture. */
export function seekBars(key: string, n: number, peaks?: readonly number[]): readonly number[] {
  return (peaks && resamplePeaks(peaks, n)) || seekTexture(key, n);
}

/**
 * One SVG path drawing every bar as a rounded rectangle, centred on the band's middle:
 * `heights` (0..1 of `height`) across `width` with `gap` between bars. One path per
 * layer, so a layer is a single native view however many bars it has.
 */
export function barsPath(
  heights: readonly number[],
  width: number,
  height: number,
  gap = BAR_GAP,
): string {
  const n = heights.length;
  if (n === 0 || !(width > 0) || !(height > 0)) return '';
  const w = Math.max(1, (width - gap * (n - 1)) / n);
  const r = Math.min(1.5, w / 2);
  const f = (v: number) => Math.round(v * 100) / 100;
  let d = '';
  for (let i = 0; i < n; i++) {
    const h = Math.max(2 * r, heights[i] * height);
    const x = i * (w + gap);
    const y = (height - h) / 2;
    d +=
      `M${f(x + r)} ${f(y)}h${f(w - 2 * r)}a${r} ${r} 0 0 1 ${r} ${r}v${f(h - 2 * r)}` +
      `a${r} ${r} 0 0 1 ${-r} ${r}h${f(-(w - 2 * r))}a${r} ${r} 0 0 1 ${-r} ${-r}` +
      `v${f(-(h - 2 * r))}a${r} ${r} 0 0 1 ${r} ${-r}z`;
  }
  return d;
}
