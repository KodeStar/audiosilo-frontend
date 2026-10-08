import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { Fragment, type ReactNode, useLayoutEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccountSection } from '@/components/account/account-section';
import { JournalScreen } from '@/components/journal/journal-screen';
import { SettingsContent } from '@/components/settings/settings-content';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
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

/** A plain column section (no scroller, no page gutters of its own) in the hub's tab page
 * scroller. */
const column = (body: ReactNode) => (
  <TabPageScroll testID="you-hub-scroll" contentContainerClassName="gap-6">
    {body}
  </TabPageScroll>
);

/**
 * The hub's sections, each with its scroller. `phone`: the section sits under the hub's
 * large title and segmented control, so it leaves out a heading of its own. Stats, Year
 * and Account are plain columns the hub scrolls (`column`); the Journal and Settings
 * scroll themselves. Account without a `connectionId` shows the default server, with a
 * switcher when several are signed in.
 */
const SECTIONS: Record<YouSection, (opts: { phone: boolean }) => ReactNode> = {
  stats: () => column(<StatsSection />),
  year: () => column(<YearSection />),
  journal: ({ phone }) => <JournalScreen embedded={phone} />,
  settings: ({ phone }) => <SettingsContent embedded={phone} />,
  account: () => column(<AccountSection />),
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

  // The phone's large title (the tab stack's header) follows the section; the wide
  // sub-nav keeps the destination's own title, "You".
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);

  const options = youSectionsFor(layout).map((value) => ({
    value,
    label: t(youSectionLabelKey(value, layout)),
  }));

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
      {/* Keyed: a new section starts at its top, not at the offset the last one was left
          at (one shared scroller would keep it). */}
      <Fragment key={section}>{SECTIONS[section]({ phone })}</Fragment>
    </View>
  );
}
