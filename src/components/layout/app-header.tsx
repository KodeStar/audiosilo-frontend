import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Brand } from '@/components/brand/brand';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * Sticky phone header: the wordmark on the left, a search affordance on the
 * right (search no longer lives in the bottom tab bar). The desktop sidebar
 * carries the brand + search instead, so this is only rendered on phones.
 */
export function AppHeader() {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ paddingTop: insets.top + 8 }} className="border-b border-border bg-topbar">
      <View className="h-16 flex-row items-center justify-between px-4">
        <Brand size={26} />
        <AnimatedPressable
          onPress={() => router.push('/search')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('nav.search')}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-accent"
        >
          <Icon name="search" size={20} color={themed.mutedForeground} />
        </AnimatedPressable>
      </View>
    </View>
  );
}
