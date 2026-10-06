import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useMarkFinished, type SourcedProgress } from '@/api/hooks';
import { Icon } from '@/components/ui/icon';
import { Sheet } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { parentPath, pathLeaf } from '@/lib/paths';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * Home's long-press menu for an in-progress book: mark finished, or jump to the
 * containing folder ("more in series"). Presented as a bottom Sheet, mounted once at
 * the screen's root (a Sheet renders in place, so inside a tile it would be clipped):
 * the screen keeps a `menuItem` state that a tile's long press sets. Visible while
 * `item` is non-null; renders nothing when null.
 */
export function ProgressMenuSheet({
  item,
  onClose,
}: {
  item: SourcedProgress | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const markFinished = useMarkFinished(item?.connectionId);
  const { openLibrary } = useOpen();

  const onMarkFinished = () => {
    onClose();
    if (!item) return;
    markFinished.mutate({
      libraryId: item.library_id,
      path: item.path,
      position: item.position,
      duration: item.duration,
      playback_speed: item.playback_speed,
    });
  };
  const onMoreInSeries = () => {
    onClose();
    if (!item) return;
    void openLibrary(item.connectionId, item.library_id, parentPath(item.path));
  };

  return (
    <Sheet visible={item != null} onClose={onClose} title={item ? pathLeaf(item.path) : ''}>
      <View className="gap-1 px-2 pb-4 pt-1">
        <MenuRow
          icon="check"
          label={t('library.progressCard.markFinished')}
          onPress={onMarkFinished}
        />
        <MenuRow
          icon="library"
          label={t('library.progressCard.moreInSeries')}
          onPress={onMoreInSeries}
        />
      </View>
    </Sheet>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: 'check' | 'library';
  label: string;
  onPress: () => void;
}) {
  const themed = useThemeColors();
  const neutral = themed.foreground;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      className="flex-row items-center gap-3 rounded-lg px-4 py-3 active:bg-accent"
    >
      <Icon name={icon} size={20} color={neutral} />
      <Text variant="title">{label}</Text>
    </Pressable>
  );
}
