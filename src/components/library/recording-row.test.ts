import type { Book } from '@/api/types';

// The row's cover reads the theme provider, whose module imports global.css (unparseable
// in Node).
jest.mock('@/theme/theme-provider', () => ({ useTheme: () => ({ scheme: 'light' }) }));

/* eslint-disable import/first */
import i18n from '@/i18n';

import { recordingCaption, recordingLabel } from './recording-row';
/* eslint-enable import/first */

const t = i18n.t.bind(i18n);

const book = (over: Partial<Book> = {}) =>
  ({
    title: 'Leviathan Wakes',
    narrator: 'Jefferson Mays',
    duration: 36_000,
    ...over,
  }) as Book;

const facts = (over: Partial<Parameters<typeof recordingCaption>[1]> = {}) => ({
  libraryId: 1,
  path: 'Corey/Leviathan Wakes',
  book: book(),
  fraction: 0,
  started: false,
  finished: false,
  ...over,
});

describe('recordingLabel', () => {
  it('names a recording by its narrator, else its title or folder', () => {
    expect(recordingLabel(t, facts())).toBe('Read by Jefferson Mays');
    expect(recordingLabel(t, facts({ book: book({ narrator: '' }) }))).toBe('Leviathan Wakes');
    // A recording in another library whose row is not loaded yet.
    expect(recordingLabel(t, facts({ book: undefined }))).toBe('Leviathan Wakes');
  });
});

describe('recordingCaption', () => {
  it('says its length and the listener progress in it', () => {
    expect(recordingCaption(t, facts())).toBe('10h');
    expect(recordingCaption(t, facts({ started: true, fraction: 0.4 }))).toBe('10h · 40% listened');
    expect(recordingCaption(t, facts({ started: true, finished: true, fraction: 1 }))).toBe(
      '10h · Finished',
    );
  });

  it('names another library and an abridged recording', () => {
    expect(recordingCaption(t, facts({ book: book({ abridged: true }) }), 'Kids')).toBe(
      'Kids · Abridged · 10h',
    );
    // Absent `abridged` is unknown, never said.
    expect(recordingCaption(t, facts({ book: book({ abridged: false }) }))).toBe('10h');
  });
});
