/**
 * The app's EPUB cache (`ebook-file.native.ts`, Bridge Phase 3b-2) has nothing to clear on
 * the web, whose reader fetches the book each time it opens (or reads its download). Metro
 * picks the native file on iOS and Android.
 */
export async function clearEbookCache(_connectionId: string): Promise<void> {}

/** A book's EPUB as `hasLocalEbook` looks for it on both platforms. */
export type EbookFileRef = {
  connectionId: string;
  libraryId: number;
  path: string;
  /** The server's `ebook.size`: it names the app's cache file. */
  size?: number;
  /** The book download's EPUB (its `manifest.ebookUri`), when it has one. */
  saved?: string;
};

/** Whether the book's EPUB is on this device: on the web only its download's copy
 * (`saved`, in the Cache API), there being no reader cache. */
export async function hasLocalEbook({ saved }: EbookFileRef): Promise<boolean> {
  return !!saved;
}
