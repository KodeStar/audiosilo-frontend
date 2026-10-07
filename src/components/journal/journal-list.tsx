import { ActivityIndicator } from 'react-native';

import { useMiniPlayerInset } from '@/components/player/mini-player';
import { cn } from '@/lib/utils';
import { useThemeColors } from '@/theme/use-theme-colors';

import type { Source } from './use-journal-sources';

/** The page column (the prototype's `page narrow`). */
export const JOURNAL_COLUMN = 'w-full max-w-[960px] self-center';

/** Ask each server on the merge's boundary for its next page (once at a time). */
export function fetchMoreOf(sources: readonly Source<unknown>[], fetchFrom: string[]) {
  for (const s of sources) {
    if (fetchFrom.includes(s.connectionId) && !s.isFetchingNextPage) s.fetchNextPage();
  }
}

/** The page's list frame: the header, the per-server notes, the column, the inset. */
export function useJournalListProps() {
  const paddingBottom = useMiniPlayerInset();
  return {
    className: 'flex-1',
    contentContainerClassName: cn(JOURNAL_COLUMN, 'px-4 pt-4 lg:px-8'),
    contentContainerStyle: { paddingBottom: paddingBottom + 24 },
    keyboardShouldPersistTaps: 'handled' as const,
    onEndReachedThreshold: 0.6,
  };
}

/** The spinner under a list while a server's next page loads. */
export function MoreSpinner({ visible }: { visible: boolean }) {
  const themed = useThemeColors();
  return visible ? <ActivityIndicator className="py-6" color={themed.mutedForeground} /> : null;
}
