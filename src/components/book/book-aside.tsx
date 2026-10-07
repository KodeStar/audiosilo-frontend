import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book } from '@/api/types';
import { BookMetaAbout, type MatchedBookMeta } from '@/components/library/book-meta';
import { BookVersions } from '@/components/library/book-versions';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

/** Your listening's figures, already in words; a figure the page doesn't know honestly
 * is absent (never made up). */
export type ListeningFigures = {
  started?: string;
  finished?: string;
  speed?: string;
  listened?: string;
};

/**
 * The book page's aside (the prototype's right column; between the hero and the tabs on
 * a narrow page): About, Other versions (only when there are), and Your listening (once
 * the book is started).
 */
export function BookAside({
  book,
  connectionId,
  meta,
  listening,
  className,
}: {
  book: Book;
  connectionId: string;
  meta?: MatchedBookMeta;
  listening: ListeningFigures | null;
  className?: string;
}) {
  const { t } = useTranslation();
  // An undescribed book still reads complete: who wrote and reads it.
  const fallback =
    book.author && book.narrator
      ? t('book.about.fallbackBoth', {
          title: book.title,
          author: book.author,
          narrator: book.narrator,
        })
      : book.author
        ? t('book.about.fallbackAuthor', { title: book.title, author: book.author })
        : t('book.about.none');
  return (
    <View testID="book-aside" className={cn('gap-4', className)}>
      <Card>
        <BookMetaAbout
          meta={meta}
          description={book.description}
          published={book.published}
          fallback={fallback}
        />
      </Card>
      <BookVersions book={book} connectionId={connectionId} />
      {listening ? <YourListening figures={listening} /> : null}
    </View>
  );
}

function YourListening({ figures }: { figures: ListeningFigures }) {
  const { t } = useTranslation();
  const rows = [
    { key: 'listened', label: t('book.listening.listened'), value: figures.listened },
    { key: 'speed', label: t('book.listening.speed'), value: figures.speed },
    { key: 'started', label: t('book.listening.started'), value: figures.started },
    { key: 'finished', label: t('book.listening.finished'), value: figures.finished },
  ].filter((r): r is { key: string; label: string; value: string } => !!r.value);
  if (rows.length === 0) return null;
  return (
    <Card testID="book-listening" className="gap-3">
      <Text variant="eyebrow">{t('book.listening.title')}</Text>
      <View className="flex-row flex-wrap gap-y-3">
        {rows.map((r) => (
          <View key={r.key} className="w-1/2 gap-0.5 pr-2">
            <Text variant="caption">{r.label}</Text>
            <Text
              className="font-display text-lg tracking-tight text-foreground"
              style={tabularNums}
            >
              {r.value}
            </Text>
          </View>
        ))}
      </View>
    </Card>
  );
}
