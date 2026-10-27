import en from './locales/en.json';

import type { Catalog } from './catalogs';

export type { Catalog } from './catalogs';

/**
 * The web bundles only English (the fallback, and the language most start in): each other
 * catalog is about as large and is its own chunk, loaded when it is the language in use
 * (`ensureLanguage`). Native bundles all of them (`catalogs.ts`).
 */
export const BUNDLED_CATALOGS: Readonly<Record<string, Catalog>> = { en };

/** The other catalogs' chunks, by language code. */
export const CATALOG_LOADERS: Readonly<Record<string, () => Promise<{ default: Catalog }>>> = {
  es: () => import('./locales/es.json'),
  fr: () => import('./locales/fr.json'),
  de: () => import('./locales/de.json'),
  pt: () => import('./locales/pt.json'),
  it: () => import('./locales/it.json'),
};

/** A catalog, loaded when it is not bundled; `undefined` for a code with none. */
export async function loadCatalog(
  code: string,
  loaders: Readonly<Record<string, () => Promise<{ default: Catalog }>>> = CATALOG_LOADERS,
): Promise<Catalog | undefined> {
  if (BUNDLED_CATALOGS[code]) return BUNDLED_CATALOGS[code];
  const load = loaders[code];
  return load ? (await load()).default : undefined;
}
