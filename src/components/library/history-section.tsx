import { router } from 'expo-router';
import { Pressable, View } from 'react-native';

import { useHistory } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatClock } from '@/lib/format';
import { colors } from '@/theme/tokens';

/** Recent listening spans for a book; tap to jump back to a span's start.
 * Renders nothing when there's no history. */
export function HistorySection({
  libraryId,
  path,
  emptyLabel,
}: {
  libraryId: number;
  path: string;
  emptyLabel?: string;
}) {
  const { data: history } = useHistory(libraryId, path);

  if (!history || history.length === 0) {
    // Inline (book screen) hides entirely when empty; the player sheet passes an
    // emptyLabel so the sheet visibly opens instead of showing a blank panel.
    if (!emptyLabel) return null;
    return (
      <View className="gap-2">
        <Text variant="title">History</Text>
        <Text variant="caption">{emptyLabel}</Text>
      </View>
    );
  }

  const jump = (position: number) =>
    router.push({
      pathname: '/player',
      params: { libraryId: String(libraryId), path, position: String(position) },
    });

  return (
    <View className="gap-2">
      <Text variant="title">History</Text>
      {history.map((h) => (
        <Pressable
          key={h.id}
          onPress={() => jump(h.from_pos)}
          className="flex-row items-center justify-between rounded-lg bg-white p-3 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
        >
          <View className="flex-row items-center gap-3">
            <Icon name="clock" size={16} color={colors.primary} />
            <View>
              <Text variant="subtitle">
                {formatClock(h.from_pos)} → {formatClock(h.to_pos)}
              </Text>
              <Text variant="caption">{new Date(h.ended_at).toLocaleString()}</Text>
            </View>
          </View>
          <Icon name="chevron-right" size={14} />
        </Pressable>
      ))}
    </View>
  );
}
