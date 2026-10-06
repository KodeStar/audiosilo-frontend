import { View } from 'react-native';

import { RowSurface } from '@/components/ui/row-surface';
import { Skeleton } from '@/components/ui/skeleton';

/** A loading placeholder shaped like a BookRow: a small cover square and two
 * text lines. Shown while a search is in flight so the list mirrors its layout. */
export function BookRowSkeleton() {
  return (
    <RowSurface className="flex-row items-center gap-3 p-2">
      <Skeleton className="h-16 w-16 rounded-lg" />
      <View className="flex-1 gap-2">
        <Skeleton className="h-3.5 w-1/2 rounded-sm" />
        <Skeleton className="h-3 w-1/3 rounded-sm" />
      </View>
    </RowSurface>
  );
}

/** A stack of row skeletons for a loading results list. */
export function BookRowSkeletonList({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <BookRowSkeleton key={i} />
      ))}
    </>
  );
}
