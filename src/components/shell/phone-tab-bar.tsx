import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { Text as RNText, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from '@/components/ui/safe-area-view';
import { useThemeColors } from '@/theme/use-theme-colors';

import { PHONE_TABS, useTabPress } from './destinations';
import { useChromeEdge } from './shell-metrics';

/**
 * The phone tab bar on web (iOS and Android use the native tab bar): the five
 * destinations, the active one in brand, 44 pt targets, padded past the home indicator.
 * It publishes its height (its top edge: it sits on the window's bottom edge) for the
 * root toasts (`useShellMetrics`).
 */
export function PhoneTabBar() {
  const { t } = useTranslation();
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
              className="min-h-[44px] flex-1 items-center justify-center gap-0.5 rounded-control py-1"
            >
              <Icon
                name={d.icon}
                size={22}
                color={selected ? themed.brand : themed.mutedForeground}
              />
              <RNText
                numberOfLines={1}
                className={`font-sans-semibold text-[10.5px] ${
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
