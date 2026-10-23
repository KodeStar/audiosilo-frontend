import { useIsFocused } from 'expo-router';
import type { TFunction } from 'i18next';
import { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useFollowRequests } from '@/api/hooks';
import type { OpmlImportRow, PodcastRequest } from '@/api/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RowSurface } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { useNow } from '@/lib/use-now';
import { tabularNums } from '@/theme/tabular-nums';

import {
  failedRows,
  importFailureKey,
  importProgress,
  importRowKey,
  importRowReasonKey,
  liveImportRows,
  stillAdding,
} from './find-shows-model';
import { pickOpml } from './opml-pick';
import {
  canRetryImport,
  isRunning,
  unavailableRows,
  type WaveState,
  type WaveStatus,
} from './opml-waves';
import { type OpmlImport, withRetries } from './use-opml-import';

/** The status line of an import (`now` for a countdown). A done import is done only once
 * nothing is still being added; rows that could not be added are counted (those that need
 * a person first, then those that failed, each with its own Try again). */
function statusLine(
  status: WaveStatus,
  rows: readonly OpmlImportRow[],
  now: number,
  t: TFunction,
): string {
  switch (status.kind) {
    case 'uploading':
      return t('podcasts.import.status.uploading');
    case 'waitingRequests':
      return t('podcasts.import.status.waitingRequests');
    case 'waitingTime': {
      const seconds = Math.max(1, Math.ceil((status.at - now) / 1000));
      return status.why === 'busy'
        ? t('podcasts.import.status.busy', { seconds })
        : status.why === 'rateLimited'
          ? t('podcasts.import.status.rateLimited', { seconds })
          : t('podcasts.import.status.waitingTime', { seconds });
    }
    case 'done': {
      if (stillAdding(rows)) return t('podcasts.import.status.finishing');
      const unavailable = unavailableRows(rows);
      const failed = failedRows(rows);
      return unavailable > 0
        ? t('podcasts.import.status.unavailable', { count: unavailable })
        : failed > 0
          ? t('podcasts.import.status.doneFailed', { count: failed })
          : t('podcasts.import.status.done');
    }
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
 * its place in the list, each queued one read live from the follow requests. `opml` is
 * the page's import (`useOpmlImport`), so it carries on while another section shows.
 */
export function OpmlImportPanel({
  opml,
  connectionId,
  libraryId,
}: {
  opml: OpmlImport;
  connectionId: string;
  libraryId: number;
}) {
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
          connectionId={connectionId}
          libraryId={libraryId}
          state={state}
          opml={opml}
          running={running}
        />
      ) : null}
    </View>
  );
}

function ImportProgress({
  connectionId,
  libraryId,
  state,
  opml,
  running,
}: {
  connectionId: string;
  libraryId: number;
  state: WaveState;
  opml: OpmlImport;
  running: boolean;
}) {
  const { t } = useTranslation();
  const focused = useIsFocused();
  const { data: requests } = useFollowRequests(libraryId, { active: focused }, connectionId);
  const { fileName, retries, canRetryRow, retryRow, stop: onStop, retry: onRetry } = opml;
  const rows = useMemo(
    () => liveImportRows(withRetries(state.rows, retries), requests),
    [state.rows, retries, requests],
  );
  const { settled, total } = importProgress(rows);
  const retryable = canRetryImport(state);
  return (
    <View className="gap-3">
      <View className="gap-1" accessibilityLiveRegion="polite">
        {fileName ? (
          <Text variant="caption" numberOfLines={1}>
            {fileName}
          </Text>
        ) : null}
        {rows.length > 0 ? (
          <Text variant="label" style={tabularNums} testID="opml-summary">
            {t('podcasts.import.summary', { settled, total })}
          </Text>
        ) : null}
        <StatusText status={state.status} rows={rows} />
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
      {rows.length > 0 ? (
        <View className="gap-2" accessibilityLabel={t('podcasts.import.rowsLabel')}>
          {rows.map((row) => (
            <ImportRow
              key={row.outline_index}
              row={row}
              requests={requests}
              busy={retries[row.outline_index]?.kind === 'busy'}
              onRetry={canRetryRow(row) ? retryRow : undefined}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** The status line on its own, so the countdown's ticks redraw it alone. The clock ticks
 * while the import runs, not only while it counts down: a clock stopped since the last
 * countdown would start the next one seconds (or minutes) too long. */
function StatusText({ status, rows }: { status: WaveStatus; rows: readonly OpmlImportRow[] }) {
  const { t } = useTranslation();
  const now = useNow(1000, isRunning(status));
  return (
    <Text variant="body" style={tabularNums} testID="opml-status">
      {statusLine(status, rows, now, t)}
    </Text>
  );
}

const ImportRow = memo(function ImportRow({
  row,
  requests,
  busy,
  onRetry,
}: {
  row: OpmlImportRow;
  requests: readonly PodcastRequest[] | undefined;
  busy: boolean;
  /** Its own Try again (a single follow by its address), when it has one. */
  onRetry?: (row: OpmlImportRow) => void;
}) {
  const { t } = useTranslation();
  // The server marks a list's private feeds; a row with no usable feed has none to mark.
  const hasFeed = row.feed !== null && row.status !== 'invalid' && row.status !== 'duplicate';
  const label = row.path ?? row.feed;
  const reasonKey = importRowReasonKey(row, requests);
  return (
    <RowSurface
      testID={`opml-row-${row.outline_index}`}
      className="flex-row items-center gap-3 px-3 py-2.5"
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-2">
          <Text variant="caption" style={tabularNums}>
            {t('podcasts.import.entry', { index: row.outline_index })}
          </Text>
          {row.private && hasFeed ? (
            <Badge variant="outline">
              <Text>{t('podcasts.shows.privateBadge')}</Text>
            </Badge>
          ) : null}
        </View>
        {label ? (
          <Text variant="label" numberOfLines={1}>
            {label}
          </Text>
        ) : null}
        <Text variant="caption">
          {row.status === 'duplicate' && row.duplicate_of !== null
            ? `${t(importRowKey(row))} (${t('podcasts.import.entry', { index: row.duplicate_of })})`
            : t(importRowKey(row))}
        </Text>
        {reasonKey ? (
          <Text variant="caption" testID={`opml-row-reason-${row.outline_index}`}>
            {t(reasonKey)}
          </Text>
        ) : null}
      </View>
      {onRetry ? (
        <Button
          variant="outline"
          size="sm"
          icon="rotate"
          title={t('podcasts.import.tryAgain')}
          accessibilityLabel={t('podcasts.import.tryRowAgain', { index: row.outline_index })}
          loading={busy}
          onPress={() => onRetry(row)}
          testID={`opml-row-retry-${row.outline_index}`}
        />
      ) : null}
    </RowSurface>
  );
});
