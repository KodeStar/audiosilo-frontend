import { useNarrators } from '@/api/hooks';
import { PeopleMode } from '@/components/series/people-mode';

import type { LibraryModeProps } from '../library-modes';

/** The Library tab's Narrators mode for the selected library (`PeopleMode`). */
export function NarratorsMode({ connectionId, libraryId }: LibraryModeProps) {
  const list = useNarrators(libraryId, connectionId);
  return (
    <PeopleMode kind="narrator" connectionId={connectionId} libraryId={libraryId} list={list} />
  );
}
