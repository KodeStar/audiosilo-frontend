import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';

/** A left-pointing chevron: the vendored set has only `chevron-right`, so it is turned
 * around (adding a glyph needs the FontAwesome generator's token). */
export function BackGlyph({ size, color }: { size: number; color: string }) {
  return (
    <View style={{ transform: [{ rotate: '180deg' }] }}>
      <Icon name="chevron-right" size={size} color={color} />
    </View>
  );
}
