import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Text as RNText, View } from 'react-native';

import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { SafeAreaView } from '@/components/ui/safe-area-view';
import { engine } from '@/downloads/engine';
import { useThemeColors } from '@/theme/use-theme-colors';

import { TABS, useTabPress } from './destinations';

/** Downloads need offline storage: on web only in a secure context with the Cache API.
 * Static per page load, so the bar never changes under a mounted screen. */
const PHONE_TABS = TABS.filter((t) => t.name !== '(offline)' || engine.supported);

/**
 * The phone tab bar on web (iOS and Android use the native tab bar): the five
 * destinations, the active one in brand, 44 pt targets, padded past the home indicator.
 * `onLayout` reports its height so the mini player can float just above it.
 */
export function PhoneTabBar({ onLayout }: { onLayout?: (e: LayoutChangeEvent) => void }) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { active, press } = useTabPress();
  return (
    <SafeAreaView
      edges={['bottom']}
      onLayout={onLayout}
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
              className="min-h-[44px] flex-1 items-center justify-center gap-0.5 rounded-[10px] py-1"
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
