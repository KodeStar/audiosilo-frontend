import { isRecord } from '@/lib/storage-keys';

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
 * Reader -> host: `ready`, `opened` (title, flattened TOC, whether the book reads right to
 * left), `progress` (on every move), `loading` (a section is being laid out), `error`,
 * `escape` (Escape pressed in the book, which the host's own keys never see), `csp` (a
 * blocked load, logged). The reader parses an EPUB nobody vetted, so its messages are
 * checked here field by field (`parseReaderMessage`) and taken only from that frame's
 * window on our own origin (`acceptReaderMessage`).
 */

export type ReaderTheme = { scheme: 'light' | 'dark'; background: string; foreground: string };

/** Where to open: a CFI first, else a fraction of the book, else the start. */
export type ReaderPlace = { cfi?: string; fraction?: number };

export type GotoTarget = { href: string } | { cfi: string } | { fraction: number };

type OpenFields = {
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
  | { type: 'prev' };

export type TocEntry = { label: string; href: string; depth: number };

/** `drm`: the book is encrypted; `unreadable`: not an EPUB, or a damaged one (both shown);
 * `runtime`: anything that went wrong after opening (logged). */
export type ReaderErrorCode = 'drm' | 'unreadable' | 'runtime';

export type ReaderMessage =
  | { type: 'ready' }
  | { type: 'opened'; title: string; toc: TocEntry[]; rtl: boolean }
  | { type: 'progress'; cfi: string; fraction: number; sectionLabel: string }
  | { type: 'loading'; value: boolean }
  | { type: 'error'; code: ReaderErrorCode; message: string }
  | { type: 'escape' }
  | { type: 'csp'; directive: string; blocked: string };

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
      const code =
        data.code === 'drm' || data.code === 'unreadable' || data.code === 'runtime'
          ? data.code
          : null;
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
  };
}
