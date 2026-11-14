import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ApiError } from '@/api/client';
import {
  CapabilityError,
  useAddLibrivox,
  useCancelBridgeJob,
  useLibrivoxJob,
  useLibrivoxWork,
} from '@/api/hooks';
import type { Library, LibrivoxRecording } from '@/api/types';
import { librivoxUrl } from '@/components/book/book-details-model';
import { JobStatusLayout, type JobStatusTone } from '@/components/bridge/job-status-layout';
import { OfflineState } from '@/components/layout/offline-state';
import { Button } from '@/components/ui/button';
import type { IconName } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { isOpenJob } from '@/lib/bridge-jobs';
import { formatDuration } from '@/lib/format';
import { useUnreadQuery } from '@/lib/offline-state';
import { useOpen } from '@/lib/open';
import { openExternalUrl } from '@/lib/support';
import { tabularNums } from '@/theme/tabular-nums';

import { followedRead, watchLibrivoxFetch } from './fetch-watcher';
import {
  addRefusalKey,
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
 * while the Bridge works on it. `target`: undefined while the libraries load.
 */
export function LibrivoxWorkPanel({
  connectionId,
  workId,
  target,
  bridgeAway,
}: {
  connectionId: string;
  workId: string;
  target: Library | undefined;
  /** The Bridge went away while the page was open: Add and Cancel are held back until it
   * is back. */
  bridgeAway: boolean;
}) {
  const { t } = useTranslation();
  const work = useLibrivoxWork(workId, connectionId);
  const offline = useUnreadQuery(work) === 'offline';

  // With nothing to show and no network (held for it, where it stays pending, or failed
  // without one): the offline state, never the spinner nor a Retry that can't work.
  if (offline) return <OfflineState hint={t('common.offlineList')} className="py-4" />;
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
          bridgeAway={bridgeAway}
        />
      ))}
    </View>
  );
}

function RecordingRow({
  connectionId,
  recording: r,
  target,
  bridgeAway,
}: {
  connectionId: string;
  recording: LibrivoxRecording;
  target: Library | undefined;
  bridgeAway: boolean;
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
    if (!target || bridgeAway) return;
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
          className="self-start"
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
          held={bridgeAway}
        />
      ) : null}
      {canAdd ? (
        <Button
          size="sm"
          icon="download"
          title={t('librivox.add.action', { library: target?.name ?? '' })}
          accessibilityLabel={t('librivox.add.label', {
            names: readers || t('librivox.recording.unknownReader'),
            library: target?.name ?? '',
          })}
          disabled={!target || bridgeAway}
          loading={add.isPending}
          onPress={onAdd}
          className="self-start"
          testID="librivox-add"
        />
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
type Look = { title: string; icon: IconName; tone: JobStatusTone };
const WORKING = {
  title: 'librivox.fetch.title',
  icon: 'download',
  tone: 'mutedForeground',
} as const;
const PHASE_LOOK = {
  waiting: WORKING,
  running: WORKING,
  stopping: WORKING,
  parked: { title: 'librivox.fetch.parkedTitle', icon: 'circle-exclamation', tone: 'warning' },
  failed: {
    title: 'librivox.fetch.failedTitle',
    icon: 'circle-exclamation',
    tone: 'destructive',
  },
  cancelled: { ...WORKING, title: 'librivox.fetch.cancelledTitle' },
  done: { title: 'librivox.fetch.doneTitle', icon: 'circle-check', tone: 'mutedForeground' },
} as const satisfies Record<FetchView['phase'], Look>;

/** A fetch's status (the Bridge's work on it): a title (Adding, Needs attention, Couldn't
 * add it, Added), one line, a neutral progress bar while sections download, and Cancel
 * under them while it is open (where Add sits: the row is the page's width). `held`: the
 * Bridge is away, so Cancel waits with Add (a cancel is the Bridge's too: never sent). */
function FetchStatus({
  view,
  cancelling,
  onCancel,
  held,
}: {
  view: FetchView;
  cancelling: boolean;
  onCancel?: () => void;
  held: boolean;
}) {
  const { t } = useTranslation();
  const look = PHASE_LOOK[view.phase];
  return (
    <JobStatusLayout
      testID="librivox-fetch-status"
      icon={look.icon}
      tone={look.tone}
      title={t(look.title)}
      line={statusLine(t, view)}
      lineLines={3}
      fraction={
        view.phase === 'running' && view.done !== undefined && view.total
          ? view.done / view.total
          : undefined
      }
    >
      {onCancel ? (
        <View className="flex-row">
          <Button
            testID="librivox-cancel"
            size="sm"
            variant="outline"
            title={t('common.cancel')}
            disabled={held || view.phase === 'stopping'}
            loading={cancelling}
            onPress={onCancel}
          />
        </View>
      ) : null}
    </JobStatusLayout>
  );
}

/**
 * The `librivox.fetch` a recording row follows: the last one it queued or saw open on the
 * work, kept once the work stops naming it (it lists only open jobs), so a failed fetch
 * still says why. Each open one followed is watched past the page (`watchLibrivoxFetch`):
 * the root's `LibrivoxFetchWatcher` polls it and, when it ends, has the works and the
 * library's lists read again, whether or not the page is still open. The row only reads it (no poll of
 * its own); a job that is gone (a 404, deleted with its library) shows nothing.
 */
function useFollowedFetch(connectionId: string, r: LibrivoxRecording) {
  const { t } = useTranslation();
  const [followed, setFollowed] = useState(r.job?.id);
  // The work's open job is followed when the work comes to name it, not on every render:
  // an answer that still names the job before (the work asked again and not in yet, or that
  // ask failed and the last answer stands) would take the row back from the one it queued.
  const [named, setNamed] = useState(r.job?.id);
  if (r.job?.id !== named) {
    setNamed(r.job?.id);
    if (r.job) setFollowed(r.job.id);
  }
  const read = useLibrivoxJob(followed, false, connectionId);
  const cancel = useCancelBridgeJob(connectionId);
  // One already known ended is the watcher's no more: a work opened again shows its last
  // answer first, which still names the fetch whose end was handled when it came.
  const { job, ended } = followedRead(read);
  // Handed over again with each answer that reads it open (nothing changes while it is
  // watched): the watcher drops a watch its read was refused (a 401, the token revoked),
  // and once signed in again the row would show a fetch nobody polls.
  const readAt = read.dataUpdatedAt;
  useEffect(() => {
    if (followed !== undefined && !ended) watchLibrivoxFetch(connectionId, followed);
  }, [connectionId, followed, ended, readAt]);

  return {
    job,
    // Watched as it is queued, not only by the effect above: the row may be gone by the
    // time Add answers (the page left meanwhile), and its state with it.
    follow: (id: number) => {
      watchLibrivoxFetch(connectionId, id);
      setFollowed(id);
    },
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
