import { View } from 'react-native';

import { Cover } from '@/components/ui/cover';

import type { StoryCover } from './year-model';

/** What a story card's cover takes (`story-cover.tsx`, `story-cover.web.tsx`). */
export type StoryCoverProps = {
  connectionId: string;
  book: StoryCover;
  width: number;
  /** Draw the title on cloth instead of the art: the second try of a share whose capture
   * could not read an image. */
  plain: boolean;
};

/** The title (and author) on the title's cloth colour, no art. */
export function PlainCover({ book, width }: Pick<StoryCoverProps, 'book' | 'width'>) {
  return (
    <View style={{ width, height: width }} className="overflow-hidden rounded-cover">
      <Cover source={null} label={book.title} sublabel={book.author} size={width} rounded="" />
    </View>
  );
}
