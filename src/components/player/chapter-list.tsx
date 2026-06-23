import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

/** One row in the chapter/file picker. `sublabel` carries an optional time. */
export type ChapterItem = { key: string; label: string; sublabel?: string };

const ROW_H = 56;

/**
 * The player's chapter (or file) list, shown as an in-view bottom sheet that opens
 * scrolled to the current chapter. Rendered as an absolute overlay rather than a
 * React Native `<Modal>` because the phone player is itself a native full-screen
 * modal, and a Modal-in-Modal won't present on iOS (see player-view.tsx).
 */
export function ChapterListSheet({
  title,
  items,
  currentIndex,
  onSelect,
  onClose,
}: {
  title: string;
  items: ChapterItem[];
  currentIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const neutral = scheme === 'dark' ? colors.dark.textStrong : colors.light.textStrong;
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const startIndex = items.length > 0 ? Math.max(0, Math.min(currentIndex, items.length - 1)) : 0;

  return (
    <View className="absolute inset-0 justify-end">
      <Pressable className="absolute inset-0 bg-black/40" onPress={onClose} />
      <View className="rounded-t-2xl bg-gray-100 dark:bg-gray-840">
        <View className="flex-row items-center justify-between px-4 pb-2 pt-4">
          <Text variant="title">{title}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={12}
            className="h-8 w-8 items-center justify-center"
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
          >
            <Icon name="close" size={22} color={neutral} />
          </Pressable>
        </View>
        <FlatList
          style={{ maxHeight: Math.round(height * 0.6) }}
          data={items}
          keyExtractor={(item) => item.key}
          initialScrollIndex={startIndex}
          getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
          onScrollToIndexFailed={() => {}}
          contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
          renderItem={({ item, index }) => {
            const current = index === currentIndex;
            return (
              <Pressable
                onPress={() => {
                  onSelect(index);
                  onClose();
                }}
                style={{ height: ROW_H }}
                className="flex-row items-center gap-3 px-4 active:bg-gray-200 dark:active:bg-gray-860"
              >
                <View className="w-5 items-center">
                  {current ? <Icon name="play" size={12} color={colors.primary} /> : null}
                </View>
                <Text
                  numberOfLines={1}
                  className={`flex-1 ${current ? 'font-roboto-semibold text-primary' : ''}`}
                >
                  {item.label}
                </Text>
                {item.sublabel ? <Text variant="caption">{item.sublabel}</Text> : null}
              </Pressable>
            );
          }}
        />
      </View>
    </View>
  );
}
