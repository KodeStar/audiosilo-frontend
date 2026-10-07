import i18n from '@/i18n';

jest.mock('@/playback/store', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@/testing/player-store-mock').createPlayerStoreMock(),
);
const mockStarts = jest.fn();
jest.mock('@/components/library/meta-gating', () => {
  const actual = jest.requireActual('@/components/library/meta-gating');
  return {
    ...actual,
    chapterStartsOf: (...a: unknown[]) => {
      mockStarts(...a);
      return actual.chapterStartsOf(...a);
    },
  };
});

/* eslint-disable import/first */
import type { Chapter } from '@/api/types';

import { chapterNamer } from './use-book-place';
/* eslint-enable import/first */

const chapter = (index: number, title: string, start: number): Chapter => ({
  index,
  title,
  file_index: 0,
  file_path: 'a.m4b',
  start,
  end: start + 100,
  book_offset: start,
});

describe('chapterNamer', () => {
  const t = i18n.t.bind(i18n);
  const chapters = [chapter(0, 'Prologue', 0), chapter(1, '', 100)];

  it('names the chapter at a place, numbering an untitled one', () => {
    const name = chapterNamer(chapters, undefined, t);
    expect(name(50)).toBe('Prologue');
    expect(name(150)).toBe('Chapter 2');
    expect(chapterNamer([], undefined, t)(50)).toBeNull();
  });

  it('places one chapter list once, however many rows name from it', () => {
    const list = [...chapters];
    mockStarts.mockClear();
    chapterNamer(list, undefined, t)(10);
    chapterNamer(list, undefined, t)(150);
    expect(mockStarts).toHaveBeenCalledTimes(1);
    // Other files place it again.
    chapterNamer(list, [{ rel_path: 'a.m4b', duration: 200 }], t)(10);
    expect(mockStarts).toHaveBeenCalledTimes(2);
  });
});
