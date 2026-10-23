import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { CapabilityError, useExportOpml } from '@/api/hooks';
import type { OpmlExport } from '@/api/types';
import { saveExport } from '@/components/journal/export-save';
import { toast } from '@/components/ui/toast';

import { exportErrorKey } from './find-shows-model';

/** The exported file's name (the server's `Content-Disposition` names it the same). */
export const OPML_EXPORT_NAME = 'audiosilo-subscriptions.opml';

/** The toast an export ends with: how many shows it wrote, and what it left out. A count
 * the browser can't read (a cross-origin page without the server exposing it) reads as
 * unknown, and private feeds are still said never to be exported. */
export function exportToast(r: OpmlExport, t: TFunction): { title: string; description: string } {
  const title =
    r.exported === null
      ? t('podcasts.export.doneUnknown')
      : t('podcasts.export.done', { count: r.exported });
  const lines = [
    r.omittedPrivate !== null && r.omittedPrivate > 0
      ? t('podcasts.export.privateLeftOut', { count: r.omittedPrivate })
      : t('podcasts.export.privateNever'),
    r.omittedUnavailable !== null && r.omittedUnavailable > 0
      ? t('podcasts.export.unavailableLeftOut', { count: r.omittedUnavailable })
      : null,
  ];
  return { title, description: lines.filter(Boolean).join(' ') };
}

/**
 * Export my shows (Bridge Phase 2d-2, capability `podcast_opml`): the followed public
 * shows as `audiosilo-subscriptions.opml`, fetched with the Authorization header and saved
 * the Journal's way (`saveExport`: a download on the web, the share sheet on a device),
 * then a toast with the counts. A refusal is a toast in the listener's words.
 */
export function useExportShows(connectionId: string) {
  const { t } = useTranslation();
  const exporter = useExportOpml(connectionId);
  const run = async () => {
    let answer: OpmlExport;
    try {
      answer = await exporter.mutateAsync();
    } catch (e) {
      if (!(e instanceof CapabilityError)) toast({ title: t(exportErrorKey(e)) });
      return;
    }
    try {
      await saveExport(
        {
          name: OPML_EXPORT_NAME,
          content: answer.text,
          mimeType: 'text/x-opml',
          uti: 'public.xml',
        },
        t('podcasts.export.dialogTitle'),
      );
    } catch {
      toast({ title: t('podcasts.export.error.other') });
      return;
    }
    toast(exportToast(answer, t));
  };
  return { run, busy: exporter.isPending };
}
