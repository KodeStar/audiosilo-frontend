import { Image, type ImageSource } from 'expo-image';
import { Platform, type ViewStyle, View } from 'react-native';

// react-native-web supports CSS `filter`, but it isn't in RN's ViewStyle type;
// cast through `unknown` to attach it without an `any`.
const WEB_BLUR = { filter: 'blur(60px)' } as unknown as ViewStyle;

/**
 * Full-bleed ambient backdrop derived from the book's cover art: an oversized,
 * heavily-blurred rendition under a scrim, so the transport reads as sitting in a
 * dim room lit by the book itself. Native blurs via `Image` `blurRadius`; web via
 * a CSS `filter` on the wrapper (expo-image doesn't blur on web).
 *
 * Degrades gracefully: with no cover it renders nothing, so the player's plain
 * base background shows through. Purely decorative - `pointerEvents="none"`.
 */
export function CoverBackdrop({ source }: { source?: ImageSource | null }) {
  if (!source) return null;
  const native = Platform.OS !== 'web';

  return (
    <View className="absolute inset-0 overflow-hidden" pointerEvents="none">
      <View
        style={[
          { position: 'absolute', top: '-20%', left: '-20%', right: '-20%', bottom: '-20%' },
          native ? null : WEB_BLUR,
        ]}
      >
        <Image
          source={source}
          blurRadius={native ? 60 : 0}
          contentFit="cover"
          style={{ width: '100%', height: '100%' }}
        />
      </View>
      {/* Scrim: dims the art so foreground text always passes contrast in both
          themes. Layered light-on-light / dark-on-dark, plus a slightly heavier
          top wash to seat the header controls. */}
      <View className="absolute inset-0 bg-gray-100/80 dark:bg-gray-900/80" />
      <View className="absolute inset-x-0 top-0 h-32 bg-gray-100/40 dark:bg-gray-900/40" />
    </View>
  );
}
