import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Text as RNText, type TextStyle, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from '@/components/ui/safe-area-view';
import { linesFor, useLargeText } from '@/lib/text-scale';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import { PHONE_TABS, useTabPress } from './destinations';
import { useChromeEdge } from './shell-metrics';

// Under large text a label wraps between words only: react-native-web's Text breaks inside a
// word ("Accue/il"), so a word wider than its slot ends in "..." on its line instead.
const LARGE_LABEL_STYLE = {
  wordWrap: 'normal',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
} as TextStyle;

/**
 * The phone tab bar on web (iOS and Android use the native tab bar): the five
 * destinations, the active one in brand, 44 pt targets, padded past the home indicator.
 * It publishes its height (its top edge: it sits on the window's bottom edge) for the
 * root toasts (`useShellMetrics`).
 */
export function PhoneTabBar() {
  const { t } = useTranslation();
  const large = useLargeText();
  const [height, setHeight] = useState<number>();
  useChromeEdge('bar', height);
  const themed = useThemeColors();
  const { active, press } = useTabPress();
  return (
    <SafeAreaView
      edges={['bottom']}
      onLayout={(e) => setHeight(e.nativeEvent.layout.height)}
      className="border-t border-border bg-background"
    >
      <View testID="shell-tab-bar" accessibilityRole="tablist" className="flex-row px-1.5 py-1.5">
        {PHONE_TABS.map((d) => {
          const selected = active === d.name;
          const label = t(d.labelKey);
          return (
            <AnimatedPressable
              key={d.name}
              testID={`tab-bar-${d.name}`}
              onPress={() => press(d.name)}
              accessibilityRole="tab"
              aria-selected={selected}
              accessibilityLabel={label}
              className={cn(
                'min-h-[44px] flex-1 items-center justify-center gap-0.5 rounded-control py-1',
                large && 'min-w-[44px] basis-auto px-[2px]',
              )}
            >
              <Icon
                name={d.icon}
                size={22}
                color={selected ? themed.brand : themed.mutedForeground}
              />
              {/* The label follows the browser's text size up to 13.5 px (about 1.3x). Below
                  large text its slot is a fifth of the width and a long name ends in "...", so
                  no tab is pushed off screen; under large text a long label can borrow space
                  from its neighbours or wrap between words. */}
              <RNText
                numberOfLines={linesFor(1, large)}
                style={large ? LARGE_LABEL_STYLE : undefined}
                className={`${large ? 'max-w-full text-center ' : ''}font-sans-semibold text-[10.5px] web:text-[length:min(0.65625rem,13.5px)] ${
                  selected ? 'text-foreground' : 'text-muted-foreground'
                }`}
              >
                {label}
              </RNText>
            </AnimatedPressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}
