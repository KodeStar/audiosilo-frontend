import { type Ref, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, TextInput, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The Search screen's field (the prototype's 52-tall search input): a search glyph, the
 * text, and a clear button once there is text. Focus draws the `ring` border plus a 3px
 * 20% ring (web), like every Stacks input; the focus is tracked in state so native gets
 * the border too.
 */
export function SearchField({
  value,
  onChangeText,
  autoFocus,
  ref,
}: {
  value: string;
  onChangeText: (text: string) => void;
  autoFocus?: boolean;
  ref?: Ref<TextInput>;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const [focused, setFocused] = useState(false);
  // The full list of what can be found doesn't fit a phone's field.
  const phone = useLayout() === 'phone';
  return (
    <View
      className={cn(
        'h-[52px] w-full max-w-[760px] flex-row items-center gap-2.5 rounded-card border bg-card pl-4 pr-1.5',
        focused ? 'border-ring' : 'border-input',
        Platform.select({ web: 'transition-[border-color,box-shadow]' }),
        focused && Platform.select({ web: 'ring-[3px] ring-ring/20' }),
      )}
    >
      <Icon name="search" size={18} color={themed.subtleForeground} />
      <TextInput
        ref={ref}
        testID="search-input"
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={phone ? t('search.fieldPlaceholderShort') : t('search.fieldPlaceholder')}
        placeholderTextColor={themed.subtleForeground}
        accessibilityLabel={t('search.label')}
        role="searchbox"
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        autoFocus={autoFocus}
        className={cn(
          'h-full min-w-0 flex-1 font-sans text-foreground',
          phone ? 'text-base' : 'text-[17px]',
          Platform.select({ web: 'outline-none' }),
        )}
      />
      {value ? (
        <Pressable
          onPress={() => onChangeText('')}
          accessibilityRole="button"
          accessibilityLabel={t('search.clear')}
          className={cn(
            'h-10 w-10 items-center justify-center rounded-control active:bg-accent',
            Platform.select({
              web: 'cursor-pointer outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
            }),
          )}
        >
          <Icon name="close" size={16} color={themed.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}
