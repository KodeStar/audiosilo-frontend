import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { BookMetaAttribution } from '@/api/types';
import { HiddenStrip } from '@/components/search/hidden-strip';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { openExternalUrl } from '@/lib/support';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';
import { useThemeColors } from '@/theme/use-theme-colors';

/**
 * The licence line every companion block ends with (STYLEGUIDE section 8, "Companion"):
 * the server's own credit and licence for the work's CC BY-SA content (it writes the
 * legal text; the client never composes it), the licence linking to its deed. Nothing
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
  if (!attribution) return null;
  const color = tone === 'inverse' ? colors.dark.mutedForeground : themed.subtleForeground;
  return (
    <View className={cn('flex-row flex-wrap items-center gap-x-1.5 gap-y-0.5', className)}>
      <Icon name="globe" size={12} color={color} />
      <Text variant="caption" style={{ color }}>
        {t('player.companion.attribution', { credit: attribution.credit })}
      </Text>
      <Text variant="caption" style={{ color }}>
        ·
      </Text>
      <AnimatedPressable
        onPress={() => void openExternalUrl(attribution.license_url)}
        accessibilityRole="link"
        accessibilityLabel={t('player.companion.licence', { licence: attribution.license })}
        hitSlop={8}
        className={cn(Platform.select({ web: `cursor-pointer rounded-sm ${FOCUS_RING_CLASS}` }))}
      >
        <Text variant="caption" className="underline" style={{ color }}>
          {attribution.license}
        </Text>
      </AnimatedPressable>
    </View>
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
