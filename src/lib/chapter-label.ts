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
