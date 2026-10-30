import { t } from 'i18next';

import { networkChecked } from '@/api/address-route';
import { resolveClient } from '@/api/connection-clients';
import { isReachable, onReconnect } from '@/api/reachability';
import type { Chapter, Progress } from '@/api/types';
import { toast } from '@/components/ui/toast';
import { contradictedTitle } from '@/lib/chapter-label';
import { formatClock } from '@/lib/format';
import { onForeground, whenActive } from '@/lib/when-active';

import { selectUndoFor, undoJump, useJumpUndo } from './jump-undo';
import { onSyncAnswer, usesListeningSync } from './listening-outbox';
import {
  ackVersion,
  getDeviceId,
  markAnswered,
  readMirror,
  type ProgressSave,
} from './progress-sync';
import {
  holdSaves,
  localMoveCount,
  onPickedUpAgain,
  selectBookKey,
  selectBookPosition,
  standByPlace,
  usePlayer,
} from './store';

/**
 * Picking a loaded book up again where ANOTHER device left it. A book this device holds loaded resumes from its engine's place on every
 * Play (a press, the lock screen, earbuds): nothing asks the server. If another device (or
 * the other AudioSilo app on the same phone, which keeps its own engine, mirror and queue)
 * played on meanwhile, the listener heard the old place AND this device's next save, newer
 * by the clock, overwrote the other one on the server (last-write-wins).
 *
 * So when the loaded book is picked up again, ask the server first:
 * - the app comes to the foreground, or the book's server comes back, while the book is
 *   loaded and settled (`paused`/`ready`): never while it has been playing on;
 * - the book plays again after `LONG_PAUSE_MS` of pause, from anywhere (`onPickedUpAgain`,
 *   called before the play's first save): the engine is already playing, so the move comes
 *   as early as the answer does.
 * While the check is out the store holds its saves (`holdSaves`), so the stale place is
 * never written; the hold ends with the check, or by itself after 5 seconds.
 *
 * It moves only when the server's record was written by another device (`device_id`, which
 * the server stores per record), is newer than this device's own last save of the book
 * (the durable mirror holds every save of this device, queued or not; it also keeps the
 * records this device read, and those say where the book is, not where this engine is), is
 * not finished, and is more than `MOVE_THRESHOLD_S` from the engine's place. A
 * seek of the listener's own while the check was out wins (`localMoveCount`). The move is
 * the store's `seekBook` (the resume floor, the undo chip's detection), and a toast says
 * what happened with Undo.
 *
 * A finished record moves nothing: like `playBook`, its position is not a place to resume
 * (it is the end), and restarting a book the listener is in the middle of here would be
 * worse. This device's next save then records the book unfinished again.
 */

/** A smaller difference is not worth moving the listener (auto-rewind is up to 30 s). */
export const MOVE_THRESHOLD_S = 30;
/** How long the server has to answer. */
export const CHECK_TIMEOUT_MS = 5_000;

const timeOf = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Where to move the loaded book, or null to stay. Pure. `mirror` is this device's newest
 * knowledge of the book (its own saves, queued or synced, and records it read). Only a save
 * of its own keeps the engine where it is: a record read since (a downloaded book's page
 * and its download keep the mirror current) is where the book is, not where this engine is.
 */
export function placeToMoveTo(input: {
  server: Progress | null;
  deviceId: string;
  mirror: Pick<ProgressSave, 'updated_at' | 'device_id'> | null;
  enginePosition: number;
}): number | null {
  const { server, deviceId, mirror, enginePosition } = input;
  if (!server || server.finished || !(server.position > 0)) return null;
  if (!server.device_id || server.device_id === deviceId) return null;
  const ownSave = mirror?.device_id === deviceId ? mirror : null;
  if (ownSave && timeOf(server.updated_at) <= timeOf(ownSave.updated_at)) return null;
  if (Math.abs(server.position - enginePosition) <= MOVE_THRESHOLD_S) return null;
  return server.position;
}

/**
 * Sync v2 (`listening_sync`): another device's place to OFFER, never to move to by itself.
 * Pure. Two cases, in order:
 * (a) the row the server kept was written by another device, at a version this device has
 *     not acknowledged (`ackVersion`), and is more than `MOVE_THRESHOLD_S` from here: "On
 *     {device} you were at {place}. Jump there?";
 * (b) else the row's `other_place` (the place the server did NOT keep when two devices
 *     diverged) when it is another device's, more than `MOVE_THRESHOLD_S` from here, and not
 *     answered yet (`answered` holds the `device_id|updated_at` keys this device answered).
 * Answering either (Jump or Stay) acknowledges the row's version and notes the key, so it
 * is offered once.
 */
export type PlaceOffer = {
  position: number;
  /** "" when the server doesn't know the device's name. */
  deviceName: string;
  /** `device_id|updated_at` of the offered place. */
  key: string;
};

