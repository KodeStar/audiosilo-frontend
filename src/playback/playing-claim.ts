import { randomUUID } from '@/lib/random';
import { isRecord } from '@/lib/storage-keys';
import { tabChannel, type TabChannel } from '@/lib/tab-channel';

/**
 * One tab plays at a time (fe#123, web only). Two tabs of the web player are one device to
 * the server (they share its id and the listening outbox): playing at once, the listener
 * hears both, their seconds are recorded twice and the saved place goes back and forth.
 *
 * So a tab that starts playing says so on a channel every tab of the browser shares
 * (`tabChannel`: `BroadcastChannel`, else `storage` events), and a tab of the same
 * connection that is playing, or on its way to, gives way: it pauses, closes its listening
 * span and tells the listener ("Playing in another tab"). It keeps its book and its place;
 * pressing play there claims the connection back. The rule is per connection, not per book:
 * one account plays once in a browser, and two connections may play side by side.
 *
 * The newest play wins, by when it was asked for (`askedAt`), not by which claim arrives
 * last: a tab still loading whose play was asked for after another tab's keeps going, and
 * that tab gives way to its claim once it plays. Two plays asked for in the same
 * millisecond are told apart by their tab ids, so exactly one of them stands.
 *
 * The store makes the claim and gives way (`store.ts`: `claimPlaying`, `giveWayTo`); this
 * module is the message and the rule. Off the web there is no channel, and none of it runs.
 */
export type PlayingClaim = {
  /** The connection the tab plays on. */
  connectionId: string;
  /** The tab that plays. */
  tab: string;
  /** When its play was asked for (ms): the newest wins. */
  askedAt: number;
  /** When it began playing, which is when the claim was made (ms): a tab that gives way
   * ends its listening span here, so the two tabs' spans never cover the same time. */
  sentAt: number;
};

const isClaim = (v: unknown): v is PlayingClaim =>
  isRecord(v) &&
  typeof v.connectionId === 'string' &&
  typeof v.tab === 'string' &&
  typeof v.askedAt === 'number' &&
  Number.isFinite(v.askedAt) &&
  typeof v.sentAt === 'number' &&
  Number.isFinite(v.sentAt);

/** A tab's own play, as the rule reads it. */
export type OwnPlay = {
  tab: string;
  /** The connection of its loaded book, null with none loaded. */
  connectionId: string | null;
  /** Whether it plays, or means to (a play asked for and still starting). */
  live: boolean;
  /** When that play was asked for (ms). */
  askedAt: number;
};

/**
 * Whether a tab gives way to another tab's `claim` (pure): it plays (or means to) on the
 * claim's connection, and the claim's play was asked for later than its own (the same
 * millisecond: the greater tab id). A tab with nothing playing gives way to nothing.
 */
export function givesWayTo(claim: PlayingClaim, mine: OwnPlay): boolean {
  if (claim.tab === mine.tab || !mine.live || mine.connectionId !== claim.connectionId) {
    return false;
  }
  if (claim.askedAt !== mine.askedAt) return claim.askedAt > mine.askedAt;
  return claim.tab > mine.tab;
}

export type PlayingClaims = {
  /** Who this tab is in its claims. */
  tab: string;
  /** Tell the other tabs this one plays on `connectionId`, a play asked for at `askedAt`. */
  announce: (connectionId: string, askedAt: number) => void;
  /** Be told of each other tab's claim; returns the unsubscribe. */
  subscribe: (listener: (claim: PlayingClaim) => void) => () => void;
};

/** The claims of one tab over `channel` (null: no other tabs, nothing is said or heard). */
export function playingClaims(
  channel: TabChannel<unknown> | null,
  tab: string = randomUUID(),
): PlayingClaims {
  return {
    tab,
    announce: (connectionId, askedAt) => {
      const claim: PlayingClaim = { connectionId, tab, askedAt, sentAt: Date.now() };
      channel?.post(claim);
    },
    subscribe: (listener) =>
      channel?.subscribe((message) => {
        if (isClaim(message) && message.tab !== tab) listener(message);
      }) ?? (() => {}),
  };
}

/** The channel's name: every build that knows the rule shares it. */
export const PLAYING_CHANNEL = 'audiosilo-playing';

let shared: PlayingClaims | null = null;

/** This tab's claims, on the channel the web player's tabs share (opened on first use). */
export function tabClaims(): PlayingClaims {
  shared ??= playingClaims(tabChannel<unknown>(PLAYING_CHANNEL));
  return shared;
}

/** Test-only: open the channel again on the next use. */
export function resetTabClaimsForTests(): void {
  shared = null;
}
