import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { type ReactNode, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import { AccountSection } from '@/components/account/account-section';
import { JournalScreen } from '@/components/journal/journal-screen';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { SettingsContent } from '@/components/settings/settings-content';
import { SubNavSections } from '@/components/shell/tab-root-nav';
import { StatsSection } from '@/components/you/stats/stats-section';
import { YearSection } from '@/components/you/year/year-section';
import { useLayout } from '@/lib/layout';
import type { YouSection } from '@/lib/paths';

import {
  parseYouSection,
  youSectionLabelKey,
  youSectionParams,
  youSectionsFor,
  youTitleKey,
} from './you-model';

/** How the hub shows one section. */
type SectionSpec = {
  /** The section's body. `phone`: it sits under the hub's large title and segmented
   * control, so it leaves out a heading of its own. */
  render: (opts: { phone: boolean }) => ReactNode;
  /** The section scrolls itself (a list, a page with its own ScrollView) and fills the
   * hub's body; otherwise the hub puts it in a padded ScrollView with the mini player's
   * inset. */
  ownScroll: boolean;
};

/**
 * The hub's sections. Stats, Year and Account are plain columns (no scroller, no page
 * gutters of their own): the hub scrolls them with its gutters and the mini player's
 * inset. Account without a `connectionId` shows the default server, with a switcher when
 * several are signed in.
 */
const SECTIONS: Record<YouSection, SectionSpec> = {
  stats: { render: () => <StatsSection />, ownScroll: false },
  year: { render: () => <YearSection />, ownScroll: false },
  journal: { render: ({ phone }) => <JournalScreen embedded={phone} />, ownScroll: true },
  settings: { render: ({ phone }) => <SettingsContent embedded={phone} />, ownScroll: true },
  account: { render: () => <AccountSection />, ownScroll: false },
};

/**
 * The You hub (`/you?section=stats|year|journal|settings|account`, the Me tab's root;
 * STYLEGUIDE section 2). A phone: the large title names the section ("Your listening"),
 * then a scrolling segmented control of all five sections, then the section. Tablet and
 * desktop: the top bar's You destination, its sub-nav offering Stats, Year in listening
 * and Journal (Settings is the gear, Account the profile menu; an old link to either
 * still renders here). The section is the route's `section` param (`parseYouSection`:
 * absent or unknown is Stats), switched in place with `setParams`; the Journal keeps its
 * own `tab` param beside it.
 */
export function YouHub() {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const layout = useLayout();
  const phone = layout === 'phone';
  const params = useLocalSearchParams<{ section?: string }>();
  const section = parseYouSection(params.section);
  const title = t(youTitleKey(section));
  const paddingBottom = useMiniPlayerInset();

  // The phone's large title (the tab stack's header) follows the section; the wide
  // sub-nav keeps the destination's own title, "You".
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const options = youSectionsFor(layout).map((value) => ({
    value,
    label: t(youSectionLabelKey(value, layout)),
  }));
  const spec = SECTIONS[section];
  const body = spec.render({ phone });

  return (
    <View className="flex-1" testID={`you-hub-${section}`}>
      <View className={phone ? 'px-4 pb-2' : undefined}>
        <SubNavSections
          tab="(me)"
          options={options}
          value={section}
          onChange={(next) => router.setParams(youSectionParams(next))}
          accessibilityLabel={t('you.sections.label')}
          className="max-w-full"
        />
      </View>
      {spec.ownScroll ? (
        body
      ) : (
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-6 p-4 lg:px-8"
          contentContainerStyle={{ paddingBottom }}
          keyboardShouldPersistTaps="handled"
        >
          {body}
        </ScrollView>
      )}
    </View>
  );
}
