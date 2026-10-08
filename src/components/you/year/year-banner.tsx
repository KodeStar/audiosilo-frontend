import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import { Icon } from '@/components/ui/icon';
import { FOCUS_RING_OFFSET_CLASS, Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';

import { StoryBackground } from './story-background';
import type { StoryTheme } from './story-themes';

/**
 * The Year in listening banner (the prototype's "Your 2026 in listening ... Play the
 * story"): a story ground (`theme`), white type, one action, the whole card a button. At
 * the foot of Your listening (on `ink`, no pink) and atop the phone's Year section (on
 * `dusk`, the story's first ground), where it opens the full-screen story.
 */
export function YearBanner({
  year,
  summary,
  theme,
  onPress,
}: {
  year: string;
  /** One sentence from the year's real figures. */
  summary: string;
  theme: StoryTheme;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const title = t('year.bannerTitle', { year });
  return (
    <Pressable
      role="button"
      accessibilityLabel={`${title}. ${summary}`}
      accessibilityHint={t('year.play')}
      onPress={onPress}
      className={cn(
        'overflow-hidden rounded-dialog',
        Platform.select({ web: `cursor-pointer ${FOCUS_RING_OFFSET_CLASS}` }),
      )}
    >
      <StoryBackground theme={theme} />
      <View className="flex-row flex-wrap items-center justify-between gap-4 p-6">
        <View className="min-w-[200px] flex-1 gap-1.5">
          <Text variant="eyebrow" style={{ color: colors.white, opacity: 0.7 }}>
            {t('year.ready')}
          </Text>
          <Text
            className="font-display text-[28px] leading-[30px] tracking-tight"
            style={{ color: colors.white }}
          >
            {title}
          </Text>
          <Text className="font-sans text-sm" style={{ color: colors.white, opacity: 0.85 }}>
            {summary}
          </Text>
        </View>
        <View
          className="h-[46px] flex-row items-center gap-2 rounded-control border px-4"
          style={{
            backgroundColor: 'rgba(255,255,255,0.14)',
            borderColor: 'rgba(255,255,255,0.28)',
          }}
        >
          <Text className="font-sans-semibold text-base" style={{ color: colors.white }}>
            {t('year.play')}
          </Text>
          <Icon name="chevron-right" size={16} color={colors.white} />
        </View>
      </View>
    </Pressable>
  );
}
