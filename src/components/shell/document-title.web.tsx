import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { destination, useActiveTab } from '@/components/shell/destinations';
import { formatDocumentTitle, usePageTitleStore } from '@/lib/document-title';
import { bookTitle } from '@/lib/paths';
import { selectIsTransportLive, usePlayer } from '@/playback/store';

/**
 * The browser tab's title (see `@/lib/document-title`): the book playing, else the
 * focused page's own title, else the active tab's name. Renders nothing; mounted once at
 * the root so it covers the root modals (the full player) too. Reads only the playing
 * book and the play state, never the position, so it doesn't re-render on every tick.
 */
export function DocumentTitle() {
  const { t } = useTranslation();
  const page = usePageTitleStore((s) => s.claim?.title);
  const tab = useActiveTab();
  const live = usePlayer(selectIsTransportLive);
  const nowPlaying = usePlayer((s) => s.nowPlaying);
  const title = formatDocumentTitle({
    page: page ?? (tab ? t(destination(tab).titleKey) : null),
    playing: live && nowPlaying ? bookTitle(nowPlaying.title, nowPlaying.path) : null,
  });
  useEffect(() => {
    document.title = title;
  }, [title]);
  return null;
}
