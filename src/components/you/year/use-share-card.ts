import { type RefObject, useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, type View } from 'react-native';

import { toast } from '@/components/ui/toast';
import { whenActive } from '@/lib/when-active';

import { captureCard, deliverCard } from './share-card';
import type { CapturedCard, ShareCardOptions } from './share-types';

/** Waits for React to commit a state change and the platform to lay it out (two frames),
 * before a second capture reads the card again. */
function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    const raf = globalThis.requestAnimationFrame ?? ((cb: () => void) => setTimeout(cb, 16));
    raf(() => raf(() => resolve()));
  });
}

export type ShareCardState = {
  /** A share is being made: the story holds its card (no auto-advance) meanwhile, from
   * the press until the capture and the share sheet have settled and the app is back in
   * the foreground (Android's share sheet answers as soon as a target is picked, while
   * that app is still open over this one). */
  busy: boolean;
  /** The card draws its covers as plain title blocks: the second try of a capture that
   * failed with covers (an image the capture could not read). */
  coversOff: boolean;
  share: (card: RefObject<View | null>, opts: ShareCardOptions) => Promise<void>;
};

/**
 * "Share this card": capture the card on screen as a 1080 x 1920 PNG and share it
 * (`captureCard`, `deliverCard`). One share at a time. When a capture fails, it tries once more with the
 * covers drawn as title blocks (an image a capture can't read must not cost the whole
 * card), then says it couldn't make the image. A download on the web says where it went.
 */
export function useShareCard(): ShareCardState {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [coversOff, setCoversOff] = useState(false);
  const running = useRef(false);

  const share = useCallback(
    async (card: RefObject<View | null>, opts: ShareCardOptions) => {
      if (running.current) return;
      running.current = true;
      setBusy(true);
      try {
        let captured: CapturedCard;
        try {
          if (!card.current) throw new Error('No card on screen');
          captured = await captureCard(card.current, opts.fileName);
        } catch (first) {
          // Only the capture is retried: a share sheet that failed must not open twice.
          console.warn('[year] card capture failed, retrying without covers', first);
          setCoversOff(true);
          await nextFrames();
          if (!card.current) throw first;
          captured = await captureCard(card.current, opts.fileName);
        }
        setCoversOff(false);
        const outcome = await deliverCard(captured, opts);
        if (outcome === 'downloaded') {
          toast({
            title: t('year.saved'),
            description: t('year.savedBody', { name: opts.fileName }),
          });
        }
      } catch (e) {
        console.warn('[year] card share failed', e);
        toast({ title: t('year.shareFailed'), description: t('year.shareFailedBody') });
      } finally {
        setCoversOff(false);
        // Away (the app shared to is over this one): wait for the foreground. Only then:
        // a state that is neither (unknown, an extension) must not hold the story forever.
        const away = AppState.currentState === 'background' || AppState.currentState === 'inactive';
        if (away) await new Promise<void>((resolve) => whenActive(resolve));
        running.current = false;
        setBusy(false);
      }
    },
    [t],
  );

  return { busy, coversOff, share };
}
