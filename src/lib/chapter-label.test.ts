import type { TFunction } from 'i18next';

import { chapterLabel, contradictedTitle, resumeChapterLabel } from './chapter-label';

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

describe('contradictedTitle', () => {
  it("returns the title when its number is not the chapter's place (a Prologue first)", () => {
    // The fixture's Caliban's War: Prologue, Chapter 1 ... Chapter 23, Epilogue.
    expect(contradictedTitle({ number: 11, title: 'Chapter 10' })).toBe('Chapter 10');
    expect(contradictedTitle({ number: 2, title: 'Ch. 1' })).toBe('Ch. 1');
    expect(contradictedTitle({ number: 4, title: '3. The Wedding' })).toBe('3. The Wedding');
    expect(contradictedTitle({ number: 3, title: '02_caliban_ch2.mp3' })).toBe('02 caliban ch2');
  });

  it('leaves a title that agrees, or carries no chapter number, to the numbered label', () => {
    expect(contradictedTitle({ number: 11, title: 'Chapter 11' })).toBeNull();
    expect(contradictedTitle({ number: 1, title: 'Prologue' })).toBeNull();
    expect(contradictedTitle({ number: 3, title: 'The Shadow of the Past' })).toBeNull();
    expect(contradictedTitle({ number: 5, title: 'The Summer of 1969' })).toBeNull();
    expect(contradictedTitle({ number: 5, title: '' })).toBeNull();
  });
});

describe('resumeChapterLabel', () => {
  const tr = ((key: string, o: Record<string, unknown>) =>
    `${key}:${String(o.title ?? o.chapter)}`) as unknown as TFunction;

  it('says the title when the number contradicts it, else the number', () => {
    expect(resumeChapterLabel(tr, { number: 11, title: 'Chapter 10' })).toBe(
      'common.resumeTitled:Chapter 10',
    );
    expect(resumeChapterLabel(tr, { number: 11, title: 'Chapter 11' })).toBe(
      'common.resumeChapter:11',
    );
    expect(resumeChapterLabel(tr, { number: 2, title: 'Ch. 1' })).toBe('common.resumeTitled:Ch. 1');
  });
});
