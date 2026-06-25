import { Text as RNText, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { APP_VERSION } from '@/lib/version';

import { Logo } from './logo';

/**
 * Wordmark: the silo logo + "AUDIO" (pink) / "SILO" (grey), optionally with a
 * version underneath. Used in the desktop sidebar (large, with version) and the
 * phone header (compact). `size` scales the logo only; the wordmark text stays a
 * fixed size. `version` is the connected server's version (from /server); it
 * falls back to this build's bundled version when unknown.
 */
export function Brand({
  size = 28,
  showVersion = false,
  version,
}: {
  size?: number;
  showVersion?: boolean;
  version?: string;
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
          // eslint-disable-next-line i18next/no-literal-string -- "v" is universal version notation
          <Text variant="caption">v{version ?? APP_VERSION}</Text>
        ) : null}
      </View>
    </View>
  );
}
