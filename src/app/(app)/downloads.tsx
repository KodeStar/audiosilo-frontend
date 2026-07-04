import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, ScrollView, View } from 'react-native';

import { useOptionalApi } from '@/api/provider';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { Cover } from '@/components/ui/cover';
import { Icon } from '@/components/ui/icon';
import { EmptyNote } from '@/components/ui/query-state';
import { Text } from '@/components/ui/text';
import { engine } from '@/downloads/engine';
import { downloadKey, useDownloads } from '@/downloads/store';
import type { DownloadEntry } from '@/downloads/types';
import { formatBytes } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { colors } from '@/theme/tokens';

function DownloadRow({ entry }: { entry: DownloadEntry }) {
  const { t } = useTranslation();
  // Each row belongs to its OWN connection (downloads span every server); resolve that
  // connection's client for the cover, and fall back to the locally-cached cover when
  // it isn't connected/available.
  const api = useOptionalApi(entry.connectionId);
  // openPlayer makes this download's server active before routing, so the player
  // chrome + playback read from the right connection.
  const { openPlayer } = useOpen();
  const remove = () =>
    void useDownloads.getState().remove(entry.connectionId, entry.libraryId, entry.path);
  const coverSource = entry.manifest.coverUri
    ? entry.manifest.coverUri
    : api
      ? { uri: api.coverUrl(entry.libraryId, entry.path), headers: api.authHeaders() }
      : null;

  return (
    <View className="flex-row items-center gap-3 rounded-lg bg-white p-2 dark:border dark:border-gray-860 dark:bg-gray-840">
      <Pressable
        className="flex-1 flex-row items-center gap-3 active:opacity-80"
        onPress={() => void openPlayer(entry.connectionId, entry.libraryId, entry.path)}
      >
        <Cover source={coverSource} label={entry.title} rounded="rounded-md" size={52} />
        <View className="flex-1 gap-1">
          <Text variant="subtitle" numberOfLines={1}>
            {entry.title}
          </Text>
          {entry.status === 'downloaded' ? (
            <Text variant="caption">
              {entry.totalBytes > 0 ? formatBytes(entry.totalBytes) : t('downloads.downloaded')}
            </Text>
          ) : entry.status === 'error' ? (
            <Text className="text-xs text-red-500">{t('downloads.failed')}</Text>
          ) : (
            <View className="h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <View
                className="h-full rounded-full bg-primary"
                style={{ width: `${Math.max(4, entry.progress * 100)}%` }}
              />
            </View>
          )}
        </View>
      </Pressable>
      <Pressable onPress={remove} hitSlop={8} className="h-9 w-9 items-center justify-center">
        <Icon name="trash" size={16} color={colors.dark.textMuted} />
      </Pressable>
    </View>
  );
}

export default function DownloadsScreen() {
  const { t } = useTranslation();
  const entries = useDownloads((s) => s.entries);
  const supported = useDownloads((s) => s.supported);
  const paddingBottom = useMiniPlayerInset();

  const list = useMemo(
    () =>
      Object.values(entries).sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt)),
    [entries],
  );
  // Disk usage is an async query on web (Cache API), so resolve it into state.
  const [totalBytes, setTotalBytes] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void engine.totalBytesUsed().then((bytes) => {
      if (!cancelled) setTotalBytes(bytes);
    });
    return () => {
      cancelled = true;
    };
  }, [entries]);

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="gap-4 p-4 lg:px-8"
      contentContainerStyle={{ paddingBottom }}
    >
      <View className="flex-row items-center justify-between">
        <Text variant="heading">{t('downloads.title')}</Text>
        {supported && totalBytes > 0 ? (
          <Text variant="muted">
            {t('downloads.storageUsed', { size: formatBytes(totalBytes) })}
          </Text>
        ) : null}
      </View>

      {!supported ? (
        <EmptyNote message={t('downloads.unsupported')} />
      ) : list.length === 0 ? (
        <EmptyNote message={t('downloads.empty')} />
      ) : (
        list.map((entry) => (
          <DownloadRow
            key={downloadKey(entry.connectionId, entry.libraryId, entry.path)}
            entry={entry}
          />
        ))
      )}
    </ScrollView>
  );
}
