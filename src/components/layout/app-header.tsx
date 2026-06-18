import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Logo } from '@/components/brand/logo';
import { Text } from '@/components/ui/text';

/**
 * Sticky top header. Translucent gray surface with a bottom hairline, matching
 * the old client's glassy `.header`. (A true blur can be layered in later with
 * expo-glass-effect / expo-blur.)
 */
export function AppHeader({ title }: { title?: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{ paddingTop: insets.top }}
      className="border-b border-gray-100 bg-gray-200/90 dark:border-gray-750 dark:bg-gray-800/90"
    >
      <View className="h-16 flex-row items-center gap-2 px-4">
        <Logo size={24} />
        <Text className="font-roboto-bold text-xl text-primary">AudioSilo</Text>
        {title ? (
          <Text className="font-roboto-semibold text-lg text-gray-700 dark:text-gray-200">
            {title}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
