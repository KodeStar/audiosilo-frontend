import type { InfiniteData } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { qk } from '@/api/hooks';
import { queryClient, useApis } from '@/api/provider';
import type { ChaptersResponse, MyBookmark, MyNote, Page } from '@/api/types';
import { chapterNamer, labelText } from '@/components/annotations';
import { toast } from '@/components/ui/toast';
import { copyText } from '@/lib/clipboard';
import { formatCount } from '@/lib/format';

import { collectPages } from './export-collect';
import { exportFileName, exportRows, type ExportWords, toCsv, toMarkdown } from './export-format';
import { type ExportFile, saveExport } from './export-save';
import { formatDayDate } from './journal-format';
import type { Sourced } from './merge-model';
import type { Source } from './use-journal-sources';

/** The most rows of each list taken from one server (an export stays bounded). */
export const MAX_EXPORT_ROWS = 10_000;
/** Rows per request while the export pages through what the Journal hasn't loaded. */
const EXPORT_PAGE = 500;

export type ExportFormat = 'md' | 'csv';
export type ExportAction = 'save' | 'copy';

const FILE_TYPES: Record<ExportFormat, Pick<ExportFile, 'mimeType' | 'uti'>> = {
  md: { mimeType: 'text/markdown', uti: 'net.daringfireball.markdown' },
  csv: { mimeType: 'text/csv', uti: 'public.comma-separated-values-text' },
};

/** The chapter at a position, from chapters this device already holds (the Journal,
 * the book page or the player read them): an export never fetches chapters. */
function cachedChapterAt(
  t: TFunction,
): (cid: string, lib: number, path: string, position: number) => string | undefined {
  return (cid, lib, path, position) => {
    const data = queryClient.getQueryData<ChaptersResponse>(qk.chapters(cid, lib, path));
    return chapterNamer(data?.chapters, data?.files, t)(position) ?? undefined;
  };
}

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
    if (preparing !== null) return;
    setPreparing(0);
    const counts = new Map<string, number>();
    const progress = (id: string) => (n: number) => {
      counts.set(id, n);
      setPreparing([...counts.values()].reduce((a, b) => a + b, 0));
    };
    const failed = new Set<string>();
    let truncated = false;
    const bookmarks: Sourced<MyBookmark>[] = [];
    const notes: Sourced<MyNote>[] = [];

    // Only servers whose list is known to work (their `annotations` flag on): an
    // older server is never asked for a route it lacks.
    const gather = async <T extends MyBookmark | MyNote>(
      list: Source<T>[],
      kind: 'bookmarks' | 'notes',
      out: Sourced<T>[],
    ) => {
      for (const s of list) {
        if (s.status !== 'ready' && s.status !== 'error') continue;
        const client = apis.find((a) => a.connection.id === s.connectionId)?.client;
        if (!client) continue;
        const key =
          kind === 'bookmarks' ? qk.myBookmarks(s.connectionId) : qk.myNotes(s.connectionId);
        try {
          const got = await collectPages<T>(
            queryClient.getQueryData<InfiniteData<Page<T>>>(key),
            (cursor) =>
              (kind === 'bookmarks'
                ? client.myBookmarks({ limit: EXPORT_PAGE, cursor })
                : client.myNotes({ limit: EXPORT_PAGE, cursor })) as Promise<Page<T>>,
            { maxRows: MAX_EXPORT_ROWS, onProgress: progress(`${kind}\n${s.connectionId}`) },
          );
          truncated ||= got.truncated;
          for (const row of got.items) {
            out.push({ ...row, connectionId: s.connectionId, connectionName: s.connectionName });
          }
        } catch {
          failed.add(s.connectionName);
        }
      }
    };

    try {
      await gather(sources.bookmarks, 'bookmarks', bookmarks);
      await gather(sources.notes, 'notes', notes);
      const rows = exportRows(bookmarks, notes, {
        chapterAt: cachedChapterAt(t),
        labelName: (key) => labelText(t, key) ?? undefined,
      });
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
        // Web: the Clipboard API. Elsewhere `copyText` falls back to the share sheet,
        // which can't confirm a copy, so only a real copy says "Copied".
        if (await copyText(content)) toast({ title: t('journal.export.copied') });
      } else {
        await saveExport(
          { name: exportFileName(format, new Date()), content, ...FILE_TYPES[format] },
          t('journal.export.dialogTitle'),
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
      setPreparing(null);
    }
  };

  return { run, preparing };
}
