import type { FlashListRef } from '@shopify/flash-list';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Book } from '@/api/types';
import type { PlayTarget } from '@/components/player/play-route';
import { startBookInPlace } from '@/components/player/start-book';
import { openProfiles } from '@/components/profiles/use-choose-profile';
import { Screen } from '@/components/ui/screen';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';
import { contentKey } from '@/lib/content-key';
import { cn } from '@/lib/utils';
import { selectBookKey, selectIsTransportLive, usePlayer } from '@/playback/store';
import { DEFAULT_BEDTIME } from '@/stores/profiles';

import { GrownUpsButton } from './grown-ups-button';
import { KidsPlayer } from './kids-player';
import { KidsStoriesList } from './kids-stories';
import { MoonCard } from './moon-card';
import { useKidsProfile, useKidsStories } from './use-kids';

/** "Who's listening?" (`src/app/profiles.tsx`, workstream D): where leaving kids mode
 * goes, and where the chosen profile's PIN is asked. */

/** The widest the page's content gets. */
const MAX_WIDTH = 1200;

/**
 * Play a story. Kids mode is its own player: a story starts in place
 * (`startBookInPlace`) on every layout and never opens the full player, which kids mode
 * doesn't allow; the story already loaded plays on (a tap never pauses it: the big play
 * button does that). Rejects when the story couldn't be fetched.
 */
async function playStory(target: PlayTarget): Promise<void> {
  const store = usePlayer.getState();
  if (selectBookKey(store) === contentKey(target.connectionId, target.libraryId, target.path)) {
    if (!selectIsTransportLive(store)) await store.toggle();
    return;
  }
  await startBookInPlace(target);
}

/**
 * Kids mode (Phase 8, the route `/kids`, STYLEGUIDE "Profile picker and kids mode"): the
 * whole app for a profile in kids mode. "Hi Leo" and the Grown-ups hold, the bedtime card,
 * the story playing now in a big simple player (`KidsPlayer`, which replaces the full
 * player here), and the profile's one library as big cover tiles, continue-listening
 * first: the whole page is one virtualised list (`KidsStoriesList`, this page's header on
 * top), paging through the library as it scrolls. No search, settings, downloads page or
 * Up next: the gate and `KidsRouteGuard` keep a kids profile here.
 *
 * A story starts in place (`playStory`), and the page scrolls back up to the player. On
 * Android the back button does nothing here while the shell sits under this screen (going
 * back would only bounce off the gate); with nothing under it, it leaves the app as usual.
 */
export function KidsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const phone = layout === 'phone';
  const reduced = useReducedMotion();
  const profile = useKidsProfile();
  const { stories, connectionId, retry, loadMore } = useKidsStories();
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const list = useRef<FlashListRef<Book[]>>(null);
  const [outer, setOuter] = useState(0);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => router.canGoBack());
      return () => sub.remove();
    }, []),
  );

  // Stable, so a story tile (memoised) redraws only when its own props change.
  const onPlay = useCallback(
    (book: Book) => {
      if (!connectionId) return;
      list.current?.scrollToOffset({ offset: 0, animated: !reduced });
      playStory({ connectionId, libraryId: book.library_id, path: book.rel_path }).catch(() => {
        toast({ title: t('kids.startFailed.title'), description: t('kids.startFailed.body') });
      });
    },
    [connectionId, reduced, t],
  );

  // The content column: the page less its insets and gutters, at most MAX_WIDTH wide,
  // centred by padding the sides (the list's rows are laid out to its width).
  const side = phone ? 16 : 36;
  const room = Math.max(0, outer - insets.left - insets.right - 2 * side);
  const width = outer > 0 ? Math.min(MAX_WIDTH, room) : 0;
  const centring = (room - width) / 2;

  const name = profile?.name.trim() ?? '';
  const header = (
    <View>
      <View className="flex-row flex-wrap items-center justify-between gap-3">
        <Text
          accessibilityRole="header"
          className={cn(
            'shrink font-display tracking-tight text-foreground',
            phone ? 'text-3xl' : 'text-5xl',
          )}
        >
          {name ? t('kids.greeting', { name }) : t('kids.greetingNoName')}
        </Text>
        <GrownUpsButton onExit={openProfiles} />
      </View>
      <View className="mt-5">
        <MoonCard bedtime={profile?.kids?.bedtime ?? DEFAULT_BEDTIME} />
      </View>
      {loaded ? (
        <View className={phone ? 'mt-7' : 'mt-10'}>
          <KidsPlayer width={width} />
        </View>
      ) : null}
      <Text
        accessibilityRole="header"
        className={cn(
          'mb-4 font-display tracking-tight text-foreground',
          phone ? 'mt-9 text-2xl' : 'mt-12 text-3xl',
        )}
      >
        {t('kids.stories.title')}
      </Text>
    </View>
  );
  return (
    <Screen testID="kids-screen">
      <View
        testID="kids-page"
        className="flex-1"
        onLayout={(e) => setOuter(Math.round(e.nativeEvent.layout.width))}
      >
        <KidsStoriesList
          listRef={list}
          stories={stories}
          connectionId={connectionId}
          width={width}
          layout={layout}
          header={header}
          onPlay={onPlay}
          onRetry={retry}
          onEndReached={loadMore}
          contentContainerStyle={{
            paddingTop: insets.top + (phone ? 16 : 28),
            paddingBottom: insets.bottom + 40,
            paddingLeft: insets.left + side + centring,
            paddingRight: insets.right + side + centring,
          }}
        />
      </View>
    </Screen>
  );
}
