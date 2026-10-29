import { useIsFocused } from 'expo-router';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBridgeJobs } from '@/api/hooks';
import type { BridgeJob } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { formatDuration, formatShortDay, formatWallClock, localIsoDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { type JobStatusView, jobStatusView, parkEndsByItself, statusJob } from './bridge-model';
import type { GenerateModel } from './use-generate';

/** The status's one line under its title: the stage, the counts and the time left while
 * it runs; why it stopped while parked; the Bridge's error once it failed. */
function statusLine(t: TFunction, view: JobStatusView): string {
  switch (view.phase) {
    case 'waiting':
      return t('bridge.status.waiting');
    case 'stopping':
      return t('bridge.status.stopping');
    case 'running':
      return [
        t(`bridge.stage.${view.stage}`),
        view.done !== undefined && view.total !== undefined
          ? t('bridge.status.count', { done: view.done, total: view.total })
          : '',
        view.etaSeconds ? t('bridge.status.eta', { time: formatDuration(view.etaSeconds) }) : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'parked':
      return t(`bridge.park.${view.reason}`);
    case 'failed':
      return view.error || t('bridge.status.failedGeneric');
  }
}

/** When a parked job tries again by itself: the time when that is today, the day and the
 * time when it is later (a monthly budget waits for the month to turn). A time already
 * past promises nothing (the Bridge may be away): the console then. */
function retryLine(t: TFunction, at: Date, now = new Date()): string {
  if (at.getTime() <= now.getTime()) return t('bridge.status.openConsole');
  const time = formatWallClock(at);
  return localIsoDay(at) === localIsoDay(now)
    ? t('bridge.status.retryAt', { time })
    : t('bridge.status.retryOn', { day: formatShortDay(at), time });
}

/** What a job's status needs of the surface's model (`useGenerate`'s, `useMakeReadalong`'s):
 * the book, whether this person may act on its jobs, and the writes. */
export type JobStatusModel = Pick<
  GenerateModel,
  'target' | 'allowed' | 'queueing' | 'cancel' | 'cancelling' | 'retry'
>;

/** A job status's own words: its title while it runs, while parked and once it failed, and
 * the prefix of its test ids (`<prefix>-status`, `-retry`, `-cancel`). */
export type JobStatusWords = {
  title: string;
  parkedTitle: string;
  failedTitle: string;
  testID: string;
};

/**
 * A book's generate job, compactly (where the action was: under the book page's actions,
 * or in the companion's empty Who's who and Story so far): the stage, "12 of 40", the time
 * left and Cancel while it runs; a short reason and "Open the console to fix it" while it
 * is parked (or when it tries again by itself, or that it carries on by itself: waiting
 * for a worker); the error and Try again once it failed.
 * Nothing without such a job (`statusJob`), nor for someone who may not generate here
 * (`model.allowed`: the Bridge offline included, when the cached job could no longer move
 * and its buttons could send nothing). It reads the book's job list itself, polling while
 * its screen is focused (read here, so a poll or a blur re-renders only this).
 */
export function GenerateStatus({ model, className }: { model: GenerateModel; className?: string }) {
  const { t } = useTranslation();
  return (
    <BridgeJobStatus
      model={model}
      select={statusJob}
      words={{
        title: t('bridge.status.title'),
        parkedTitle: t('bridge.status.parkedTitle'),
        failedTitle: t('bridge.status.failedTitle'),
        testID: 'generate',
      }}
      className={className}
    />
  );
}

/**
 * The status of the job `select` picks from a book's job list (`GenerateStatus`'s, and the
 * read-along's `MakeReadalongOffer`), in its own words: nothing without one, nor for someone
 * who may not act on it (`model.allowed`). It reads the job list itself, polling while its
 * screen is focused.
 */
export function BridgeJobStatus({
  model,
  select,
  words,
  className,
}: {
  model: JobStatusModel;
  select: (jobs: BridgeJob[]) => BridgeJob | undefined;
  words: JobStatusWords;
  className?: string;
}) {
  const { connectionId, libraryId, path } = model.target;
  const focused = useIsFocused();
  const { data: job } = useBridgeJobs(
    libraryId,
    path,
    { enabled: model.allowed, active: focused, select },
    connectionId,
  );
  return job && model.allowed ? (
    <JobStatus job={job} model={model} words={words} className={className} />
  ) : null;
}

/** One job's status (see `BridgeJobStatus`). Status is the words and the icon, never
 * colour alone. */
function JobStatus({
  job,
  model,
  words,
  className,
}: {
  job: BridgeJob;
  model: JobStatusModel;
  words: JobStatusWords;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const view = jobStatusView(job);
  const parked = view.phase === 'parked';
  const failed = view.phase === 'failed';
  const title = failed ? words.failedTitle : parked ? words.parkedTitle : words.title;
  const fraction =
    view.phase === 'running' && view.done !== undefined && view.total
      ? view.done / view.total
      : undefined;
  return (
    <View testID={`${words.testID}-status`} className={cn('max-w-[560px] gap-1.5', className)}>
      <View className="flex-row items-center gap-2">
        <Icon
          name={failed || parked ? 'circle-exclamation' : 'sparkles'}
          size={14}
          color={failed ? themed.destructive : parked ? themed.warning : themed.mutedForeground}
        />
        <Text variant="label" className="min-w-0 flex-1" numberOfLines={2}>
          {title}
        </Text>
        {failed ? (
          <Button
            testID={`${words.testID}-retry`}
            size="sm"
            variant="outline"
            icon="rotate"
            title={t('bridge.status.tryAgain')}
            loading={model.queueing}
            onPress={model.retry}
          />
        ) : (
          <Button
            testID={`${words.testID}-cancel`}
            size="sm"
            variant="ghost"
            title={t('common.cancel')}
            disabled={view.phase === 'stopping'}
            loading={model.cancelling}
            onPress={() => model.cancel(job)}
          />
        )}
      </View>
      <Text variant="caption" numberOfLines={failed ? 4 : 2} style={tabularNums}>
        {statusLine(t, view)}
      </Text>
      {fraction !== undefined ? (
        <ProgressBar fraction={fraction} minPercent={4} fillClassName="bg-foreground/60" />
      ) : null}
      {parked ? (
        <Text variant="caption">
          {view.retryAt
            ? retryLine(t, view.retryAt)
            : t(
                parkEndsByItself(view.reason)
                  ? 'bridge.status.byItself'
                  : 'bridge.status.openConsole',
              )}
        </Text>
      ) : null}
    </View>
  );
}
