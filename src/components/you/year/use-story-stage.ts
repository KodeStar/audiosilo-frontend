import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';

import { useScreenReaderEnabled } from './use-screen-reader';
import { useShareCard } from './use-share-card';
import { useStoryPlayer } from './use-story-player';
import type { ReadyYearStory } from './use-year-story';
import { shareFileName } from './year-model';

/**
 * Everything a story host (the Year section's stage, the phone's full-screen story) wires
 * the same way: the story's clock (`useStoryPlayer`), held while the listener holds the
 * card, a share is being made or a screen reader runs, and still under reduced motion;
 * "Share this card" (`useShareCard`) for the card on show; and the props `StoryStage`
 * takes from them (`stage`, spread onto it with the host's own width).
 */
export function useStoryStage(story: ReadyYearStory, cid: string, initial?: number) {
  const { t } = useTranslation();
  const reduced = useReducedMotion();
  const screenReader = useScreenReaderEnabled();
  const share = useShareCard();
  const [held, setHeld] = useState(false);
  const player = useStoryPlayer(story.cards.length, {
    held: held || share.busy || screenReader,
    still: reduced,
    initial,
  });
  const cardRef = useRef<View>(null);
  const card = story.cards[player.index];

  const shareCard = useCallback(() => {
    if (!card) return;
    void share.share(cardRef, {
      fileName: shareFileName(story.year, player.index, card.kind),
      title: t('year.shareTitle', { year: story.year }),
    });
  }, [card, share, story.year, player.index, t]);

  return {
    player,
    sharing: share.busy,
    shareCard,
    stage: {
      cards: story.cards,
      copies: story.copies,
      player,
      connectionId: cid,
      cardRef,
      plainCovers: share.coversOff,
      screenReader,
      still: reduced,
      onHold: setHeld,
    },
  };
}
