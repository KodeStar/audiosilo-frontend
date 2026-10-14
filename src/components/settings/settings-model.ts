import { firstParam, type SettingsSection } from '@/lib/paths';

/**
 * Settings' rules (`/settings?section=`, and the phone You hub's Settings segment): which
 * panes exist, how they group, which a link opens and how the page lays them out. Pure,
 * so they're tested apart from the screen. Each setting lives in exactly one pane
 * (STYLEGUIDE section 2); the Downloads page and the series page bind the same values as
 * shortcuts, never a second copy.
 */

/** One pane of settings: a nav item on a wide page, a titled card on a narrow one.
 * (Accessibility has no pane: the app has no setting of its own for it yet, and the guide
 * says not to show a switch that does nothing. Household is a page of its own since Phase
 * 8b-1, linked from the App group: `HOUSEHOLD_LINK_GROUP`.) */
export type SettingsPane = Exclude<SettingsSection, 'preferences' | 'household'>;

export type SettingsGroupKey = 'listening' | 'app' | 'servers';

export type SettingsGroup = { key: SettingsGroupKey; panes: readonly SettingsPane[] };

const GROUPS: readonly SettingsGroup[] = [
  { key: 'listening', panes: ['playback', 'sleep', 'downloads'] },
  { key: 'app', panes: ['appearance', 'language'] },
  { key: 'servers', panes: ['accounts', 'support'] },
];

/** The group whose panes end with the link to the Household page (`/household`, Phase
 * 8b-1): where its pane used to be. */
export const HOUSEHOLD_LINK_GROUP: SettingsGroupKey = 'app';

/** The pane the bare page (and `preferences`) opens on. */
export const FIRST_PANE: SettingsPane = 'playback';

/** The groups and panes this build shows: Support only where the build may link to it
 * (`isSupportAvailable`: Apple builds hide it). */
export function settingsGroups(supportAvailable: boolean): readonly SettingsGroup[] {
  return supportAvailable
    ? GROUPS
    : GROUPS.map((g) => ({ ...g, panes: g.panes.filter((p) => p !== 'support') }));
}

/** The pane a link asks for: `preferences` (and anything absent or unknown) is the first
 * pane, `accounts` the signed-in servers; a pane this build hides is the first pane too.
 * (`household` is the Household page now: the route redirects it, `isHouseholdSection`.) */
export function parseSettingsSection(
  raw: string | string[] | undefined,
  supportAvailable: boolean,
): SettingsPane {
  const v = firstParam(raw);
  const shown = settingsGroups(supportAvailable).flatMap((g) => g.panes);
  return (shown as readonly string[]).includes(v) ? (v as SettingsPane) : FIRST_PANE;
}

/** Whether a `/settings` link asks for the old Household pane, which is the Household
 * page now (`/household`): the route replaces itself with the page. */
export function isHouseholdSection(raw: string | string[] | undefined): boolean {
  return firstParam(raw) === 'household';
}

/** The `section` param that names `pane` (the first pane is the bare page). */
export function sectionParam(pane: SettingsPane): SettingsPane | undefined {
  return pane === FIRST_PANE ? undefined : pane;
}

/** From this MEASURED width the page puts its section nav beside one pane (the
 * prototype's settings layout); below it every pane stacks under its group's heading.
 * Measured, not the window: the desktop's Up next drawer can take 300-480 of it. */
export const SPLIT_MIN = 720;

/** A pane's card puts a wide control (a segmented control) beside its label from this
 * measured card width; narrower, under it. */
export const INLINE_MIN = 560;

/** How the page lays out at `width` (0 = not measured yet: guess from the form factor,
 * so a desktop doesn't flash the phone's stack first). */
export function settingsLayout(width: number, phone: boolean): 'split' | 'stacked' {
  if (width <= 0) return phone ? 'stacked' : 'split';
  return width >= SPLIT_MIN ? 'split' : 'stacked';
}
