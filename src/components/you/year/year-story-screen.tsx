import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useCid } from '@/api/provider';
import { Icon } from '@/components/ui/icon';
import { Spinner } from '@/components/ui/spinner';
import { FOCUS_RING_CLASS } from '@/components/ui/text';
import { useGlobalShortcut } from '@/lib/keyboard';
import { cn } from '@/lib/utils';
import { colors } from '@/theme/tokens';

import { CARD_DESIGN_WIDTH } from './card-size';
import { StoryStage } from './story-stage';
import { StoryText } from './story-text';
import { useStoryStage } from './use-story-stage';
import { type ReadyYearStory, useYearStory } from './use-year-story';
import { yearStateCopy } from './year-copy';
import { parseYearParams } from './year-params';

/** Room under the card for "Share this card". */
const SHARE_ROW = 72;
/** A pull down this far closes the story. */
const CLOSE_PULL = 120;

/** Out of the story: back to the page it was opened from (a cold link has the app shell
 * under it, the root stack's anchor), else home. */
function closeStory() {
  if (router.canGoBack()) router.back();
  else router.dismissTo('/');
}

/**
 * The phone's full-screen Year in listening story (`/year`, a root modal like the
 * player): the card as large as the screen allows at 9:16, on black, with its close
 * button, "Share this card" under it, a pull down to close, and on the web the arrow keys
 * and Escape. It never navigates into the app shell (the rule for root routes).
 */
export function YearStoryScreen(params: {
  year?: string | string[];
  connection?: string | string[];
  card?: string | string[];
}) {
  const { t } = useTranslation();
  const { range, connection, card } = parseYearParams(params);
  const cid = useCid(connection);
  const story = useYearStory(cid, range);
  const insets = useSafeAreaInsets();

  useGlobalShortcut(true, (e) => e.key === 'Escape', closeStory);
  const pull = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .activeOffsetY(24)
        .failOffsetX([-24, 24])
        .onEnd((e) => {
          if (e.translationY > CLOSE_PULL) closeStory();
        }),
    [],
  );

  return (
    <GestureDetector gesture={pull}>
      <View
        className="flex-1 bg-black"
        style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
      >
        <StatusBar style="light" />
        {story.status === 'ready' ? (
          <FullStory story={story} cid={cid} initial={card} />
        ) : (
          <View className="flex-1 items-center justify-center gap-5 px-8">
            {story.status === 'loading' ? (
              <Spinner color={colors.white} />
            ) : (
              <StoryText className="text-center" style={{ fontSize: 16, lineHeight: 23 }}>
                {yearStateCopy(story, t).body}
              </StoryText>
            )}
            <Pressable
              role="button"
              onPress={closeStory}
              className={cn(
                'h-11 items-center justify-center rounded-xl border border-white/40 px-5',
                Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
              )}
            >
              <StoryText className="font-sans-semibold" style={{ fontSize: 15 }}>
                {t('year.close')}
              </StoryText>
            </Pressable>
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

function FullStory({
  story,
  cid,
  initial,
}: {
  story: ReadyYearStory;
  cid: string;
  initial: number;
}) {
  const { t } = useTranslation();
  const window = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { player, sharing, shareCard, stage } = useStoryStage(story, cid, initial);
  const room = window.height - insets.top - insets.bottom - SHARE_ROW;
  const width = Math.floor(Math.min(window.width, (room * 9) / 16));
  const u = width / CARD_DESIGN_WIDTH;

  const { previous, next } = player;
  useGlobalShortcut(true, (e) => e.key === 'ArrowLeft', previous);
  useGlobalShortcut(true, (e) => e.key === 'ArrowRight', next);

  return (
    <View className="flex-1 items-center justify-center">
      <StoryStage {...stage} width={width} rounded={width < window.width}>
        <Pressable
          role="button"
          accessibilityLabel={t('year.close')}
          onPress={closeStory}
          className={cn(
            'absolute right-1 h-11 w-11 items-center justify-center',
            Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
          )}
          style={{ top: 22 * u }}
        >
          <Icon name="close" size={22} color={colors.white} />
        </Pressable>
      </StoryStage>
      <View style={{ height: SHARE_ROW }} className="items-center justify-center">
        <Pressable
          role="button"
          onPress={shareCard}
          disabled={sharing}
          aria-busy={sharing || undefined}
          className={cn(
            'h-11 flex-row items-center gap-2 rounded-xl border border-white/40 px-5',
            sharing && 'opacity-60',
            Platform.select({ web: `cursor-pointer ${FOCUS_RING_CLASS}` }),
          )}
        >
          {sharing ? (
            <Spinner color={colors.white} />
          ) : (
            <Icon name="share" size={18} color={colors.white} />
          )}
          <StoryText className="font-sans-semibold" style={{ fontSize: 15 }}>
            {t('year.share')}
          </StoryText>
        </Pressable>
      </View>
    </View>
  );
}
