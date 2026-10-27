/**
 * The app's EPUB cache (`ebook-file.native.ts`, Bridge Phase 3b-2) has nothing to clear on
 * the web, whose reader fetches the book each time it opens (or reads its download). Metro
 * picks the native file on iOS and Android.
 */
export async function clearEbookCache(_connectionId: string): Promise<void> {}
