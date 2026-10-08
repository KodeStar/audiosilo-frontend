import type { TFunction } from 'i18next';

import { prettifyChapterTitle } from '@/playback/prettify-title';

/**
 * The display label for a chapter: its title (prettified when it is a filename), else
 * "Chapter N". One definition for every surface that names the current chapter (the
 * full player, the mini/accessory/docked players, the sleep sheet, the palette).
 */
export function chapterLabel(chapter: { title: string; index: number }, t: TFunction): string {
  return prettifyChapterTitle(
    chapter.title || t('player.chapters.chapterNumber', { number: chapter.index + 1 }),
  );
}

/** A chapter named by its place in the book (1-based) and its own title. */
export type NamedChapter = { number: number; title: string };

/** A chapter-name-shaped number at the start of a title: "Chapter 10", "Ch. 10",
 * "10. The Wedding", "Kapitel 10" (a few words, then digits). A number further in ("The
 * Summer of 1969") is not the chapter's. */
const TITLE_NUMBER = /^\D{0,12}?(\d+)/;

/**
 * The chapter's title when its place in the book would contradict it, else null.
 * Labels that name a chapter by its place ("Resume chapter 11", "Ch. 11 of 25") count
 * from the first chapter, but in a book that opens with a "Prologue" or "Opening
 * credits" the 11th chapter is titled "Chapter 10", the name the player shows. There a
 * label says the title instead ("Resume Chapter 10"); a title without a number of its
 * own, or with the same one, leaves the label as it was.
 */
export function contradictedTitle(chapter: NamedChapter): string | null {
  const title = prettifyChapterTitle(chapter.title ?? '').trim();
  const m = TITLE_NUMBER.exec(title);
  return m && Number(m[1]) !== chapter.number ? title : null;
}

/** "Resume chapter 11", or "Resume Chapter 10" when the title contradicts the number
 * (`contradictedTitle`): the book page, the Now card and the series page say it alike. */
export function resumeChapterLabel(t: TFunction, chapter: NamedChapter): string {
  const titled = contradictedTitle(chapter);
  return titled
    ? t('common.resumeTitled', { title: titled })
    : t('common.resumeChapter', { chapter: chapter.number });
}
