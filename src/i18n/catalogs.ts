import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import pt from './locales/pt.json';

/** A UI catalog (the English one is the shape; the others may be partial). */
export type Catalog = typeof en;

/**
 * The catalogs in the app from the start, by language code: every one on native. The web
 * bundles only English and loads the language in use (`catalogs.web.ts`).
 */
export const BUNDLED_CATALOGS: Readonly<Record<string, Catalog>> = { en, es, fr, de, pt, it };

/** A catalog that is not bundled, loaded (native: every one is bundled, so none). */
export function loadCatalog(code: string): Promise<Catalog | undefined> {
  return Promise.resolve(BUNDLED_CATALOGS[code]);
}
