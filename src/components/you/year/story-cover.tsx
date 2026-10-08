import { BookCover } from '@/components/library/book-cover';

import { PlainCover, type StoryCoverProps } from './plain-cover';

/** A book's cover on a story card (iOS and Android: the app's `BookCover`, which a
 * react-native-view-shot capture draws like any other view). The web has its own
 * (`story-cover.web.tsx`). */
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
    />
  );
}
