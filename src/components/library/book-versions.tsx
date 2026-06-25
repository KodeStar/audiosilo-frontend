import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { useBookCopies, useSourceLabeller } from '@/api/hooks';
import type { Book } from '@/api/types';
import { Icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { formatBytes } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { useSession } from '@/stores/session';
import { colors } from '@/theme/tokens';

// Reuse the shared, locale-aware byte formatter (so a GB-sized copy reads "2 GB",
// not "2048 MB"); null drops the size hint from the `· `-joined quality line.
const mb = (n?: number) => (n && n > 0 ? formatBytes(n) : null);

/** A version picker for a book that exists in more than one place. Collapsed, it
 * shows where the shown copy lives (the current value); tapping reveals the other
 * copies across servers/libraries (with quality hints) to switch to. Hidden when
 * there's only one copy. Sits near the top of the book screen, under the breadcrumb. */
export function BookVersions({ book, connectionId }: { book: Book; connectionId: string | null }) {
  const { t } = useTranslation();
  const { copies, isLoading } = useBookCopies(book);
  const sourceOf = useSourceLabeller();
  const { openBook } = useOpen();
  const connections = useSession((s) => s.connections);
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

  const activeName = connections.find((c) => c.id === connectionId)?.name ?? '';
  const currentSource = sourceOf(connectionId ?? '', book.library_id, activeName) ?? activeName;

  return (
    <View className="gap-1">
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={t('library.versions.choose')}
        hitSlop={6}
        className="flex-row items-center gap-3 rounded-lg bg-gray-100 px-4 py-3 active:opacity-70 dark:bg-gray-840"
      >
        <Icon name="server" size={16} color={colors.primary} />
        <View className="flex-1">
          <Text variant="subtitle" numberOfLines={1}>
            {currentSource || t('library.versions.thisCopy')}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {t('library.versions.otherCount', { count: others.length })}
          </Text>
        </View>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} />
      </Pressable>

      {open
        ? others.map((c) => {
            const src = sourceOf(c.connectionId, c.libraryId, c.connectionName) ?? c.connectionName;
            const quality = [
              c.format?.toUpperCase(),
              c.multiFile ? t('library.versions.multiFile') : t('library.versions.singleFile'),
              mb(c.size),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <Pressable
                key={`${c.connectionId}:${c.libraryId}:${c.path}`}
                onPress={() => void openBook(c.connectionId, c.libraryId, c.path)}
                accessibilityRole="button"
                className="ml-3 flex-row items-center gap-3 rounded-lg bg-gray-50 p-3 active:opacity-80 dark:border dark:border-gray-860 dark:bg-gray-840"
              >
                <Icon name="chevron-right" size={14} color={colors.primary} />
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
              </Pressable>
            );
          })
        : null}
    </View>
  );
}
