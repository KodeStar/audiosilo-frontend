import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import type { BookMetaAttribution } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_CLASS, Text } from '@/components/ui/text';
import { initials } from '@/lib/names';
import { clothColor } from '@/lib/monogram';
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

/** A character token (STYLEGUIDE section 8, "Avatar, portrait, character token"): the
 * initial on a colour from the name. Decorative: the name is always written beside it. */
export function CharacterToken({ name, size = 44 }: { name: string; size?: number }) {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: clothColor(name),
      }}
    >
      <Text
        className="font-display"
        style={{ color: colors.white, fontSize: Math.round(size * 0.4), lineHeight: size * 0.5 }}
      >
        {initials(name).slice(0, 1)}
      </Text>
    </View>
  );
}

/** A hidden character's token: dashed, with the eye-off glyph, never an initial. */
export function HiddenToken({ size = 30 }: { size?: number }) {
  const themed = useThemeColors();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="items-center justify-center border border-dashed border-border-strong bg-card"
      style={{ width: size, height: size, borderRadius: size / 2 }}
    >
      <Icon name="eye-off" size={Math.round(size * 0.45)} color={themed.subtleForeground} />
    </View>
  );
}

/**
 * The quiet strip that counts what is held back ("7 characters you haven't met yet are
 * hidden") with Show anyway, or, once shown, the "Spoilers shown" badge with Hide them
 * again. Counted, never named. Nothing when nothing is held back.
 */
export function HiddenStrip({
  count,
  title,
  hint,
  shown,
  onToggle,
  tokens = false,
}: {
  count: number;
  /** The count, in words. */
  title: string;
  hint?: string;
  shown: boolean;
  onToggle: () => void;
  /** Lead with a few dashed tokens (Who's who). */
  tokens?: boolean;
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
    <View className="flex-row items-center gap-3 rounded-card border border-dashed border-border-strong p-3">
      {tokens ? (
        <View className="flex-row">
          {Array.from({ length: Math.min(count, 3) }, (_, i) => (
            <View key={i} style={{ marginLeft: i === 0 ? 0 : -8 }}>
              <HiddenToken />
            </View>
          ))}
        </View>
      ) : (
        <Icon name="eye-off" size={18} color={themed.subtleForeground} />
      )}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text variant="label">{title}</Text>
        {hint ? <Text variant="caption">{hint}</Text> : null}
      </View>
      {toggle}
    </View>
  );
}

/** A companion panel's kind empty state: one glyph, one headline, one sentence. */
export function CompanionEmpty({
  icon,
  title,
  hint,
}: {
  icon: 'users' | 'book-open';
  title: string;
  hint: string;
}) {
  const themed = useThemeColors();
  return (
    <View className="items-center gap-2 px-6 py-10">
      <Icon name={icon} size={28} color={themed.subtleForeground} />
      <Text variant="label" className="text-center">
        {title}
      </Text>
      <Text variant="caption" className="max-w-[340px] text-center">
        {hint}
      </Text>
    </View>
  );
}
