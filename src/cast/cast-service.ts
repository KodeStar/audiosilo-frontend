import { resolveConnectionId } from '@/lib/connection-id';
import { contentKeyOf } from '@/lib/content-key';
import { isEarlyTranscodeEnd } from '@/playback/transcode';
import {
  type BookRef,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackState,
  type PlaybackTrack,
} from '@/playback/types';

import {
  castStreamOffset,
  castTrackIndex,
  castUrlIndex,
  isUnaskedJump,
  itemStartingAt,
  type SeenPlace,
  streamIdentity,
} from './cast-media';
import type { PrepareCast } from './cast-prepare';
import type { CastItem, CastMediaStatus, CastRemote } from './types';

/** How long (ms) a move the JS asked for may take to show in the receiver's status before
 * a different place counts as someone else's move again. */
const ASKED_MOVE_MS = 8_000;

/** How far (seconds) before where the receiver was when a move was asked a status on that file
 * may be and still be the replaced media playing on there (`skippedPast`). */
const JUMP_SLACK_S = 1;

/** How recent (ms) the last sighting of the receiver playing must be for an early `finished`
 * to reload there and play on: an older one (an iPhone that suspended the sender) is a
 * place the listener may long have passed, so the book comes back paused there instead. Also
 * how recent one must be for the phone to count as watching the receiver (`watching`). */
const EARLY_END_FRESH_MS = 15_000;

/** How often (ms) at most the receiver's queue is loaded again with a newly minted cast token
 * after the receiver was refused (`freshToken`), for each book, while the last token minted
 * has not played yet: a load that fails for another reason (a codec the receiver can't play)
 * must not mint a token on every try, a Retry that loads the book again included, since each
 * one minted can end another receiver's (the server keeps the 20 most recently used per device
 * and 100 per person). A minted token the receiver went on to play at the place this phone
 * meant is a good one, and its own refusal later (the server ended it in turn) mints at once,
 * though never a third time within this long: a receiver that plays each new token a while
 * and then errs for another reason (a network that drops) would otherwise mint on every
 * error. */
export const REMINT_EVERY_MS = 60_000;

/** The receiver took a queue but reported an error while its load was in flight: the Default
 * Media Receiver skips an item it is refused and tries the next, so the load can still
 * resolve, on a later file than the one asked for. Handled as a refused load (`sendQueue`).
 * `queue` is the refused queue's number (`queueSeq`). */
class ReceiverRefused extends Error {
  constructor(readonly queue: number) {
    super('LOAD_REFUSED');
  }
}

/** Where this phone means the receiver to be (`intended`): the place a load, seek or file
 * jump it sent asked for, or the start of the next file once one ended. `landed` once the
 * receiver reported playing or paused on that file; until then a refused file's reload goes
 * back there, not to the later file the receiver skipped on to. `elsewhere`: before it
 * landed, the receiver reported playing or paused on another file (`followIntent`). */
type Intent = {
  trackIndex: number;
  position: number;
  at: number;
  landed: boolean;
  elsewhere?: boolean;
  /** Where the receiver was when the move was asked (the snapshot's place): the media a queue
   * in flight replaces can still report playing on there (`skippedPast`). */
  from: { trackIndex: number; position: number };
};

/** The book loaded on the receiver: what was sent, so a seek into a transcoded file or a
 * jump to another file can reload it, and a status can be mapped back. */
type Loaded = {
  tracks: PlaybackTrack[];
  book: BookRef;
  items: CastItem[];
  /** The URLs sent, by track index (a transcoded item's `&t=` included). */
  urls: string[];
  /** Per track: the file position the receiver's time 0 stands for (a transcoded item
   * requested mid-file; 0 otherwise). */
  offsets: number[];
};

/**
 * Map the receiver's player state onto the store's. The receiver's `buffering` while it was
 * playing stays `playing`: the receiver owns its buffer (a seek on a LAN, a Wi-Fi blip) and
 * the store's 3 s stall watchdog would otherwise call a normal buffer a dead stream. Idle is
 * by reason: `finished` on the last file is the book's end (on an earlier file the receiver
 * is moving on to the next: `loading`; one well before the last file's end is a stream that
 * died, which the service checks before taking it: `endedEarly`), `error` an error, and a stop from elsewhere
 * (`cancelled`, `interrupted`: the TV remote's stop, another sender) a pause, which the next
 * play reloads at the same place.
 */
export function castState(
  status: CastMediaStatus,
  ctx: { prev: PlaybackState; lastTrack: boolean; loading: boolean },
): PlaybackState {
  switch (status.playerState) {
    case 'playing':
      return 'playing';
    case 'paused':
      return 'paused';
    case 'buffering':
      return ctx.prev === 'playing' ? 'playing' : 'loading';
    case 'loading':
      return 'loading';
    case 'idle':
    default:
      switch (status.idleReason) {
        case 'finished':
          return ctx.lastTrack ? 'ended' : 'loading';
        case 'error':
          return 'error';
        case 'cancelled':
        case 'interrupted':
          return 'paused';
        default:
          return ctx.loading ? 'loading' : 'idle';
      }
  }
}

/** A book's key with its connection id resolved (a receiver's `customData` can name a legacy
 * connection id, from a load before the identity migration). */
function castBookKey(book: BookRef): string {
  return contentKeyOf({ ...book, connectionId: resolveConnectionId(book.connectionId) });
}

/** The same book of the same person (`castBookKey`). */
function sameBook(a: BookRef, b: BookRef): boolean {
  return castBookKey(a) === castBookKey(b);
}

