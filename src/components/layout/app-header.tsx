import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Brand } from '@/components/brand/brand';
import { Icon } from '@/components/ui/icon';
import { colors } from '@/theme/tokens';

/**
 * Sticky phone header: the wordmark on the left, a search affordance on the
 * right (search no longer lives in the bottom tab bar). The desktop sidebar
 * carries the brand + search instead, so this is only rendered on phones.
 */
export function AppHeader() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{ paddingTop: insets.top + 8 }}
      className="border-b border-gray-100 bg-gray-200/90 dark:border-gray-750 dark:bg-gray-800/90"
    >
      <View className="h-16 flex-row items-center justify-between px-4">
        <Brand size={26} />
        <Pressable
          onPress={() => router.push('/search')}
          hitSlop={10}
          accessibilityLabel={t('nav.search')}
          className="h-10 w-10 items-center justify-center"
        >
          <Icon name="search" size={20} color={colors.dark.textMuted} />
        </Pressable>
      </View>
    </View>
  );
}
