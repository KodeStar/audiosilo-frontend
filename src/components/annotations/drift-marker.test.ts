import de from '@/i18n/locales/de.json';
import en from '@/i18n/locales/en.json';
import es from '@/i18n/locales/es.json';
import fr from '@/i18n/locales/fr.json';
import italian from '@/i18n/locales/it.json';
import pt from '@/i18n/locales/pt.json';

import { isDriftBookmark, isFellAsleepNote, shownNote } from './drift-marker';

const LOCALES = { en, de, es, fr, it: italian, pt };

describe('isFellAsleepNote', () => {
  it.each(Object.entries(LOCALES))(
    'knows the timer’s note made in %s, whatever the language is today',
    (_, l) => {
      expect(isFellAsleepNote(l.player.sleepTimer.fellAsleepNote)).toBe(true);
      expect(isFellAsleepNote(` ${l.player.sleepTimer.fellAsleepNote}\n`)).toBe(true);
    },
  );

  it('does not take a note the listener wrote', () => {
    expect(isFellAsleepNote('Fell asleep during the battle, re-listen')).toBe(false);
    expect(isFellAsleepNote('')).toBe(false);
    expect(isFellAsleepNote(undefined)).toBe(false);
  });
});

describe('isDriftBookmark', () => {
  it('reads the label on a server with annotations, whatever the note says', () => {
    expect(isDriftBookmark({ label: 'fell_asleep', note: 'Fell asleep' })).toBe(true);
    expect(isDriftBookmark({ label: 'fell_asleep', note: 'Kaladin at the chasm' })).toBe(true);
  });

  it('reads the note where there is no label (an older server, or made before labels)', () => {
    expect(isDriftBookmark({ note: 'Eingeschlafen' })).toBe(true);
    expect(isDriftBookmark({ label: '', note: 'Me dormí' })).toBe(true);
    expect(isDriftBookmark({ note: 'Bridge Four' })).toBe(false);
  });

  it('leaves the listener’s own labelled bookmark alone', () => {
    expect(isDriftBookmark({ label: 'quote', note: 'Fell asleep' })).toBe(false);
  });
});

describe('shownNote', () => {
  it('hides the timer’s automatic note: the row says where the listener drifted off', () => {
    expect(shownNote({ label: 'fell_asleep', note: 'Endormi' })).toBe('');
    expect(shownNote({ note: 'Fell asleep' })).toBe('');
  });

  it('shows a note the listener wrote, on a drift marker too', () => {
    expect(shownNote({ label: 'fell_asleep', note: 'Around the duel ' })).toBe('Around the duel');
    expect(shownNote({ label: 'quote', note: 'Fell asleep' })).toBe('Fell asleep');
  });
});
