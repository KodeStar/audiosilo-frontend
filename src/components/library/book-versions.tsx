import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useBookCopies, useSourceLabeller } from '@/api/hooks';
import type { Book } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { useOpen } from '@/lib/open';
import { colors } from '@/theme/tokens';

const mb = (n?: number) => (n && n > 0 ? `${Math.round(n / 1048576)} MB` : null);

/** Lists the book's other copies across servers/libraries (a collapsible
 * section), so the user can switch to a different version — e.g. a higher-quality
 * single-file copy. Renders nothing when there's only the one copy. */
export function BookVersions({ book, connectionId }: { book: Book; connectionId: string | null }) {
  const { copies, isLoading } = useBookCopies(book);
  const sourceOf = useSourceLabeller();
  const { openBook } = useOpen();
  const [open, setOpen] = useState(false);

  const others = copies.filter(
    (c) =>
      !(
        c.connectionId === connectionId &&
        c.libraryId === book.library_id &&
        c.path === book.rel_path
      ),
  );
  if (isLoading || others.length === 0) return null;

  return (
    <View className="gap-2">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        className="flex-row items-center justify-between active:opacity-70"
      >
        <Text variant="label">Other versions ({others.length})</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16} />
      </Pressable>
      {open
        ? others.map((c) => {
            const src = sourceOf(c.connectionId, c.libraryId, c.connectionName) ?? c.connectionName;
            const quality = [
              c.format?.toUpperCase(),
              c.multiFile ? 'multi-file' : 'single file',
              mb(c.size),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <Pressable
                key={`${c.connectionId}:${c.libraryId}:${c.path}`}
                onPress={() => void openBook(c.connectionId, c.libraryId, c.path)}
                accessibilityRole="button"
                className="flex-row items-center gap-3 rounded-lg bg-gray-50 p-3 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
              >
                <Icon name="server" size={16} color={colors.primary} />
                <View className="flex-1">
                  <Text variant="subtitle" numberOfLines={1}>
                    {src}
                  </Text>
                  {quality ? (
                    <Text variant="caption" numberOfLines={1}>
                      {quality}
                    </Text>
                  ) : null}
                </View>
                <Icon name="chevron-right" size={14} />
              </Pressable>
            );
          })
        : null}
    </View>
  );
}
