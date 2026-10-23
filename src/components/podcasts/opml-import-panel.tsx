import type { TFunction } from 'i18next';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { OpmlImportRow } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RowSurface } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { useNow } from '@/lib/use-now';
import { tabularNums } from '@/theme/tabular-nums';

import { importFailureKey, importProgress, importRowKey } from './find-shows-model';
import { pickOpml } from './opml-pick';
import { canRetry, isRunning, type WaveState, type WaveStatus } from './opml-waves';
import type { OpmlImport } from './use-opml-import';

/** The status line of an import (`now` for a countdown). */
function statusLine(status: WaveStatus, now: number, t: TFunction): string {
  switch (status.kind) {
    case 'uploading':
      return t('podcasts.import.status.uploading');
    case 'waitingRequests':
      return t('podcasts.import.status.waitingRequests');
    case 'waitingTime': {
      const seconds = Math.max(1, Math.ceil((status.at - now) / 1000));
      return status.why === 'busy'
        ? t('podcasts.import.status.busy', { seconds })
        : t('podcasts.import.status.waitingTime', { seconds });
    }
    case 'done':
      return t('podcasts.import.status.done');
    case 'stalled':
      return t('podcasts.import.status.stalled');
    case 'stopped':
      return status.why === 'busy'
        ? t('podcasts.import.status.stoppedBusy')
        : status.why === 'cantAct'
          ? t('podcasts.import.status.stoppedCantAct')
          : t('podcasts.import.status.stoppedUser');
    case 'failed':
      return t(importFailureKey(status.code));
  }
}

/**
 * Find shows' OPML import (Bridge Phase 2d-2, capability `podcast_opml`): choose a list
 * exported by another podcast app, and it is followed in automatic waves of five
 * (`OpmlWaves`). The page shows the summary, what the import is doing (the next batch's
 * countdown), Stop while it runs and Try again once it stopped, and every subscription by
 * its place in the list. `opml` is the page's import (`useOpmlImport`), so it carries on
 * while another section shows.
 */
export function OpmlImportPanel({ opml }: { opml: OpmlImport }) {
  const { t } = useTranslation();
  const { state, problem } = opml;
  const running = !!state && isRunning(state.status);
  const choose = () =>
    void pickOpml().then(
      (file) => {
        if (file) opml.start(file);
      },
      () => opml.unreadable(),
    );
  return (
    <View testID="opml-import" className="gap-4">
      <Text variant="body">{t('podcasts.import.intro')}</Text>
      <Button
        variant={state ? 'outline' : 'default'}
        icon="inbox"
        title={state || problem ? t('podcasts.import.chooseAnother') : t('podcasts.import.choose')}
        onPress={choose}
        disabled={running}
        className="self-start"
        testID="opml-choose"
      />
      {problem ? (
        <Text variant="body" className="text-destructive" role="alert" testID="opml-problem">
          {t(problem === 'tooLarge' ? 'podcasts.import.tooLarge' : 'podcasts.import.unreadable')}
        </Text>
      ) : null}
      {state ? (
        <ImportProgress
          state={state}
          fileName={opml.fileName}
          running={running}
          onStop={opml.stop}
          onRetry={opml.retry}
        />
      ) : null}
    </View>
  );
}

function ImportProgress({
  state,
  fileName,
  running,
  onStop,
  onRetry,
}: {
  state: WaveState;
  fileName: string | null;
  running: boolean;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { settled, total } = importProgress(state.rows);
  const retryable = canRetry(state.status);
  return (
    <View className="gap-3">
      <View className="gap-1" accessibilityLiveRegion="polite">
        {fileName ? (
          <Text variant="caption" numberOfLines={1}>
            {fileName}
          </Text>
        ) : null}
        {state.rows.length > 0 ? (
          <Text variant="label" style={tabularNums} testID="opml-summary">
            {t('podcasts.import.summary', { settled, total })}
          </Text>
        ) : null}
        <StatusText status={state.status} />
      </View>
      <View className="flex-row flex-wrap gap-2">
        {running ? (
          <Button
            variant="outline"
            size="sm"
            icon="circle-stop"
            title={t('podcasts.import.stop')}
            onPress={onStop}
            testID="opml-stop"
          />
        ) : null}
        {retryable ? (
          <Button
            variant="outline"
            size="sm"
            icon="rotate"
            title={t('podcasts.import.tryAgain')}
            onPress={onRetry}
            testID="opml-retry"
          />
        ) : null}
      </View>
      {state.rows.length > 0 ? (
        <View className="gap-2" accessibilityLabel={t('podcasts.import.rowsLabel')}>
          {state.rows.map((row) => (
            <ImportRow key={row.outline_index} row={row} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The status line on its own, so the countdown's ticks redraw it alone. */
function StatusText({ status }: { status: WaveStatus }) {
  const { t } = useTranslation();
  const now = useNow(1000, status.kind === 'waitingTime');
  return (
    <Text variant="body" style={tabularNums} testID="opml-status">
      {statusLine(status, now, t)}
    </Text>
  );
}

const ImportRow = memo(function ImportRow({ row }: { row: OpmlImportRow }) {
  const { t } = useTranslation();
  return (
    <RowSurface testID={`opml-row-${row.outline_index}`} className="gap-0.5 px-3 py-2.5">
      <View className="flex-row items-center gap-2">
        <Text variant="caption" style={tabularNums}>
          {t('podcasts.import.entry', { index: row.outline_index })}
        </Text>
        {row.private ? (
          <Badge variant="outline">
            <Text>{t('podcasts.shows.privateBadge')}</Text>
          </Badge>
        ) : null}
      </View>
      <Text variant="label" numberOfLines={1}>
        {row.path ?? row.feed ?? t('podcasts.import.row.invalid')}
      </Text>
      <Text variant="caption">
        {row.status === 'duplicate' && row.duplicate_of !== null
          ? `${t(importRowKey(row))} (${t('podcasts.import.entry', { index: row.duplicate_of })})`
          : t(importRowKey(row))}
      </Text>
    </RowSurface>
  );
});
