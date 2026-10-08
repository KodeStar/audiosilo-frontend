import { BookCover, coverSizeFor, MAX_COVER_SIZE } from '@/components/library/book-cover';

import { CARD_DESIGN_WIDTH } from './card-size';
import { PlainCover, type StoryCoverProps } from './plain-cover';
import { SHARE_WIDTH } from './share-types';

/** How much larger than the card on screen a shared card is drawn. */
const SHARE_SCALE = SHARE_WIDTH / CARD_DESIGN_WIDTH;

/**
 * A book's cover on a story card: the app's `BookCover` (on the web a plain `?token=`
 * URL, which a share's rasteriser can inline), its thumbnail sized for the 1080-wide share
 * image so a shared cover stays sharp (the largest thumbnail past that, never the full
 * art); `plain` draws the title on cloth (a share's second try).
 */
export function StoryCoverArt({ connectionId, book, width, plain }: StoryCoverProps) {
  if (plain) return <PlainCover book={book} width={width} />;
  return (
    <BookCover
      connectionId={connectionId}
      libraryId={book.library_id}
      path={book.path}
      width={width}
      title={book.title}
      author={book.author}
      shadow={width > 100 ? 'lg' : 'xs'}
      thumbnail={coverSizeFor(width, SHARE_SCALE) ?? MAX_COVER_SIZE}
    />
  );
}
