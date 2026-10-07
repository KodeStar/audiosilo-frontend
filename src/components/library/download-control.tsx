import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

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
import { ProgressRing } from '@/components/ui/progress-ring';
import { Text } from '@/components/ui/text';
import { useDownloadControls } from '@/downloads/use-download-controls';
import { formatBytes } from '@/lib/format';
import { useLayout } from '@/lib/layout';
import { tabularNums } from '@/theme/tabular-nums';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Download affordance on the book detail screen: Download for offline / "52% · Cancel"
 * / Downloaded (a menu with its size and Remove download) / Retry download, with a
 * fallback when offline storage is unavailable (an insecure-context or very old browser,
 * or a book this browser only plays converted). Delete asks first (the Downloads page's
 * confirm, with the size): the only undo is downloading the book again. */
export function DownloadControl({
  libraryId,
  path,
  book,
  chapterData,
  disabled,
  compact,
}: {
  libraryId: number;
  path: string;
  book?: Book;
  chapterData?: ChaptersResponse;
  disabled?: boolean;
  /** Render an icon-only square button (sits inline next to the Listen button). */
  compact?: boolean;
}) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  // A phone's row is narrow: the short word, beside the hero's icon buttons.
  const phone = useLayout() === 'phone';
  const {
    connectionId,
    supported,
    needsTranscode,
    status,
    error,
    progress,
    totalBytes,
    start,
    cancel,
  } = useDownloadControls(libraryId, path, book, chapterData);
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

  // Icon-only variant for the overview's inline button row. Each state collapses
  // to a single square (height matches the Listen button via the row's stretch).
  if (compact) {
    if (!supported) {
      return (
        <Button
          icon="download"
          variant="secondary"
          size="lg"
          disabled
          accessibilityLabel={unavailableLabel}
        />
      );
    }
    // The icon shows the action, not the state: trash = delete the download,
    // stop = cancel the one in progress (the bar below already signals progress).
    if (status === 'downloaded') {
      return (
        <>
          <Button
            icon="trash"
            variant="secondary"
            size="lg"
            onPress={() => setConfirming(true)}
            accessibilityLabel={t('library.download.remove')}
          />
          {confirm}
        </>
      );
    }
    if (status === 'downloading' || status === 'queued') {
      return (
        <Button
          icon="circle-stop"
          variant="secondary"
          size="lg"
          onPress={cancel}
          accessibilityLabel={t('library.download.cancel')}
        />
      );
    }
    return (
      <Button
        icon="download"
        variant="secondary"
        size="lg"
        disabled={disabled || !book}
        onPress={start}
        accessibilityLabel={
          status === 'error' ? t('library.download.retry') : t('library.download.download')
        }
      />
    );
  }

  // The book hero's full-width control (the prototype's `DownloadControl`): an outline
  // button per state, so the hero's one pink thing stays its progress bar.
  if (!supported) {
    return <Button title={unavailableLabel} variant="outline" size="lg" icon="download" disabled />;
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
            >
              <Icon name="circle-check" size={18} color={themed.success} />
              <Text>{t('library.download.downloaded')}</Text>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {totalBytes > 0 ? (
              <DropdownMenuLabel>
                {t('book.download.onDevice', { size: formatBytes(totalBytes) })}
              </DropdownMenuLabel>
            ) : null}
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
    const words =
      status === 'queued'
        ? t('book.download.queuedCancel')
        : t('book.download.progressCancel', { percent: Math.round(progress * 100) });
    return (
      <Button
        variant="outline"
        size="lg"
        onPress={cancel}
        accessibilityLabel={`${words}, ${t('library.download.cancel')}`}
      >
        <ProgressRing
          fraction={status === 'queued' ? 0 : progress}
          size={18}
          stroke={2.5}
          color={themed.foreground}
          trackColor={themed.border}
        />
        <Text style={tabularNums}>{words}</Text>
      </Button>
    );
  }

  return (
    <View className="gap-1.5">
      <Button
        title={
          status === 'error'
            ? t('library.download.retry')
            : phone
              ? t('library.download.download')
              : t('book.download.forOffline')
        }
        variant={status === 'error' ? 'destructive-outline' : 'outline'}
        size="lg"
        icon={status === 'error' ? 'rotate' : 'download'}
        disabled={disabled || !book}
        onPress={start}
      />
      {status === 'error' && error ? (
        <Text variant="caption" className="max-w-[320px] text-destructive" numberOfLines={2}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** The in-flight download's line, shown only while downloading/queued: the percentage
 * and the bytes so far over an ink bar (the hero's pink is the book's progress). Pairs
 * with the control's button (which handles cancel), so it carries no controls. */
export function DownloadProgress({ libraryId, path }: { libraryId: number; path: string }) {
  const { t } = useTranslation();
  const { status, progress, bytes, totalBytes } = useDownloadControls(libraryId, path);
  if (status !== 'downloading' && status !== 'queued') return null;
  const percent = Math.max(4, Math.min(100, progress * 100));
  return (
    <View className="max-w-[560px] gap-1.5">
      <Text variant="caption" numberOfLines={1} style={tabularNums}>
        {status === 'queued'
          ? t('library.download.queued')
          : t('library.download.downloading', { percent: Math.round(progress * 100) })}
        {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
      </Text>
      <View className="h-1 overflow-hidden rounded-full bg-muted">
        <View className="h-full rounded-full bg-foreground/60" style={{ width: `${percent}%` }} />
      </View>
    </View>
  );
}
