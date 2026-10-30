import { router, useNavigation } from 'expo-router';
import { Fragment, type ReactNode, useLayoutEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccountSection } from '@/components/account/account-section';
import { HouseholdPage } from '@/components/household/household-page';
import { JournalScreen } from '@/components/journal/journal-screen';
import { ListeningAsCard } from '@/components/profiles/listening-as-card';
import { SettingsContent } from '@/components/settings/settings-content';
import { TabPageScroll } from '@/components/shell/tab-page-scroll';
import { SubNavSections } from '@/components/shell/tab-root-nav';
import { StatsSection } from '@/components/you/stats/stats-section';
import { YearSection } from '@/components/you/year/year-section';
import { useLayout } from '@/lib/layout';
import type { CoreYouSection } from '@/lib/paths';
import { useRouteParams } from '@/lib/route-params';
import { usePageTitle } from '@/lib/use-page-title';
import { WithActiveModules } from '@/modules/active-modules';
import type { PlayerModule, YouModuleSection } from '@/modules/registry';

import {
  isCoreYouSection,
  parseYouSection,
  youModuleSections,
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
 * large title and segmented control, so it leaves out a heading of its own. Stats, Year,
 * Household and Account are plain columns the hub scrolls (`column`); the Journal and
 * Settings scroll themselves. The phone's Settings opens Household as the hub's own
 * segment (elsewhere it is the pushed page). Account without a `connectionId` shows the default server, with a
 * switcher when several are signed in.
 */
const SECTIONS: Record<CoreYouSection, (opts: { phone: boolean }) => ReactNode> = {
  stats: () => column(<StatsSection />),
  year: () => column(<YearSection />),
  journal: ({ phone }) => <JournalScreen embedded={phone} />,
  settings: ({ phone }) =>
    phone ? (
      <SettingsContent
        embedded
        onOpenHousehold={() => router.setParams(youSectionParams('household'))}
      />
    ) : (
      <SettingsContent />
    ),
  household: ({ phone }) => column(<HouseholdPage embedded={phone} />),
  // The phone has no profile menu: who is listening heads its Account segment (Phase 8).
  account: ({ phone }) =>
    column(
      <>
        {phone ? <ListeningAsCard /> : null}
        <AccountSection />
      </>,
    ),
};

/**
 * The You hub (`/you?section=stats|year|journal|settings|household|account`, the Me tab's
 * root; STYLEGUIDE section 2). A phone: the large title names the section ("Your
 * listening"), then a scrolling segmented control of all six sections, then the section.
 * Tablet and desktop: the top bar's You destination, its sub-nav offering Stats, Year in
 * listening, Journal and Household (Settings is the gear, Account the profile menu; an old
 * link to either still renders here). The section is the route's `section` param (`parseYouSection`:
 * absent or unknown is Stats), switched in place with `setParams`; the Journal keeps its
 * own `tab` param beside it. An active module's sections (`youSections`,
 * `src/modules/registry.ts`, none yet) follow the hub's own; `modules` is the list to
 * choose from (the registry; tests pass a fake).
 */
export function YouHub({ modules }: { modules?: readonly PlayerModule[] } = {}) {
  return (
    <WithActiveModules modules={modules}>{(active) => <Hub active={active} />}</WithActiveModules>
  );
}

function Hub({ active }: { active: readonly PlayerModule[] }) {
  const { t } = useTranslation();
  const navigation = useNavigation();
  const layout = useLayout();
  const phone = layout === 'phone';
  const params = useRouteParams<{ section?: string }>();
  const moduleSections = useMemo(() => youModuleSections(active), [active]);
  const moduleKeys = useMemo(() => [...moduleSections.keys()], [moduleSections]);
  const section = parseYouSection(params.section, moduleKeys);
  const ownSection = isCoreYouSection(section) ? section : null;
  const moduleSection = ownSection ? undefined : moduleSections.get(section);
  const title = ownSection ? t(youTitleKey(ownSection)) : (moduleSection?.label(t) ?? '');

  // The phone's large title (the tab stack's header) follows the section; the wide
  // sub-nav keeps the destination's own title, "You".
  useLayoutEffect(() => {
    navigation.setOptions({ title });
  }, [navigation, title]);
  // The browser tab names the section at every width.
  usePageTitle(title);

  const options = youSectionsFor(layout, moduleKeys).map((value) => ({
    value,
    label: isCoreYouSection(value)
      ? t(youSectionLabelKey(value, layout))
      : (moduleSections.get(value)?.label(t) ?? value),
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
      <Fragment key={section}>
        {ownSection
          ? SECTIONS[ownSection]({ phone })
          : moduleSection
            ? column(<ModuleSectionBody section={moduleSection} phone={phone} />)
            : null}
      </Fragment>
    </View>
  );
}

/** A module's section behind a component of its own, so a hook its `render` reaches stays
 * out of the hub's own. */
function ModuleSectionBody({ section, phone }: { section: YouModuleSection; phone: boolean }) {
  return section.render({ phone });
}
