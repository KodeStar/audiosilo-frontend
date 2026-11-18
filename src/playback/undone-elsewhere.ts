import { invalidateFinishedProgress } from '@/api/hooks';
import { queryClient } from '@/api/provider';

import { onFinishUndoneElsewhere } from './progress-sync';

/**
 * Web: a finish another tab undid (its Undo, or Mark as not finished) is read again here, so
 * this tab's pages stop showing the book finished ("Listen again") without a click. The
 * other tab's Undo reaches this one on a tab channel (`onFinishUndoneElsewhere`). Started
 * with the root's services; returns the stop.
 */
export function startUndoneElsewhere(): () => void {
  return onFinishUndoneElsewhere((ref) =>
    invalidateFinishedProgress(queryClient, ref.connectionId, ref.libraryId, ref.path),
  );
}
