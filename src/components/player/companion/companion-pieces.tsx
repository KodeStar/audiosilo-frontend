import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { BookMetaAttribution } from '@/api/types';
import { HiddenStrip } from '@/components/search/hidden-strip';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/support';
import { httpUrl } from '@/lib/url-host';
import { cn } from '@/lib/utils';
import { themeColors } from '@/theme/high-contrast';
import { useThemeColors, useThemeScheme } from '@/theme/use-theme-colors';

/**
 * The licence line every companion block ends with (STYLEGUIDE section 8, "Companion"):
 * the server's own credit and licence for the work's CC BY-SA content (it writes the
 * legal text; the client never composes it), the credit linking to the work's page on the
 * metadata site (`source_url`, where CC BY-SA asks the material be linked) and the licence
 * to its deed (`CaptionLink`: plain text without an http(s) URL). Nothing
 * without an attribution (an older server).
 */
export function Attribution({
  attribution,
  className,
  tone = 'muted',
}: {
  attribution?: BookMetaAttribution;
  className?: string;
  /** `inverse` on Previously on's dark card. */
  tone?: 'muted' | 'inverse';
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const { highContrast } = useThemeScheme();
  if (!attribution) return null;
  const color =
    tone === 'inverse'
      ? themeColors('dark', highContrast).mutedForeground
      : themed.subtleForeground;
  return (
    <View className={cn('flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <Icon name="globe" size={12} color={color} />
      <CaptionLink
        text={t('player.companion.attribution', { credit: attribution.credit })}
        url={attribution.source_url}
        label={(text) => t('player.companion.creditSource', { credit: text })}
        color={color}
      />
      <Text variant="caption" style={{ color }}>
        ·
      </Text>
      <CaptionLink
        text={attribution.license}
        url={attribution.license_url}
        label={(licence) => t('player.companion.licence', { licence })}
        color={color}
      />
    </View>
  );
}

const LINK_CLASS = cn(Platform.select({ web: `cursor-pointer rounded-sm ${FOCUS_RING_CLASS}` }));

/**
 * A credit's caption: an underlined link opening `url` (like every external link,
 * `openExternalUrl`) when it is an http(s) URL, else plain text. `label` names the link
 * for screen readers from the words it shows.
 */
export function CaptionLink({
  text,
  url,
  label,
  color,
  className,
  textClassName,
}: {
  text: string;
  url?: string;
  label: (text: string) => string;
  /** The caption's colour; else the `textClassName` text colour. */
  color?: string;
  /** The outer element's (its alignment in the parent). */
  className?: string;
  textClassName?: string;
}) {
  const target = url ? httpUrl(url) : null;
  const style = color ? { color } : undefined;
  if (!target) {
    return (
      <Text variant="caption" className={cn(className, textClassName)} style={style}>
        {text}
      </Text>
    );
  }
  return (
    <AnimatedPressable
      onPress={() => void openExternalUrl(target)}
      accessibilityRole="link"
      accessibilityLabel={label(text)}
      hitSlop={8}
      className={cn(LINK_CLASS, className)}
    >
      <Text variant="caption" className={cn('underline', textClassName)} style={style}>
        {text}
      </Text>
    </AnimatedPressable>
  );
}

/**
 * The companion's spoiler strip: what is held back, counted ("7 characters you haven't
 * met yet are hidden", the shared `HiddenStrip`) with Show anyway, or, once shown, the
 * "Spoilers shown" badge with Hide them again. Nothing when nothing is held back.
 */
export function SpoilerStrip({
  count,
  title,
  hint,
  shown,
  onToggle,
  token = true,
}: {
  count: number;
  /** The count, in words. */
  title: string;
  hint?: string;
  shown: boolean;
  onToggle: () => void;
  /** Lead with a hidden character token (Who's who), else the eye-off glyph. */
  token?: boolean;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  if (count === 0) return null;
  const toggle = (
    <AnimatedPressable
      onPress={onToggle}
      hitSlop={10}
      accessibilityRole="button"
      className={cn(
        'min-h-[36px] justify-center rounded-control px-3 active:bg-accent',
        Platform.select({ web: `cursor-pointer hover:bg-accent ${FOCUS_RING_CLASS}` }),
      )}
    >
      <Text variant="label" className="text-brand-ink">
        {shown ? t('player.companion.hideAgain') : t('book.meta.showAnyway')}
      </Text>
    </AnimatedPressable>
  );
  if (shown) {
    return (
      <View className="flex-row items-center justify-between gap-2">
        <View className="flex-row items-center gap-1.5 rounded-full bg-warning-soft px-2.5 py-1">
          <Icon name="circle-exclamation" size={12} color={themed.warning} />
          <Text variant="caption" className="font-sans-semibold text-warning">
            {t('player.companion.spoilersShown')}
          </Text>
        </View>
        {toggle}
      </View>
    );
  }
  return (
    <HiddenStrip label={title} hint={hint} token={token}>
      {toggle}
    </HiddenStrip>
  );
}
