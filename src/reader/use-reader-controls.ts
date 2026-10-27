import { type RefObject, useEffect, useImperativeHandle, useRef } from 'react';

import type { GotoTarget, HostChannel, ReaderTheme } from './protocol';
import type { ReaderHostProps } from './reader-host-types';

/**
 * What both reader hosts (the web's iframe, the app's WebView) do the same way: the screen's
 * commands (`goto`, `next`, `prev`) as the host's handle, and a theme or text size change
 * after the book opened sent as `appearance` (by value: `open` carried the first).
 */
export function useReaderControls(
  channel: RefObject<HostChannel | null>,
  ref: ReaderHostProps['ref'],
  theme: ReaderTheme,
  fontScale: number,
) {
  useImperativeHandle(
    ref,
    () => ({
      goto: (target: GotoTarget) => channel.current?.send({ type: 'goto', ...target }),
      next: () => channel.current?.send({ type: 'next' }),
      prev: () => channel.current?.send({ type: 'prev' }),
    }),
    [channel],
  );

  const { scheme, background, foreground } = theme;
  const appearanceSent = useRef(`${scheme}${background}${foreground}${fontScale}`);
  useEffect(() => {
    const key = `${scheme}${background}${foreground}${fontScale}`;
    if (appearanceSent.current === key) return;
    appearanceSent.current = key;
    channel.current?.send({
      type: 'appearance',
      theme: { scheme, background, foreground },
      fontScale,
    });
  }, [channel, scheme, background, foreground, fontScale]);
}