/** Whether the receiver plays media that is not this loaded book: another AudioSilo
 * sender's book (its items name it), or any other app's media on the same Default Media
 * Receiver (its items name nothing of ours, and its URL is not one of our streams). A
 * status naming no URL can't be told apart, and counts as ours. */
function isForeign(status: CastMediaStatus, loaded: Loaded): boolean {
  if (status.book) return !sameBook(status.book, loaded.book);
  if (!status.contentId) return false;
  const id = streamIdentity(status.contentId);
  return !loaded.urls.some((u) => streamIdentity(u) === id);
}

/**
 * Casting as a playback route (decision 7: not a second player). Implements the same
 * `PlaybackService` the local engines do, over one connected session's `CastRemote`, so the
 * store drives the receiver exactly as it drives the phone: its saves, resume floor, stall
 * watchdog and chapter UI read the snapshot this emits, in the same per-track coordinates
 * (the receiver's queue has one item per track, in track order).
 *
 * Not while casting: Smart speed, Voice boost and auto-rewind (`configure` keeps the config
 * but the receiver plays plain audio), and the volume (`setVolume` is a no-op: the only
 * caller is the sleep timer's fade, and the receiver's volume is the TV's own, which a fade
 * and its restore to full must never touch; the timer still pauses the cast).
 *
 * Moves nobody here asked for (the TV remote, Google Home, the Cast notification, a
 * suspended iPhone coming back to a receiver that played on) are reported through
 * `onRemoteMove` once seen, as the native engines report the lock screen's, so the store
 * lowers its resume floor to them and saves.
 */
