import type { LayoutClass } from '@/lib/layout';
import { firstParam, type YouSection } from '@/lib/paths';

/**
 * The You hub's rules (`/you?section=stats|year|journal|settings|account`, the Me tab's
 * root): pure, so the section a link opens and what each form factor offers are tested
 * apart from the screen.
 */

export const YOU_SECTIONS: readonly YouSection[] = [
  'stats',
  'year',
  'journal',
  'settings',
  'account',
];

/** The sections the top bar's You destination offers in the sub-nav. Settings and Account
 * are the gear and the profile menu there. */
const WIDE_SECTIONS: readonly YouSection[] = ['stats', 'year', 'journal'];

/** The section a link asks for; anything else (absent, unknown, repeated) is Stats. */
export function parseYouSection(raw: string | string[] | undefined): YouSection {
  const v = firstParam(raw);
  return (YOU_SECTIONS as readonly string[]).includes(v) ? (v as YouSection) : 'stats';
}

/** The sections the hub's segmented control offers on this form factor: all five on a
 * phone (it has no top bar), Stats, Year and Journal on tablet and desktop. A link to
 * Settings or Account still renders there; the control then shows no segment chosen. */
export function youSectionsFor(layout: LayoutClass): readonly YouSection[] {
  return layout === 'phone' ? YOU_SECTIONS : WIDE_SECTIONS;
}

/** A section's segment label: short on a phone ("Year"), the destination's own words in
 * the wider sub-nav ("Year in listening"). */
export function youSectionLabelKey(section: YouSection, layout: LayoutClass) {
  if (section === 'year' && layout !== 'phone') return 'you.titles.year' as const;
  return `you.sections.${section}` as const;
}

/** The phone's large title for a section ("Your listening" over Stats). */
export const youTitleKey = (section: YouSection) => `you.titles.${section}` as const;

/** The route params that open `next`: Stats is the bare root, and leaving the Journal
 * drops its tab (a later visit opens on the Diary, as a fresh link would). */
export function youSectionParams(next: YouSection): { section?: YouSection; tab?: undefined } {
  return { section: next === 'stats' ? undefined : next, tab: undefined };
}
