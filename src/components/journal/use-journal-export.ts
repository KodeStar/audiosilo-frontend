import type { InfiniteData, QueryKey } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ApiClient } from '@/api/client';
import { qk } from '@/api/hooks';
import { queryClient, useApis } from '@/api/provider';
import type { ChaptersResponse, MyBookmark, MyNote, Page, PageQuery } from '@/api/types';
import { chapterNamer, labelText } from '@/components/annotations';
import { toast } from '@/components/ui/toast';
import { copyText } from '@/lib/clipboard';
import { contentKey } from '@/lib/content-key';
import { formatCount, formatDayDate } from '@/lib/format';

import { collectPages } from './export-collect';
import {
  exportFileName,
  exportRows,
  type ExportWords,
  type RowNames,
  toCsv,
  toMarkdown,
} from './export-format';
import { type ExportFile, saveExport } from './export-save';
import type { Sourced } from './merge-model';
import type { Source } from './use-journal-sources';

/** The most rows of each list taken from one server (an export stays bounded). */
const MAX_EXPORT_ROWS = 10_000;
/** Rows per request while the export pages through what the Journal hasn't loaded. */
const EXPORT_PAGE = 500;

export type ExportFormat = 'md' | 'csv';
export type ExportAction = 'save' | 'copy';

const FILE_TYPES: Record<ExportFormat, Pick<ExportFile, 'mimeType' | 'uti'>> = {
  md: { mimeType: 'text/markdown', uti: 'net.daringfireball.markdown' },
  csv: { mimeType: 'text/csv', uti: 'public.comma-separated-values-text' },
};

/** The chapter at a position, from chapters this device already holds (the Journal,
 * the book page or the player read them): an export never fetches chapters. One namer per
 * book for the run. */
function cachedChapterAt(t: TFunction): RowNames['chapterAt'] {
  const namers = new Map<string, (position: number) => string | null>();
  return (cid, lib, path, position) => {
    const key = contentKey(cid, lib, path);
    let nameAt = namers.get(key);
    if (!nameAt) {
      const data = queryClient.getQueryData<ChaptersResponse>(qk.chapters(cid, lib, path));
      nameAt = chapterNamer(data?.chapters, data?.files, t);
      namers.set(key, nameAt);
    }
    return nameAt(position) ?? undefined;
  };
}

/** One of the lists the export takes: the servers' sources, the key of the Journal's
 * cached pages, and the request for a page. */
type ExportList<T> = {
  id: string;
  sources: readonly Source<T>[];
  key: (cid: string) => QueryKey;
  fetch: (client: ApiClient, page: PageQuery) => Promise<Page<T>>;
};

/**
 * The Journal's export: every bookmark and note on every server that can list them (the
 * pages already loaded, then the rest, `collectPages`, bounded by `MAX_EXPORT_ROWS`),
 * as Markdown or CSV, shared as a file (native), downloaded (web) or copied as Markdown.
 * `preparing` counts the rows gathered so far while it runs (null when idle). A server
 * that fails is left out and named in a toast; the rest still export.
 */
