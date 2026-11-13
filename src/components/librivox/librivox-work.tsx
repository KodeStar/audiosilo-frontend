import { useQueryClient } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';
import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  invalidateLibraryLists,
  qk,
  useAddLibrivox,
  useCancelBridgeJob,
  useLibrivoxJob,
  useLibrivoxWork,
} from '@/api/hooks';
import type { Library, LibrivoxRecording } from '@/api/types';
import { librivoxUrl } from '@/components/book/book-details-model';
import { Button } from '@/components/ui/button';
import { Icon, type IconName } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { isOpenJob } from '@/lib/bridge-jobs';
import { formatDuration } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { openExternalUrl } from '@/lib/support';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import {
  addRefusalKey,
  DONE_RECHECK_MS,
  type FetchView,
  fetchView,
  namesLine,
  offersAdd,
  readErrorKey,
  rowState,
} from './librivox-model';

/**
 * One work's LibriVox recordings, under its search result (LibriVox L6): each reader with
 * its length, sections and project number, a link to its LibriVox page, and Add to the
 * target library; In your library (Open) once this server holds it, its fetch's progress
 * while the Bridge works on it. `target`: undefined while the libraries load, null when the
 * server has no books library.
 */
export function LibrivoxWorkPanel({
  connectionId,
  workId,
  target,
}: {
  connectionId: string;
  workId: string;
  target: Library | null | undefined;
}) {
  const { t } = useTranslation();
  const work = useLibrivoxWork(workId, connectionId);

  // Only with nothing to show: a failed ask for the work again (after an Add, or when a job
  // ends) keeps the rows, and with them the job each one follows.
  if (work.isError && !work.data) {
    return (
      <View className="gap-2 px-3 py-3" testID="librivox-work-error">
        <Text variant="body">{t(readErrorKey(work.error))}</Text>
        <Button
          variant="outline"
          size="sm"
          icon="rotate"
          title={t('common.retry')}
          onPress={() => void work.refetch()}
          className="self-start"
        />
      </View>
    );
  }
  if (!work.data) {
    return (
      <View className="items-center py-4" accessibilityLabel={t('librivox.work.loading')}>
        <Spinner />
      </View>
    );
  }
  const { recordings } = work.data;
  if (recordings.length === 0) {
    return (
      <Text variant="caption" className="px-3 py-3" testID="librivox-work-empty">
        {t('librivox.work.noRecordings')}
      </Text>
    );
  }
  return (
    <View className="gap-0 pl-3" testID="librivox-work">
      {recordings.map((r) => (
        <RecordingRow
          key={r.recording_id}
          connectionId={connectionId}
          recording={r}
          target={target}
        />
      ))}
    </View>
  );
}

function RecordingRow({
  connectionId,
  recording: r,
  target,
}: {
  connectionId: string;
  recording: LibrivoxRecording;
  target: Library | null | undefined;
}) {
  const { t } = useTranslation();
  const { openBook } = useOpen();
  const add = useAddLibrivox(connectionId);
  const fetch = useFollowedFetch(connectionId, r);
  const here = r.in_library[0];
  const state = rowState(!!here, fetch.job, r.job !== null);
  const readers = namesLine(r.narrators);
  const facts = [
    r.runtime_min > 0 ? formatDuration(r.runtime_min * 60) : '',
    r.chapter_count > 0 ? t('librivox.recording.sections', { count: r.chapter_count }) : '',
    t('librivox.recording.project', { id: r.librivox_id }),
  ]
    .filter(Boolean)
    .join(' · ');
  const page = librivoxUrl({ librivox: { id: r.librivox_id, url: r.url } });

  const onAdd = () => {
    if (!target) return;
    add.mutateAsync({ libraryId: target.id, librivoxId: r.librivox_id }).then(
      (answer) => fetch.follow(answer.job.id),
      (e: unknown) => {
        // Never sent (the flag went meanwhile): the page closes with it.
        if (!(e instanceof CapabilityError)) toast({ title: t(addRefusalKey(e)) });
      },
    );
  };

  const view = fetch.job ? fetchView(fetch.job) : undefined;
  const canAdd = offersAdd(state, fetch.job);

  return (
    <View testID="librivox-recording" className="gap-1.5 border-b border-border py-3 pr-1">
      <Text variant="label" numberOfLines={2}>
        {readers
          ? t('librivox.recording.readBy', { names: readers })
          : t('librivox.recording.unknownReader')}
      </Text>
      <Text variant="caption" style={tabularNums}>
        {facts}
      </Text>
      {page ? (
        <Button
          variant="link"
          size="sm"
          icon="arrow-up-right"
          title={t('librivox.recording.page')}
          onPress={() => void openExternalUrl(page)}
          className="self-start px-0"
        />
      ) : null}
      {state === 'inLibrary' && here ? (
        <View className="flex-row flex-wrap items-center gap-2" testID="librivox-in-library">
          <Text variant="caption">{t('librivox.recording.inLibrary')}</Text>
          <Button
            variant="outline"
            size="sm"
            icon="book-open"
            title={t('librivox.recording.open')}
            onPress={() => openBook(connectionId, here.library_id, here.path)}
          />
        </View>
      ) : null}
      {state === 'opening' ? (
        <Text variant="caption" testID="librivox-fetch-status">
          {t('bridge.status.waiting')}
        </Text>
      ) : null}
      {state === 'job' && fetch.job && view ? (
        <FetchStatus
          view={view}
          cancelling={fetch.cancelling}
          onCancel={isOpenJob(fetch.job) ? fetch.cancel : undefined}
        />
      ) : null}
      {canAdd ? (
        target === null ? (
          <Text variant="caption">{t('librivox.add.noLibrary')}</Text>
        ) : (
          <Button
            size="sm"
            icon="download"
            title={t('librivox.add.action', { library: target?.name ?? '' })}
            accessibilityLabel={t('librivox.add.label', {
              names: readers || t('librivox.recording.unknownReader'),
              library: target?.name ?? '',
            })}
            disabled={!target}
            loading={add.isPending}
            onPress={onAdd}
            className="self-start"
            testID="librivox-add"
          />
        )
      ) : null}
    </View>
  );
}

