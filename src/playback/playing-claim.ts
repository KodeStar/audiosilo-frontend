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
 * span and tells the listener ("Playing in another tab"). It keeps its book; pressing play
 * there claims the connection back, from where the other tab left that book when it played
 * the same one (the store's `otherTabsPlace`: the tabs are never at two places of a book).
 * The rule is per connection, not per book: one account plays once in a browser, and two
 * connections may play side by side.
 *
 * The newest play wins, by when it was asked for (`askedAt`), not by which claim arrives
 * last: a tab still loading whose play was asked for after another tab's keeps going, and
 * that tab gives way to its claim once it plays. Two plays asked for in the same
 * millisecond are told apart by their tab ids, so exactly one of them stands.
 *
 * A tab that gives way answers the claim with where it stopped (`GaveWay`): its last save
 * is up to 15 s old, so the tab that took over, which began from that save, moves on to the
 * place the listener really was (the store's `onGaveWayAnswer`).
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
  isNumber(v.askedAt) &&
  isNumber(v.sentAt);

/**
 * A tab's answer to the claim it gave way to: the book it was playing and the place it
 * stopped at, for the tab that claimed (`to`) to play on from. Told from a claim by its
 * `kind` (a claim has none, and no `sentAt` here: a build that knows only claims reads it
 * as nothing).
 */
export type GaveWay = {
  kind: 'gave-way';
  connectionId: string;
  libraryId: number;
  /** The book's rel path. */
  path: string;
  /** Where it stopped, whole-book seconds. */
  position: number;
  /** The playing file (its rel path) and the seconds into it, when known: the same file in
   * whatever order the other tab's queue plays (fe#188). */
  file?: string;
  filePos?: number;
  /** Whether that place is the book's end (a save of it reads finished). */
  finished: boolean;
  /** The tab that gave way. */
  tab: string;
  /** The claim it answers: the tab that made it, and when (`PlayingClaim.sentAt`). */
  to: string;
  claimedAt: number;
};

/** What an answer says besides who it is from and which claim it answers. */
export type StoppedAt = Pick<
  GaveWay,
  'connectionId' | 'libraryId' | 'path' | 'position' | 'file' | 'filePos' | 'finished'
>;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const isGaveWay = (v: unknown): v is GaveWay =>
  isRecord(v) &&
  v.kind === 'gave-way' &&
  typeof v.connectionId === 'string' &&
  isNumber(v.libraryId) &&
  typeof v.path === 'string' &&
  isNumber(v.position) &&
  (v.file === undefined || typeof v.file === 'string') &&
  (v.filePos === undefined || isNumber(v.filePos)) &&
  typeof v.finished === 'boolean' &&
  typeof v.tab === 'string' &&
  typeof v.to === 'string' &&
  isNumber(v.claimedAt);

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
  /** Tell the other tabs this one plays on `connectionId`, a play asked for at `askedAt`.
   * Returns the claim it made (an answer names it: `GaveWay.claimedAt`). */
  announce: (connectionId: string, askedAt: number) => PlayingClaim;
  /** Answer `claim`, which this tab gave way to, with where it stopped. */
  answer: (claim: PlayingClaim, stopped: StoppedAt) => void;
  /** Be told of each other tab's claim, and of each answer to a claim of this tab's;
   * returns the unsubscribe. */
  subscribe: (
    listener: (claim: PlayingClaim) => void,
    answered?: (answer: GaveWay) => void,
  ) => () => void;
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
      return claim;
    },
    answer: (claim, stopped) => {
      const answer: GaveWay = {
        ...stopped,
        kind: 'gave-way',
        tab,
        to: claim.tab,
        claimedAt: claim.sentAt,
      };
      channel?.post(answer);
    },
    subscribe: (listener, answered) =>
      channel?.subscribe((message) => {
        if (isClaim(message)) {
          if (message.tab !== tab) listener(message);
        } else if (isGaveWay(message) && message.to === tab && message.tab !== tab) {
          answered?.(message);
        }
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
