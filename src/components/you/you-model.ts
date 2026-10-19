import type { LayoutClass } from '@/lib/layout';
import { type CoreYouSection, firstParam, type YouSection } from '@/lib/paths';

/**
 * The You hub's rules (`/you?section=stats|year|journal|settings|household|account`, the Me tab's
 * root): pure, so the section a link opens and what each form factor offers are tested
 * apart from the screen. An active module's sections (`moduleKeys`, Bridge Phase 2a) come
 * after the hub's own on every form factor.
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
 * there, Household and Account the profile menu (decision 4 of Phase 8b-1: Household is
 * the phone's sixth segment, a pushed page elsewhere). */
const WIDE_SECTIONS: readonly CoreYouSection[] = ['stats', 'year', 'journal'];

/** Whether `section` is one of the hub's own. */
export function isCoreYouSection(section: string): section is CoreYouSection {
  return (YOU_SECTIONS as readonly string[]).includes(section);
}

/** The keys of `moduleKeys` that can be sections: not one of the hub's own, each once. */
function moduleSectionKeys(moduleKeys: readonly string[]): string[] {
  return [...new Set(moduleKeys)].filter((k) => k !== '' && !isCoreYouSection(k));
}

/** The section a link asks for: one of the hub's own, or the key of an active module's
 * section (`moduleKeys`); anything else (absent, unknown, repeated, a module that is off)
 * is Stats. */
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
  return moduleSectionKeys(moduleKeys).includes(v) ? v : 'stats';
}

/** The sections the hub's segmented control offers on this form factor: all six on a
 * phone (it has no top bar), Stats, Year and Journal on tablet and desktop. A link to
 * Settings, Household or Account still renders there; the control then shows no segment
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
  const keys = moduleSectionKeys(moduleKeys);
  return keys.length > 0 ? [...own, ...keys] : own;
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
