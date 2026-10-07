import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { Book } from '@/api/types';
import { BookCover } from '@/components/library/book-cover';
import { pillClass, slopTo44 } from '@/components/player/control-pill';
import { AnimatedPressable } from '@/components/ui/animated-pressable';
import { Icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { bookTitle } from '@/lib/paths';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

/** A row action's size in rem (`h-9 w-9`), for its 44 pt slop. */
const ACTION_REM = 2.25;

/** A row's icon action (edit, delete), named for what it acts on ("Delete bookmark at
 * 17:26:50"), with a 44 pt touch on native. Always a quiet muted glyph, delete too (as the
 * prototype): a list must not be a column of red; the destructive colour belongs inside
 * a confirmation, and a row's delete offers Undo instead. */
export function RowAction({
  icon,
  label,
  onPress,
  testID,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  const themed = useThemeColors();
  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={slopTo44(ACTION_REM)}
      testID={testID}
      className={pillClass('ghost', 'h-9 w-9')}
    >
      <Icon name={icon} size={15} color={themed.mutedForeground} />
    </AnimatedPressable>
  );
}

/** The book a row across books belongs to: its cover, opening its page. */
export function RowCover({
  connectionId,
  book,
  onOpen,
}: {
  connectionId: string;
  book: Book;
  onOpen: () => void;
}) {
  const title = bookTitle(book.title, book.rel_path);
  return (
    <AnimatedPressable accessibilityRole="link" accessibilityLabel={title} onPress={onOpen}>
      <BookCover
        connectionId={connectionId}
        libraryId={book.library_id}
        path={book.rel_path}
        coverVersion={book.cover_version}
        width={40}
        title={title}
        author={book.author}
      />
    </AnimatedPressable>
  );
}

/**
 * The shared shape of a bookmark or note row (STYLEGUIDE section 8, "Bookmark"; the
 * prototype's book page tabs and Journal): a hairline above every row but the first, the
 * lead (a time chip, or a cover across books), the body, then the actions.
 */
export function AnnotationRowFrame({
  lead,
  children,
  actions,
  first,
  testID,
}: {
  lead: ReactNode;
  children: ReactNode;
  actions: ReactNode;
  first?: boolean;
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      className={cn('flex-row items-start gap-3 py-3.5', !first && 'border-t border-border')}
    >
      {lead}
      <View className="min-w-0 flex-1 gap-1">{children}</View>
      <View className="-my-1 flex-row items-center">{actions}</View>
    </View>
  );
}

/** A row's meta line: "Chapter · title · 3 days ago", whichever parts it has, and the
 * server it is on (`server`, a list across servers only: the Diary's server flag look, a
 * server glyph and the name in `info`). */
export function RowMeta({
  parts,
  server,
}: {
  parts: (string | null | undefined)[];
  server?: string;
}) {
  const themed = useThemeColors();
  const text = parts.filter((p): p is string => !!p).join(' · ');
  if (!text && !server) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-x-2 gap-y-0.5">
      {text ? (
        <Text variant="caption" className="shrink text-subtle-foreground" numberOfLines={1}>
          {text}
        </Text>
      ) : null}
      {server ? (
        <View className="shrink flex-row items-center gap-1" testID="row-server">
          <Icon name="server" size={11} color={themed.info} />
          <Text variant="caption" className="text-info" numberOfLines={1}>
            {server}
          </Text>
        </View>
      ) : null}
    </View>
  );
}
