import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { BookCover } from '@/components/library/book-cover';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { bytesToGo, entryBytes } from '@/downloads/downloads-view';
import type { AheadBook, SlotState } from '@/downloads/keep-ahead';
import type { DownloadEntry } from '@/downloads/types';
import { formatBytes } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { StorageScope } from './storage-card';

const COVER = 52;
const percent = (fraction: number) => Math.floor(Math.max(0, Math.min(1, fraction)) * 100);

/** What went wrong with a failed download, and whether anything was lost (STYLEGUIDE
 * section 12): the cause from `entry.failure`, then the share kept on the device or
 * that a retry starts over. Entries saved before failures were classified read as
 * "stopped". */
export function failureText(
  t: TFunction,
  entry: Pick<DownloadEntry, 'failure'>,
  server: string,
  scope: StorageScope,
): string {
  const f = entry.failure ?? { kind: 'unknown' as const };
  const cause =
    f.kind === 'network'
      ? t('downloads.failure.network', { server })
      : f.kind === 'server'
        ? t('downloads.failure.server', { server, status: f.status })
        : f.kind === 'storage'
          ? scope === 'browser'
            ? t('downloads.failure.storageBrowser')
            : t('downloads.failure.storageDevice')
          : f.kind === 'unservable'
            ? t('downloads.failure.unservable')
            : f.kind === 'removed'
              ? t('downloads.failure.removed')
              : t('downloads.failure.unknown');
  // An unservable download is fully saved: the cause already says what to do.
  if (f.kind === 'unservable' || f.kind === 'removed') return cause;
  const kept = f.kept ?? 0;
  const tail =
    kept > 0
      ? t('downloads.failure.kept', { percent: percent(kept) })
      : t('downloads.failure.restart');
  return `${cause} ${tail}`;
}

/** A row of the In progress / Ready offline cards: cover, the text column, an optional
 * status column (beside it on tablet and desktop, under the text on a phone) and the
 * actions. Rows are separated by hairlines, as in the prototype's list cards. */
function RowFrame({
  cover,
  title,
  meta,
  status,
  actions,
  first,
}: {
  cover: ReactNode;
  title: string;
  meta: string;
  status?: ReactNode;
  actions: ReactNode;
  first: boolean;
}) {
  const phone = useLayout() === 'phone';
  return (
    <View
      className={cn('flex-row items-center gap-3 px-4 py-3', !first && 'border-t border-border')}
    >
      {cover}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label" numberOfLines={1}>
          {title}
        </Text>
        <Text variant="caption" numberOfLines={1} style={tabularNums}>
          {meta}
        </Text>
        {phone && status ? <View className="mt-1.5 gap-1">{status}</View> : null}
      </View>
      {!phone && status ? <View className="w-56 gap-1 lg:w-64">{status}</View> : null}
      <View className="flex-row items-center gap-1">{actions}</View>
    </View>
  );
}

/** A thin brand progress bar (the page's one pink thing, with the storage bar's first
 * server colour). */
function ProgressBar({ fraction }: { fraction: number }) {
  return (
    <View className="h-1 overflow-hidden rounded-full bg-muted">
      <View
        className="h-full rounded-full bg-brand"
        style={{ width: `${Math.max(2, percent(fraction))}%` }}
      />
    </View>
  );
}

