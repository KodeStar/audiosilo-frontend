import { type Href, router, useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, ScrollView, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { Book } from '@/api/types';
import { usePlayBook } from '@/components/player/use-play-book';
import { Screen } from '@/components/ui/screen';
import { Text } from '@/components/ui/text';
import { toast } from '@/components/ui/toast';
import { useLayout } from '@/lib/layout';
import { cn } from '@/lib/utils';
import { usePlayer } from '@/playback/store';
import { DEFAULT_BEDTIME } from '@/stores/profiles';

import { GrownUpsButton } from './grown-ups-button';
import { KidsPlayer } from './kids-player';
import { KidsStoriesGrid } from './kids-stories';
import { MoonCard } from './moon-card';
import { useKidsProfile, useKidsStories } from './use-kids';

/** "Who's listening?" (`src/app/profiles.tsx`, workstream D): where leaving kids mode
 * goes, and where the chosen profile's PIN is asked. */
const PROFILES_HREF = '/profiles' as Href;

/** The widest the page's content gets. */
const MAX_WIDTH = 1200;

/**
 * Kids mode (Phase 8, the route `/kids`, STYLEGUIDE "Profile picker and kids mode"): the
 * whole app for a profile in kids mode. "Hi Leo" and the Grown-ups hold, the bedtime card,
 * the story playing now in a big simple player (`KidsPlayer`, which replaces the full
 * player here), and the profile's one library as big cover tiles (`KidsStoriesGrid`,
 * continue-listening first). No search, settings, downloads page or Up next: the gate and
 * `KidsRouteGuard` keep a kids profile here.
 *
 * A story starts through `usePlayBook`, which starts it in place here on every layout
 * (`navFor` counts this screen as a player on top), and the page scrolls back up to the
 * player. On Android the back button does nothing here while the shell sits under this
 * screen (going back would only bounce off the gate); with nothing under it, it leaves the
 * app as usual.
 */
export function KidsScreen() {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const layout = useLayout();
  const phone = layout === 'phone';
  const reduced = useReducedMotion();
  const profile = useKidsProfile();
  const { stories, connectionId, retry } = useKidsStories();
  const loaded = usePlayer((s) => s.nowPlaying !== null);
  const playBook = usePlayBook();
  const scroll = useRef<ScrollView>(null);
  const [width, setWidth] = useState(0);

  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => router.canGoBack());
      return () => sub.remove();
    }, []),
  );

  const onPlay = (book: Book) => {
    if (!connectionId) return;
    scroll.current?.scrollTo({ y: 0, animated: !reduced });
    playBook({ connectionId, libraryId: book.library_id, path: book.rel_path }).catch(() => {
      toast({ title: t('kids.startFailed.title'), description: t('kids.startFailed.body') });
    });
  };

  const name = profile?.name.trim() ?? '';
  return (
    <Screen testID="kids-screen">
      <ScrollView
        ref={scroll}
        contentContainerStyle={{
          paddingTop: insets.top + (phone ? 16 : 28),
          paddingBottom: insets.bottom + 40,
          paddingLeft: insets.left + (phone ? 16 : 36),
          paddingRight: insets.right + (phone ? 16 : 36),
        }}
      >
        <View
          className="w-full self-center"
          style={{ maxWidth: MAX_WIDTH }}
          onLayout={(e) => setWidth(Math.round(e.nativeEvent.layout.width))}
        >
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
            <GrownUpsButton onExit={() => router.push(PROFILES_HREF)} />
          </View>
          <View className="mt-5">
            <MoonCard bedtime={profile?.kids?.bedtime ?? DEFAULT_BEDTIME} />
          </View>
          {loaded ? (
            <View className={phone ? 'mt-7' : 'mt-10'}>
              <KidsPlayer wide={!phone} width={width} />
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
          <KidsStoriesGrid
            stories={stories}
            connectionId={connectionId}
            width={width}
            phone={phone}
            onPlay={onPlay}
            onRetry={retry}
          />
        </View>
      </ScrollView>
    </Screen>
  );
}
