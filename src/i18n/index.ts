import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import { BUNDLED_CATALOGS, loadCatalog } from './catalogs';

/**
 * Supported UI languages. `en` is the source-of-truth catalog and the fallback;
 * the rest are LTR translations (no RTL handling this pass). The in-app Settings
 * language picker derives its options from this list.
 *
 * NOTE: `app.json`'s `locales` is a SEPARATE, hand-maintained list - it points at
 * native-metadata files (`./assets/locales/<code>.json`, distinct from these UI
 * catalogs) and notably omits `en`. It does NOT read from SUPPORTED_LANGUAGES.
 * To add a language: drop a `locales/<code>.json`, add an entry below, import it in
 * `catalogs.ts` and give it a loader in `catalogs.web.ts`, add its note to
 * `fell-asleep-notes.ts`, AND add the matching `app.json` `locales` entry (+ its
 * `assets/locales/<code>.json`).
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Español' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
] as const;

export type SupportedCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly SupportedCode[];

export const FALLBACK_CODE: SupportedCode = 'en';

export function isSupportedCode(code: string | null | undefined): code is SupportedCode {
  return !!code && (SUPPORTED_CODES as readonly string[]).includes(code);
}

// Initialise synchronously: the bundled catalogs (every one on native, English on the
// web: `catalogs.ts`) are there, so the instance is ready before the first
// `useTranslation` call. The real language is applied by the LanguageProvider once it
// resolves the persisted/device choice (`ensureLanguage` first, which loads a web
// catalog); until then we render under the fallback (the provider gates first paint).
// eslint-disable-next-line import/no-named-as-default-member -- `.use`/`.init` are the i18next instance API, not the named `use` export.
void i18n.use(initReactI18next).init({
  resources: Object.fromEntries(
    Object.entries(BUNDLED_CATALOGS).map(([code, translation]) => [code, { translation }]),
  ),
  lng: FALLBACK_CODE,
  fallbackLng: FALLBACK_CODE,
  supportedLngs: SUPPORTED_CODES as unknown as string[],
  interpolation: { escapeValue: false },
  returnNull: false,
});

/**
 * Makes `code`'s catalog available before switching to it: a no-op where it is bundled
 * (every language on native), a load of its chunk on the web. A catalog that can't be
 * loaded (offline, never cached) leaves the language to fall back to English.
 */
export async function ensureLanguage(code: SupportedCode): Promise<void> {
  if (i18n.hasResourceBundle(code, 'translation')) return;
  const catalog = await loadCatalog(code);
  if (catalog) i18n.addResourceBundle(code, 'translation', catalog, true, true);
}

let switches = 0;
let latestSwitch: Promise<void> = Promise.resolve();

/**
 * Switches the UI to `code`, its catalog loaded first (`ensureLanguage`). A later switch
 * wins: one still loading its catalog when another is asked for never applies, and
 * resolves once the later one has (so the `LanguageProvider`, holding the first paint
 * until its switch is done, never paints before the language is in).
 */
export function switchLanguage(code: SupportedCode): Promise<void> {
  const mine = ++switches;
  const run = (async () => {
    try {
      await ensureLanguage(code);
    } catch {
      // the language's strings fall back to English
    }
    if (mine !== switches) return latestSwitch;
    // eslint-disable-next-line import/no-named-as-default-member -- the instance's own API.
    await i18n.changeLanguage(code);
  })();
  latestSwitch = run;
  return run;
}

export { getLocale } from './locale';

export default i18n;
