import { create } from 'zustand';

/**
 * The web player's browser tab title. Expo Router turns React Navigation's own
 * document-title sync off (and a Stack's `title` is the phone header's, empty on a pushed
 * page), so without this the tab shows the URL. One writer, `DocumentTitle`, composes it
 * from the focused screen's title (`usePageTitle`), the active tab's name, and the book
 * playing. Both are web only (`.web` files; no-ops on native).
 */

const BRAND = 'AudioSilo';

/** The tab title: the playing book wins, then the focused page, then the brand alone. */
export function formatDocumentTitle({
  page,
  playing,
}: {
  page?: string | null;
  playing?: string | null;
}): string {
  if (playing) return `▶ ${playing} · ${BRAND}`;
  if (page) return `${page} · ${BRAND}`;
  return BRAND;
}

/** The focused screen's title. The claim object is its identity, so a late release can't
 * clear a newer screen's claim, even one with the same text. */
export const usePageTitleStore = create<{ claim: { title: string } | null }>()(() => ({
  claim: null,
}));

/**
 * Make `title` the page title until the returned release is called. Releasing only clears
 * the title while it is still this claim's: the next screen's focus can claim before the
 * last one's blur releases.
 */
export function claimPageTitle(title: string): () => void {
  const claim = { title };
  usePageTitleStore.setState({ claim });
  return () => {
    if (usePageTitleStore.getState().claim === claim) usePageTitleStore.setState({ claim: null });
  };
}
