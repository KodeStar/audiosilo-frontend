import type { ReadalongMap, ReadalongSpan } from '@/api/types';
import { isRecord } from '@/lib/storage-keys';

/**
 * The player's check of a read-along map (Bridge Phase 3c, `audiosilo-readalong/v1`) as the
 * server sends it (`client.readalong`) or a download kept it. The server checks only the
 * head (format, ebook sha256, audio files, coverage, `sections` an array); every span is
 * checked here, field by field: a `cfi` that starts `epubcfi(` and is at most 1024 bytes,
 * and finite times with `0 <= start <= end`. A span that fails is dropped (counted in
 * `dropped`), never the map; a section without an `href` string or a `spans` array is
 * dropped with its spans. The map's `gaps` and `audio_gaps` are not kept: the player does
 * not use them.
 */

/** The map's format, exactly. */
const READALONG_FORMAT = 'audiosilo-readalong/v1';

/** The longest CFI a span may carry, in UTF-8 bytes. */
export const MAX_READALONG_CFI_BYTES = 1024;

/** The most sections and spans the player takes from one map (the server bounds the file at
 * 16 MiB, about 80 000 sentences): anything past them is dropped. */
const MAX_SECTIONS = 10_000;
const MAX_SPANS = 200_000;
const MAX_HREF = 2048;

/** A map the player checked, with how many of its spans failed the check. */
export type CheckedReadalongMap = ReadalongMap & { dropped: number };

/** The UTF-8 length of `s`, counted only as far as `limit` (past it, `limit + 1`). */
export function utf8Length(s: string, limit = Infinity): number {
  if (s.length > limit) return limit + 1;
  let bytes = 0;
  for (let i = 0; i < s.length && bytes <= limit; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** One span, checked; null when it fails. */
export function checkReadalongSpan(v: unknown): ReadalongSpan | null {
  if (!isRecord(v)) return null;
  const { cfi, start, end } = v;
  if (typeof cfi !== 'string' || !cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) return null;
  if (utf8Length(cfi, MAX_READALONG_CFI_BYTES) > MAX_READALONG_CFI_BYTES) return null;
  if (!finite(start) || !finite(end) || start < 0 || start > end) return null;
  return { cfi, start, end };
}

/** A whole map, checked; null when it is no `audiosilo-readalong/v1` map at all. */
export function parseReadalongMap(data: unknown): CheckedReadalongMap | null {
  if (!isRecord(data) || data.format !== READALONG_FORMAT || !Array.isArray(data.sections)) {
    return null;
  }
  let dropped = 0;
  let total = 0;
  const sections: ReadalongMap['sections'] = [];
  for (const raw of data.sections.slice(0, MAX_SECTIONS)) {
    if (!isRecord(raw) || typeof raw.href !== 'string' || !Array.isArray(raw.spans)) {
      if (isRecord(raw) && Array.isArray(raw.spans)) dropped += raw.spans.length;
      continue;
    }
    const spans: ReadalongSpan[] = [];
    for (const s of raw.spans) {
      const span = total < MAX_SPANS ? checkReadalongSpan(s) : null;
      if (span) {
        spans.push(span);
        total++;
      } else dropped++;
    }
    sections.push({ href: raw.href.slice(0, MAX_HREF), spans });
  }
  const ebook = isRecord(data.ebook) ? data.ebook : {};
  const audio = isRecord(data.audio) ? data.audio : {};
  const coverage = isRecord(data.coverage) ? data.coverage : {};
  const generator = isRecord(data.generator) ? data.generator : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : '');
  const share = (v: unknown) => (finite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return {
    format: READALONG_FORMAT,
    ebook: { file: text(ebook.file), sha256: text(ebook.sha256) },
    audio: {
      duration: finite(audio.duration) && audio.duration > 0 ? audio.duration : 0,
      files: Array.isArray(audio.files)
        ? audio.files.flatMap((f) =>
            isRecord(f) && typeof f.path === 'string' && finite(f.duration)
              ? [{ path: f.path, duration: f.duration }]
              : [],
          )
        : [],
    },
    granularity: text(data.granularity),
    generator: { name: text(generator.name), version: text(generator.version) },
    generated_at: text(data.generated_at),
    coverage: { text: share(coverage.text), audio: share(coverage.audio) },
    sections,
    dropped,
  };
}

/** Whether a checked map has any sentence to follow. */
export function hasSpans(map: Pick<ReadalongMap, 'sections'>): boolean {
  return map.sections.some((s) => s.spans.length > 0);
}

/** What the reader document is sent of a map (`readalong {map}`): its sections' hrefs and
 * spans, nothing of the head. */
export type ReaderReadalongMap = { sections: { href: string; spans: ReadalongSpan[] }[] };

export function readerMapOf(map: Pick<ReadalongMap, 'sections'>): ReaderReadalongMap {
  return { sections: map.sections.map(({ href, spans }) => ({ href, spans })) };
}

/** Where the narration is at `t` (whole-book seconds) in a map: the CFI of the latest
 * sentence starting at or before it (a reader opens there, then follows), or undefined
 * before the first. */
export function cfiAt(map: ReaderReadalongMap, t: number): string | undefined {
  let best: ReadalongSpan | undefined;
  for (const section of map.sections) {
    for (const span of section.spans) {
      if (span.start <= t && (!best || span.start > best.start)) best = span;
    }
  }
  return best?.cfi;
}
