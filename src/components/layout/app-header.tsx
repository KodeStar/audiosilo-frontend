import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Brand } from '@/components/brand/brand';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

/**
 * Sticky phone header: the wordmark on the left, a search affordance on the
 * right (search no longer lives in the bottom tab bar). The desktop sidebar
 * carries the brand + search instead, so this is only rendered on phones.
 */
export function AppHeader() {
  const { t } = useTranslation();
  const { scheme } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{ paddingTop: insets.top + 8 }}
      className="border-b border-gray-100 bg-gray-200/90 dark:border-gray-750 dark:bg-gray-800/90"
    >
      <View className="h-16 flex-row items-center justify-between px-4">
        <Brand size={26} />
        <AnimatedPressable
          onPress={() => router.push('/search')}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('nav.search')}
          className="h-10 w-10 items-center justify-center rounded-full active:bg-gray-100 dark:active:bg-gray-840"
        >
          <Icon name="search" size={20} color={colors[scheme].textMuted} />
        </AnimatedPressable>
      </View>
    </View>
  );
}
