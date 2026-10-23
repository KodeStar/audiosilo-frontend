import { useTranslation } from 'react-i18next';

import { CoverTile, useServerFlag } from '@/components/library/cover-tile';
import { libraryModeHref } from '@/components/library/library-modes';
import { ShelfRow } from '@/components/library/shelf-row';
import { episodeAsBook } from '@/components/podcasts/podcast-model';
import { formatRelative } from '@/lib/format';
import { openLibraryRoot } from '@/lib/open';
import { bookTitle } from '@/lib/paths';
import { useLibrarySelection } from '@/stores/library-selection';
import type { Connection } from '@/stores/session';

import { HomeSection } from './home-section';
import type { NewEpisode } from './new-episodes-model';
import { useNewEpisodes } from './use-new-episodes';

/**
 * Home's New episodes (Bridge Phase 2d-1): the latest episodes of the shows the
 * listener follows, newest first, without those already started or finished (`skip`,
 * content keys). A tile opens the episode page; its actions start it the normal way, so
 * an episode not on the server is fetched first. All shows opens the Library's Shows on
 * the first podcast library of the newest episode's server. Renders nothing while
 * there is none (and while loading: a rail that may never show keeps no skeleton).
 */
export function NewEpisodesRail({
  connections,
  skip,
  limit,
}: {
  connections: readonly Connection[];
  skip: ReadonlySet<string>;
  limit: number;
}) {
  const { t } = useTranslation();
  const serverLabel = useServerFlag();
  const { items, podcastLibraries } = useNewEpisodes(connections, skip, limit);
  if (items.length === 0) return null;
  const first = items[0];
  const allShows = () => {
    const libraryId = podcastLibraries.get(first.connectionId) ?? first.show.library_id;
    useLibrarySelection.getState().select({ connectionId: first.connectionId, libraryId });
    openLibraryRoot(libraryModeHref('shows'));
  };
  return (
    <HomeSection
      title={t('home.newEpisodes.title')}
      sub={t('home.newEpisodes.sub')}
      action={{ label: t('home.newEpisodes.allShows'), onPress: allShows }}
    >
      <ShelfRow
        data={items}
        keyExtractor={(e: NewEpisode) => e.key}
        accessibilityLabel={t('home.newEpisodes.title')}
        renderItem={({ connectionId, show, episode }, width) => {
          const when = formatRelative(episode.published ?? undefined);
          return (
            <CoverTile
              connectionId={connectionId}
              libraryId={show.library_id}
              path={episode.path}
              title={bookTitle(episode.title, episode.path)}
              book={episodeAsBook(episode, show)}
              author={show.author}
              caption={
                when ? t('home.newEpisodes.caption', { show: show.title, when }) : show.title
              }
              server={serverLabel(connectionId)}
              width={width}
            />
          );
        }}
      />
    </HomeSection>
  );
}
