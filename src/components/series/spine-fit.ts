/**
 * The geometry of a book spine (STYLEGUIDE section 8, "Spine"): its size from the
 * listening length, where its parts sit, and how its title fits. Pure, so the bookcase,
 * the mini shelves and the tests share one set of rules.
 *
 * Text is never measured by a layout pass: a spine would have to render, measure and
 * render again, and a shelf holds dozens. Instead `textAdvance` estimates a string's
 * width from a small per-character table of each font's AVERAGE advance (in ems), by
 * character class: narrow (i, l, punctuation), wide (m, w, capitals M W), other
 * capitals, digits, spaces, CJK (a full em) and everything else. The table was measured
 * in a browser (canvas `measureText` at 100px over each class, Bricolage Grotesque Bold
 * and Figtree SemiBold as the app loads them) and rounded up about 3%, so the estimate
 * errs a little wide: a title that "fits" here has room to spare in the real font.
 */

/** The two families a spine sets its title in: the cover's display face, or the body
 * face (ghost spines, which have no cover). */
export type SpineFont = 'display' | 'sans';

type Advances = {
  narrow: number;
  wide: number;
  upper: number;
  digit: number;
  space: number;
  cjk: number;
  other: number;
};

/** Average advance per character class, in ems. */
export const SPINE_ADVANCE: Record<SpineFont, Advances> = {
  // Bricolage Grotesque 700 (font-display).
  display: { narrow: 0.3, wide: 0.98, upper: 0.7, digit: 0.61, space: 0.24, cjk: 1, other: 0.61 },
  // Figtree 600 (font-sans-semibold).
  sans: { narrow: 0.31, wide: 0.91, upper: 0.7, digit: 0.59, space: 0.25, cjk: 1, other: 0.56 },
};

const NARROW = /[ijlIft.,:;'!|()[\]’-]/;
const WIDE = /[mwMW@%]/;
const CJK = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/;

/** A string's estimated width in ems (multiply by the font size for pixels). */
export function textAdvance(text: string, font: SpineFont): number {
  const a = SPINE_ADVANCE[font];
  let em = 0;
  for (const ch of text) {
    if (ch === ' ') em += a.space;
    else if (CJK.test(ch)) em += a.cjk;
    else if (NARROW.test(ch)) em += a.narrow;
    else if (WIDE.test(ch)) em += a.wide;
    else if (ch >= '0' && ch <= '9') em += a.digit;
    else if (ch !== ch.toLowerCase()) em += a.upper;
    else em += a.other;
  }
  return em;
}

/** JetBrains Mono's advance (every glyph), for the series number at a spine's top. */
export const MONO_ADVANCE = 0.6;

/** The series number's size: 10px at scale 1, smaller when "12.25" must fit a thin
 * spine, never under the floor. */
export function spineIndexSize(position: string, across: number, scale: number): number {
  const n = Math.max(1, [...position].length);
  return Math.max(SPINE_MIN_FONT, Math.min(10 * scale, across / (n * MONO_ADVANCE)));
}

/** The smallest a spine title is ever set (the style guide's 5px floor). */
export const SPINE_MIN_FONT = 5;
/** How far a title may shrink on one line before wrapping is tried (82%). */
export const SPINE_SHRINK = 0.82;
/** Spines at least this wide may set a title on two lines. */
export const SPINE_WRAP_MIN_WIDTH = 40;
/** A title line's height, as a multiple of its size. */
const LINE = 1.1;
/** Base tracking, and the tightened tracking tried before any shrinking (ems). */
const TRACK = 0.02;
const TRACK_TIGHT = -0.02;

export type SpineTitleFit = {
  /** One line, or two (set side by side across the spine). */
  lines: string[];
  fontSize: number;
  /** Letter spacing in ems. */
  letterSpacing: number;
  /** True only as the last resort: the title doesn't fit even at the floor, so the line
   * is ellipsized (and the spine's accessibility label carries the full title). */
  ellipsize: boolean;
};

/** The best break of a title into two lines at a space (the one whose longer line is
 * shortest), or null for a single word. */
function twoLineSplit(text: string, font: SpineFont): [string, string] | null {
  const words = text.split(/\s+/).filter(Boolean);
  let best: { width: number; lines: [string, string] } | null = null;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ');
    const b = words.slice(i).join(' ');
    const width = Math.max(textAdvance(a, font), textAdvance(b, font));
    if (!best || width < best.width) best = { width, lines: [a, b] };
  }
  return best?.lines ?? null;
}

/**
 * How a spine sets its title, rotated to run along `length` (the band between the two
 * bands, in px) on a spine `across` px thick (its width less the side padding):
 * 1. the base size, if the title fits;
 * 2. else the same size with tighter tracking;
 * 3. else one line shrunk to fit, down to 82% of the base;
 * 4. else two lines, on a spine at least 40 px wide, when that sets it larger;
 * 5. else one line shrunk to fit, down to the 5 px floor;
 * 6. else the floor, ellipsized: the only case that cuts the title.
 * The base is first capped so one line fits across the spine's thickness.
 */
