import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  View,
} from 'react-native';

import { useBrowse, useLibraries } from '@/api/hooks';
import { EntryRow } from '@/components/library/entry-row';
import { useMiniPlayerInset } from '@/components/player/mini-player';
import { BreadCrumbs, type Crumb } from '@/components/ui/breadcrumbs';
import { Icon } from '@/components/ui/icon';
import { EmptyNote, ErrorNote } from '@/components/ui/query-state';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { libraryHref, segmentsToPath } from '@/lib/paths';
import { recallScroll, rememberScroll, scrollKey } from '@/lib/scroll-memory';
import { colors } from '@/theme/tokens';

// Reveal the back-to-top button once the user is roughly a screenful down.
const BACK_TO_TOP_THRESHOLD = 600;

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
  const paddingBottom = useMiniPlayerInset();

  // This screen unmounts on every navigation (see scroll-memory), so we restore
  // the last scroll offset ourselves rather than relying on the navigator.
  const scrollRef = useRef<ScrollView>(null);
  const restoredRef = useRef(false);
  const [showTop, setShowTop] = useState(false);
  const key = scrollKey(libraryId, path);

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

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    rememberScroll(key, y);
    const shouldShow = y > BACK_TO_TOP_THRESHOLD;
    if (shouldShow !== showTop) setShowTop(shouldShow);
  };

  // Re-apply the saved offset once the list has rendered tall enough to hold it.
  // Fires again as content grows (loading → loaded), so it lands on the final
  // height; the guard keeps it to a single restore per mount.
  const onContentSizeChange = (_w: number, height: number) => {
    if (restoredRef.current) return;
    const saved = recallScroll(key);
    if (saved > 0 && height > 0) {
      scrollRef.current?.scrollTo({ y: saved, animated: false });
    }
    if (!isLoading && entries.length > 0) restoredRef.current = true;
  };

  return (
    <View className="flex-1">
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="p-4 lg:px-8"
        contentContainerStyle={{ paddingBottom }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onContentSizeChange={onContentSizeChange}
      >
        {crumbs.length > 1 ? <BreadCrumbs crumbs={crumbs} /> : null}

        {isLoading ? <Spinner center /> : null}
        {error ? (
          <ErrorNote message="Could not open this folder." onRetry={() => refetch()} />
        ) : null}

        {folders.length > 0 ? (
          <>
            <Text className="mb-2 mt-4 text-xl font-roboto-bold text-gray-700 dark:text-gray-100">
              Folders
            </Text>
            {folders.map((entry) => (
              <EntryRow key={entry.path} entry={entry} libraryId={libraryId} />
            ))}
          </>
        ) : null}

        {audioFiles.length > 0 ? (
          <>
            <Text className="mb-2 mt-4 text-xl font-roboto-bold text-gray-700 dark:text-gray-100">
              Files
            </Text>
            {audioFiles.map((entry) => (
              <EntryRow key={entry.path} entry={entry} libraryId={libraryId} />
            ))}
          </>
        ) : null}

        {!isLoading && !error && entries.length === 0 ? (
          <EmptyNote message="This folder is empty." />
        ) : null}
      </ScrollView>

      {showTop ? (
        <Pressable
          onPress={() => {
            // Instant — a slow animated scroll is easy to out-scroll by hand.
            scrollRef.current?.scrollTo({ y: 0, animated: false });
            rememberScroll(key, 0);
            setShowTop(false);
          }}
          accessibilityRole="button"
          accessibilityLabel="Back to top"
          className="absolute bottom-6 right-6 h-12 w-12 items-center justify-center rounded-full bg-primary shadow-lg active:opacity-80"
        >
          <Icon name="chevron-up" size={22} color={colors.white} />
        </Pressable>
      ) : null}
    </View>
  );
}
