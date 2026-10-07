import type { ReactNode } from 'react';
import { View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

import { NameToken } from './name-token';

/**
 * The dashed strip that counts what the spoiler gate holds back ("3 characters you
 * haven't met yet are hidden"): counted, never named. Search's character results and
 * the player's Who's who and Story so far. It leads with a hidden character token (an
 * eye-off glyph for what isn't a person: `token={false}`); `children` sits at its end
 * (the companion's Show anyway). Kindly worded, never naming anyone (STYLEGUIDE
 * section 9, spoiler safety).
 */
export function HiddenStrip({
  label,
  hint,
  token = true,
  children,
}: {
  /** The count, in words. */
  label: string;
  hint?: string;
  token?: boolean;
  children?: ReactNode;
}) {
  const themed = useThemeColors();
  return (
    <View className="max-w-[640px] flex-row items-center gap-3 rounded-menu border-[1.5px] border-dashed border-border-strong bg-muted/60 px-3.5 py-3">
      {token ? (
        <NameToken kind="character" size={30} hidden />
      ) : (
        <View className="h-[30px] w-[30px] items-center justify-center">
          <Icon name="eye-off" size={18} color={themed.mutedForeground} />
        </View>
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="muted">{label}</Text>
        {hint ? <Text variant="caption">{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}
