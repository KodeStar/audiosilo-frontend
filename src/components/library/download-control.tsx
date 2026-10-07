import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import type { Book, ChaptersResponse } from '@/api/types';
import { RemoveDownloadConfirm } from '@/components/downloads/remove-download-confirm';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useDownloadControls } from '@/downloads/use-download-controls';
import { formatBytes } from '@/lib/format';
import { useThemeColors } from '@/theme/use-theme-colors';

/** Download affordance on the book detail screen: download / progress+cancel /
 * downloaded+delete / retry, with a fallback when offline storage is unavailable
 * (an insecure-context or very old browser). Delete asks first (the Downloads page's
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
  const { connectionId, supported, status, error, progress, bytes, totalBytes, start, cancel } =
    useDownloadControls(libraryId, path, book, chapterData);
  const [confirming, setConfirming] = useState(false);
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
          accessibilityLabel={t('library.download.unavailable')}
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

  if (!supported) {
    return (
      <Button
        title={t('library.download.unavailable')}
        variant="secondary"
        icon="download"
        disabled
      />
    );
  }

  if (status === 'downloaded') {
    return (
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-2 rounded-lg bg-muted px-4 py-3">
          <Icon name="check" size={16} color={themed.brand} />
          <Text className="font-sans-semibold">
            {t('library.download.downloaded')}
            {totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={() => setConfirming(true)}
          hitSlop={6}
          accessibilityRole="button"
          accessibilityLabel={t('library.download.remove')}
          className="h-11 w-11 items-center justify-center rounded-lg bg-muted"
        >
          <Icon name="trash" size={16} color={themed.mutedForeground} />
        </Pressable>
        {confirm}
      </View>
    );
  }

  if (status === 'downloading' || status === 'queued') {
    return (
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Text variant="muted" className="flex-1" numberOfLines={1}>
            {status === 'queued'
              ? t('library.download.queued')
              : t('library.download.downloading', { percent: Math.round(progress * 100) })}
            {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
          </Text>
          <Pressable
            onPress={cancel}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('library.download.cancel')}
            className="h-8 w-8 items-center justify-center"
          >
            <Icon name="close" size={16} color={themed.mutedForeground} />
          </Pressable>
        </View>
        <ProgressBar fraction={progress} minPercent={4} className="h-1.5" />
      </View>
    );
  }

  return (
    <View className="gap-1.5">
      {status === 'error' && error ? (
        <Text className="text-xs text-destructive" numberOfLines={2}>
          {error}
        </Text>
      ) : null}
      <Button
        title={status === 'error' ? t('library.download.retry') : t('library.download.download')}
        variant="secondary"
        icon="download"
        disabled={disabled || !book}
        onPress={start}
      />
    </View>
  );
}

/** The in-flight download progress bar, shown only while downloading/queued.
 * Pairs with the compact DownloadControl button (which handles cancel), so it
 * carries no controls of its own - just the percentage and bar. */
export function DownloadProgress({ libraryId, path }: { libraryId: number; path: string }) {
  const { t } = useTranslation();
  const { status, progress, bytes, totalBytes } = useDownloadControls(libraryId, path);
  if (status !== 'downloading' && status !== 'queued') return null;
  return (
    <View className="gap-1.5">
      <Text variant="muted" numberOfLines={1}>
        {status === 'queued'
          ? t('library.download.queued')
          : t('library.download.downloading', { percent: Math.round(progress * 100) })}
        {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
      </Text>
      <ProgressBar fraction={progress} minPercent={4} className="h-1.5" />
    </View>
  );
}
