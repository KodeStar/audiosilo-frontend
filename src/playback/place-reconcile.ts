import { t } from 'i18next';

import { networkChecked } from '@/api/address-route';
import type { ApiClient } from '@/api/client';
import { resolveClient } from '@/api/connection-clients';
import { isReachable, onReconnect } from '@/api/reachability';
import type { Chapter, Progress } from '@/api/types';
import { dismissToast, toast } from '@/components/ui/toast';
import { contradictedTitle } from '@/lib/chapter-label';
import { sameConnection } from '@/lib/connection-id';
import { contentKey, contentKeyOf } from '@/lib/content-key';
import { formatClock } from '@/lib/format';
import { quietly } from '@/lib/quietly';
import { sharedStart } from '@/lib/shared-start';
import { onForeground, whenActive } from '@/lib/when-active';

import { selectUndoFor, undoJump, useJumpUndo } from './jump-undo';
import { type HeldListen, onSyncAnswer, usesListeningSync } from './listening-outbox';
import {
  ackVersion,
  answerOffer,
  cachedDeviceId,
  getDeviceId,
  GUARD_SLACK_S,
  guardHolds,
  ignoreOffer,
  knownSkew,
  localTimeOf,
  onHeldSave,
  type LatePlace,
  placeKey,
  readMirror,
  serverTimeOf,
  type ProgressSave,
} from './progress-sync';
import {
  answerAfterSpan,
  engineHoldsOtherBook,
  holdSaves,
  localMoveCount,
  localPlayAskedAt,
  type NowPlaying,
  onLatePlace,
  onPickedUpAgain,
  placeChecked,
  saveLoadedPlace,
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
 *   called before the play's first save). A Play press in the app waits up to
 *   `PICK_UP_WAIT_MS` for the check before the engine starts (fe#158), so no sound of the
 *   old place comes first; from the lock screen, a headset or the car the engine is already
 *   playing, so the move comes as early as the answer does.
 * While the check is out the store holds its saves (`holdSaves`), so the stale place is
 * never written; the hold ends with the check, or by itself after 5 seconds.
 * - a downloaded book started without its server's place (it did not answer within the
 *   start's wait) gets it when the server answers after all (`onLatePlace`, `applyLatePlace`).
 *
 * It moves only when the server's record was written by another device (`device_id`, which
 * the server stores per record; for a late place, also a record with no device id:
 * `byAnotherDevice`), is newer than this device's own last save of the book
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

/** A smaller difference is not worth moving the listener (auto-rewind is up to 30 s): one
 * threshold with the replay guard's slack. */
export const MOVE_THRESHOLD_S = GUARD_SLACK_S;
/** How long the server has to answer. */
export const CHECK_TIMEOUT_MS = 5_000;

/**
 * Whether a place with device id `id` was written by another device than this one
 * (`deviceId`). A place with no device id is no listening device's (a progress edit, a
 * listening import, a `PUT` that named none: CROSS-REPO section 25; this device's own Mark as
 * not finished writes one): another device's only for a late place (`late`, `applyLatePlace`),
 * which stands in for the start's own resume lookup, where the newest record wins whoever
 * wrote it. Then it is moved to as an unknown device's when it is newer than every record the
 * start read (`placeToMoveTo`), and never offered (`offerOf`): the start's own lookup offers no
 * such record either, and an older one is no place another device left (the listener's own
 * Mark as not finished, an old import).
 */
function byAnotherDevice(id: string | undefined, deviceId: string, late: boolean): boolean {
  return id ? id !== deviceId : late && deviceId !== '';
}

const timeOf = (iso: string | undefined): number => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Where to move the loaded book, or null to stay. Pure. `mirror` is this device's newest
 * knowledge of the book (its own saves, queued or synced, and records it read). Only a save
 * of its own keeps the engine where it is: a record read since (a downloaded book's page
 * and its download keep the mirror current) is where the book is, not where this engine is.
 * A late place with no device id is weighed against any record, as the start's lookup was.
 */
export function placeToMoveTo(input: {
  server: Progress | null;
  deviceId: string;
  mirror: Pick<ProgressSave, 'updated_at' | 'device_id' | 'server_clock'> | null;
  enginePosition: number;
  skewMs?: number;
  /** A late place (`applyLatePlace`): a record with no device id counts (`byAnotherDevice`). */
  late?: boolean;
}): number | null {
  const { server, deviceId, mirror, enginePosition, skewMs = 0, late = false } = input;
  if (!server || server.finished || !(server.position > 0)) return null;
  if (!byAnotherDevice(server.device_id, deviceId, late)) return null;
  // A late place with no device id stands in for the start's lookup, which took the newest of
  // the row and the record the start read, whoever's: not newer than that record, it stays.
  const weighed = !server.device_id || mirror?.device_id === deviceId ? mirror : null;
  if (
    weighed &&
    (serverTimeOf(server.updated_at, skewMs) || 0) <= (localTimeOf(weighed, skewMs) || 0)
  )
    return null;
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
 * is offered once. A place with no device id is no device's and is never offered, a late
 * place's neither (`byAnotherDevice`).
 */
export type PlaceOffer = {
  position: number;
  /** "" when the server doesn't know the device's name. */
  deviceName: string;
  /** `device_id|updated_at` of the offered place. */
  key: string;
};

/** The offer keys a mirror record has settled: answered (Jump, Stay) or timed out
 * (`ignored`). Neither is offered again (`offerOf`'s `answered`). */
export function settledOffers(
  record: Pick<ProgressSave, 'answered' | 'ignored'> | null | undefined,
): string[] {
  return [...(record?.answered ?? []), ...(record?.ignored ?? [])];
}

export function offerOf(
  row: Progress | null | undefined,
  deviceId: string,
  ackVersion: number | undefined,
  enginePosition: number,
  answered: readonly string[] = [],
): PlaceOffer | null {
  if (!row) return null;
  // A place of another device, far enough from here and not answered yet.
  const candidate = (p: {
    position: number;
    device_id?: string;
    device_name?: string;
    updated_at: string;
  }): PlaceOffer | null => {
    if (!p.device_id || p.device_id === deviceId) return null;
    if (Math.abs(p.position - enginePosition) <= MOVE_THRESHOLD_S) return null;
    const key = placeKey(p);
    return answered.includes(key)
      ? null
      : { position: p.position, deviceName: p.device_name ?? '', key };
  };
  const kept = !row.finished && row.version > (ackVersion ?? 0) ? candidate(row) : null;
  return kept ?? (row.other_place ? candidate(row.other_place) : null);
}

/** Offers shown this launch (`bookKey|key`), including ones that timed out. */
const shownOffers = new Set<string>();
/** A device's places are offered at most once in this long for a book: one that plays on
 * moves its place (a new key) with each span it sends, a new offer every sync. */
export const OFFER_REPEAT_MS = 10 * 60_000;
/** When each device's place was last offered and the local play/move it was shown on. */
const offeredAt = new Map<string, { at: number; play: number; moves: number; toastId?: number }>();

/**
 * Offer the loaded book another device's place from `row` (the server's row for it), when
 * `offerOf` finds one. Never moves the book by itself: a toast with Jump (seek there) and
 * Stay (close: this device's place stands, its next span a `stay` that the server applies
 * over the other device's writes since the offer, a `jump` without `listening_stay`; sent at
 * once when paused: `standByPlace`). Either answer acknowledges the row's version. Resolves
 * once it is shown or not.
 *
 * `held`: the legacy PUT path's replay guard held a save of this book back for `row`
 * (fe#198; `onHeldSave`). There is no acknowledged version there (the row's own is new),
 * Stay saves this device's place at once (and lifts the session's guard), and a toast that
 * times out answers nothing: the place stays held, and is offered again next launch.
 *
 * `heldListen`: the sync answer kept the stored row over a listen from here. A new local
 * play or move offers that row again, even if its toast timed out. A held Stay also offers
 * a new key at once. Continuing to listen through save ticks keeps the same repeat cap.
 */
export async function offerLoadedPlace(
  bookKey: string,
  row: Progress | null,
  deviceId: string,
  mirror: Pick<ProgressSave, 'ack_version' | 'answered' | 'ignored'> | null,
  { held = false, heldListen }: { held?: boolean; heldListen?: HeldListen } = {},
): Promise<boolean> {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  if (!np || !row || selectBookKey(player) !== bookKey) return false;
  // A Sync v2 offer, or a held save's: an older server keeps last-write-wins and its own
  // move (above).
  if (!held && !usesListeningSync(np.connectionId)) return false;
  const play = localPlayAskedAt();
  const moves = localMoveCount();
  const keptKey = placeKey(row);
  const previous = offeredAt.get(`${bookKey}|${row.device_id}`);
  const changed = heldListen && (!previous || previous.play !== play || previous.moves !== moves);
  const ignored = (mirror?.ignored ?? []).filter((key) => !changed || key !== keptKey);
  const offer = offerOf(
    row,
    deviceId,
    held ? undefined : mirror?.ack_version,
    selectBookPosition(player),
    settledOffers({ answered: mirror?.answered, ignored }),
  );
  if (!offer) return false;
  const repeat = changed && offer.key === keptKey;
  if (!repeat && shownOffers.has(`${bookKey}|${offer.key}`)) return false;
  // The key is `device_id|updated_at`; an ISO time has no `|`.
  const fromDevice = `${bookKey}|${offer.key.slice(0, offer.key.lastIndexOf('|'))}`;
  const last = offeredAt.get(fromDevice);
  if (
    !repeat &&
    !(heldListen === 'stay' && offer.key === keptKey) &&
    last &&
    Date.now() - last.at < OFFER_REPEAT_MS
  )
    return false;
  shownOffers.add(`${bookKey}|${offer.key}`);
  const latest = { at: Date.now(), play, moves, toastId: last?.toastId };
  offeredAt.set(fromDevice, latest);
  const answer = () => answerOffer(np.connectionId, np.libraryId, np.path, row, offer.key);
  whenActive(() => {
    const now = usePlayer.getState();
    if (selectBookKey(now) !== bookKey || !now.nowPlaying || offeredAt.get(fromDevice) !== latest)
      return;
    const place = describePlace(now.nowPlaying.queue.chapters, offer.position, { bare: true });
    // A new play or move can re-offer before the previous toast timed out.
    if (latest.toastId !== undefined) dismissToast(latest.toastId);
    latest.toastId = toast({
      title: offer.deviceName
        ? t('player.placeOffer.device', { device: offer.deviceName, place })
        : t('player.placeOffer.unknown', { place }),
      action: {
        label: t('player.placeOffer.jump'),
        onPress: () => {
          // Acknowledged before the move, so the span the jump opens is sent on the row it
          // answered, and after the span heard here closes, so that one is not
          // (`answerAfterSpan`).
          void answerAfterSpan(np, answer).then(() => {
            if (selectBookKey(usePlayer.getState()) === bookKey) {
              quietly(usePlayer.getState().seekBook(offer.position));
            }
          });
        },
      },
      closeLabel: t('player.placeOffer.stay'),
      onClose: () => {
        void answer().then(() => {
          if (selectBookKey(usePlayer.getState()) !== bookKey) return;
          if (held) saveLoadedPlace();
          else standByPlace();
        });
      },
      // Not answered: noted, so the same place is not offered again (no acknowledgement).
      // A held save's is not noted: that would let the guard through, as a Stay does.
      onTimeout: () => {
        if (held) return;
        void ignoreOffer(np.connectionId, np.libraryId, np.path, row, offer.key).catch(
          () => undefined,
        );
      },
      duration: 12_000,
    });
  });
  return true;
}

/** The sync answer's row for the loaded book, offered with the outcome of its own listens. */
function offerFromAnswer(
  connectionId: string,
  rows: Progress[],
  held: ReadonlyMap<string, HeldListen>,
) {
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const bookKey = selectBookKey(player);
  if (!np || !bookKey || !sameConnection(np.connectionId, connectionId)) return;
  const row = rows.find((r) => r.library_id === np.libraryId && r.path === np.path);
  // This device's own row with no other place offers nothing (`offerOf`): no reads then.
  if (!row || (row.device_id === cachedDeviceId() && !row.other_place)) return;
  // Keyed by the answer's connection id (`heldListens`): the id the loaded book's connection
  // was migrated from or to answers for it too (`sameConnection`).
  const heldListen = held.get(contentKey(connectionId, np.libraryId, np.path));
  void Promise.all([getDeviceId(), readMirror(np.connectionId, np.libraryId, np.path)])
    .then(([deviceId, mirror]) => offerLoadedPlace(bookKey, row, deviceId, mirror, { heldListen }))
    .catch(() => undefined);
}

/** A guarded save of the loaded book that its server's row held back (fe#198): offered. */
function offerHeldSave(save: ProgressSave, row: Progress, mirror: ProgressSave | null) {
  const bookKey = selectBookKey(usePlayer.getState());
  if (!bookKey || bookKey !== contentKeyOf(save)) return;
  void offerLoadedPlace(bookKey, row, save.device_id, mirror, { held: true }).catch(
    () => undefined,
  );
}

/** The check that is out, if any: one at a time. */
let checking: Promise<void> | null = null;

/** The checks' triggers, by name (tests). */
export type ReconcileReason = 'foreground' | 'reconnect' | 'picked-up';

/** Ask the server about the loaded book and move it if another device moved on. Never
 * throws; resolves once the check is over (moved, stayed, or gave up). With a check already
 * out it resolves with that one: a Play press that waits for its check (`pickUpBeforePlay`)
 * waits for the one the app coming to the front started just before it. */
export async function reconcileLoadedPlace(reason: ReconcileReason): Promise<void> {
  if (checking) return checking;
  const player = usePlayer.getState();
  const np = player.nowPlaying;
  const bookKey = selectBookKey(player);
  if (!np || !bookKey || player.loadingBook || np.queue.total <= 0) return;
  const { state } = player.snapshot;
  // Only a book being picked up again: never one that has been playing on. The store says
  // when a play is a pick-up (`onPickedUpAgain`), as the engine plays or, for a Play press,
  // just before it is asked to.
  const settled = state === 'paused' || state === 'ready';
  if (reason === 'picked-up' ? state !== 'playing' && !settled : !settled) return;
  const client = resolveClient(np.connectionId);
  // Offline (a downloaded book with its server away): nothing to ask; saves go on.
  if (!client || !isReachable(np.connectionId)) return;

  const check = checkLoadedPlace(np, bookKey, client);
  checking = check;
  try {
    await check;
  } finally {
    if (checking === check) checking = null;
  }
}

/** The check itself (`reconcileLoadedPlace`): never throws. */
async function checkLoadedPlace(np: NowPlaying, bookKey: string, client: ApiClient): Promise<void> {
  const release = holdSaves();
  const moves = localMoveCount();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CHECK_TIMEOUT_MS);
  let moved = false;
  try {
    const [server, deviceId, mirror, skewMs] = await Promise.all([
      client.getProgress(np.libraryId, np.path, abort.signal),
      getDeviceId(),
      readMirror(np.connectionId, np.libraryId, np.path),
      knownSkew(np.connectionId),
    ]);
    if (abort.signal.aborted) return;
    moved = await moveOrOffer(np, bookKey, moves, server, deviceId, mirror, skewMs);
  } catch {
    // Unreachable, refused or too slow: stay where the engine is; the saves go on.
  } finally {
    clearTimeout(timer);
    // After a move the other device's place is already saved, and the engine may not
    // have reported the move yet: the next save comes from the engine itself.
    release({ flush: !moved });
  }
}

/** An answer waiting for its tick to end (`moveOrOffer`), and what deciding it comes to:
 * its own decision, or the newer answer's that replaced it (`settle`). `late`: a late
 * place's (`applyLatePlace`), weighed against this device's record as the start read it. */
type TickAnswer = {
  row: Progress | null;
  late: boolean;
  outcome: Promise<boolean>;
  settle: (moved: Promise<boolean>) => void;
};

function tickAnswer(row: Progress | null, late: boolean): TickAnswer {
  let settle: TickAnswer['settle'] = () => undefined;
  const outcome = new Promise<boolean>((resolve) => (settle = resolve));
  return { row, late, outcome, settle };
}

/** The answer for each book waiting for its tick to end (`moveOrOffer`). */
const tickAnswers = new Map<string, TickAnswer>();
/** The move or offer under way for each book (`moveOrOffer`). */
const deciding = new Map<string, Promise<boolean>>();

/** Whether the server's row `a` is at least as new as `b` (no row is the oldest). */
function asNew(a: Progress | null, b: Progress | null): boolean {
  if (!b) return true;
  if (!a) return false;
  const ta = timeOf(a.updated_at);
  const tb = timeOf(b.updated_at);
  return ta !== tb ? ta > tb : a.version >= b.version;
}

/**
 * Whether an answer with `row` takes the place of the one `waiting` for the tick's end: a
 * newer row does. The same row does too, unless that puts a check's answer in place of a late
 * place's: the two then differ only in what they are weighed against, and a check's record
 * holds the session's own saves since the start, of the place it started from, which read as
 * newer than the row (`applyLatePlace`). So the same row is decided the same way whichever
 * of the two came first.
 */
function replaces(row: Progress | null, late: boolean, waiting: TickAnswer): boolean {
  if (!asNew(row, waiting.row)) return false;
  return late || !waiting.late || !asNew(waiting.row, row);
}

/**
 * The reconcile's rule over the server's answer for the loaded book: moved to another
 * device's newer place (`placeToMoveTo`), else offered one (`offerLoadedPlace`). Not when
 * another book is loaded, nor once the listener moved since `moves` (theirs wins). Resolves
 * true when it moved.
 *
 * Answers for the book that come in the same tick (a late place and a check's, say) are
 * decided once, on the newest row (the same row: as the late place weighs it, `replaces`):
 * each was weighed against the place before the other's move, so both moved and both said
 * so. The others resolve as that one does (a check that read no move would let its held
 * saves go with the place before it). One that comes while another is being applied waits
 * for it, and then finds the book moved (the listener's moves count it).
 */
async function moveOrOffer(
  np: NowPlaying,
  bookKey: string,
  moves: number,
  server: Progress | null,
  deviceId: string,
  mirror: ProgressSave | null,
  skewMs: number,
  { late = false }: { late?: boolean } = {},
): Promise<boolean> {
  const waiting = tickAnswers.get(bookKey);
  if (waiting && !replaces(server, late, waiting)) return waiting.outcome;
  const answer = tickAnswer(server, late);
  tickAnswers.set(bookKey, answer);
  // The answer this one replaces comes to what this one does.
  waiting?.settle(answer.outcome);
  await Promise.resolve();
  if (tickAnswers.get(bookKey) !== answer) return answer.outcome;
  tickAnswers.delete(bookKey);
  // Every decision under way first: one begun while this waited for another is waited for
  // too, or the two would each move from the place before the other's move.
  for (let before = deciding.get(bookKey); before; before = deciding.get(bookKey)) {
    await before.catch(() => false);
  }
  const decided = decide(np, bookKey, moves, server, deviceId, mirror, skewMs, late);
  answer.settle(decided.catch(() => false));
  deciding.set(bookKey, decided);
  try {
    return await decided;
  } finally {
    if (deciding.get(bookKey) === decided) deciding.delete(bookKey);
  }
}

/** `moveOrOffer`'s rule for one answer. */
async function decide(
  np: NowPlaying,
  bookKey: string,
  moves: number,
  server: Progress | null,
  deviceId: string,
  mirror: ProgressSave | null,
  skewMs: number,
  late: boolean,
): Promise<boolean> {
  const now = usePlayer.getState();
  if (selectBookKey(now) !== bookKey || localMoveCount() !== moves) return false;
  // A book that played to its end stays there: its finish is already sent.
  if (now.snapshot.state === 'ended') return false;
  // The engine plays another book (Android's car started it, adopted or not yet): a move,
  // or an offer's Jump, would seek that book, not this one.
  if (engineHoldsOtherBook()) return false;
  const from = selectBookPosition(now);
  const to = placeToMoveTo({ server, deviceId, mirror, enginePosition: from, skewMs, late });
  if (to === null) {
    // Sync v2: a place another device left that the server did not move to is offered (never
    // one with no device id, a late place's neither).
    await offerLoadedPlace(bookKey, server, deviceId, mirror);
    return false;
  }
  // The row it moved to is the place this device has now seen (Sync v2's ack), acknowledged
  // as a Jump is (`answerAfterSpan`): once the span heard before the move is in, so that span
  // goes on the version it was heard on and only the move's own on the row's.
  if (server && server.version > 0) {
    // The answer waits its turn: another book, or a move of the listener's own, since wins,
    // and then the row is not acknowledged either (this device never moved to it).
    const overtaken = () =>
      selectBookKey(usePlayer.getState()) !== bookKey || localMoveCount() !== moves;
    await answerAfterSpan(np, async () => {
      if (overtaken()) return;
      await ackVersion(np.connectionId, np.libraryId, np.path, server.version, server).catch(
        () => undefined,
      );
    });
    if (overtaken()) return false;
  }
  await usePlayer.getState().seekBook(to);
  tell(bookKey, from, to);
  return true;
}

/**
 * A downloaded book that started without its server's place (`onLatePlace`: the server had
 * not answered within the start's wait) gets it after all: the same rule as a check's answer,
 * weighed against this device's record as the start read it (`LatePlace.mirror`: the
 * session's own saves since are of the older place it started from, and would always read as
 * newer). A seek of the listener's own made meanwhile wins, and so does an offer of the same
 * row shown or answered since (Jump, Stay or ignored: `answeredSince`), which the move would
 * otherwise overrule. The start's saves then go unguarded (`placeChecked`) unless the answer
 * holds a further place the book stayed short of. Never throws.
 */
async function applyLatePlace(
  bookKey: string,
  { server, mirror }: LatePlace,
  moves: number,
): Promise<void> {
  const np = usePlayer.getState().nowPlaying;
  if (!np) return;
  try {
    const [deviceId, current, skewMs] = await Promise.all([
      getDeviceId(),
      readMirror(np.connectionId, np.libraryId, np.path),
      knownSkew(np.connectionId),
    ]);
    if (answeredSince(bookKey, server, current)) return;
    const moved = await moveOrOffer(np, bookKey, moves, server, deviceId, mirror, skewMs, {
      late: true,
    });
    // The start's place is checked now (the replay guard, fe#198): unless the answer holds
    // another device's place further on that the book stayed short of (the listener's own
    // seek won, or it was offered), its saves go unguarded.
    const now = usePlayer.getState();
    if (selectBookKey(now) !== bookKey) return;
    const at = { position: selectBookPosition(now), device_id: deviceId, finished: false };
    if (moved || !guardHolds(at, server, current?.answered)) placeChecked(bookKey);
  } catch {
    // Stays where it is; the saves go on (guarded: the start was not checked, fe#198).
  }
}

/** True when the listener has already been offered `row` (this launch, `shownOffers`) or has
 * answered it (`current`, this device's record now: its version acknowledged, or its key
 * noted), so a late answer of the same row neither moves the book nor offers it again. */
function answeredSince(
  bookKey: string,
  row: Progress | null,
  current: Pick<ProgressSave, 'ack_version' | 'answered' | 'ignored'> | null,
): boolean {
  if (!row) return false;
  const key = placeKey(row);
  if (shownOffers.has(`${bookKey}|${key}`)) return true;
  if (settledOffers(current).includes(key)) return true;
  return row.version > 0 && (current?.ack_version ?? 0) >= row.version;
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
  quietly(player.seekBook(from));
}

/**
 * Start the triggers for the life of the app; returns the release. Shared: the root layout
 * starts them, and so does the car's headless task (a book the car started is picked up from
 * another device's newer place there too). They run once until the last holder releases
 * them: two would race for `onPickedUpAgain`'s one slot, and either's teardown would clear it.
 */
export const startPlaceReconcile = sharedStart(runPlaceReconcile);

function runPlaceReconcile(): () => void {
  const stops: (() => void)[] = [];
  stops.push(onPickedUpAgain(() => reconcileLoadedPlace('picked-up')));
  // A downloaded book whose server answered only after it started.
  stops.push(onLatePlace(applyLatePlace));
  // On the foreground, once the address runner has checked the network: a home address
  // checked on the network the device was on before it was suspended goes first.
  stops.push(
    onForeground(() => void networkChecked().then(() => reconcileLoadedPlace('foreground'))),
  );
  stops.push(
    onReconnect((cid) => {
      // Told the id now: a book loaded before another tab's migration names the old one.
      const np = usePlayer.getState().nowPlaying;
      if (np && sameConnection(np.connectionId, cid)) {
        void reconcileLoadedPlace('reconnect');
      }
    }),
  );
  // Sync v2: each sync answer's row for the loaded book may carry a place to offer.
  stops.push(onSyncAnswer(offerFromAnswer));
  // The legacy PUT path: a save the replay guard held back offers the place that held it.
  stops.push(onHeldSave(offerHeldSave));
  return () => {
    for (const stop of stops) stop();
  };
}
