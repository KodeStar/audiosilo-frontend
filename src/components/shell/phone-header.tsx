import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBanner } from '@/components/layout/offline-banner';
import { ReconnectBanner } from '@/components/layout/reconnect-banner';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

import { BackGlyph } from './back-glyph';

/**
 * The phone page header (STYLEGUIDE section 10), rendered by each tab Stack as its
 * screens' `header` on every platform, so it slides with the page on a push:
 * - a tab root gets a large display title;
 * - a pushed page gets an inline back button, named after the page it returns to on
 *   iOS ("< Library"), a bare arrow on Android and web.
 * The app-wide banners (reconnect, offline) sit under it. It pads the status-bar inset
 * itself: the screens below it no longer need a top inset of their own.
 */
export function PhoneHeader({
  title,
  backTitle,
  onBack,
}: {
  /** The page title, shown large; empty on a pushed page (it renders its own heading). */
  title: string;
  /** Set on a pushed page: the previous page's title ('' when it has none). */
  backTitle?: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const insets = useSafeAreaInsets();
  const canGoBack = backTitle !== undefined;
  const namedBack = Platform.OS === 'ios' && !!backTitle;
  return (
    <View style={{ paddingTop: insets.top }} className="bg-background">
      {canGoBack ? (
        <View className="h-[44px] flex-row items-center px-2">
          <AnimatedPressable
            onPress={onBack}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={namedBack ? t('nav.backTo', { name: backTitle }) : t('nav.back')}
            className="min-h-[44px] min-w-[44px] flex-row items-center gap-1 rounded-[10px] px-1.5 active:bg-accent"
          >
            <BackGlyph size={20} color={themed.foreground} />
            {namedBack ? (
              <Text variant="label" className="text-[15px]" numberOfLines={1}>
                {backTitle}
              </Text>
            ) : null}
          </AnimatedPressable>
          {title ? (
            <Text variant="label" className="flex-1 text-center" numberOfLines={1}>
              {title}
            </Text>
          ) : null}
        </View>
      ) : (
        <View className="px-4 pb-2.5 pt-1.5">
          <Text
            variant="display"
            accessibilityRole="header"
            className="text-[30px] leading-[36px]"
            numberOfLines={1}
          >
            {title}
          </Text>
        </View>
      )}
      <ReconnectBanner />
      <OfflineBanner />
    </View>
  );
}