export function offerOf(
  row: Progress | null | undefined,
  deviceId: string,
  ackVersion: number | undefined,
  enginePosition: number,
  answered: readonly string[] = [],
): PlaceOffer | null {
  if (!row) return null;
  const far = (position: number) => Math.abs(position - enginePosition) > MOVE_THRESHOLD_S;
  if (
    !row.finished &&
    row.device_id &&
    row.device_id !== deviceId &&
    row.version > (ackVersion ?? 0) &&
    far(row.position)
  ) {
    const key = `${row.device_id}|${row.updated_at}`;
    if (!answered.includes(key)) {
      return { position: row.position, deviceName: row.device_name ?? '', key };
    }
  }
  const other = row.other_place;
  if (other && other.device_id && other.device_id !== deviceId && far(other.position)) {
    const key = `${other.device_id}|${other.updated_at}`;
    if (!answered.includes(key)) {
      return { position: other.position, deviceName: other.device_name ?? '', key };
    }
  }
  return null;
}

/** Offers shown this launch (`bookKey|key`): each is shown once, answered or not. */
const shownOffers = new Set<string>();

/**
 * Offer the loaded book another device's place from `row` (the server's row for it), when
 * `offerOf` finds one. Never moves the book by itself: a toast with Jump (seek there) and
 * Stay (close: this device's place stands, its next span a deliberate move that the server
 * applies). Either answer acknowledges the row's version. Resolves once it is shown or not.
 */
export async function offerLoadedPlace(
  bookKey: string,
  row: Progress | null,
  deviceId: string,
  mirror: Pick<ProgressSave, 'ack_version' | 'answered'> | null,
): Promise<boolean> {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np || !row || selectBookKey(player) !== bookKey) return false;
  // A Sync v2 offer: an older server keeps last-write-wins and its own move (above).
  if (!usesListeningSync(np.connectionId)) return false;
  const offer = offerOf(
    row,
    deviceId,
    mirror?.ack_version,
    selectBookPosition(player),
    mirror?.answered,
  );
  if (!offer || shownOffers.has(`${bookKey}|${offer.key}`)) return false;
  shownOffers.add(`${bookKey}|${offer.key}`);
  const ref = { connectionId: np.connectionId, libraryId: np.libraryId, path: np.path };
  const answer = async () => {
    await ackVersion(ref.connectionId, ref.libraryId, ref.path, row.version, row);
    await markAnswered(ref.connectionId, ref.libraryId, ref.path, offer.key, row);
  };
  whenActive(() => {
    const now = usePlayer.getState();
    if (selectBookKey(now) !== bookKey || !now.nowPlaying) return;
    const place = describePlace(now.nowPlaying.queue.chapters, offer.position, { bare: true });
    toast({
      title: offer.deviceName
        ? t('player.placeOffer.device', { device: offer.deviceName, place })
        : t('player.placeOffer.unknown', { place }),
      action: {
        label: t('player.placeOffer.jump'),
        onPress: () => {
          // Acknowledged first: the span the jump opens is sent on the row it answered.
          void answer().then(() => {
            if (selectBookKey(usePlayer.getState()) === bookKey) {
              void usePlayer.getState().seekBook(offer.position);
            }
          });
        },
      },
      closeLabel: t('player.placeOffer.stay'),
      onClose: () => {
        void answer().then(() => {
          if (selectBookKey(usePlayer.getState()) === bookKey) standByPlace();
        });
      },
      duration: 12_000,
    });
  });
  return true;
}

/** The sync answer's row for the loaded book, offered (never moved to). */
function offerFromAnswer(connectionId: string, rows: Progress[]) {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const bookKey = selectBookKey(player);
  if (!np || !bookKey || np.connectionId !== connectionId) return;
  const row = rows.find((r) => r.library_id === np.libraryId && r.path === np.path);
  if (!row) return;
  void Promise.all([getDeviceId(), readMirror(np.connectionId, np.libraryId, np.path)])
    .then(([deviceId, mirror]) => offerLoadedPlace(bookKey, row, deviceId, mirror))
    .catch(() => undefined);
}

let checking = false;

/** The checks' triggers, by name (tests). */
export type ReconcileReason = 'foreground' | 'reconnect' | 'picked-up';

/** Ask the server about the loaded book and move it if another device moved on. Never
 * throws; resolves once the check is over (moved, stayed, or gave up). */
