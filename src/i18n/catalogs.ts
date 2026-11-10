import en from './locales/en.json';

/** A UI catalog (the English one is the shape; the others may be partial). */
export type Catalog = typeof en;

/**
 * The catalogs in use from the start, by language code: only English (the fallback, and
 * the language most start in), on native as on the web (`catalogs.web.ts`).
 */
export const BUNDLED_CATALOGS: Readonly<Record<string, Catalog>> = { en };

/**
 * The other catalogs on native, by language code: still in the bundle (one bundle on
 * native), but Metro runs a module only when it is first required (hence `require()`
 * inside a function, not an import). A cold start evaluates English alone, not all six
 * (PERF-SPIKE P5: about 15% of the Android bundle); the language in use is required when
 * `ensureLanguage` switches to it.
 */
export const CATALOG_LOADERS: Readonly<Record<string, () => Catalog>> = {
  es: () => require('./locales/es.json') as Catalog,
  fr: () => require('./locales/fr.json') as Catalog,
  de: () => require('./locales/de.json') as Catalog,
  pt: () => require('./locales/pt.json') as Catalog,
  it: () => require('./locales/it.json') as Catalog,
};

/** A catalog, required when it is not bundled; `undefined` for a code with none. */
export async function loadCatalog(
  code: string,
  loaders: Readonly<Record<string, () => Catalog>> = CATALOG_LOADERS,
): Promise<Catalog | undefined> {
  if (BUNDLED_CATALOGS[code]) return BUNDLED_CATALOGS[code];
  return loaders[code]?.();
}
