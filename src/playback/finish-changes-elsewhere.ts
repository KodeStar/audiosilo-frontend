import { invalidateFinishedProgress } from '@/api/hooks';
import { resolveConnectionId } from '@/lib/connection-id';
import { queryClient } from '@/api/provider';

import { onFinishChangedElsewhere } from './finish-delivery';

/** Read this tab's caches again when a sibling delivered or undid a finish. Only
 * the tab that changed the book sends the message. */
export function startFinishChangesElsewhere(): () => void {
  return onFinishChangedElsewhere((ref) =>
    invalidateFinishedProgress(
      queryClient,
      resolveConnectionId(ref.connectionId),
      ref.libraryId,
      ref.path,
    ),
  );
}