/** The status's line: the step and the sections while it runs, why it stopped while parked
 * or once it failed. */
function statusLine(t: TFunction, view: FetchView): string {
  switch (view.phase) {
    case 'waiting':
      return t('bridge.status.waiting');
    case 'stopping':
      return t('bridge.status.stopping');
    case 'running':
      return [
        t(`librivox.fetch.step.${view.step}`),
        view.done !== undefined && view.total !== undefined
          ? t('bridge.status.count', { done: view.done, total: view.total })
          : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'parked':
    case 'failed':
      return t(`librivox.fetch.code.${view.code}`);
    case 'cancelled':
      return t('librivox.fetch.cancelled');
    case 'done':
      return t('librivox.fetch.done');
  }
}

/** A status's title, icon and the icon's colour: one look while the Bridge works on it
 * (waiting, running, stopping), one for each way it stopped. */
type Look = { title: string; icon: IconName; color: 'mutedForeground' | 'warning' | 'destructive' };
const WORKING = {
  title: 'librivox.fetch.title',
  icon: 'download',
  color: 'mutedForeground',
} as const;
const PHASE_LOOK = {
  waiting: WORKING,
  running: WORKING,
  stopping: WORKING,
  parked: { title: 'librivox.fetch.parkedTitle', icon: 'circle-exclamation', color: 'warning' },
  failed: {
    title: 'librivox.fetch.failedTitle',
    icon: 'circle-exclamation',
    color: 'destructive',
  },
  cancelled: { ...WORKING, title: 'librivox.fetch.cancelledTitle' },
  done: { title: 'librivox.fetch.doneTitle', icon: 'circle-check', color: 'mutedForeground' },
} as const satisfies Record<FetchView['phase'], Look>;

/** A fetch's status (the Bridge's work on it): a title (Adding, Needs attention, Couldn't
 * add it, Added), one line, a neutral progress bar while sections download, and Cancel
 * while it is open. Status is the words and the icon, never colour alone. */
function FetchStatus({
  view,
  cancelling,
  onCancel,
}: {
  view: FetchView;
  cancelling: boolean;
  onCancel?: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const look = PHASE_LOOK[view.phase];
  const fraction =
    view.phase === 'running' && view.done !== undefined && view.total
      ? view.done / view.total
      : undefined;
  return (
    <View testID="librivox-fetch-status" className="max-w-[560px] gap-1.5">
      <View className="flex-row items-center gap-2">
        <Icon name={look.icon} size={14} color={themed[look.color]} />
        <Text variant="label" className="min-w-0 flex-1" numberOfLines={2}>
          {t(look.title)}
        </Text>
        {onCancel ? (
          <Button
            testID="librivox-cancel"
            size="sm"
            variant="ghost"
            title={t('common.cancel')}
            disabled={view.phase === 'stopping'}
            loading={cancelling}
            onPress={onCancel}
          />
        ) : null}
      </View>
      <Text variant="caption" numberOfLines={3} style={tabularNums}>
        {statusLine(t, view)}
      </Text>
      {fraction !== undefined ? (
        <ProgressBar fraction={fraction} minPercent={4} fillClassName="bg-foreground/60" />
      ) : null}
    </View>
  );
}

/**
 * The `librivox.fetch` a recording row follows: the last one it queued or saw open on the
 * work, kept once the work stops naming it (it lists only open jobs), so a failed fetch
 * still says why. Read by its id while the page is focused; a job that is gone (a 404,
 * deleted with its library) is followed no more. A job that ends asks the connection's
 * works again (a done one moves the recording into the library), and a done one asks again
 * a moment later (the server records the book just after the job ends) and has the
 * library's lists read again (a Library mounted under the page shows the new book).
 */
function useFollowedFetch(connectionId: string, r: LibrivoxRecording) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const focused = useIsFocused();
  const [followed, setFollowed] = useState(r.job?.id);
  if (r.job && r.job.id !== followed) setFollowed(r.job.id);
  const read = useLibrivoxJob(followed, focused, connectionId);
  const cancel = useCancelBridgeJob(connectionId);
  const gone = read.error instanceof ApiError && read.error.status === 404;
  const job = gone ? undefined : read.data;
  const ended = gone || (!!job && !isOpenJob(job));
  const doneIn = job?.state === 'done' ? job.library_id : null;

  useEffect(() => {
    if (!ended) return;
    const ask = () => void qc.invalidateQueries({ queryKey: qk.librivoxWorks(connectionId) });
    ask();
    if (doneIn === null) return;
    invalidateLibraryLists(qc, connectionId, doneIn);
    const timer = setTimeout(ask, DONE_RECHECK_MS);
    return () => clearTimeout(timer);
  }, [ended, doneIn, qc, connectionId]);

  return {
    job,
    follow: setFollowed,
    cancelling: cancel.isPending,
    cancel: () => {
      if (!job) return;
      cancel.mutate(job, {
        onError: (e) => {
          // A 409: it already ended (the read again shows how); never sent: nothing to say.
          if (e instanceof CapabilityError || (e instanceof ApiError && e.status === 409)) return;
          toast({ title: t('bridge.status.cancelFailed') });
        },
      });
    },
  };
}
