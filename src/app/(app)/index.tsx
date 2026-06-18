import { router } from 'expo-router';
import { useEffect, useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { useAllProgress } from '@/api/hooks';
import { useApi } from '@/api/provider';
import type { Progress } from '@/api/types';
import { DownloadBadge } from '@/components/library/download-badge';
import { Cover } from '@/components/ui/cover';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { pathLeaf } from '@/lib/paths';
import { flushQueue } from '@/playback/progress-sync';

function ProgressRow({ item }: { item: Progress }) {
  const api = useApi();
  const fraction = item.duration > 0 ? Math.min(1, item.position / item.duration) : 0;
  return (
    <Pressable
      onPress={() =>
        router.push({
          pathname: '/player',
          params: { libraryId: String(item.library_id), path: item.path },
        })
      }
      className="flex-row items-center gap-3 rounded-lg bg-white p-2 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
    >
      <Cover
        source={{ uri: api.coverUrl(item.library_id, item.path), headers: api.authHeaders() }}
        label={pathLeaf(item.path)}
        rounded="rounded-md"
        size={52}
      />
      <View className="flex-1 gap-1">
        <Text variant="subtitle" numberOfLines={1}>
          {pathLeaf(item.path)}
        </Text>
        {!item.finished ? (
          <View className="h-1 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
            <View className="h-full rounded-full bg-primary" style={{ width: `${fraction * 100}%` }} />
          </View>
        ) : (
          <Text variant="caption">Finished</Text>
        )}
      </View>
      <DownloadBadge libraryId={item.library_id} path={item.path} />
    </Pressable>
  );
}

export default function HomeScreen() {
  const api = useApi();
  const { data: progress, isLoading, error, refetch } = useAllProgress();

  // Replay any saves captured while offline.
  useEffect(() => {
    void flushQueue(api);
  }, [api]);

  const { inProgress, finished } = useMemo(() => {
    const items = progress ?? [];
    const sorted = [...items].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return {
      inProgress: sorted.filter((p) => !p.finished && p.position > 0),
      finished: sorted.filter((p) => p.finished),
    };
  }, [progress]);

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-6 p-4">
      <Text variant="heading">Continue listening</Text>
      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not load your progress." onRetry={() => refetch()} /> : null}
      {!isLoading && !error && inProgress.length === 0 ? (
        <EmptyNote message="Start a book and it will show up here." />
      ) : null}
      {inProgress.map((item) => (
        <ProgressRow key={`${item.library_id}:${item.path}`} item={item} />
      ))}

      {finished.length > 0 ? (
        <>
          <Text variant="heading">Recently finished</Text>
          {finished.slice(0, 10).map((item) => (
            <ProgressRow key={`${item.library_id}:${item.path}`} item={item} />
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}
