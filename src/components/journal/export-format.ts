import type { Book, MyBookmark, MyNote } from '@/api/types';
import { formatClock } from '@/lib/format';
import { bookTitle } from '@/lib/paths';

import type { Sourced } from './merge-model';

/**
 * The Journal's export: the listener's bookmarks and notes as CSV (RFC 4180) or as
 * Markdown grouped by book. Pure string building: every word a reader sees comes in
 * translated (`ExportWords`), so the formatters are tested without i18n.
 */

export type ExportKind = 'bookmark' | 'note';

/** One exported bookmark or note. */
export type ExportRow = {
  kind: ExportKind;
  /** Which server it is on (the book's identity: two servers can each have the book). */
  connectionId: string;
  server: string;
  libraryId: number;
  path: string;
  title: string;
  author: string;
  /** Whole-book seconds. */
  position: number;
  /** The chapter's name, when this device knows the book's chapters. */
  chapter?: string;
  /** The label's display name (a bookmark's; a note has none). */
  label?: string;
  text: string;
  /** Epoch ms it was made. */
  created: number;
};

/** What the rows are built from, besides the server's rows. */
export type RowNames = {
  /** The chapter at a position, when the book's chapters are known. */
  chapterAt: (
    connectionId: string,
    libraryId: number,
    path: string,
    position: number,
  ) => string | undefined;
  /** A label key's display name ("Quote"); undefined for none or a key this player
   * doesn't know. */
  labelName: (label: string | undefined) => string | undefined;
};

const titleOf = (book: Book | undefined, path: string) => bookTitle(book?.title, path);

/** The rows of both lists, newest first. */
export function exportRows(
  bookmarks: readonly Sourced<MyBookmark>[],
  notes: readonly Sourced<MyNote>[],
  names: RowNames,
): ExportRow[] {
  const created = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? 0 : t;
  };
  const base = (r: Sourced<MyBookmark> | Sourced<MyNote>) => ({
    connectionId: r.connectionId,
    server: r.connectionName,
    libraryId: r.library_id,
    path: r.path,
    title: titleOf(r.book, r.path),
    author: r.book?.author ?? '',
    position: r.position,
    chapter: names.chapterAt(r.connectionId, r.library_id, r.path, r.position),
    created: created(r.created_at),
  });
  return [
    ...bookmarks.map((b): ExportRow => ({
      ...base(b),
      kind: 'bookmark',
      label: names.labelName(b.label),
      text: b.note,
    })),
    ...notes.map((n): ExportRow => ({ ...base(n), kind: 'note', text: n.body })),
  ].sort((a, b) => b.created - a.created);
}

/** Every translated word the formatters write. */
export type ExportWords = {
  /** The column headers, in order. */
  columns: {
    server: string;
    kind: string;
    book: string;
    author: string;
    position: string;
    chapter: string;
    label: string;
    text: string;
    created: string;
  };
  kind: Record<ExportKind, string>;
  /** The Markdown document's title ("Journal"). */
  title: string;
  /** "Exported 7 October 2026". */
  exported: string;
};

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-05 21:12", in the device's time: sorts as text and opens as a date in a
 * spreadsheet. Empty for an unknown time. */
export function localStamp(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A UTF-8 byte order mark: without it Excel reads a CSV as the system code page and
 * mangles accents and CJK. */
export const UTF8_BOM = '﻿';

/**
 * One CSV field (RFC 4180): quoted when it holds a comma, a quote, CR or LF, with
 * quotes doubled. A field a spreadsheet would run as a formula (starting with `=`, `+`,
 * `-`, `@`, tab or CR) is prefixed with an apostrophe (OWASP's CSV injection advice): a
 * note is the listener's own text, but a shared export opened in Excel must not run it.
 */
export function csvField(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** The rows as CSV: a BOM, a header line, CRLF line ends. The server column only when
 * the rows come from more than one server. */
export function toCsv(rows: readonly ExportRow[], words: ExportWords, withServer: boolean): string {
  const c = words.columns;
  const header = [
    ...(withServer ? [c.server] : []),
    c.kind,
    c.book,
    c.author,
    c.position,
    c.chapter,
    c.label,
    c.text,
    c.created,
  ];
  const lines = rows.map((r) => [
    ...(withServer ? [r.server] : []),
    words.kind[r.kind],
    r.title,
    r.author,
    formatClock(r.position),
    r.chapter ?? '',
    r.label ?? '',
    r.text,
    localStamp(r.created),
  ]);
  return UTF8_BOM + [header, ...lines].map((l) => l.map(csvField).join(',')).join('\r\n') + '\r\n';
}

/** A one-line Markdown text: line breaks folded to spaces. */
const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim();

/** A list item's body, every line indented under the item so a note's own line breaks
 * (and blank lines) stay inside it. */
const indented = (s: string) =>
  s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => (l.trim() ? `  ${l}` : ''))
    .join('\n');

/**
 * The rows as Markdown, one section per book (books in the order of their newest row;
 * inside a book, by position, as the book reads):
 *
 *   ## The Way of Kings
 *   Brandon Sanderson · Hearthside
 *
 *   - **12:41:07** · Bookmark · Quote · Bridge Four · 2026-10-05 21:12
 *     Life before death.
 */
export function toMarkdown(
  rows: readonly ExportRow[],
  words: ExportWords,
  withServer: boolean,
): string {
  const groups = new Map<string, ExportRow[]>();
  for (const r of rows) {
    const key = `${r.connectionId}\n${r.libraryId}\n${r.path}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out = [`# ${words.title}`, '', words.exported];
  for (const g of groups.values()) {
    const first = g[0];
    out.push('', `## ${oneLine(first.title)}`);
    const by = [first.author, withServer ? first.server : ''].filter(Boolean).map(oneLine);
    if (by.length > 0) out.push(by.join(' · '));
    out.push('');
    for (const r of [...g].sort((a, b) => a.position - b.position || a.created - b.created)) {
      const meta = [
        `**${formatClock(r.position)}**`,
        words.kind[r.kind],
        r.label,
        r.chapter ? oneLine(r.chapter) : undefined,
        localStamp(r.created),
      ].filter(Boolean);
      out.push(`- ${meta.join(' · ')}`);
      const body = indented(r.text);
      if (body.trim()) out.push(body);
    }
  }
  return out.join('\n') + '\n';
}

/** The file's name: `journal-2026-10-07.md`, in the device's date. */
export function exportFileName(format: 'md' | 'csv', now: Date): string {
  return `journal-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.${format}`;
}
