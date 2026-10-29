import { type RefObject, useEffect, useMemo, useRef } from 'react';

import { useLatestRef } from '@/lib/use-latest';

import { readalongMessages } from './book-chunks';
import type { HostChannel, HostMessage, ReadalongPosition } from './protocol';
import type { ReaderReadalongMap } from './readalong-map';
import type { ReaderReadalongProps } from './reader-host-types';
import type { ReadalongLink } from './reader-session';

/** How often the narration's place is sent while a map is in: the reader's clock moves the
 * highlight on between samples (`PositionClock`, reader/src/readalong.js). */
export const POSITION_MS = 1000;

/** What both hosts' read-along side is: the session's link, and the handle's commands. */
export type ReaderReadalong = ReadalongLink & {
  follow(): void;
  syncPosition(): void;
};

/** A position worth sending: finite, not negative, a speed above 0. */
function checkPosition(p: ReadalongPosition | null | undefined): ReadalongPosition | null {
  if (!p || typeof p.playing !== 'boolean') return null;
  const { t, rate } = p;
  if (!Number.isFinite(t) || t < 0 || !Number.isFinite(rate) || rate <= 0) return null;
  return { t, rate, playing: p.playing };
}

/**
 * The read-along side both reader hosts share (Bridge Phase 3c): the map (`readalong`; in
 * the app, `chunked`, a large one in pieces, `readalongMessages`), the narration's place
 * every POSITION_MS while a map is in (`position`) and `follow`, sent to each reader document
 * once it is `ready` (`documentReady`) and again when the map changes; the reader's
 * `seek`, `following` and `readalong` handed to the props' callbacks. A document made again
 * follows if the last one last said it followed (else `followNarration`). Nothing is held
 * for a document that is not ready yet: it gets the latest of everything when it is.
 */
export function useReaderReadalong(
  channel: RefObject<HostChannel | null>,
  props: ReaderReadalongProps,
  chunked: boolean,
): ReaderReadalong {
  const latest = useLatestRef(props);
  // What the reader last said of following (null: nothing yet for this map).
  const following = useRef<boolean | null>(null);
  // The messages of the map last sent, made once per map.
  const sent = useRef<{ map: ReaderReadalongMap | null; messages: HostMessage[] } | null>(null);

  const link = useMemo(() => {
    const readyChannel = () => (channel.current?.isReady() ? channel.current : null);
    const syncPosition = () => {
      const ch = readyChannel();
      if (!ch || !latest.current.readalongMap) return;
      const position = checkPosition(latest.current.readalongPosition?.());
      if (position) ch.send({ type: 'position', ...position });
    };
    const sendMap = () => {
      const ch = readyChannel();
      if (!ch) return;
      const map = latest.current.readalongMap ?? null;
      if (!sent.current || sent.current.map !== map) {
        sent.current = {
          map,
          messages: chunked ? readalongMessages(map) : [{ type: 'readalong', map }],
        };
      }
      for (const message of sent.current.messages) ch.send(message);
      if (!map) return;
      // The place first, so a follow turns to the sentence being read now.
      syncPosition();
      if (following.current ?? latest.current.followNarration === true) {
        ch.send({ type: 'follow' });
      }
    };
    return {
      sendMap,
      // A document that never had a map is sent none (a map going away is: the effect).
      documentReady: () => {
        if (latest.current.readalongMap) sendMap();
      },
      syncPosition,
      follow() {
        following.current = true;
        readyChannel()?.send({ type: 'follow' });
      },
      receive(message) {
        const p = latest.current;
        switch (message.type) {
          case 'seek':
            p.onSeek?.(message.t);
            return;
          case 'following':
            following.current = message.value;
            p.onFollowing?.(message.value);
            return;
          case 'readalong':
            p.onReadalongState?.({ state: message.state, unresolved: message.unresolved });
            return;
        }
      },
    } satisfies ReaderReadalong & { sendMap(): void };
  }, [channel, latest, chunked]);

  const map = props.readalongMap ?? null;
  useEffect(() => {
    if (!map) following.current = null;
    link.sendMap();
  }, [link, map]);

  const hasMap = map !== null;
  useEffect(() => {
    if (!hasMap) return;
    const timer = setInterval(link.syncPosition, POSITION_MS);
    return () => clearInterval(timer);
  }, [link, hasMap]);

  return link;
}