export function useJournalExport(sources: {
  bookmarks: Source<MyBookmark>[];
  notes: Source<MyNote>[];
}) {
  const { t } = useTranslation();
  const apis = useApis();
  const [preparing, setPreparing] = useState<number | null>(null);
  // One export at a time, for the whole run: `preparing` ends before the share sheet
  // (which stays up until the listener closes it), this only when it is all over.
  const busy = useRef(false);

  const words = (): ExportWords => ({
    columns: {
      server: t('journal.export.columns.server'),
      kind: t('journal.export.columns.kind'),
      book: t('journal.export.columns.book'),
      author: t('journal.export.columns.author'),
      position: t('journal.export.columns.position'),
      chapter: t('journal.export.columns.chapter'),
      label: t('journal.export.columns.label'),
      text: t('journal.export.columns.text'),
      created: t('journal.export.columns.created'),
    },
    kind: { bookmark: t('journal.export.bookmark'), note: t('journal.export.note') },
    title: t('journal.title'),
    exported: t('journal.export.exported', { date: formatDayDate(new Date()) }),
  });

  const run = async (format: ExportFormat, action: ExportAction) => {
    if (busy.current) return;
    busy.current = true;
    setPreparing(0);
    // The rows are gathered: the label goes before anything else comes up (the share
    // sheet, the copy's fallback sheet), not once that closes.
    const ready = () => setPreparing(null);
    const counts = new Map<string, number>();
    const progress = (id: string) => (n: number) => {
      counts.set(id, n);
      setPreparing([...counts.values()].reduce((a, b) => a + b, 0));
    };
    let truncated = false;

    // Every server and both lists at once; only each list's pages follow one another.
    // Only servers known to list them (their `annotations` flag on): an older server is
    // never asked for a route it lacks. A server that fails is left out (and named).
    const gather = <T extends MyBookmark | MyNote>({
      id,
      sources: list,
      key,
      fetch,
    }: ExportList<T>) =>
      Promise.all(
        list.map(async (s): Promise<{ server: string; rows: Sourced<T>[]; failed?: true }> => {
          const client = apis.find((a) => a.connection.id === s.connectionId)?.client;
          const server = s.connectionName;
          if (s.supported !== true || !client) return { server, rows: [] };
          try {
            const got = await collectPages<T>(
              queryClient.getQueryData<InfiniteData<Page<T>>>(key(s.connectionId)),
              (cursor) => fetch(client, { limit: EXPORT_PAGE, cursor }),
              { maxRows: MAX_EXPORT_ROWS, onProgress: progress(`${id}\n${s.connectionId}`) },
            );
            truncated ||= got.truncated;
            const rows = got.items.map((row): Sourced<T> => ({
              ...row,
              connectionId: s.connectionId,
              connectionName: server,
            }));
            return { server, rows };
          } catch {
            return { server, rows: [], failed: true };
          }
        }),
      );

    try {
      const [bookmarks, notes] = await Promise.all([
        gather<MyBookmark>({
          id: 'bookmarks',
          sources: sources.bookmarks,
          key: qk.myBookmarks,
          fetch: (c, page) => c.myBookmarks(page),
        }),
        gather<MyNote>({
          id: 'notes',
          sources: sources.notes,
          key: qk.myNotes,
          fetch: (c, page) => c.myNotes(page),
        }),
      ]);
      const failed = new Set([...bookmarks, ...notes].filter((g) => g.failed).map((g) => g.server));
      const rows = exportRows(
        bookmarks.flatMap((g) => g.rows),
        notes.flatMap((g) => g.rows),
        {
          chapterAt: cachedChapterAt(t),
          labelName: (key) => labelText(t, key) ?? undefined,
        },
      );
      if (failed.size > 0) {
        toast({ title: t('journal.export.failedServers', { servers: [...failed].join(', ') }) });
      }
      if (rows.length === 0) {
        if (failed.size === 0) toast({ title: t('journal.export.nothing') });
        return;
      }
      const withServer = new Set(rows.map((r) => r.connectionId)).size > 1;
      const content =
        format === 'csv' ? toCsv(rows, words(), withServer) : toMarkdown(rows, words(), withServer);
      if (action === 'copy') {
        ready();
        // Web: the Clipboard API. Elsewhere `copyText` falls back to the share sheet,
        // which can't confirm a copy, so only a real copy says "Copied".
        if (await copyText(content)) toast({ title: t('journal.export.copied') });
      } else {
        await saveExport(
          { name: exportFileName(format, new Date()), content, ...FILE_TYPES[format] },
          t('journal.export.dialogTitle'),
          ready,
        );
      }
      if (truncated) {
        toast({
          title: t('journal.export.truncated', {
            count: MAX_EXPORT_ROWS,
            max: formatCount(MAX_EXPORT_ROWS),
          }),
        });
      }
    } catch {
      toast({ title: t('journal.export.failed') });
    } finally {
      // Cancelled, failed or nothing to export: the label goes too.
      ready();
      busy.current = false;
    }
  };

  return { run, preparing };
}
