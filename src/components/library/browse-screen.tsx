import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';

import { useBrowse, useLibraries } from '@/api/hooks';
import { EntryRow } from '@/components/library/entry-row';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
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

  const entries = listing?.entries ?? [];
  const folders = entries.filter((e) => e.is_dir);
  const audioFiles = entries.filter((e) => !e.is_dir);

  return (
    <ScrollView className="flex-1" contentContainerClassName="p-4 px-8">
      {crumbs.length > 1 ? <BreadCrumbs crumbs={crumbs} /> : null}

      {isLoading ? <Spinner center /> : null}
      {error ? <ErrorNote message="Could not open this folder." onRetry={() => refetch()} /> : null}

      {folders.length > 0 ? (
        <>
          <Text className="mb-2 mt-4 text-xl font-roboto-bold text-gray-700 dark:text-gray-100">Folders</Text>
          {folders.map((entry) => (
            <EntryRow key={entry.path} entry={entry} libraryId={libraryId} />
          ))}
        </>
      ) : null}

      {audioFiles.length > 0 ? (
        <>
          <Text className="mb-2 mt-4 text-xl font-roboto-bold text-gray-700 dark:text-gray-100">Files</Text>
          {audioFiles.map((entry) => (
            <EntryRow key={entry.path} entry={entry} libraryId={libraryId} />
          ))}
        </>
      ) : null}

      {!isLoading && !error && entries.length === 0 ? <EmptyNote message="This folder is empty." /> : null}
    </ScrollView>
  );
}
