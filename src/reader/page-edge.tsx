import { type RefObject, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type LayoutChangeEvent, Pressable } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { TABLET_MIN_WIDTH, useLayout } from '@/lib/layout';

import type { ReaderHostHandle } from './reader-host-types';

/**
 * Whether the page edges over a reader narrow to the book's margin (24 px: the reader's
 * side margin is about 6% of its width, so a 44 px edge would lie over the text and catch
 * a tap meant for a sentence, fe#165). Judged by the reader's own width once it is
 * measured (`width`: the companion's 420 px column on a desktop is phone-narrow), else by
 * the window's layout class.
 */
export function narrowPageEdges(width: number | null, phone: boolean): boolean {
  return width === null ? phone : width < TABLET_MIN_WIDTH;
}

/** The reader area's width for `narrowPageEdges`: its `onLayout`, and the answer. */
export function usePageEdges(): { narrow: boolean; onLayout: (e: LayoutChangeEvent) => void } {
  const phone = useLayout() === 'phone';
  const [width, setWidth] = useState<number | null>(null);
  return {
    narrow: narrowPageEdges(width, phone),
    onLayout: (e) => setWidth(e.nativeEvent.layout.width),
  };
}

/** Turns the page at one side of the reader: an RTL book's next page is on the left, so
 * the page edges and the arrow keys follow the book. */
export function turnPage(
  host: RefObject<ReaderHostHandle | null>,
  rtl: boolean,
  side: 'left' | 'right',
): void {
  if ((side === 'left') === rtl) host.current?.next();
  else host.current?.prev();
}

/** Both page edges over a reader (`PageEdge`), labelled and turning the way the book
 * reads (`turnPage`). */
export function PageEdges({
  host,
  rtl,
  narrow,
}: {
  host: RefObject<ReaderHostHandle | null>;
  rtl: boolean;
  narrow: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PageEdge
        side="left"
        narrow={narrow}
        label={t(rtl ? 'reader.next' : 'reader.previous')}
        onPress={() => turnPage(host, rtl, 'left')}
      />
      <PageEdge
        side="right"
        narrow={narrow}
        label={t(rtl ? 'reader.previous' : 'reader.next')}
        onPress={() => turnPage(host, rtl, 'right')}
      />
    </>
  );
}

/** A page turn at one edge of the book: a tall, quiet target over the margin, narrowed
 * clear of the text where the reader is narrow (`narrowPageEdges`). */
function PageEdge({
  side,
  label,
  narrow,
  onPress,
}: {
  side: 'left' | 'right';
  label: string;
  narrow: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      role="button"
      accessibilityLabel={label}
      onPress={onPress}
      className={`absolute bottom-0 top-0 ${narrow ? 'w-6' : 'w-11'} items-center justify-center opacity-40 web:hover:opacity-100 ${
        side === 'left' ? 'left-0' : 'right-0'
      }`}
    >
      <Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={18} />
    </Pressable>
  );
}

/** The room kept at the reader's foot while the follow pill shows (fe#192): the pill (30)
 * and the space around it, so it never covers the last line of the page. */
export const FOLLOW_PILL_ROOM = 48;

/** The reader page's style while the follow pill shows (`pill`): `FOLLOW_PILL_ROOM` at its
 * foot, else none. */
export function followPillRoom(pill: boolean) {
  return pill ? { paddingBottom: FOLLOW_PILL_ROOM } : undefined;
}

/**
 * The read-along's way back to the narration (Bridge Phase 3c): a pill at the foot of the
 * reader while it does not follow the sentence being read, "Follow narration" before it
 * ever followed, "Back to narration" once the listener turned away. Pressing it calls the
 * host's `follow()`.
 */
export function FollowPill({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Button
      testID="readalong-follow"
      size="sm"
      icon="microphone"
      title={label}
      onPress={onPress}
      className="rounded-full"
    />
  );
}