function sizeMeta(t: TFunction, server: string, bytes: number, keptAhead: boolean): string {
  const parts = [
    keptAhead ? t('downloads.row.keptAhead') : null,
    bytes > 0 ? t('downloads.row.meta', { server, size: formatBytes(bytes) }) : server,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** A download that is running, waiting its turn or failed. */
export function ActiveRow({
  entry,
  server,
  scope,
  first,
  onCancel,
  onRetry,
}: {
  entry: DownloadEntry;
  server: string;
  scope: StorageScope;
  first: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  const total = entry.totalBytes > 0 ? entry.totalBytes : entry.manifest.book.size;
  const toGo = bytesToGo(entry);
  const failed = entry.status === 'error';

  const status = failed ? (
    <>
      <View className="flex-row items-center gap-1.5">
        <Icon name="circle-exclamation" size={14} color={themed.destructive} />
        <Text className="font-sans-semibold text-sm text-destructive" style={tabularNums}>
          {t('downloads.row.stoppedAt', { percent: percent(entry.progress) })}
        </Text>
      </View>
      <Text variant="caption">{failureText(t, entry, server, scope)}</Text>
    </>
  ) : entry.status === 'queued' ? (
    <Text variant="caption">{t('downloads.row.queued')}</Text>
  ) : (
    <>
      <ProgressBar fraction={entry.progress} />
      <Text variant="caption" style={tabularNums}>
        {toGo !== null
          ? t('downloads.row.progress', {
              percent: percent(entry.progress),
              size: formatBytes(toGo),
            })
          : t('downloads.row.percent', { percent: percent(entry.progress) })}
      </Text>
    </>
  );

  return (
    <RowFrame
      first={first}
      cover={
        <BookCover
          connectionId={entry.connectionId}
          libraryId={entry.libraryId}
          path={entry.path}
          coverVersion={entry.manifest.book.cover_version}
          width={COVER}
          title={entry.title}
        />
      }
      title={entry.title}
      meta={sizeMeta(t, server, total, entry.origin === 'keep-ahead')}
      status={status}
      actions={
        <>
          {failed ? (
            <Button
              variant="outline"
              size="sm"
              icon="rotate"
              title={phone ? undefined : t('downloads.row.retry')}
              accessibilityLabel={t('downloads.row.retryLabel', { title: entry.title })}
              onPress={onRetry}
              className={phone ? 'w-11 px-0' : undefined}
            />
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            icon={phone || failed ? 'close' : undefined}
            title={phone || failed ? undefined : t('downloads.row.cancel')}
            accessibilityLabel={t('downloads.row.cancelLabel', { title: entry.title })}
            onPress={onCancel}
            className={phone || failed ? 'w-11 px-0' : undefined}
          />
        </>
      }
    />
  );
}

/** A book "Keep the next books ready" will download once it can (Wi-Fi, room, its
 * turn). Cancel marks it declined for the session, like cancelling a running one. */
export function PlannedRow({
  book,
  state,
  server,
  first,
  onCancel,
}: {
  book: AheadBook;
  state: Extract<SlotState, 'waiting' | 'no-space' | 'later'>;
  server: string;
  first: boolean;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const phone = useLayout() === 'phone';
  const label =
    state === 'waiting'
      ? t('downloads.row.waitingWifi')
      : state === 'no-space'
        ? t('downloads.row.noSpace')
        : t('downloads.row.queued');
  return (
    <RowFrame
      first={first}
      cover={
        <BookCover
          connectionId={book.connectionId}
          libraryId={book.libraryId}
          path={book.path}
          width={COVER}
          title={book.title}
        />
      }
      title={book.title}
      meta={sizeMeta(t, server, book.size, true)}
      status={
        <Text variant="caption" className={cn(state === 'no-space' && 'text-warning')}>
          {label}
        </Text>
      }
      actions={
        <Button
          variant="ghost"
          size="sm"
          icon={phone ? 'close' : undefined}
          title={phone ? undefined : t('downloads.row.cancel')}
          accessibilityLabel={t('downloads.row.cancelLabel', { title: book.title })}
          onPress={onCancel}
          className={phone ? 'w-11 px-0' : undefined}
        />
      }
    />
  );
}

/** A book on the device: opens its page; Play starts it (as the old list did); Remove
 * asks first (`onRemove` opens the confirm). */
export function ReadyRow({
  entry,
  progressLabel,
  first,
  onOpen,
  onPlay,
  onRemove,
}: {
  entry: DownloadEntry;
  /** "38%", "Not started" or "Finished", when the listener's progress is known. */
  progressLabel?: string;
  first: boolean;
  onOpen: () => void;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const phone = useLayout() === 'phone';
  const size = formatBytes(entryBytes(entry));
  const meta = [
    entry.manifest.book.author,
    progressLabel,
    phone ? size : null,
    entry.origin === 'keep-ahead' ? t('downloads.row.keptAhead') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View className={cn('flex-row items-center gap-2 pr-3', !first && 'border-t border-border')}>
      <AnimatedPressable
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={[entry.title, meta].filter(Boolean).join(', ')}
        className={cn(
          'min-w-0 flex-1 flex-row items-center gap-3 py-3 pl-4 active:bg-accent hover:bg-accent',
          Platform.select({
            web: 'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring',
          }),
        )}
      >
        <BookCover
          connectionId={entry.connectionId}
          libraryId={entry.libraryId}
          path={entry.path}
          coverVersion={entry.manifest.book.cover_version}
          width={COVER}
          title={entry.title}
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text variant="label" numberOfLines={1}>
            {entry.title}
          </Text>
          <Text variant="caption" numberOfLines={1} style={tabularNums}>
            {meta}
          </Text>
        </View>
        {phone ? null : (
          <Text variant="muted" className="w-24 text-right" style={tabularNums}>
            {size}
          </Text>
        )}
      </AnimatedPressable>
      <Button
        variant="ghost"
        size="icon"
        icon="play"
        accessibilityLabel={t('downloads.row.play', { title: entry.title })}
        onPress={onPlay}
      />
      <Button
        variant="ghost"
        size="icon"
        accessibilityLabel={t('downloads.row.remove', { title: entry.title })}
        onPress={onRemove}
      >
        <Icon name="trash" size={16} color={themed.mutedForeground} />
      </Button>
    </View>
  );
}
