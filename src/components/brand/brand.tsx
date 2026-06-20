import Constants from 'expo-constants';
import { Text as RNText, View } from 'react-native';

import { Text } from '@/components/ui/text';

import { Logo } from './logo';

/**
 * Wordmark: the silo logo + "AUDIO" (pink) / "SILO" (grey), optionally with the
 * app version underneath. Used in the desktop sidebar (large, with version) and
 * the phone header (compact).
 */
export function Brand({
  size = 28,
  showVersion = false,
}: {
  size?: number;
  showVersion?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-2.5">
      <Logo size={size} />
      <View>
        <RNText className="font-roboto-bold text-xl">
          <RNText className="font-roboto-bold text-primary">AUDIO</RNText>
          <RNText className="font-roboto-bold text-gray-500 dark:text-gray-300">SILO</RNText>
        </RNText>
        {showVersion ? (
          <Text variant="caption">v{Constants.expoConfig?.version ?? '1.0.0'}</Text>
        ) : null}
      </View>
    </View>
  );
}
