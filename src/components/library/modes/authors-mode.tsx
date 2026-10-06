import { useAuthors } from '@/api/hooks';
import { PeopleMode } from '@/components/series/people-mode';

import type { LibraryModeProps } from '../library-modes';

/** The Library tab's Authors mode for the selected library (`PeopleMode`). */
export function AuthorsMode({ connectionId, libraryId }: LibraryModeProps) {
  const list = useAuthors(libraryId, connectionId);
  return <PeopleMode kind="author" connectionId={connectionId} libraryId={libraryId} list={list} />;
}
