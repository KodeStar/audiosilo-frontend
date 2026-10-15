import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBridgeJobs } from '@/api/hooks';
import type { BridgeJob } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { formatDuration, formatWallClock } from '@/lib/format';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import { type JobStatusView, jobStatusView, statusJob } from './bridge-model';
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

/**
 * A book's generate job, compactly (where the action was: under the book page's actions,
 * or in the companion's empty Who's who and Story so far): the stage, "12 of 40", the time
 * left and Cancel while it runs; a short reason and "Open the console to fix it" while it
 * is parked (or when it tries again by itself); the error and Try again once it failed.
 * Nothing without such a job (`statusJob`). It reads the book's job list itself, polling
 * while `model.active`, so a poll re-renders only this.
 */
export function GenerateStatus({ model, className }: { model: GenerateModel; className?: string }) {
  const { connectionId, libraryId, path } = model.target;
  const { data: job } = useBridgeJobs(
    libraryId,
    path,
    { enabled: model.allowed, active: model.active, select: statusJob },
    connectionId,
  );
  return job ? <JobStatus job={job} model={model} className={className} /> : null;
}

/** One job's status (see `GenerateStatus`). Status is the words and the icon, never
 * colour alone. */
function JobStatus({
  job,
  model,
  className,
}: {
  job: BridgeJob;
  model: GenerateModel;
  className?: string;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const view = jobStatusView(job);
  const parked = view.phase === 'parked';
  const failed = view.phase === 'failed';
  const title = failed
    ? t('bridge.status.failedTitle')
    : parked
      ? t('bridge.status.parkedTitle')
      : t('bridge.status.title');
  const fraction =
    view.phase === 'running' && view.done !== undefined && view.total
      ? view.done / view.total
      : undefined;
  return (
    <View testID="generate-status" className={cn('max-w-[560px] gap-1.5', className)}>
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
            testID="generate-retry"
            size="sm"
            variant="outline"
            icon="rotate"
            title={t('bridge.status.tryAgain')}
            loading={model.queueing}
            onPress={model.retry}
          />
        ) : (
          <Button
            testID="generate-cancel"
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
            ? t('bridge.status.retryAt', { time: formatWallClock(view.retryAt) })
            : t('bridge.status.openConsole')}
        </Text>
      ) : null}
    </View>
  );
}