export class CastPlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private unsubs: (() => void)[] = [];
  private loaded: Loaded | null = null;
  private loadsInFlight = 0;
  /** Bumped by every `load` and `reset`: a load whose number moved on while it prepared (a
   * newer book was started, or the route was reset) stands back, never sending its queue
   * over the newer one or taking `loaded` from it. */
  private loadSeq = 0;
  /** Bumped by every queue sent: the receiver answers a LOAD a newer one replaced with a
   * rejection (both SDKs), which is that newer one's business, not a failure. */
  private queueSeq = 0;
  /** The receiver has no media of ours (stopped from elsewhere): the next play reloads. */
  private needsReload = false;
  /** The receiver plays another sender's book (another person's phone loaded theirs): its
   * statuses and progress are not this book's place, so they are ignored until this phone
   * loads (`sendQueue`) or adopts (`adoptQueue`) a book again. */
  private foreignMedia = false;
  private seen: SeenPlace | null = null;
  /** The place the last early-end reload started from (`isEarlyTranscodeEnd`): a stream that
   * ends again without real progress past it is the book's end after all. */
  private earlyEndRetryAt: number | null = null;
  private askedMove: { until: number } | null = null;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  /** When the JS last set the speed: a status still carrying the old one is not the
   * receiver changing it. */
  private rateAskedAt = 0;
  /** The book (`castBookKey`) a cast token was last minted again for a refused receiver, when
   * (`freshToken`), whether the receiver has played with that token since (`notePlayed`), and
   * when the mint before it was for the same book (`prev`): kept across loads and resets, so a
   * book loaded again mints no sooner than `REMINT_EVERY_MS` later unless its token played,
   * and never a third time within it; another book may mint at once. */
  private reminted: { book: string; at: number; played: boolean; prev?: number } | null = null;
  /** The mint on its way (`freshToken`) and the queue it is for, which a second refused send
   * of that queue waits on too. */
  private minting: { loaded: Loaded; done: Promise<boolean> } | null = null;
  /** Whether the book should be playing: the latest settled word from either side, this
   * phone's command (`play`; `pause` or a `load`, which is sent paused) or the receiver's
   * own `playing`, `paused` or stop (the TV remote, Google Home) or the book's end, read when
   * no load of ours is in flight (`onStatus`, `stopped`); for a session it did not load and no
   * word came since, the play state it was taken over in (`adoptQueue`); null when none is
   * known. A queue sent again plays by it (`playOn`): the receiver's status reads
   * `buffering` or `loading` while it takes a seek or a load, whichever play state it ends
   * in. */
  private playIntent: boolean | null = null;
  /** Where this phone means the receiver to be (`Intent`); null when nothing was asked (an
   * adopted session the receiver named no file for, or after a reset). */
  private intended: Intent | null = null;
  /** The queue (`queueSeq`) the receiver reported an error for while a load of ours was in
   * flight, and when: that load is a refused one (`ReceiverRefused`), and the receiver's
   * statuses while it is sent again (the later files it skips on to) are not the book's
   * place, for at most `ASKED_MOVE_MS` after the error (a load the receiver never answers
   * must not hide its statuses for good). */
  private refusedQueue: { seq: number; at: number } | null = null;
  /** Bumped by every status that named a file of the loaded book and placed the snapshot
   * there: a book's load refused to the end reads it to tell whether the receiver has said
   * where it is in that book (`load`). A progress tick names no file and does not count. */
  private statusPlaces = 0;

  constructor(
    private readonly remote: CastRemote,
    private readonly prepare: PrepareCast,
    private readonly now: () => number = Date.now,
  ) {
    this.unsubs.push(
      remote.onStatus((s) => this.onStatus(s)),
      remote.onProgress((p) => this.onProgress(p)),
    );
  }

  /** Stop listening to the remote (the session ended). */
  detach() {
    for (const u of this.unsubs) u();
    this.unsubs = [];
  }

  /** Read the receiver's status now (bounded) and fold it in, so the place handed back to
   * the phone or saved before iOS suspends the app is the receiver's latest. Not one read
   * while a queue was sent (or the route was reset): that is the receiver before it took the
   * queue, and an error it still says would count as that queue's refusal (`refusedQueue`). */
  async refresh(): Promise<void> {
    const queue = this.queueSeq;
    const s = await this.remote.readStatus().catch(() => null);
    if (s && queue === this.queueSeq) this.onStatus(s, true);
  }

  /**
   * Give a session the app did not load (it was relaunched mid-cast) its queue, so seeks
   * and file jumps can reload it: the tracks the store built for the receiver's book.
   */
  async adoptQueue(
    tracks: PlaybackTrack[],
    book: BookRef,
    status?: CastMediaStatus,
  ): Promise<void> {
    const seq = this.loadSeq;
    const loaded = await this.prepareLoaded(tracks, book);
    // A book loaded (or a reset) while this one prepared owns the receiver now.
    if (seq !== this.loadSeq) return;
    // A transcoded item the receiver was given mid-file counts from its `&t=`: without that
    // offset every place read from the receiver would be that far early (and saved so).
    const index = status ? castTrackIndex(status, loaded.urls) : null;
    this.intended = null;
    if (status && index !== null) {
      loaded.offsets[index] = castStreamOffset(status);
      const position = Number.isFinite(status.position) ? status.position : 0;
      this.intend(index, position + loaded.offsets[index], true);
    }
    this.foreignMedia = false;
    this.earlyEndRetryAt = null;
    // Taken over playing or paused, as the store adopted it (`adoptReceiverBook`), unless a
    // play or pause from this phone came since that status was read: the command stands.
    this.playIntent ??= status
      ? status.playerState === 'playing' || status.playerState === 'buffering'
      : null;
    this.loaded = loaded;
  }

  // --- PlaybackService ----------------------------------------------------

  async setup() {}

  async configure(_config: PlaybackConfig) {
    // Auto-rewind, Smart speed and Voice boost are the phone engine's: the receiver plays
    // plain audio. The skip lengths are applied by the store itself.
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    _chapters?: PlaybackChapter[],
    book?: BookRef,
  ) {
    if (!book) throw new Error('A cast needs the book it is loading');
    const seq = ++this.loadSeq;
    this.earlyEndRetryAt = null;
    this.playIntent = false;
    this.loadsInFlight++;
    try {
      const loaded = await this.prepareLoaded(tracks, book);
      // A newer load (or a reset) came while this one prepared (its cast token can take a
      // round trip a cached one doesn't): it owns the receiver, this one stands back.
      if (seq !== this.loadSeq) return;
      this.loaded = loaded;
      const ready = () =>
        this.update({
          state: 'ready',
          trackIndex: startIndex,
          position: positionInTrack,
          duration: tracks[startIndex]?.duration ?? 0,
        });
      const placed = this.statusPlaces;
      let sent: boolean;
      try {
        sent = await this.sendQueue(startIndex, positionInTrack, false);
      } catch (err) {
        // The receiver took the queue but was refused a file of it and went on to a later
        // one (`ReceiverRefused`; its status, read again, shows where): it holds this book, so
        // the load stands. A failed load hands the book back to the phone
        // (`RoutedPlaybackService`), which would leave the receiver playing out of reach.
        if (!(err instanceof ReceiverRefused)) throw err;
        // Until a status says where (the read can come back empty), it stands at the place
        // asked for, ready: a tick taken since the hold on it ended (`holdingAsked`) names no
        // file, and can be the last book's.
        if (seq === this.loadSeq && placed === this.statusPlaces) ready();
        return;
      }
      if (!sent || seq !== this.loadSeq) return;
      ready();
    } finally {
      this.loadsInFlight--;
    }
  }

  async play() {
    this.playIntent = true;
    if (this.needsReload && this.loaded) {
      await this.sendQueue(this.snapshot.trackIndex, this.snapshot.position, true);
      return;
    }
    await this.remote.play();
  }

  async pause() {
    this.playIntent = false;
    // Another sender's book is on the receiver: ours is already paused, theirs is theirs.
    if (this.foreignMedia) return;
    await this.remote.pause();
  }

  async seekTo(positionInTrack: number) {
    this.earlyEndRetryAt = null;
    if (this.foreignMedia) {
      // Ours waits for the next play, which loads it back at this place (`needsReload`).
      this.update({ position: positionInTrack });
      this.see();
      return;
    }
    const item = this.loaded?.items[this.snapshot.trackIndex];
    this.askMove();
    if (item?.transcoded || this.needsReload) {
      // The receiver can't seek a transcoded stream: ask for it from there. A newer queue
      // (or a reset) that replaced this one has the place now.
      if (!(await this.sendQueue(this.snapshot.trackIndex, positionInTrack, this.playOn()))) {
        return;
      }
    } else {
      this.intend(this.snapshot.trackIndex, positionInTrack);
      await this.remote.seek(positionInTrack);
    }
    this.update({ position: positionInTrack });
    this.see();
  }

  async skipToTrack(index: number, positionInTrack = 0) {
    if (!this.loaded) return;
    this.earlyEndRetryAt = null;
    if (this.foreignMedia) {
      // As `seekTo`: the next play loads ours back there.
      this.update({
        trackIndex: index,
        position: positionInTrack,
        duration: this.loaded.tracks[index]?.duration ?? 0,
      });
      this.see();
      return;
    }
    this.askMove();
    // The v4 native SDK has no "jump to item": reload the queue from there (it keeps the
    // speed and the play state). A newer queue (or a reset) that replaced it wins.
    if (!(await this.sendQueue(index, positionInTrack, this.playOn()))) return;
    this.update({
      trackIndex: index,
      position: positionInTrack,
      duration: this.loaded.tracks[index]?.duration ?? 0,
    });
    this.see();
  }

  async setRate(rate: number) {
    // Held at once (emitted once the receiver took it): a status or a reload meanwhile
    // already reads the asked speed.
    this.snapshot = { ...this.snapshot, rate };
    this.rateAskedAt = this.now();
    // Another sender's book keeps its own speed: ours goes with our next load.
    if (!this.foreignMedia) await this.remote.setRate(rate).catch(() => undefined);
    this.update({ rate });
  }

  async setVolume() {
    // Deliberately nothing: see the class comment (the receiver's volume is the TV's).
  }

  async reset() {
    this.loadSeq++;
    this.queueSeq++;
    this.loaded = null;
    this.seen = null;
    this.earlyEndRetryAt = null;
    this.needsReload = false;
    this.intended = null;
    this.refusedQueue = null;
    // The next book's play state is its own (`adoptQueue` takes the one it is taken over in).
    this.playIntent = null;
    // Another sender's book on the receiver is theirs: only ours is ever stopped (and
    // theirs stays ignored until this phone loads a book again, `sendQueue`).
    if (!this.foreignMedia) await this.remote.stop().catch(() => undefined);
    this.update({ ...INITIAL_SNAPSHOT, rate: this.snapshot.rate });
  }

  onRemoteMove(handler: ((trackIndex: number, positionInTrack: number) => void) | null) {
    this.remoteMove = handler;
  }

  onRateChange(handler: ((rate: number) => void) | null) {
    this.rateChange = handler;
  }

  adoptPlace(snapshot: PlaybackSnapshot) {
    this.snapshot = { ...snapshot };
    this.see();
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener: (s: PlaybackSnapshot) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- internals ------------------------------------------------------------

  /** Whether a queue sent again (a seek into a transcoded file, a file jump, a refused
   * receiver's reload) should play: the play intent, else (an adopted session no word came
   * for yet) whether the book plays now. */
  private playOn(): boolean {
    return this.playIntent ?? this.snapshot.state === 'playing';
  }

  /** Our book is off the receiver (stopped from elsewhere, or an early end not reloaded): it
   * waits paused, and the next play loads it again. */
  private stopped() {
    this.needsReload = true;
    this.playIntent = false;
  }

  private askMove() {
    this.askedMove = { until: this.now() + ASKED_MOVE_MS };
  }

  /** Mean the receiver to be at `(trackIndex, position)` from now on (`landed`: it is). */
  private intend(trackIndex: number, position: number, landed = false) {
    this.intended = {
      trackIndex,
      position: Math.max(0, position),
      at: this.now(),
      landed,
      from: { trackIndex: this.snapshot.trackIndex, position: this.snapshot.position },
    };
  }

  /**
   * Follow the receiver's own moves in `intended` (no load of ours in flight). A file that
   * ended (`finished`), or a status already naming the next file after the one the receiver
   * played, means the start of that next file. Playing or paused on the meant file lands it.
   * Playing or paused on another file is followed (the TV remote, Google Home, a run-on) once
   * the meant file landed or `ASKED_MOVE_MS` went by; before that it is a file the receiver
   * skipped on to after being refused the meant one, which the error reloads from, and is
   * noted (`elsewhere`) for `refusedPlace`. A status with no position of its own (`position`
   * is then the snapshot's, maybe another file's) moves no place.
   */
  private followIntent(status: CastMediaStatus, index: number, position: number, last: number) {
    const want = this.intended;
    const settled = status.playerState === 'playing' || status.playerState === 'paused';
    if (status.playerState === 'idle') {
      if (status.idleReason === 'finished' && index < last) this.intend(index + 1, 0);
      return;
    }
    const at = Number.isFinite(status.position) ? position : 0;
    if (want && index === want.trackIndex) {
      // A buffering receiver can report 0 before it reaches the asked place.
      if (at > 0) want.position = at;
      if (settled) want.landed = true;
    } else if (want?.landed && index === want.trackIndex + 1) {
      this.intend(index, settled ? at : 0, settled);
    } else if (settled) {
      if (!want || want.landed || this.now() - want.at >= ASKED_MOVE_MS) {
        this.intend(index, at, true);
      } else {
        want.elsewhere = true;
      }
    }
  }

  /** Whether the receiver's statuses and progress are the files it skips on to after being
   * refused the queue that is being sent again (`refusedQueue`), not the book's place: bounded
   * by `ASKED_MOVE_MS` after the error, so a load the receiver never answers hides nothing for
   * good. */
  private skippingRefused(): boolean {
    const refused = this.refusedQueue;
    return (
      this.loadsInFlight > 0 &&
      refused?.seq === this.queueSeq &&
      this.now() - refused.at < ASKED_MOVE_MS
    );
  }

  /** The queue being sent is a refused one (`ReceiverRefused`), from the first sign of it. */
  private refuseQueue() {
    if (this.refusedQueue?.seq !== this.queueSeq) {
      this.refusedQueue = { seq: this.queueSeq, at: this.now() };
    }
  }

  /** Whether a status on file `index` says the receiver went past the file this phone means
   * (`intended`) before it ever played or paused there: playing or paused on a later file
   * (`within`: less than that long after the move). The Default Media Receiver goes on to the
   * next file it can play when it is refused one, from that file's start: the file the receiver
   * was on when the move was asked, at or past where it was then, is the replaced media playing
   * on. A buffering or loading one is no sign: a new media session's first status can still name
   * the media it replaces, and the native SDK's status carries no session id to tell them apart. */
  private skippedPast(status: CastMediaStatus, index: number, within = Infinity): boolean {
    const want = this.intended;
    if (!want || want.landed || index <= want.trackIndex) return false;
    if (status.playerState !== 'playing' && status.playerState !== 'paused') return false;
    const at = Number.isFinite(status.position) ? status.position : 0;
    const runningOn =
      index === want.from.trackIndex && at > 0 && at >= want.from.position - JUMP_SLACK_S;
    return !runningOn && this.now() - want.at < within;
  }

  /** Whether a status in flight names a URL none of the loaded queue's: the queue it replaces,
   * sent with the token before a mint, whose files the receiver can still be going through.
   * Not while the mint is on its way (`loaded` is still that queue). */
  private ofReplacedQueue(status: CastMediaStatus, loaded: Loaded): boolean {
    return !this.minting && !!status.contentId && castUrlIndex(status.contentId, loaded.urls) < 0;
  }

  /** A status while a load of ours is in flight that names the meant file playing or paused
   * lands it (`followIntent` reads none in flight, and the receiver sends no more once it
   * simply plays), and a token played so is a good one (`notePlayed`). */
  private landInFlight(status: CastMediaStatus, index: number, loaded: Loaded) {
    const want = this.intended;
    if (!want || want.landed || index !== want.trackIndex) return;
    if (status.playerState !== 'playing' && status.playerState !== 'paused') return;
    // The media it replaces on the same file (a transcoded item asked from another `&t=`).
    if (status.contentId && status.contentId !== loaded.urls[index]) return;
    want.landed = true;
    const at = Number.isFinite(status.position) ? status.position + loaded.offsets[index] : 0;
    if (at > 0) want.position = at;
    if (status.playerState === 'playing') this.notePlayed(status, loaded, index);
  }

  /** Whether the snapshot holds the place a queue in flight asked for (`sendQueueOnce`) against
   * the receiver: until the receiver plays or pauses there (`landInFlight`), its statuses and
   * ticks are the media the queue replaces (its stop, its file, its place), a file it skips on
   * to, or name no file, and are never the book's place. For at most `ASKED_MOVE_MS` after the
   * move: a load the receiver never answers must not hide them for good. */
  private holdingAsked(): boolean {
    const want = this.intended;
    return this.loadsInFlight > 0 && !!want && !want.landed && this.now() - want.at < ASKED_MOVE_MS;
  }

  /** Whether the phone has been following the receiver just now (a status or a progress tick
   * within `EARLY_END_FRESH_MS`): it would have seen the receiver play any file it did. */
  private watching(): boolean {
    return !!this.seen && this.now() - this.seen.at <= EARLY_END_FRESH_MS;
  }

  /**
   * Where to load the queue again after the receiver stopped on an error naming file `index`
   * at `reported`. The meant place while it has not landed (a move, or the next file after
   * one that ended: the receiver skips a file it is refused and errs on a later one). Past
   * the meant file it landed on, while the phone was watching: the next file after it, from
   * its start (the receiver could not have played one in between unseen). Otherwise the
   * error's own file, where it was last seen on it when the receiver reports less (it
   * reports 0 once idle): so too when the meant place never landed but the receiver played
   * or paused on another file (`elsewhere`) and the error came `ASKED_MOVE_MS` or more after
   * the move, as `followIntent` would have followed it had another status come (the receiver
   * sends none while it simply plays). For the same reason a move can land unseen (its
   * `playing` came while the load that asked was in flight, and no status since): that long
   * after the move, the meant file is reloaded where the ticks since last put it.
   */
  private refusedPlace(index: number, reported: number): { trackIndex: number; position: number } {
    const want = this.intended;
    if (want && !want.landed) {
      const late = this.now() - want.at >= ASKED_MOVE_MS;
      if (!want.elsewhere || !late) {
        const seen = late && this.seen?.trackIndex === want.trackIndex ? this.seen.position : 0;
        return { trackIndex: want.trackIndex, position: Math.max(want.position, seen) };
      }
    } else if (want && index > want.trackIndex && this.watching()) {
      return { trackIndex: want.trackIndex + 1, position: 0 };
    }
    const seen = this.seen?.trackIndex === index ? this.seen : null;
    return { trackIndex: index, position: Math.max(reported, seen?.position ?? 0) };
  }

  /** The receiver's queue for a book, as sent from its start (no item requested mid-file). */
  private async prepareLoaded(
    tracks: PlaybackTrack[],
    book: BookRef,
    opts?: { freshToken?: boolean },
  ): Promise<Loaded> {
    const { items } = await this.prepare(tracks, book, opts);
    return { tracks, book, items, urls: items.map((i) => i.url), offsets: items.map(() => 0) };
  }

  /** Whether a refused receiver may be given a newly minted token for the loaded book now:
   * once per token minted, a token that never played once per `REMINT_EVERY_MS`, and never
   * more than two within it. */
  private remintDue(): boolean {
    const loaded = this.loaded;
    if (!loaded) return false;
    const last = this.reminted;
    if (!last || last.book !== castBookKey(loaded.book)) return true;
    const now = this.now();
    if (now - last.at >= REMINT_EVERY_MS) return true;
    return last.played && (last.prev === undefined || now - last.prev >= REMINT_EVERY_MS);
  }

  /**
   * The loaded queue again, its URLs carrying a newly minted cast token (fe#158): the server
   * caps the cast tokens of a device and of a person and ends the least recently used, which a
   * receiver may still be playing with, so its next file, seek or load is refused while the
   * cache still holds that token. Resolves whether the queue was swapped (false: not due, the
   * mint failed, or another book or a reset took the receiver meanwhile). One mint at a time
   * for a loaded queue: sent again and refused while one is on its way (a second seek, sent
   * with the token being replaced), it waits on that one and is sent again after the first, so
   * the later move is the one the receiver ends on. Another book loaded meanwhile asks for its
   * own.
   */
  private freshToken(): Promise<boolean> {
    const loaded = this.loaded;
    if (!loaded) return Promise.resolve(false);
    if (this.minting?.loaded === loaded) return this.minting.done;
    const done = this.mintFresh().finally(() => {
      if (this.minting?.done === done) this.minting = null;
    });
    this.minting = { loaded, done };
    return done;
  }

  private async mintFresh(): Promise<boolean> {
    const loaded = this.loaded;
    if (!loaded || !this.remintDue()) return false;
    const book = castBookKey(loaded.book);
    const prev = this.reminted?.book === book ? this.reminted.at : undefined;
    this.reminted = { book, at: this.now(), played: false, prev };
    const seq = this.loadSeq;
    this.loadsInFlight++;
    try {
      const fresh = await this.prepareLoaded(loaded.tracks, loaded.book, {
        freshToken: true,
      }).catch(() => null);
      if (!fresh || seq !== this.loadSeq || this.loaded !== loaded) return false;
      this.loaded = fresh;
      return true;
    } finally {
      this.loadsInFlight--;
    }
  }

  /** Load the queue on the receiver starting at `(index, position)`; a load the receiver
   * refuses (it rejects the load, or errs while it is in flight: `ReceiverRefused`) is sent
   * once more with a newly minted token (`freshToken`) before it fails. A refused load that
   * fails reads the receiver's status, so the place shown is the file it went on to.
   * Resolves whether this is still the latest queue sent (false: a newer one replaced it,
   * and the receiver's rejection of this one was that one's doing). */
  private async sendQueue(index: number, position: number, autoplay: boolean): Promise<boolean> {
    try {
      return await this.sendQueueOnce(index, position, autoplay);
    } catch (err) {
      if (!(await this.freshToken())) throw this.onRefused(err);
      return this.sendQueueOnce(index, position, autoplay).catch((again: unknown) => {
        throw this.onRefused(again);
      });
    }
  }

  /** A load that failed: when the receiver erred on it (`ReceiverRefused`) it may have gone on
   * to a later file, so its statuses count again (`refusedQueue`) and its status is read again
   * for the place shown. Returns `err`. */
  private onRefused(err: unknown): unknown {
    if (err instanceof ReceiverRefused) {
      if (this.refusedQueue?.seq === err.queue) this.refusedQueue = null;
      void this.refresh();
    }
    return err;
  }

  private async sendQueueOnce(
    index: number,
    position: number,
    autoplay: boolean,
  ): Promise<boolean> {
    const loaded = this.loaded;
    if (!loaded) return false;
    const q = ++this.queueSeq;
    this.foreignMedia = false;
    const i = Math.max(0, Math.min(index, loaded.items.length - 1));
    const start = itemStartingAt(loaded.items[i], position);
    const items = loaded.items.map((it, n) => (n === i ? start.item : it));
    loaded.urls = items.map((it) => it.url);
    loaded.offsets = items.map((_, n) => (n === i ? start.offset : 0));
    this.askMove();
    this.intend(i, position);
    // The place asked for is the book's from now, as a local engine's file load shows it: until
    // the receiver lands it, its statuses and ticks are the media this queue replaces
    // (`holdingAsked`), whose place must never be saved or end a listening span.
    this.update({
      trackIndex: i,
      position: Math.max(0, position),
      duration: loaded.tracks[i]?.duration ?? 0,
    });
    // By the play intent as it is now (`autoplay` for a session no word came for): a play or
    // pause may have come while the caller minted a token.
    const play = this.playIntent ?? autoplay;
    this.loadsInFlight++;
    try {
      try {
        await this.remote.load({
          items,
          startIndex: i,
          startTime: start.offset > 0 ? 0 : Math.max(0, position),
          rate: this.snapshot.rate,
          autoplay: play,
          book: loaded.book,
          title: loaded.tracks[0]?.album || loaded.tracks[0]?.title || '',
        });
      } catch (err) {
        if (q !== this.queueSeq) return false;
        throw err;
      }
      if (q !== this.queueSeq) return false;
      // Its statuses stay ignored while it is sent again with a new token (the mint is a round
      // trip, while the receiver plays on into later files): `onRefused` lifts it on a failure.
      if (this.refusedQueue?.seq === q) throw new ReceiverRefused(q);
      this.needsReload = false;
      // A play or pause asked for while the queue was on its way went to the media it replaced.
      if (this.playIntent !== null && this.playIntent !== play) {
        void (this.playIntent ? this.remote.play() : this.remote.pause()).catch(() => undefined);
      }
      return true;
    } finally {
      this.loadsInFlight--;
    }
  }

  /** A status the receiver sent, or one read (`read`, `refresh`): the SDK's last, which can be
   * the media a queue in flight replaces, so it never makes that queue a refused one. */
  private onStatus(status: CastMediaStatus | null, read = false) {
    if (!status) {
      // No media on the receiver: whatever was playing was stopped from elsewhere.
      if (this.loaded && this.loadsInFlight === 0) {
        this.stopped();
        if (this.snapshot.state !== 'idle' && this.snapshot.state !== 'ended') {
          this.update({ state: 'paused' });
        }
      }
      return;
    }
    const loaded = this.loaded;
    if (this.foreignMedia) return;
    if (loaded && isForeign(status, loaded)) {
      // Our own load's earlier statuses can still name the book it replaces.
      if (this.loadsInFlight > 0) return;
      this.foreignMedia = true;
      this.needsReload = true; // a play here puts this book back on the receiver
      this.update({ state: 'paused' });
      return;
    }
    if (status.playerState === 'idle' && status.idleReason === 'error' && this.loadsInFlight > 0) {
      // Refused while a load of ours is in flight (or a mint for one): that load is sent again
      // with a new token (`sendQueue`), whatever later file the receiver skips on to meanwhile.
      // Not, once the mint is done, an error of the queue it replaces (`ofReplacedQueue`), nor
      // one read (the SDK's last, maybe that queue's). Each error while it skips on keeps its
      // statuses hidden a while longer (`skippingRefused`).
      if (loaded && !read && !this.ofReplacedQueue(status, loaded)) {
        this.refusedQueue = { seq: this.queueSeq, at: this.now() };
      }
      return;
    }
    const index = loaded ? castTrackIndex(status, loaded.urls) : null;
    if (
      loaded &&
      index !== null &&
      this.loadsInFlight > 0 &&
      !read &&
      !this.ofReplacedQueue(status, loaded)
    ) {
      if (this.skippedPast(status, index)) {
        // The receiver plays (or buffers) a later file than the one this load asked for, which
        // it never played: it was refused that file and skipped on (to one in its cache too),
        // whether or not its errors reached the phone. The load is a refused one, as an error
        // makes it, and that later file is not the book's place.
        this.refuseQueue();
      } else {
        this.landInFlight(status, index, loaded);
      }
    }
    if (this.skippingRefused()) return;
    // The receiver settled playing, paused or stopped, whoever asked: the play intent from
    // now on. A status while a load of ours is in flight (a `paused` before it takes a play's
    // queue, the replaced item's `interrupted`; as the foreign check above) is not a word on
    // that load, though a stop still means the next play reloads. A stop with no book of ours
    // loaded (a reset's own, `reset` cleared the intent) is no word on a book either.
    const stoppedElsewhere =
      status.playerState === 'idle' &&
      (status.idleReason === 'cancelled' || status.idleReason === 'interrupted');
    if (stoppedElsewhere) this.needsReload = true;
    if (!read && this.holdingAsked()) return;
    if (
      this.loadsInFlight === 0 &&
      (status.playerState === 'playing' ||
        status.playerState === 'paused' ||
        (stoppedElsewhere && loaded))
    ) {
      this.playIntent = status.playerState === 'playing';
    }
    const trackIndex = index ?? this.snapshot.trackIndex;
    const lastTrack = !loaded || trackIndex >= loaded.items.length - 1;
    const state = castState(status, {
      prev: this.snapshot.state,
      lastTrack,
      loading: this.loadsInFlight > 0,
    });
    const offset = loaded?.offsets[trackIndex] ?? 0;
    const duration = loaded?.tracks[trackIndex]?.duration ?? this.snapshot.duration;
    let position = Number.isFinite(status.position)
      ? status.position + offset
      : this.snapshot.position;
    if (loaded && index !== null && this.loadsInFlight === 0) {
      // As in flight (`skippedPast`), once the load answered: only just after the move, as a
      // file the receiver played unseen may have run on into the next by now.
      if (this.skippedPast(status, index, ASKED_MOVE_MS) && this.remintDue()) {
        this.reloadFresh(index, position);
        return;
      }
      this.followIntent(status, index, position, loaded.items.length - 1);
      if (status.playerState === 'playing') this.notePlayed(status, loaded, index);
    }
    if (state === 'ended' && loaded && this.endedEarly(trackIndex, position, duration)) return;
    // The book's real end settles it as a pause does (the store reads it so): a seek or a file
    // jump after it loads the place paused.
    if (state === 'ended' && this.loadsInFlight === 0) this.playIntent = false;
    // Only as the error arrives: one already shown is the listener's to retry (the receiver
    // says it again on every status read, as when the app comes back, and each would mint).
    if (state === 'error' && this.snapshot.state !== 'error' && loaded && this.remintDue()) {
      this.reloadFresh(trackIndex, position);
      return;
    }
    if (state === 'ended' && duration > 0) position = duration; // the book's end reads as finished
    const patch: Partial<PlaybackSnapshot> = { state, trackIndex, position, duration };
    // The receiver's speed, when it changed by itself (not one we just set).
    if (
      status.rate > 0 &&
      Math.abs(status.rate - this.snapshot.rate) > 0.01 &&
      state === 'playing' &&
      !this.askedMove &&
      this.now() - this.rateAskedAt > ASKED_MOVE_MS
    ) {
      patch.rate = status.rate;
      this.rateChange?.(status.rate);
    }
    if (index !== null) this.statusPlaces++;
    this.place(patch, index !== null);
  }

  /**
   * The receiver says the last file `finished`, but the place is well before its end
   * (`isEarlyTranscodeEnd`: a transcoded stream the server or a proxy closed reads as a
   * normal end; so does a dropped direct one): that is not the end of the book, and reading
   * it so would mark the book finished and save its end. The place is the receiver's, else
   * (it reports 0 once idle) where it was last seen playing, carried on by the time since.
   * Seen playing just now: the queue is loaded again there and plays on. Seen long ago (an
   * iPhone suspended the sender, and the receiver may have played on to the real end): the
   * book comes back paused at that place, and the next play loads it there. A stream that
   * ends again without real progress past the reload is the end after all. Returns whether
   * it handled the status (false: the book's real end).
   */
  private endedEarly(trackIndex: number, reported: number, duration: number): boolean {
    if (this.loadsInFlight > 0) return false;
    const seen = this.seen?.trackIndex === trackIndex ? this.seen : null;
    const age = seen ? this.now() - seen.at : Infinity;
    const carried = seen ? seen.position + (seen.playing ? (age / 1000) * seen.rate : 0) : 0;
    const place = Math.min(Math.max(reported, carried), duration);
    if (!isEarlyTranscodeEnd(place, duration, this.earlyEndRetryAt)) return false;
    this.earlyEndRetryAt = place;
    if (!seen?.playing || age > EARLY_END_FRESH_MS) {
      this.stopped();
      this.place({ state: 'paused', trackIndex, position: place, duration }, false);
      return true;
    }
    this.place({ state: 'loading', trackIndex, position: place, duration }, false);
    void this.sendQueue(trackIndex, place, true).catch(() => {
      // Could not load it again: paused there, and the next play tries again.
      this.stopped();
      this.update({ state: 'paused' });
    });
    return true;
  }

  /**
   * The receiver stopped on an error with our book loaded (a later file, a seek or a reload
   * it was refused): the queue is loaded again with a newly minted cast token (`freshToken`)
   * at the place this phone means (`refusedPlace`: the file the receiver was refused, not a
   * later one it skipped on to), playing on by the play intent (`playOn`), else paused,
   * before the error reaches the store, which shows that place from now. A reload that fails
   * is the error after all.
   */
  private reloadFresh(index: number, reported: number) {
    const { trackIndex, position } = this.refusedPlace(index, reported);
    const duration = this.loaded?.tracks[trackIndex]?.duration ?? 0;
    const place = Math.min(position, duration || Infinity);
    // For a session no word came for yet (`playOn`), as it was before the error.
    const playing = this.playOn();
    const seq = this.loadSeq;
    this.place({ state: 'loading', trackIndex, position: place, duration }, false);
    const fail = () => {
      if (seq === this.loadSeq) this.update({ state: 'error' });
    };
    void (async () => {
      if (!(await this.freshToken())) return fail();
      // The store's play of a book whose load answered before the receiver erred comes while
      // the token is minted: `sendQueueOnce` sends by the play intent as it is then.
      if (!(await this.sendQueueOnce(trackIndex, place, playing))) return;
      if (!(this.playIntent ?? playing) && seq === this.loadSeq) this.update({ state: 'paused' });
    })().catch((err: unknown) => {
      fail();
      this.onRefused(err);
    });
  }

  /** The receiver plays file `index` with the token last minted for this book (its URL is the
   * loaded queue's for that file, which carry it) at the place this phone means (`intended`,
   * landed): that token is a good one (`remintDue`). Not a later file it went on to after
   * being refused the meant one (from its cache, or a file it can play): each new token would
   * count as good there, and a file refused for another reason would mint on every error. */
  private notePlayed(status: CastMediaStatus, loaded: Loaded, index: number) {
    const last = this.reminted;
    const want = this.intended;
    if (!last || last.played || !status.contentId || !want?.landed) return;
    if (want.trackIndex !== index || last.book !== castBookKey(loaded.book)) return;
    if (castUrlIndex(status.contentId, loaded.urls) === index) last.played = true;
  }

  /** A progress tick names no item, so it can't tell a move from the receiver running on
   * into the next file before that file's status arrives: a tick far from where the place
   * should be is dropped and the status asked for (it says which file); only statuses
   * report moves. */
  private onProgress(position: number) {
    if (!this.loaded || this.foreignMedia || !Number.isFinite(position)) return;
    if (this.holdingAsked() || this.skippingRefused()) return;
    const offset = this.loaded.offsets[this.snapshot.trackIndex] ?? 0;
    const next = position + offset;
    if (
      this.seen &&
      isUnaskedJump(this.seen, {
        trackIndex: this.snapshot.trackIndex,
        position: next,
        at: this.now(),
      })
    ) {
      void this.refresh();
      return;
    }
    this.place({ position: next }, false);
  }

  /** Take a new place from the receiver. A jump nobody here asked for is reported as a
   * remote move before the listeners take it, as the native engines do (fe#211: the store
   * ends the listening span where the receiver was before any save, cut or keep sees the
   * landed place); the snapshot (`getSnapshot`) already holds it, and the listeners take it
   * whatever the handler does. */
  private place(patch: Partial<PlaybackSnapshot>, trustworthy: boolean) {
    const next = { ...this.snapshot, ...patch };
    const at = this.now();
    let jumped = false;
    if (this.askedMove && at > this.askedMove.until) this.askedMove = null;
    if (trustworthy && !this.askedMove && this.loadsInFlight === 0) {
      jumped = isUnaskedJump(this.seen, {
        trackIndex: next.trackIndex,
        position: next.position,
        at,
      });
    } else if (this.askedMove && trustworthy && next.state === 'playing') {
      // The asked move has landed once the receiver plays again from it.
      this.askedMove = null;
    }
    this.snapshot = next;
    this.see();
    if (!jumped || next.state === 'ended') {
      this.emit();
      return;
    }
    try {
      this.remoteMove?.(next.trackIndex, next.position);
    } finally {
      this.emit();
    }
  }

  private see() {
    this.seen = {
      trackIndex: this.snapshot.trackIndex,
      position: this.snapshot.position,
      at: this.now(),
      playing: this.snapshot.state === 'playing',
      rate: this.snapshot.rate || 1,
    };
  }

  private update(patch: Partial<PlaybackSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit();
  }

  private emit() {
    for (const l of this.listeners) l(this.snapshot);
  }
}
