import { router, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/theme/use-theme-colors';

import { BackGlyph } from './back-glyph';
import { destination, rootOfPathname, useActiveTab } from './destinations';

/**
 * The tablet/desktop sub-nav row (50) under the top bar. On a tab root it carries the
 * page title (the screens leave their title to the chrome); on a pushed page, a Back
 * button (the book and folder pages render their own breadcrumbs). Home has no row: the
 * top bar already marks it, and its content leads with the shelves.
 */
export function SubNav() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const pathname = usePathname();
  const active = useActiveTab();
  const root = rootOfPathname(pathname);
  if (root?.name === '(home)') return null;

  const back = () => {
    if (router.canGoBack()) router.back();
    else if (active) router.navigate(destination(active).root);
  };

  return (
    <View testID="shell-sub-nav" className="border-b border-border bg-background">
      {/* Capped and padded like the page below it, so the title lines up with the content. */}
      <View className="h-[50px] w-full max-w-[1480px] flex-row items-center gap-4 self-center px-4 lg:px-8">
        {root ? (
          <Text accessibilityRole="header" className="font-display text-[15px]" numberOfLines={1}>
            {t(root.titleKey)}
          </Text>
        ) : (
          <Button
            variant="ghost"
            onPress={back}
            accessibilityLabel={t('nav.back')}
            className="-ml-2 gap-1.5 px-2"
          >
            <BackGlyph size={16} color={themed.foreground} />
            <Text>{t('nav.back')}</Text>
          </Button>
        )}
      </View>
    </View>
  );
}
