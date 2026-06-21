import { Pressable, View } from 'react-native';

import type { Book, ChaptersResponse } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useDownloadControls } from '@/downloads/use-download-controls';
import { formatBytes } from '@/lib/format';
import { colors } from '@/theme/tokens';

/** Download affordance on the book detail screen: download / progress+cancel /
 * downloaded+delete / retry, with a fallback when offline storage is unavailable
 * (an insecure-context or very old browser). */
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
  const { supported, status, error, progress, bytes, totalBytes, start, cancel, remove } =
    useDownloadControls(libraryId, path, book, chapterData);

  // Icon-only variant for the overview's inline button row. Each state collapses
  // to a single square (height matches the Listen button via the row's stretch).
  if (compact) {
    if (!supported) {
      return (
        <Button icon="download" variant="secondary" disabled accessibilityLabel="Downloads unavailable" />
      );
    }
    // The icon shows the action, not the state: trash = delete the download,
    // stop = cancel the one in progress (the bar below already signals progress).
    if (status === 'downloaded') {
      return (
        <Button
          icon="trash"
          variant="secondary"
          className="px-5"
          onPress={remove}
          accessibilityLabel="Delete download"
        />
      );
    }
    if (status === 'downloading' || status === 'queued') {
      return (
        <Button
          icon="circle-stop"
          variant="secondary"
          className="px-5"
          onPress={cancel}
          accessibilityLabel="Cancel download"
        />
      );
    }
    return (
      <Button
        icon="download"
        variant="secondary"
        className="px-5"
        disabled={disabled || !book}
        onPress={start}
        accessibilityLabel={status === 'error' ? 'Retry download' : 'Download'}
      />
    );
  }

  if (!supported) {
    return <Button title="Downloads unavailable" variant="secondary" icon="download" disabled />;
  }

  if (status === 'downloaded') {
    return (
      <View className="flex-row items-center gap-2">
        <View className="flex-1 flex-row items-center gap-2 rounded-lg bg-gray-100 px-4 py-3 dark:bg-gray-840">
          <Icon name="check" size={16} color={colors.primary} />
          <Text className="font-roboto-semibold text-gray-700 dark:text-gray-200">
            Downloaded{totalBytes > 0 ? ` · ${formatBytes(totalBytes)}` : ''}
          </Text>
        </View>
        <Pressable
          onPress={remove}
          hitSlop={6}
          className="h-11 w-11 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-840"
        >
          <Icon name="trash" size={16} color={colors.dark.textMuted} />
        </Pressable>
      </View>
    );
  }

  if (status === 'downloading' || status === 'queued') {
    return (
      <View className="gap-1.5">
        <View className="flex-row items-center gap-2">
          <Text variant="muted" className="flex-1" numberOfLines={1}>
            {status === 'queued' ? 'Queued…' : `Downloading ${Math.round(progress * 100)}%`}
            {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
          </Text>
          <Pressable onPress={cancel} hitSlop={8} className="h-8 w-8 items-center justify-center">
            <Icon name="close" size={16} color={colors.dark.textMuted} />
          </Pressable>
        </View>
        <View className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <View
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        </View>
      </View>
    );
  }

  return (
    <View className="gap-1.5">
      {status === 'error' && error ? (
        <Text className="text-xs text-red-500" numberOfLines={2}>
          {error}
        </Text>
      ) : null}
      <Button
        title={status === 'error' ? 'Retry download' : 'Download'}
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
 * carries no controls of its own — just the percentage and bar. */
export function DownloadProgress({ libraryId, path }: { libraryId: number; path: string }) {
  const { status, progress, bytes, totalBytes } = useDownloadControls(libraryId, path);
  if (status !== 'downloading' && status !== 'queued') return null;
  return (
    <View className="gap-1.5">
      <Text variant="muted" numberOfLines={1}>
        {status === 'queued' ? 'Queued…' : `Downloading ${Math.round(progress * 100)}%`}
        {totalBytes > 0 ? ` · ${formatBytes(bytes)} / ${formatBytes(totalBytes)}` : ''}
      </Text>
      <View className="h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
        <View
          className="h-full rounded-full bg-primary"
          style={{ width: `${Math.max(4, progress * 100)}%` }}
        />
      </View>
    </View>
  );
}