export async function reconcileLoadedPlace(reason: ReconcileReason): Promise<void> {
  if (checking) return;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const bookKey = selectBookKey(player);
  if (!np || !bookKey || player.loadingBook || np.queue.total <= 0) return;
  const { state } = player.snapshot;
  // Only a book being picked up again: never one that has been playing on.
  if (reason === 'picked-up' ? state !== 'playing' : state !== 'paused' && state !== 'ready') {
    return;
  }
  const client = resolveClient(np.connectionId);
  // Offline (a downloaded book with its server away): nothing to ask; saves go on.
  if (!client || !isReachable(np.connectionId)) return;

  checking = true;
  const release = holdSaves();
  const moves = localMoveCount();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  let moved = false;
  try {
    const [server, deviceId, mirror] = await Promise.all([
      client.getProgress(np.libraryId, np.path, abort.signal),
      getDeviceId(),
      readMirror(np.connectionId, np.libraryId, np.path),
    ]);
    const now = usePlayer.getState();
    // Another book, or the listener moved meanwhile: theirs wins.
    if (selectBookKey(now) !== bookKey || localMoveCount() !== moves || abort.signal.aborted) {
      return;
    }
    const from = selectBookPosition(now);
    const to = placeToMoveTo({ server, deviceId, mirror, enginePosition: from });
    if (to === null) {
      // Sync v2: a place another device left that the server did not move to is offered.
      await offerLoadedPlace(bookKey, server, deviceId, mirror);
      return;
    }
    moved = true;
    // The row it moved to is the place this device has now seen (Sync v2's ack).
    if (server && server.version > 0) {
      void ackVersion(np.connectionId, np.libraryId, np.path, server.version, server).catch(
        () => undefined,
      );
    }
    await now.seekBook(to);
    tell(bookKey, from, to);
  } catch {
    // Unreachable, refused or too slow: stay where the engine is; the saves go on.
  } finally {
    clearTimeout(timer);
    checking = false;
    // After a move the other device's place is already saved, and the engine may not
    // have reported the move yet: the next save comes from the engine itself.
    release({ flush: !moved });
  }
}

/** "Picked up your place from another device: Chapter 12, 2:13" (into the chapter) with Undo, shown
 * once the app is in front (a lock-screen play moves the book in the background). */
function tell(bookKey: string, from: number, to: number) {
  whenActive(() => {
    const player = usePlayer.getState();
    if (selectBookKey(player) !== bookKey || !player.nowPlaying) return;
    toast({
      title: t('player.placeMoved.title'),
      description: describePlace(player.nowPlaying.queue.chapters, to),
      action: { label: t('player.placeMoved.undo'), onPress: () => undoMove(bookKey, from) },
    });
  });
}

/** A whole-book place as the listener reads it: "Chapter 12, 2:13" (the time into the
 * chapter), "{title}, 2:13" when the number would contradict the title, else "At 1:02:13"
 * (`bare`: just "1:02:13", inside a sentence of its own). */
export function describePlace(
  chapters: Pick<Chapter, 'book_offset' | 'title'>[],
  to: number,
  { bare = false }: { bare?: boolean } = {},
): string {
  let index = -1;
  for (let i = 0; i < chapters.length; i++) if (to >= chapters[i].book_offset) index = i;
  const inChapter = chapters.length > 1 && index >= 0;
  // Beside a chapter's name, the time INTO that chapter: "Chapter 13, 1:22:00" (the book's
  // time) read as an impossible place in a six-minute chapter.
  const time = formatClock(inChapter ? to - chapters[index].book_offset : to);
  // Named like the Resume labels: by place, or by the title when the place would
  // contradict it (a Prologue first makes the 4th chapter "Chapter 3").
  const titled =
    index >= 0 ? contradictedTitle({ number: index + 1, title: chapters[index].title }) : null;
  return inChapter
    ? titled
      ? t('player.placeMoved.titledAt', { title: titled, time })
      : t('player.placeMoved.chapterAt', { chapter: index + 1, time })
    : bare
      ? time
      : t('player.placeMoved.at', { time });
}

/** Back to where this device was. Through the undo chip's own undo when the move made
 * one (so going back makes no new chip), else a plain seek; saves then go on from there. */
export function undoMove(bookKey: string, from: number): void {
  const player = usePlayer.getState();
  if (selectBookKey(player) !== bookKey) return;
  const chip = selectUndoFor(bookKey)(useJumpUndo.getState());
  if (chip && Math.abs(chip.from - from) <= 5 && undoJump() !== null) return;
  void player.seekBook(from);
}

/** How many callers hold the triggers, and their teardown while one does. */
let holders = 0;
let teardown: (() => void) | null = null;

/**
 * Start the triggers for the life of the app; returns the release. Shared: the root layout
 * starts them, and so does the car's headless task (a book the car started is picked up from
 * another device's newer place there too). They run once until the last holder releases
 * them: two would race for `onPickedUpAgain`'s one slot, and either's teardown would clear it.
 */
export function startPlaceReconcile(): () => void {
  holders++;
  teardown ??= runPlaceReconcile();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0 || !teardown) return;
    const stop = teardown;
    teardown = null;
    stop();
  };
}

function runPlaceReconcile(): () => void {
  const stops: (() => void)[] = [];
  stops.push(onPickedUpAgain(() => void reconcileLoadedPlace('picked-up')));
  // On the foreground, once the address runner has checked the network: a home address
  // checked on the network the device was on before it was suspended goes first.
  stops.push(
    onForeground(() => void networkChecked().then(() => reconcileLoadedPlace('foreground'))),
  );
  stops.push(
    onReconnect((cid) => {
      if (usePlayer.getState().nowPlaying?.connectionId === cid) {
        void reconcileLoadedPlace('reconnect');
      }
    }),
  );
  // Sync v2: each sync answer's row for the loaded book may carry a place to offer.
  stops.push(onSyncAnswer(offerFromAnswer));
  return () => {
    for (const stop of stops) stop();
  };
}
