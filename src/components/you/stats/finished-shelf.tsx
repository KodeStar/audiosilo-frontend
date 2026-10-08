import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';

import type { StatsFinishedBook } from '@/api/types';
import { Plank } from '@/components/series/bookcase';
import { Spine } from '@/components/series/spine';
import { spineDims } from '@/components/series/spine-fit';
import { HORIZONTAL_SCROLLER } from '@/components/ui/horizontal-scroller';
import { formatRecordDate } from '@/lib/format';
import { bookTitle } from '@/lib/paths';

/** The year shelf's spines against the series page's full size. */
const SCALE = 0.68;

/**
 * Finished this year as a shelf of spines (STYLEGUIDE: "a finished year is a stack"),
 * oldest first so the shelf fills up through the year, on the series bookcase's plank.
 * The stats carry no listening length or cover colour, so every spine is the standard
 * width in its title's cloth colour. Each spine opens its book.
 */
export function FinishedShelf({
  books,
  onOpen,
}: {
  /** Newest first, as the server sends them. */
  books: readonly StatsFinishedBook[];
  onOpen: (book: StatsFinishedBook) => void;
}) {
  const { t } = useTranslation();
  const now = new Date();
  const oldestFirst = [...books].reverse();
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={HORIZONTAL_SCROLLER}
        contentContainerClassName="items-end gap-0.5 px-3 pt-5"
      >
        {oldestFirst.map((b) => {
          const title = bookTitle(b.title, b.path);
          const { width, height } = spineDims(undefined, title, SCALE);
          const at = new Date(b.finished_at);
          return (
            <Spine
              key={`${b.library_id}:${b.path}`}
              title={title}
              author={b.author}
              width={width}
              height={height}
              scale={SCALE}
              variant="book"
              onPress={() => onOpen(b)}
              accessibilityLabel={t('stats.finished.spineLabel', {
                title,
                author: b.author,
                date: Number.isNaN(at.getTime()) ? '' : formatRecordDate(at, now),
              })}
            />
          );
        })}
      </ScrollView>
      <Plank className="mx-0" />
    </View>
  );
}
