import { FlatList, useWindowDimensions, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { prettifyChapterTitle } from '@/playback/prettify-title';
import { colors, tabularNums } from '@/theme/tokens';

/** One row in the chapter/file picker. `sublabel` carries an optional time. */
export type ChapterItem = { key: string; label: string; sublabel?: string };

const ROW_H = 56;

/**
 * The player's chapter (or file) list, shown in the shared bottom `Sheet` (which
 * itself avoids RN `<Modal>` so it presents inside the iOS full-screen player).
 * Opens scrolled to the current chapter, highlighted in primary with a glyph.
 */
export function ChapterListSheet({
  title,
  items,
  currentIndex,
  onSelect,
  onClose,
  visible = true,
}: {
  title: string;
  items: ChapterItem[];
  currentIndex: number;
  onSelect: (index: number) => void;
  onClose: () => void;
  visible?: boolean;
}) {
  const { height } = useWindowDimensions();
  const startIndex = items.length > 0 ? Math.max(0, Math.min(currentIndex, items.length - 1)) : 0;

  return (
    <Sheet inline visible={visible} onClose={onClose} title={title}>
      <FlatList
        style={{ maxHeight: Math.round(height * 0.6) }}
        data={items}
        keyExtractor={(item) => item.key}
        initialScrollIndex={startIndex}
        getItemLayout={(_, index) => ({ length: ROW_H, offset: ROW_H * index, index })}
        onScrollToIndexFailed={() => {}}
        contentContainerStyle={{ paddingBottom: 8 }}
        renderItem={({ item, index }) => {
          const current = index === currentIndex;
          return (
            <AnimatedPressable
              onPress={() => {
                onSelect(index);
                onClose();
              }}
              style={{ height: ROW_H }}
              className="flex-row items-center gap-3 px-4"
              accessibilityRole="button"
            >
              <View className="w-6 items-center">
                {current ? (
                  <Icon name="play" size={12} color={colors.primary} />
                ) : (
                  <Text variant="caption" style={tabularNums}>
                    {index + 1}
                  </Text>
                )}
              </View>
              <Text
                numberOfLines={1}
                className={`flex-1 ${current ? 'font-roboto-semibold text-primary' : 'text-gray-700 dark:text-gray-200'}`}
              >
                {prettifyChapterTitle(item.label)}
              </Text>
              {item.sublabel ? (
                <Text
                  variant="caption"
                  style={tabularNums}
                  className={current ? 'text-primary' : undefined}
                >
                  {item.sublabel}
                </Text>
              ) : null}
            </AnimatedPressable>
          );
        }}
      />
    </Sheet>
  );
}
