import { View } from 'react-native';

import { Icon, type IconName } from '@/components/ui/icon';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The 40 square glyph tile that leads a folder-ish row (a library, a folder, the
 * Favourites shelf, a hearted folder): muted ink, never pink. Pink is the one thing a
 * view marks (progress, the current book, selection; STYLEGUIDE section 1), and a list
 * of pink folders spent it on every row. `tone="info"` is the audio file's blue tile.
 */
export function GlyphTile({ icon, tone = 'muted' }: { icon: IconName; tone?: 'muted' | 'info' }) {
  const themed = useThemeColors();
  const info = tone === 'info';
  return (
    <View
      testID="glyph-tile"
      className={cn(
        'h-10 w-10 items-center justify-center rounded-lg',
        info ? 'bg-info/10' : 'bg-muted',
      )}
    >
      <Icon name={icon} size={18} color={info ? themed.info : themed.foreground} />
    </View>
  );
}
