import type { Href } from 'expo-router';

import { firstParam } from '@/lib/paths';

/**
 * The Library tab's browse modes (STYLEGUIDE section 2): its sub-nav sections, in order.
 * The mode is the Library root's own search param, `/library?mode=<mode>` (absent =
 * `books`), so it survives a push and back, a reload and a shared link (the Library
 * destination lists `mode` in its `rootParams`, which the cold-link cleanup keeps).
 * Every mode but `folders` browses ONE library at a time: the device's selected library
 * (`useSelectedLibrary`). `folders` is the libraries-then-folders flow of old.
 */
export const LIBRARY_MODES = [
  'books',
  'authors',
  'series',
  'narrators',
  'collections',
  'folders',
] as const;

export type LibraryMode = (typeof LIBRARY_MODES)[number];

export const DEFAULT_LIBRARY_MODE: LibraryMode = 'books';

/** i18n key of each mode's label. */
export const LIBRARY_MODE_LABEL_KEY = {
  books: 'library.modes.books',
  authors: 'library.modes.authors',
  series: 'library.modes.series',
  narrators: 'library.modes.narrators',
  collections: 'library.modes.collections',
  folders: 'library.modes.folders',
} as const satisfies Record<LibraryMode, string>;

/** The mode a `?mode=` param asks for (Expo Router may hand back `string[]`); an
 * unknown or absent one is the default. */
export function parseLibraryMode(param?: string | string[]): LibraryMode {
  const v = firstParam(param);
  return (LIBRARY_MODES as readonly string[]).includes(v)
    ? (v as LibraryMode)
    : DEFAULT_LIBRARY_MODE;
}

/** What the selected library's server advertises, each `undefined` until its `/server`
 * info is known (`useCapability`). */
export type ModeCapabilities = { browsePeople?: boolean; collections?: boolean };

/** The capability a mode needs, if any: authors/series/narrators read the server's
 * browse lists (`browse_people`), collections its user state (`collections`). */
function needs(mode: LibraryMode, caps: ModeCapabilities): boolean | undefined {
  if (mode === 'authors' || mode === 'series' || mode === 'narrators') return caps.browsePeople;
  if (mode === 'collections') return caps.collections;
  return true;
}

/** The modes to offer: the ones whose capability is known to be on (books and folders
 * work on every server). A mode waiting on its flag is left out rather than shown and
 * then taken away. */
export function availableLibraryModes(caps: ModeCapabilities): LibraryMode[] {
  return LIBRARY_MODES.filter((m) => needs(m, caps) === true);
}

/** The mode to show for a requested one: itself unless its server is known to lack it
 * (then the default). While the flag is still unknown the request stands, so a deep
 * link to `?mode=authors` doesn't flash Books first. */
export function resolveLibraryMode(requested: LibraryMode, caps: ModeCapabilities): LibraryMode {
  return needs(requested, caps) === false ? DEFAULT_LIBRARY_MODE : requested;
}

/** The Library root in a mode (the default mode carries no param). */
export function libraryModeHref(mode: LibraryMode): Href {
  return mode === DEFAULT_LIBRARY_MODE ? '/library' : { pathname: '/library', params: { mode } };
}

/** What every single-library mode is given: the selected library (`useSelectedLibrary`). */
export type LibraryModeProps = { connectionId: string; libraryId: number };
