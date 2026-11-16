import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useBookCopies, useSourceLabeller } from '@/api/hooks';
import type { Book } from '@/api/types';
import { Card } from '@/components/ui/card';
import { Icon } from '@/components/ui/icon';
import { InsetRow } from '@/components/ui/row-surface';
import { Text } from '@/components/ui/text';
import { formatBytes } from '@/lib/format';
import { useOpen } from '@/lib/open';
import { useThemeColors } from '@/theme/use-theme-colors';

// Reuse the shared, locale-aware byte formatter (so a GB-sized copy reads "2 GB",
// not "2048 MB"); null drops the size hint from the `· `-joined quality line.
const mb = (n?: number) => (n && n > 0 ? formatBytes(n) : null);

/** The book page's "Other versions" card (the prototype's aside): every other copy of
 * the book across servers and libraries, each naming where it lives and its quality
 * (format, one file or several, size), opening that copy's page. Nothing when the book
 * has no other copy (or while the copies are still being looked for). */
export function BookVersions({ book, connectionId }: { book: Book; connectionId: string | null }) {
  const themed = useThemeColors();
  const { t } = useTranslation();
  const { copies, isLoading } = useBookCopies(book);
  const sourceOf = useSourceLabeller();
  const { openBook } = useOpen();

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
    <Card testID="book-versions" className="gap-2.5">
      <Text variant="eyebrow">{t('book.versions.title')}</Text>
      <View accessibilityRole="list" className="-mx-2">
        {others.map((c) => {
          const src = sourceOf(c.connectionId, c.libraryId, c.connectionName) ?? c.connectionName;
          const quality = [
            c.format?.toUpperCase(),
            c.multiFile ? t('library.versions.multiFile') : t('library.versions.singleFile'),
            mb(c.size),
          ]
            .filter(Boolean)
            .join(' · ');
          return (
            <InsetRow
              key={`${c.connectionId}:${c.libraryId}:${c.path}`}
              onPress={() => void openBook(c.connectionId, c.libraryId, c.path)}
              accessibilityLabel={[src, quality].filter(Boolean).join(', ')}
            >
              <Icon name="server" size={16} color={themed.mutedForeground} />
              <View className="min-w-0 flex-1">
                <Text variant="label" numberOfLines={1}>
                  {src}
                </Text>
                {quality ? (
                  <Text variant="caption" numberOfLines={1}>
                    {quality}
                  </Text>
                ) : null}
              </View>
            </InsetRow>
          );
        })}
      </View>
    </Card>
  );
}
