import 'i18next';

import type en from './locales/en.json';

// Type-safe translation keys: `t('settings.title')` is checked against the English
// catalog (the source of truth). Other locales may be partial - missing keys fall
// back to English at runtime, and are not type-checked against this shape.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation';
    resources: { translation: typeof en };
    returnNull: false;
  }
}
