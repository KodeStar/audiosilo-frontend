import { isRecord } from '@/lib/storage-keys';

import type { ReaderReadalongMap } from './readalong-map';

/**
 * The host side of the ebook reader's message protocol (Bridge Phase 3b). The reader is
 * its own document (`reader/src/reader.js`), built in two variants: on the web
 * (`public/reader.html`) a sandboxed, same-origin iframe, the two talking only by
 * `postMessage` on the page's own origin; in the app (`reader-html.native.ts`, Phase 3b-2)
 * a WebView's HTML source, the two talking over the WebView's bridge as JSON strings.
 *
 * Host -> reader: `open` (where to open, the appearance, and the book: on the web its
 * bytes as a transferable `ArrayBuffer`; in the app its size and chunk count, the bytes
 * following as `chunk`s of base64, `book-chunks.ts`), `goto`, `appearance`, `next`, `prev`.
 * Messages wait in the host until the reader says `ready`.
 *
 * Read-along (Bridge Phase 3c), host -> reader: `readalong {map}` (the map's sections and
 * spans, `readerMapOf`; null to stop; in the app a map over 256 KB of JSON comes as
 * `readalong {length, chunks}` and `readalongChunk {seq, data}` pieces of its text,
 * `readalongMessages`), `position {t, rate, playing}` (the narration's whole-book place,
 * once a second while a map is in, and at once on a play, pause, seek or rate change) and
 * `follow` (back to the narration: turn to the sentence being read and keep following).
 *
 * Reader -> host: `ready`, `opened` (title, flattened TOC, whether the book reads right to
 * left), `progress` (on every move), `loading` (a section is being laid out), `error`,
 * `escape` (Escape pressed in the book, which the host's own keys never see), `csp` (a
 * blocked load, logged); read-along: `seek {t}` (a sentence was tapped: play from its
 * start), `following {value}` (the reader follows the narration, or stopped because the
 * reader turned away) and `readalong {state, unresolved}` (`ok` once a map is in with a
 * sentence in this book's sections, else `none`; `unresolved` counts the spans skipped).
 * The reader parses an EPUB nobody vetted, so its messages are checked here field by field
 * (`parseReaderMessage`) and taken only from that frame's window on our own origin
 * (`acceptReaderMessage`).
 */

export type ReaderTheme = { scheme: 'light' | 'dark'; background: string; foreground: string };

/** Where to open: a CFI first, else a fraction of the book, else the start. */
export type ReaderPlace = { cfi?: string; fraction?: number };

export type GotoTarget = { href: string } | { cfi: string } | { fraction: number };

/** What every `open` carries besides the book. */
export type OpenFields = {
  /** The book's name, the title when the EPUB has none. */
  name: string;
  at?: ReaderPlace;
  theme: ReaderTheme;
  fontScale: number;
};

export type HostMessage =
  | ({ type: 'open'; book: ArrayBuffer } & OpenFields)
  /** The app's open: the book follows in `chunks` chunks of `size` bytes in all. */
  | ({ type: 'open'; size: number; chunks: number } & OpenFields)
  /** One piece of the app's book, `seq` counting from 0, as base64. */
  | { type: 'chunk'; seq: number; data: string }
  | ({ type: 'goto' } & GotoTarget)
  | { type: 'appearance'; theme: ReaderTheme; fontScale: number }
  | { type: 'next' }
  | { type: 'prev' }
  /** A read-along map for the open book (null: none, stop following). */
  | { type: 'readalong'; map: ReaderReadalongMap | null }
  /** The app's large map: its JSON text follows in `chunks` pieces, `length` UTF-16 code
   * units in all. */
  | { type: 'readalong'; length: number; chunks: number }
  /** One piece of the app's large map's JSON text, `seq` counting from 0. */
  | { type: 'readalongChunk'; seq: number; data: string }
  /** The narration's place: whole-book seconds, its speed, and whether it is playing. */
  | ({ type: 'position' } & ReadalongPosition)
  | { type: 'follow' };

/** Where the narration is (`position`): whole-book seconds `t`, its speed `rate`, and
 * whether it is playing (the reader moves its clock on between samples only then). */
export type ReadalongPosition = { t: number; rate: number; playing: boolean };

/** What the reader says of a map it was given (`readalong`): `ok` with a sentence in this
 * book's sections, else `none`; `unresolved` counts the spans it skips (a section this
 * EPUB doesn't have, a CFI that names nothing in it). */
export type ReadalongState = { state: 'ok' | 'none'; unresolved: number };

export type TocEntry = { label: string; href: string; depth: number };

/** `drm`: the book is encrypted; `unreadable`: not an EPUB, or a damaged one (both shown);
 * `section`: a part of the open book failed to load (shown, with Try again); `runtime`:
 * anything else that went wrong after opening (logged). */
const READER_ERROR_CODES = ['drm', 'unreadable', 'section', 'runtime'] as const;
export type ReaderErrorCode = (typeof READER_ERROR_CODES)[number];

