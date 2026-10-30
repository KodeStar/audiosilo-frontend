import { memo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { useScopedCid } from '@/api/provider';
import type { Book, ChaptersResponse } from '@/api/types';
import { RemoveDownloadConfirm } from '@/components/downloads/remove-download-confirm';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { ProgressRing } from '@/components/ui/progress-ring';
import { Text } from '@/components/ui/text';
import { failureText } from '@/downloads/failure';
import { useDownloadEntry, useDownloadProgress } from '@/downloads/store';
import { useDownloadControls } from '@/downloads/use-download-controls';
import { formatBytes } from '@/lib/format';
import { useConnectionName } from '@/stores/session';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** The full control's buttons give way in a tight row (the Button base is `shrink-0`). */
const SHRINKS = 'max-w-full shrink';

/**
 * The book hero's download control (the prototype's `DownloadControl`): Download for
 * offline / "52% · Cancel" / Downloaded (a menu with its size and Remove download) /
 * Retry download, with a fallback when offline storage is unavailable (an
 * insecure-context or very old browser, or a book this browser only plays converted).
 * Delete asks first (the Downloads page's confirm, with the size): the only undo is
 * downloading the book again. An outline button per state, so the hero's one pink thing
 * stays its progress bar. It may shrink (a phone's row keeps the hero's icon buttons
 * beside it), its words ending in "..." rather than wrapping the row.
 */
export function DownloadControl({
  libraryId,
  path,
  book,
  chapterData,
  disabled,
  short,
}: {
  libraryId: number;
  path: string;
  book?: Book;
  chapterData?: ChaptersResponse;
  disabled?: boolean;
  /** The hero's row is narrow (stacked, by the page's measured width): the short words,
   * beside its icon buttons. */
  short?: boolean;
}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  // Its state only: the ring and the size read the progress in children of their own
  // (`DownloadingButton`, `OnDeviceLabel`), so a running download's ticks redraw them,
  // not this control and its menu (fe#196).
  const { connectionId, supported, needsTranscode, status, failure, start, cancel } =
    useDownloadControls(libraryId, path, book, chapterData);
  const server = useConnectionName(connectionId) || t('downloads.storage.unknownServer');
  const [confirming, setConfirming] = useState(false);
  // Why downloading is off: this browser plays the book through the server's
  // transcoder (its raw files would not play offline), or offline storage is missing.
  const unavailableLabel = needsTranscode
    ? t('library.download.notInBrowser')
    : t('library.download.unavailable');
  const confirm = (
    <RemoveDownloadConfirm
      target={confirming ? { connectionId, libraryId, path, title: book?.title ?? '' } : null}
      onClose={() => setConfirming(false)}
    />
  );

  // Podcast episodes are not kept offline (Bridge Phase 2d-1, decision 6.1).
  if (book?.episode) return null;
  if (!supported) {
    return (
      <Button
        variant="outline"
        size="lg"
        icon="download"
        disabled
        accessibilityLabel={unavailableLabel}
        className={SHRINKS}
      >
        {words(unavailableLabel)}
      </Button>
    );
  }

  if (status === 'downloaded') {
    return (
      <>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="lg"
              accessibilityLabel={t('library.download.downloaded')}
              accessibilityHint={t('library.download.remove')}
              className={SHRINKS}
            >
              <Icon name="circle-check" size={18} color={themed.success} />
              {words(t('library.download.downloaded'))}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <OnDeviceLabel connectionId={connectionId} libraryId={libraryId} path={path} />
            <DropdownMenuItem
              icon="trash"
              variant="destructive"
              onPress={() => setConfirming(true)}
            >
              <Text>{t('library.download.remove')}</Text>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {confirm}
      </>
    );
  }

  if (status === 'downloading' || status === 'queued') {
    return (
      <DownloadingButton
        connectionId={connectionId}
        libraryId={libraryId}
        path={path}
        queued={status === 'queued'}
        short={short}
        onCancel={cancel}
      />
    );
  }

  const idleLabel =
    status === 'error'
      ? t('library.download.retry')
      : short
        ? t('library.download.download')
        : t('book.download.forOffline');
  return (
    <View className="min-w-0 shrink gap-1.5">
      <Button
        variant={status === 'error' ? 'destructive-outline' : 'outline'}
        size="lg"
        icon={status === 'error' ? 'rotate' : 'download'}
        disabled={disabled || !book}
        onPress={start}
        accessibilityLabel={idleLabel}
        className={SHRINKS}
      >
        {words(idleLabel)}
      </Button>
      {status === 'error' ? (
        // What went wrong, worded as the Downloads page words it (the stored `error` is
        // the engine's English).
        <Text variant="caption" className="max-w-[320px] text-destructive" numberOfLines={2}>
          {failureText(t, { failure }, server, Platform.OS === 'web' ? 'browser' : 'device')}
        </Text>
      ) : null}
    </View>
  );
}

/** A button's words on one line, giving way (ending in "...") in a tight row. */
function words(text: string) {
  return (
    <Text numberOfLines={1} className="shrink" style={tabularNums}>
      {text}
    </Text>
  );
}

/** "52% · Cancel" with its ring: the one part of the control that redraws as the download
 * runs (it reads the progress; `DownloadControl` doesn't). */
const DownloadingButton = memo(function DownloadingButton({
  connectionId,
  libraryId,
  path,
  queued,
  short,
  onCancel,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
  queued: boolean;
  short?: boolean;
  onCancel: () => void;
}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { progress } = useDownloadProgress(connectionId, libraryId, path);
  const said = queued
    ? t('book.download.queuedCancel')
    : t('book.download.progressCancel', { percent: Math.round(progress * 100) });
  return (
    <Button
      variant="outline"
      size="lg"
      onPress={onCancel}
      accessibilityLabel={`${said}, ${t('library.download.cancel')}`}
      className={SHRINKS}
    >
      <ProgressRing
        fraction={queued ? 0 : progress}
        size={18}
        stroke={2.5}
        color={themed.foreground}
        trackColor={themed.border}
      />
      {/* A short row says only Cancel: the ring and the progress line under the hero
          carry the percent, and "52% · Cancel" pushed the row's icons onto a second
          row at 400. */}
      {words(short ? t('common.cancel') : said)}
    </Button>
  );
});

/** The Downloaded menu's "50 MB on this device" (nothing while the size is unknown). */
function OnDeviceLabel({
  connectionId,
  libraryId,
  path,
}: {
  connectionId: string;
  libraryId: number;
  path: string;
}) {
  const { t } = useTranslation();
  const { totalBytes } = useDownloadProgress(connectionId, libraryId, path);
  if (totalBytes <= 0) return null;
  return (
    <DropdownMenuLabel>
      {t('book.download.onDevice', { size: formatBytes(totalBytes) })}
    </DropdownMenuLabel>
  );
}

/** The in-flight download's line, shown only while downloading/queued: the percentage
 * and the bytes so far over an ink bar (the hero's pink is the book's progress). Pairs
 * with the control's button (which handles cancel), so it carries no controls. */
export function DownloadProgress({ libraryId, path }: { libraryId: number; path: string }) {
  const { t } = useTranslation();
  // It redraws with every tick anyway, so the whole entry is the one read it needs.
  const entry = useDownloadEntry(useScopedCid(), libraryId, path);
  if (entry?.status !== 'downloading' && entry?.status !== 'queued') return null;
  const { status, progress, bytes, totalBytes } = entry;
  return (
    <View className="max-w-[560px] gap-1.5">
      <Text variant="caption" numberOfLines={1} style={tabularNums}>
        {status === 'queued'
          ? t('library.download.queued')
          : t('library.download.downloading', { percent: Math.round(progress * 100) })}
        {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
      </Text>
      <ProgressBar fraction={progress} minPercent={4} fillClassName="bg-foreground/60" />
    </View>
  );
}
