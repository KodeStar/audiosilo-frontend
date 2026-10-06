import { router, usePathname } from 'expo-router';
import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { SegmentedControl } from '@/components/ui/toggle-group';
import { CONTENT_WIDTH, useLayout } from '@/lib/layout';
import { useThemeColors } from '@/theme/use-theme-colors';

import { BackGlyph } from './back-glyph';
import { destination, rootOfPathname, useActiveTab } from './destinations';
import { useSubNavSlot } from './sub-nav-store';

/**
 * The tablet/desktop sub-nav row (50) under the top bar (STYLEGUIDE section 2: "Title
 * [segmented control of sections] [contextual actions]"). On a tab root it carries the
 * page title (the screens leave their title to the chrome), then whatever the root
 * published with `SubNavSections` / `SubNavActions` (`tab-root-nav.tsx`); a tablet drops
 * the title when there are sections, to leave them the room. On a pushed page, a Back
 * button (the book and folder pages render their own breadcrumbs). Home has no row: the
 * top bar already marks it, and its content leads with the shelves.
 */
export function SubNav() {
  const { t } = useTranslation();
  const themed = useThemeColors();
  const pathname = usePathname();
  const active = useActiveTab();
  const tablet = useLayout() === 'tablet';
  const root = rootOfPathname(pathname);
  const slot = useSubNavSlot(root ? root.name : null);
  if (root?.name === '(home)') return null;

  const back = () => {
    if (router.canGoBack()) router.back();
    else if (active) router.navigate(destination(active).root);
  };
  const sections = slot?.sections;

  return (
    <View testID="shell-sub-nav" className="border-b border-border bg-background">
      {/* Capped and padded like the page below it, so the title lines up with the content. */}
      <View
        className={`${CONTENT_WIDTH} h-[50px] flex-row items-center gap-4 self-center px-4 lg:px-8`}
      >
        {root ? (
          <>
            {tablet && sections ? null : (
              <Text
                accessibilityRole="header"
                className="font-display text-[15px]"
                numberOfLines={1}
              >
                {t(root.titleKey)}
              </Text>
            )}
            {sections ? (
              <SegmentedControl
                scrollable
                options={sections.options}
                value={sections.value}
                onChange={sections.onChange}
                accessibilityLabel={sections.accessibilityLabel}
                className="min-w-0 shrink"
              />
            ) : null}
            <View className="flex-1" />
            {slot?.actions.length ? (
              <View className="flex-row items-center gap-2">
                {slot.actions.map((a) => (
                  <Fragment key={a.id}>{a.node}</Fragment>
                ))}
              </View>
            ) : null}
          </>
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
