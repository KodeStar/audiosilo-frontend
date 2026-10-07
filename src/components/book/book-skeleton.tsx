import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';
import { CONTENT_WIDTH } from '@/lib/layout';
import { cn } from '@/lib/utils';

import type { BookPageLayout } from './book-page-model';

/** The book page while its item loads, shaped like the page at this layout (the hero's
 * cover beside or above its lines, the action row, the tab row and rows, the aside's
 * cards on a wide page), so nothing shifts when it lands. No spinner. */
export function BookSkeleton({ layout }: { layout: BookPageLayout }) {
  const { t } = useTranslation();
  const side = layout.heroSide;
  return (
    <View
      testID="book-skeleton"
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={t('book.page.loading')}
    >
      <View className="border-b border-border">
        <View
          className={cn(
            CONTENT_WIDTH,
            'self-center',
            side ? 'flex-row items-end gap-8 px-6 pb-8 pt-10 lg:px-8' : 'gap-5 px-4 pb-6 pt-3',
          )}
        >
          <View
            className={side ? undefined : 'self-center'}
            style={{ width: layout.cover, height: layout.cover }}
          >
            <Skeleton className="h-full w-full rounded-cover" />
          </View>
          <View className="min-w-0 flex-1 gap-3">
            <Skeleton className="h-3 w-40 rounded-sm" />
            <Skeleton className={cn('w-3/4 rounded-md', side ? 'h-11' : 'h-8')} />
            <Skeleton className="h-4 w-1/2 rounded-sm" />
            <Skeleton className="h-3.5 w-2/3 rounded-sm" />
            <View className="mt-3 flex-row gap-2">
              <Skeleton className="h-[46px] w-44 rounded-xl" />
              <Skeleton className="h-[46px] w-40 rounded-xl" />
            </View>
          </View>
        </View>
      </View>
      <View
        className={cn(
          CONTENT_WIDTH,
          'self-center pt-6',
          side ? 'px-6 lg:px-8' : 'px-4',
          layout.columns === 2 && 'flex-row items-start gap-10',
        )}
      >
        <View className="min-w-0 flex-1 gap-3">
          <Skeleton className="h-[42px] w-full rounded-md" />
          <Skeleton className="h-36 w-full rounded-card" />
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full rounded-control" />
          ))}
        </View>
        {layout.columns === 2 ? (
          <View className="gap-4" style={{ width: layout.aside }}>
            <Skeleton className="h-64 w-full rounded-card" />
            <Skeleton className="h-36 w-full rounded-card" />
          </View>
        ) : null}
      </View>
    </View>
  );
}
