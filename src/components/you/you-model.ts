import type { LayoutClass } from '@/lib/layout';
import { type CoreYouSection, firstParam, type YouSection } from '@/lib/paths';
import type { PlayerModule, YouModuleSection } from '@/modules/registry';

/**
 * The You hub's rules (`/you?section=stats|year|journal|settings|household|account`, the Me tab's
 * root): pure, so the section a link opens and what each form factor offers are tested
 * apart from the screen. Upcoming (Track U2, while offered) and an active module's sections
 * (`youModuleSections`, Bridge Phase 2a) come after the hub's own on every form factor
 * (`youExtraSections`).
 */

export const YOU_SECTIONS: readonly CoreYouSection[] = [
  'stats',
  'year',
  'journal',
  'settings',
  'household',
  'account',
];

/** The sections the top bar's You destination offers in the sub-nav. Settings is the gear
 * there and Account the profile menu. Household is in it as on a phone (v2.5.1 PLAYER-12:
 * a link to it opened a hub with no segment chosen); the profile menu, Settings and Home's
 * house row still push it as a page of its own. */
const WIDE_SECTIONS: readonly CoreYouSection[] = ['stats', 'year', 'journal', 'household'];

/** Whether `section` is one of the hub's own. */
export function isCoreYouSection(section: string): section is CoreYouSection {
  return (YOU_SECTIONS as readonly string[]).includes(section);
}

/** The active modules' sections by key, in registry order: the first of a key wins, and a
 * blank key (a link can't name it) or one of the hub's own is ignored. Its keys are the
 * `moduleKeys` the rules below take. */
export function youModuleSections(
  active: readonly PlayerModule[],
): ReadonlyMap<string, YouModuleSection> {
  const out = new Map<string, YouModuleSection>();
  for (const m of active) {
    for (const s of m.youSections ?? []) {
      if (s.key.trim() && !isCoreYouSection(s.key) && !out.has(s.key)) out.set(s.key, s);
    }
  }
  return out;
}

/** The Upcoming section's key (Track U2): the hub's own, but offered only while one of the
 * listener's servers lists upcoming releases for them (`useUpcomingAvailable`), so it rides
 * with the modules' sections, after the hub's fixed ones, and no module can take its key. */
export const UPCOMING_SECTION = 'upcoming';

/** The hub's optional sections by key, in order: Upcoming when `upcoming` is given (it is
 * offered), then the active modules' (`youModuleSections`), never one keyed like
 * Upcoming. Its keys are the `moduleKeys` the rules below take. */
export function youExtraSections(
  upcoming: YouModuleSection | null,
  modules: ReadonlyMap<string, YouModuleSection>,
): ReadonlyMap<string, YouModuleSection> {
  const out = new Map<string, YouModuleSection>();
  if (upcoming) out.set(UPCOMING_SECTION, upcoming);
  for (const [key, section] of modules) if (key !== UPCOMING_SECTION) out.set(key, section);
  return out;
}

/** The section a link asks for: one of the hub's own, or the key of an active module's
 * section (`moduleKeys`, from `youModuleSections`); anything else (absent, unknown,
 * repeated, a module that is off) is Stats. */
export function parseYouSection(raw: string | string[] | undefined): CoreYouSection;
export function parseYouSection(
  raw: string | string[] | undefined,
  moduleKeys: readonly string[],
): YouSection;
export function parseYouSection(
  raw: string | string[] | undefined,
  moduleKeys: readonly string[] = [],
): YouSection {
  const v = firstParam(raw);
  if (isCoreYouSection(v)) return v;
  return v !== '' && moduleKeys.includes(v) ? v : 'stats';
}

/** The sections the hub's segmented control offers on this form factor: all six on a
 * phone (it has no top bar), Stats, Year, Journal and Household on tablet and desktop. A
 * link to Settings or Account still renders there; the control then shows no segment
 * chosen. */
export function youSectionsFor(layout: LayoutClass): readonly CoreYouSection[];
export function youSectionsFor(
  layout: LayoutClass,
  moduleKeys: readonly string[],
): readonly YouSection[];
export function youSectionsFor(
  layout: LayoutClass,
  moduleKeys: readonly string[] = [],
): readonly YouSection[] {
  const own = layout === 'phone' ? YOU_SECTIONS : WIDE_SECTIONS;
  return moduleKeys.length > 0 ? [...own, ...moduleKeys] : own;
}

/** A section's segment label: short on a phone ("Year"), the destination's own words in
 * the wider sub-nav ("Year in listening"). */
export function youSectionLabelKey(section: CoreYouSection, layout: LayoutClass) {
  if (section === 'year' && layout !== 'phone') return 'you.titles.year' as const;
  return `you.sections.${section}` as const;
}

/** The phone's large title for a section ("Your listening" over Stats). */
export const youTitleKey = (section: CoreYouSection) => `you.titles.${section}` as const;

/** The route params that open `next`: Stats is the bare root, and leaving the Journal
 * drops its tab (a later visit opens on the Diary, as a fresh link would). */
export function youSectionParams(next: YouSection): { section?: YouSection; tab?: undefined } {
  return { section: next === 'stats' ? undefined : next, tab: undefined };
}
