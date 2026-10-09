import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, BookMetaSeriesWork, ChaptersResponse } from '@/api/types';
import {
  BookMetaCharactersTab,
  BookMetaRecapsTab,
  BookMetaSeriesTab,
  type MatchedBookMeta,
} from '@/components/library/book-meta';
import { BookmarksSection } from '@/components/library/bookmarks-section';
import { HistorySection } from '@/components/library/history-section';
import type { CommunityCoverFor } from '@/components/library/community-cover';
import type { ListeningProgress } from '@/components/library/meta-gating';
import { NotesSection } from '@/components/library/notes-section';
import type { SeriesRail } from '@/components/library/series-rails';
import { Attribution } from '@/components/player/companion/companion-pieces';
import { Skeleton } from '@/components/ui/skeleton';
import type { BookTab } from '@/lib/paths';
import { codecLabel } from '@/playback/transcode';

import { BookChaptersTab, type BookChaptersTabProps } from './book-chapters-tab';
import { fileRows, playbackMode } from './book-details-model';
import { BookDetailsTab } from './book-details-tab';

export type BookTabPanelProps = {
  tab: BookTab;
  libraryId: number;
  path: string;
  book: Book;
  chapterData?: ChaptersResponse;
  /** Room for the chapter rows' start times and the files table's columns. */
  roomy: boolean;
  /** The Chapters tab (its rows' skeleton while the list is still empty). */
  chapters: Omit<BookChaptersTabProps, 'roomy'>;
  /** The community tabs: the matched work, the spoiler gate (one position on the real
   * chapters) and the page's shared reveal, the series rails and the previous books. */
  community: {
    meta?: MatchedBookMeta;
    gate: ListeningProgress;
    summaryVisible: boolean;
    showSpoilers: boolean;
    onToggleSpoilers: () => void;
    rails: SeriesRail[];
    previousBooks: BookMetaSeriesWork[];
    onSelectView: (family: string, viewId: string) => void;
    /** Where the rails' and previous books' covers load from (`useCommunityCover`). */
    coverFor: CommunityCoverFor;
  };
  /** The Details tab: how this device plays the book, and where it lives. */
  details: { downloaded: boolean; transcoded: boolean; serverName: string; libraryName: string };
};

/** The book page's active tab panel (the tab row is the page's). */
export function BookTabPanel({
  tab,
  libraryId,
  path,
  book,
  chapterData,
  roomy,
  chapters,
  community,
  details,
}: BookTabPanelProps) {
  const { t } = useTranslation();
  const work = community.meta?.work;
  switch (tab) {
    case 'chapters':
      if (chapters.list.rows.length === 0) {
        return (
          <View className="gap-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-control" />
            ))}
          </View>
        );
      }
      return <BookChaptersTab {...chapters} roomy={roomy} />;
    case 'recaps': {
      const recaps = work?.recaps ?? [];
      return (
        <View className="gap-4">
          <BookMetaRecapsTab
            recaps={recaps}
            progress={community.gate}
            summary={work?.recap_summary}
            summaryVisible={community.summaryVisible}
            showSpoilers={community.showSpoilers}
            onToggleSpoilers={community.onToggleSpoilers}
            previousBooks={community.previousBooks}
            coverFor={community.coverFor}
          />
          {recaps.length > 0 || community.summaryVisible ? (
            <Attribution attribution={work?.attribution} />
          ) : null}
        </View>
      );
    }
    case 'characters': {
      const characters = work?.characters ?? [];
      return (
        <View className="gap-4">
          <BookMetaCharactersTab
            characters={characters}
            progress={community.gate}
            showSpoilers={community.showSpoilers}
            onToggleSpoilers={community.onToggleSpoilers}
            previousBooks={community.previousBooks}
            coverFor={community.coverFor}
          />
          {characters.length > 0 ? <Attribution attribution={work?.attribution} /> : null}
        </View>
      );
    }
    case 'bookmarks':
      return <BookmarksSection libraryId={libraryId} path={path} />;
    case 'history':
      return (
        <HistorySection libraryId={libraryId} path={path} emptyLabel={t('player.history.empty')} />
      );
    case 'notes':
      return <NotesSection libraryId={libraryId} path={path} />;
    case 'series':
      return (
        <BookMetaSeriesTab
          rails={community.rails}
          onSelectView={community.onSelectView}
          coverFor={community.coverFor}
        />
      );
    case 'details':
      return (
        <BookDetailsTab
          mode={playbackMode(details)}
          codec={codecLabel(chapterData?.codec || book.codec)}
          serverName={details.serverName}
          libraryName={details.libraryName}
          path={book.rel_path}
          files={fileRows(book, chapterData)}
          roomy={roomy}
        />
      );
  }
}