export function fitSpineTitle({
  text,
  base,
  length,
  across,
  width,
  font,
}: {
  text: string;
  /** The size the cover's type would be set at, scaled with the shelf. */
  base: number;
  length: number;
  across: number;
  /** The spine's full width, for the two-line rule. */
  width: number;
  font: SpineFont;
}): SpineTitleFit {
  const size = Math.max(SPINE_MIN_FONT, Math.min(base, across / LINE));
  const em = textAdvance(text, font);
  const chars = [...text].length;
  // Width of `em` ems plus tracking on every character, at `fs` px.
  const widthAt = (fs: number, ls: number, ems = em, n = chars) => (ems + n * ls) * fs;

  if (widthAt(size, TRACK) <= length) {
    return { lines: [text], fontSize: size, letterSpacing: TRACK, ellipsize: false };
  }
  if (widthAt(size, TRACK_TIGHT) <= length) {
    return { lines: [text], fontSize: size, letterSpacing: TRACK_TIGHT, ellipsize: false };
  }
  const fsOne = length / Math.max(0.01, em + chars * TRACK_TIGHT);
  if (fsOne >= size * SPINE_SHRINK) {
    return { lines: [text], fontSize: fsOne, letterSpacing: TRACK_TIGHT, ellipsize: false };
  }
  const split = width >= SPINE_WRAP_MIN_WIDTH ? twoLineSplit(text, font) : null;
  if (split) {
    const longer = split.reduce(
      (w, line) => Math.max(w, textAdvance(line, font) + [...line].length * TRACK_TIGHT),
      0,
    );
    const fsTwo = Math.min(size, length / Math.max(0.01, longer), across / (2 * LINE));
    if (fsTwo >= SPINE_MIN_FONT && fsTwo > fsOne) {
      return { lines: split, fontSize: fsTwo, letterSpacing: TRACK_TIGHT, ellipsize: false };
    }
  }
  if (fsOne >= SPINE_MIN_FONT) {
    return { lines: [text], fontSize: fsOne, letterSpacing: TRACK_TIGHT, ellipsize: false };
  }
  return { lines: [text], fontSize: SPINE_MIN_FONT, letterSpacing: TRACK_TIGHT, ellipsize: true };
}

/** A small, stable string hash (FNV-1a), for per-title variation. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** A spine's listening length when it is unknown (a book on no server): ten hours. */
export const UNKNOWN_SPINE_SECONDS = 10 * 3600;

/**
 * A spine's width and height at `scale`: the width follows the listening length
 * (`10 + sqrt(minutes) x 1.1`, clamped 24-72, so a 45-hour book is a thick volume) and
 * the height varies a little per title (one of five steps of 9 from 172), stable for a
 * title.
 */
export function spineDims(
  seconds: number | undefined,
  title: string,
  scale = 1,
): { width: number; height: number } {
  const minutes = (seconds && seconds > 0 ? seconds : UNKNOWN_SPINE_SECONDS) / 60;
  const width = Math.round(Math.min(72, Math.max(24, 10 + Math.sqrt(minutes) * 1.1)) * scale);
  const height = Math.round((172 + (hashString(title) % 5) * 9) * scale);
  return { width, height };
}

/** What sits at a spine's foot. */
export type SpineFoot = 'none' | 'author' | 'finished' | 'server';

/** A spine's vertical layout (px): top padding, the position row, the band that holds
 * the title (between its two coloured rules), the foot and the bottom padding. `length`
 * and `across` are the title's room (see `fitSpineTitle`). */
export type SpineGeometry = {
  padTop: number;
  indexHeight: number;
  bandMargin: number;
  bandHeight: number;
  footHeight: number;
  padBottom: number;
  length: number;
  across: number;
};

/** Spines this wide (at scale 1) show the author's surname at the foot. */
export const SPINE_AUTHOR_MIN_WIDTH = 54;

export function spineGeometry(
  width: number,
  height: number,
  scale: number,
  foot: SpineFoot,
): SpineGeometry {
  const padTop = Math.round(12 * scale);
  const indexHeight = Math.round(12 * scale);
  const bandMargin = Math.round(4 * scale);
  const footHeight =
    foot === 'finished'
      ? Math.round(18 * scale)
      : foot === 'server'
        ? Math.round(14 * scale)
        : foot === 'author'
          ? Math.round(12 * scale)
          : 0;
  const padBottom = Math.round(10 * scale);
  const bandHeight = Math.max(
    18,
    height - padTop - indexHeight - bandMargin * 2 - footHeight - padBottom,
  );
  // The band's two 2px rules and 6px of padding inside each.
  const length = Math.max(12, bandHeight - 4 - Math.round(12 * scale));
  const across = Math.max(8, width - 6);
  return { padTop, indexHeight, bandMargin, bandHeight, footHeight, padBottom, length, across };
}
