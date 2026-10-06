import type { TFunction } from 'i18next';

import { chapterLabel } from './chapter-label';

const t = ((key: string, opts?: { number?: number }) =>
  `${key}:${opts?.number ?? ''}`) as unknown as TFunction;

describe('chapterLabel', () => {
  it('uses the chapter title as given when it is a real title', () => {
    expect(chapterLabel({ title: 'The Shadow of the Past', index: 1 }, t)).toBe(
      'The Shadow of the Past',
    );
  });

  it('prettifies a filename-shaped title', () => {
    expect(chapterLabel({ title: '01_the_hobbit_ch1.mp3', index: 0 }, t)).toBe('01 the hobbit ch1');
  });

  it('falls back to the 1-based chapter number when untitled', () => {
    expect(chapterLabel({ title: '', index: 4 }, t)).toBe('player.chapters.chapterNumber:5');
  });
});
