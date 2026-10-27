import type { SupportedCode } from './index';

/**
 * The sleep timer's automatic bookmark note (`player.sleepTimer.fellAsleepNote`) in every
 * language the app speaks, for telling a "Fell asleep" marker by its note whatever the
 * language was when it was made. Kept here, not read from the catalogs, because the web
 * loads only the catalog in use; `fell-asleep-notes.test.ts` holds it to the catalogs.
 */
export const FELL_ASLEEP_NOTES: Readonly<Record<SupportedCode, string>> = {
  en: 'Fell asleep',
  es: 'Me dormí',
  fr: 'Endormi',
  de: 'Eingeschlafen',
  pt: 'Adormeci',
  it: 'Addormentato',
};
