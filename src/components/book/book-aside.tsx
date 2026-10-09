import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Book } from '@/api/types';
import type { MatchedBookMeta } from '@/components/library/book-meta';
import { BookVersions } from '@/components/library/book-versions';
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';
import { tabularNums } from '@/theme/tabular-nums';

import { BookAbout } from './book-about';
import type { ListeningFigures } from './book-page-model';

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
  return (
    <View testID="book-aside" className={cn('gap-4', className)}>
      <BookAbout book={book} meta={meta} />
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
    { key: 'smartSpeed', label: t('effects.bookSaved'), value: figures.smartSpeedSaved },
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
