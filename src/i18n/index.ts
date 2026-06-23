import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import it from './locales/it.json';
import pt from './locales/pt.json';

/**
 * Supported UI languages. `en` is the source-of-truth catalog and the fallback;
 * the rest are LTR translations (no RTL handling this pass). To add a language:
 * drop a `locales/<code>.json`, import it here, and add an entry below — the
 * Settings picker and native `app.json` `locales` declaration read from this list.
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

const resources = {
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  de: { translation: de },
  pt: { translation: pt },
  it: { translation: it },
} as const;

// Initialise synchronously: resources are bundled (no async backend), so the
// instance is ready before the first `useTranslation` call. The real language is
// applied by the LanguageProvider once it resolves the persisted/device choice;
// until then we render under the fallback (the provider gates first paint).
// eslint-disable-next-line import/no-named-as-default-member -- `.use`/`.init` are the i18next instance API, not the named `use` export.
void i18n.use(initReactI18next).init({
  resources,
  lng: FALLBACK_CODE,
  fallbackLng: FALLBACK_CODE,
  supportedLngs: SUPPORTED_CODES as unknown as string[],
  interpolation: { escapeValue: false },
  returnNull: false,
});

export { getLocale } from './locale';

export default i18n;
