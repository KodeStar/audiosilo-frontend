import { Image, type ImageSource } from 'expo-image';
import { useId } from 'react';
import { Platform, type ViewStyle, View } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

import { useTheme } from '@/theme/theme-provider';
import { colors } from '@/theme/tokens';

// react-native-web supports CSS `filter`, but it isn't in RN's ViewStyle type;
// cast through `unknown` to attach it without an `any`. Beyond the blur we
// desaturate and tone-clamp so a loud cover reads as a dim glow, not a paint job
// (a garish neon cover otherwise floods the whole panel). Native has no CSS
// filters, so it approximates the desaturation with a neutral tint layer below.
const WEB_FILTER_DARK = {
  filter: 'blur(60px) saturate(0.55) brightness(0.85)',
} as unknown as ViewStyle;
const WEB_FILTER_LIGHT = {
  filter: 'blur(60px) saturate(0.55) brightness(1.05)',
} as unknown as ViewStyle;

/**
 * Art-directed ambient backdrop derived from the book's cover art. Rather than
 * flooding the whole surface, it occupies only the upper ~60% behind the cover and
 * **dissolves into the base background** at its lower edge, so the transport /
 * chapter list sit on the plain page, not a murky slab. Composition, bottom-to-top:
 *
 *   1. an oversized, heavily-blurred, desaturated + tone-clamped rendition of the
 *      cover (web via CSS `filter`; native via `Image` `blurRadius` + a neutral
 *      tint layer that mutes saturation perceptually);
 *   2. a light theme-toned scrim so foreground text always passes contrast;
 *   3. an SVG vertical gradient that fades transparent -> the theme background
 *      color, fully opaque at the bottom edge, melting the band into the page.
 *
 * Degrades gracefully: with no cover it renders nothing. Purely decorative -
 * `pointerEvents="none"`.
 */
export function CoverBackdrop({ source }: { source?: ImageSource | null }) {
  const { scheme } = useTheme();
  // Unique per instance: SVG def ids are document-global on web, so a fixed id would
  // collide when two backdrops mount at once (e.g. a book page behind an open player
  // modal), making both `url(#id)` fills resolve to the first def. Strip characters
  // React's useId emits (colons) that aren't valid in a `url(#...)` fragment.
  const fadeId = `coverBackdropFade-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  if (!source) return null;
  const dark = scheme === 'dark';
  const native = Platform.OS !== 'web';
  const bg = dark ? colors.dark.bg : colors.light.bg;

  return (
    <View className="absolute inset-x-0 top-0 h-[60%] overflow-hidden" pointerEvents="none">
      <View
        style={[
          { position: 'absolute', top: '-20%', left: '-20%', right: '-20%', bottom: '-20%' },
          native ? null : dark ? WEB_FILTER_DARK : WEB_FILTER_LIGHT,
        ]}
      >
        <Image
          source={source}
          blurRadius={native ? 60 : 0}
          contentFit="cover"
          style={{ width: '100%', height: '100%' }}
        />
      </View>

      {/* Native-only: a neutral tint over the blurred art approximates the web
          `saturate()` - it desaturates a loud cover perceptually (no CSS filters
          on native). */}
      {native ? <View className="absolute inset-0 bg-gray-200/45 dark:bg-gray-800/45" /> : null}

      {/* Scrim: lighter than a full paint-over - the fade + tint now carry most of
          the load, so the art still reads as a warm glow while text stays legible. */}
      <View className="absolute inset-0 bg-gray-100/45 dark:bg-gray-900/50" />

      {/* Vertical fade: transparent down to ~40%, then dissolving to the base
          background so the band's bottom edge melts into the page (no hard line). */}
      <Svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
        <Defs>
          <LinearGradient id={fadeId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={bg} stopOpacity={0} />
            <Stop offset="0.4" stopColor={bg} stopOpacity={0} />
            <Stop offset="1" stopColor={bg} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${fadeId})`} />
      </Svg>
    </View>
  );
}
