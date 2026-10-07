// TEMPORARY: minimal stand-ins for agent B's `BookmarkRow` / `NoteRow` (same names and
// props), until `src/components/annotations/` is merged into this branch.
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book, Bookmark, Note } from '@/api/types';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Text } from '@/components/ui/text';
import { formatClock, formatRelative } from '@/lib/format';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { isDriftBookmark, labelText } from './annotations-bridge';

type RowProps = {
  connectionId: string;
  chapter?: string | null;
  book?: Book;
  onJump?: (position: number) => void;
  first?: boolean;
};

function Row({
  position,
  kicker,
  text,
  book,
  path,
  created,
  chapter,
  onJump,
  first,
}: {
  position: number;
  kicker?: string | null;
  text: string;
  book?: Book;
  path: string;
  created: string;
  chapter?: string | null;
  onJump?: (position: number) => void;
  first?: boolean;
}) {
  return (
    <View className={cn('gap-1 py-3', !first && 'border-t border-border')}>
      <View className="flex-row items-center gap-2">
        <AnimatedPressable accessibilityRole="button" onPress={() => onJump?.(position)}>
          <Text variant="mono" style={tabularNums}>
            {formatClock(position)}
          </Text>
        </AnimatedPressable>
        {kicker ? <Text variant="eyebrow">{kicker}</Text> : null}
      </View>
      <Text>{text}</Text>
      <Text variant="caption">
        {[bookTitle(book?.title, path), chapter, formatRelative(created)]
          .filter(Boolean)
          .join(' · ')}
      </Text>
    </View>
  );
}

export function BookmarkRow({ bookmark, ...rest }: RowProps & { bookmark: Bookmark }) {
  const { t } = useTranslation();
  const drift = isDriftBookmark(bookmark);
  return (
    <Row
      {...rest}
      position={bookmark.position}
      kicker={labelText(t, drift ? 'fell_asleep' : bookmark.label)}
      text={bookmark.note}
      path={bookmark.path}
      created={bookmark.created_at}
    />
  );
}

export function NoteRow({ note, ...rest }: RowProps & { note: Note }) {
  return (
    <Row
      {...rest}
      position={note.position}
      text={note.body}
      path={note.path}
      created={note.created_at}
    />
  );
}
