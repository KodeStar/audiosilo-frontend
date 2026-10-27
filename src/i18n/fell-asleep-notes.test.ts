import { SUPPORTED_CODES } from '@/i18n';

import { FELL_ASLEEP_NOTES } from './fell-asleep-notes';
import de from './locales/de.json';
import en from './locales/en.json';
import es from './locales/es.json';
import fr from './locales/fr.json';
import italian from './locales/it.json';
import pt from './locales/pt.json';

const CATALOGS = { en, es, fr, de, pt, it: italian };

describe('FELL_ASLEEP_NOTES', () => {
  it.each(SUPPORTED_CODES)('%s is the catalog note', (code) => {
    expect(FELL_ASLEEP_NOTES[code]).toBe(CATALOGS[code].player.sleepTimer.fellAsleepNote.trim());
  });
});
