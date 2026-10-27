import { createContext } from 'react';

/**
 * Whether the covers below are on the page's first screen (a grid's first rows, a shelf's
 * first tiles, Home's Now card): each `BookCover` then loads at once and ahead of the
 * page's other images (`Cover`'s `priority`), so a page's first paint isn't waiting on a
 * lazy image. Off by default. A leaf module, so a list can set it without importing the
 * cover.
 */
export const FirstScreenCovers = createContext(false);