export type ReaderMessage =
  | { type: 'ready' }
  | { type: 'opened'; title: string; toc: TocEntry[]; rtl: boolean }
  | { type: 'progress'; cfi: string; fraction: number; sectionLabel: string }
  | { type: 'loading'; value: boolean }
  | { type: 'error'; code: ReaderErrorCode; message: string }
  | { type: 'escape' }
  | { type: 'csp'; directive: string; blocked: string }
  | { type: 'seek'; t: number }
  | { type: 'following'; value: boolean }
  | ({ type: 'readalong' } & ReadalongState);

/** The longest a read-along seek may reach (seconds): a week of audio, past any book. */
const MAX_SEEK = 7 * 24 * 3600;
/** The most spans a reader can report unresolved (the player keeps at most 200 000). */
const MAX_UNRESOLVED = 1_000_000;

const MAX_TOC = 2000;
const MAX_TEXT = 500;
const MAX_CFI = 2048;

const str = (v: unknown, max = MAX_TEXT): string | null =>
  typeof v === 'string' ? v.slice(0, max) : null;
const fraction = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null;

function parseToc(v: unknown): TocEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: TocEntry[] = [];
  for (const item of v.slice(0, MAX_TOC)) {
    if (!isRecord(item)) continue;
    const label = str(item.label);
    const href = str(item.href, MAX_CFI);
    const depth = typeof item.depth === 'number' && Number.isInteger(item.depth) ? item.depth : 0;
    if (label !== null && href) out.push({ label, href, depth: Math.min(5, Math.max(0, depth)) });
  }
  return out;
}

/** A message from the reader, checked field by field; null for anything else. */
export function parseReaderMessage(data: unknown): ReaderMessage | null {
  if (!isRecord(data)) return null;
  switch (data.type) {
    case 'ready':
      return { type: 'ready' };
    case 'opened': {
      const title = str(data.title);
      const toc = parseToc(data.toc);
      return title !== null && toc ? { type: 'opened', title, toc, rtl: data.rtl === true } : null;
    }
    case 'progress': {
      const cfi = str(data.cfi, MAX_CFI + 1);
      const f = fraction(data.fraction);
      const sectionLabel = str(data.sectionLabel) ?? '';
      // The server refuses a CFI over 2048 bytes: such a place is not worth a message.
      if (!cfi || !cfi.startsWith('epubcfi(') || cfi.length > MAX_CFI || f === null) return null;
      return { type: 'progress', cfi, fraction: f, sectionLabel };
    }
    case 'loading':
      return typeof data.value === 'boolean' ? { type: 'loading', value: data.value } : null;
    case 'error': {
      const code = READER_ERROR_CODES.find((c) => c === data.code) ?? null;
      return code ? { type: 'error', code, message: str(data.message) ?? '' } : null;
    }
    case 'escape':
      return { type: 'escape' };
    case 'csp':
      return {
        type: 'csp',
        directive: str(data.directive, 100) ?? '',
        blocked: str(data.blocked, 200) ?? '',
      };
    case 'seek': {
      const t = data.t;
      return typeof t === 'number' && Number.isFinite(t) && t >= 0 && t <= MAX_SEEK
        ? { type: 'seek', t }
        : null;
    }
    case 'following':
      return typeof data.value === 'boolean' ? { type: 'following', value: data.value } : null;
    case 'readalong': {
      const state = data.state === 'ok' || data.state === 'none' ? data.state : null;
      const n = data.unresolved;
      if (!state || typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
      return { type: 'readalong', state, unresolved: Math.min(n, MAX_UNRESOLVED) };
    }
    default:
      return null;
  }
}

/** The parts of a `MessageEvent` the host checks. */
export type ReaderEvent = { source: unknown; origin: string; data: unknown };

/**
 * A `message` event's reader message, only when it came from `frame` (the reader
 * iframe's `contentWindow`) on `origin` (the page's own): anything else on the window
 * (another frame, an extension, a page that opened this one) is ignored.
 */
export function acceptReaderMessage(
  event: ReaderEvent,
  frame: unknown,
  origin: string,
): ReaderMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null;
  return parseReaderMessage(event.data);
}

/** Sends host messages, holding them until the reader is `ready`. */
export type HostChannel = {
  send(message: HostMessage, transfer?: Transferable[]): void;
  /** The reader said `ready`: send what waited. */
  ready(): void;
  /** Whether the reader said `ready` (a message sent now goes at once). */
  isReady(): boolean;
};

export function createHostChannel(
  post: (message: HostMessage, transfer: Transferable[]) => void,
): HostChannel {
  let isReady = false;
  const waiting: [HostMessage, Transferable[]][] = [];
  return {
    send(message, transfer = []) {
      if (isReady) post(message, transfer);
      else waiting.push([message, transfer]);
    },
    ready() {
      isReady = true;
      for (const [message, transfer] of waiting.splice(0)) post(message, transfer);
    },
    isReady: () => isReady,
  };
}
