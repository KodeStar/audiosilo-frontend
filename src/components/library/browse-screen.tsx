import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';

import { useBrowse, useLibraries } from '@/api/hooks';
import { EntryRow } from '@/components/library/entry-row';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { libraryHref, segmentsToPath } from '@/lib/paths';

/**
 * Filesystem browse view, shared by the library root (`index.tsx`) and the
 * nested catch-all (`[...path].tsx`). The optional `path` param is absent at the
 * root and a segment array once the user drills into folders.
 */
export function BrowseScreen() {
  const { libraryId: libraryIdParam, path: pathParam } = useLocalSearchParams<{
    libraryId: string;
    path?: string | string[];
  }>();
  const libraryId = Number(libraryIdParam);
  const path = segmentsToPath(pathParam);

  const { data: libraries } = useLibraries();
  const { data: listing, isLoading, error, refetch } = useBrowse(libraryId, path);

  const libraryName = libraries?.find((l) => l.id === libraryId)?.name ?? 'Library';
  const segments = path ? path.split('/') : [];
  const crumbs: Crumb[] = [
    {
      label: libraryName,
      active: segments.length === 0,
      onPress: segments.length === 0 ? undefined : () => router.push(libraryHref(libraryId)),
    },
    ...segments.map((seg, i) => {
      const isLast = i === segments.length - 1;
      const sub = segments.slice(0, i + 1).join('/');
      return {
        label: seg,
        active: isLast,
        onPress: isLast ? undefined : () => router.push(libraryHref(libraryId, sub)),
      } satisfies Crumb;
    }),
  ];

  return (
    <ScrollView className="flex-1" contentContainerClassName="gap-2 p-4">
      <BreadCrumbs crumbs={crumbs} />

      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not open this folder." onRetry={() => refetch()} /> : null}

      {listing?.entries.map((entry) => (
        <EntryRow key={entry.path} entry={entry} libraryId={libraryId} />
      ))}

      {listing && listing.entries.length === 0 ? (
        <EmptyNote message="This folder is empty." />
      ) : null}
    </ScrollView>
  );
}
