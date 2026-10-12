import { resolveConnectionId } from '@/lib/connection-id';
import { contentKeyOf } from '@/lib/content-key';
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
 * is moving on to the next: `loading`), `error` an error, and a stop from elsewhere
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

/** The same book of the same person (a receiver's `customData` can name a legacy
 * connection id, from a load before the identity migration). */
function sameBook(a: BookRef, b: BookRef): boolean {
  return (
    contentKeyOf({ ...a, connectionId: resolveConnectionId(a.connectionId) }) ===
    contentKeyOf({ ...b, connectionId: resolveConnectionId(b.connectionId) })
  );
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
  private askedMove: { until: number } | null = null;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  /** When the JS last set the speed: a status still carrying the old one is not the
   * receiver changing it. */
  private rateAskedAt = 0;

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
   * the phone or saved before iOS suspends the app is the receiver's latest. */
  async refresh(): Promise<void> {
    const s = await this.remote.readStatus().catch(() => null);
    if (s) this.onStatus(s);
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
    if (status && index !== null) loaded.offsets[index] = castStreamOffset(status);
    this.foreignMedia = false;
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
    this.loadsInFlight++;
    try {
      const loaded = await this.prepareLoaded(tracks, book);
      // A newer load (or a reset) came while this one prepared (its cast token can take a
      // round trip a cached one doesn't): it owns the receiver, this one stands back.
      if (seq !== this.loadSeq) return;
      this.loaded = loaded;
      if (!(await this.sendQueue(startIndex, positionInTrack, false))) return;
      if (seq !== this.loadSeq) return;
      this.update({
        state: 'ready',
        trackIndex: startIndex,
        position: positionInTrack,
        duration: tracks[startIndex]?.duration ?? 0,
      });
    } finally {
      this.loadsInFlight--;
    }
  }

  async play() {
    if (this.needsReload && this.loaded) {
      await this.sendQueue(this.snapshot.trackIndex, this.snapshot.position, true);
      return;
    }
    await this.remote.play();
  }

  async pause() {
    // Another sender's book is on the receiver: ours is already paused, theirs is theirs.
    if (this.foreignMedia) return;
    await this.remote.pause();
  }

  async seekTo(positionInTrack: number) {
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
      if (!(await this.sendQueue(this.snapshot.trackIndex, positionInTrack, this.isLive()))) {
        return;
      }
    } else {
      await this.remote.seek(positionInTrack);
    }
    this.update({ position: positionInTrack });
    this.see();
  }

  async skipToTrack(index: number, positionInTrack = 0) {
    if (!this.loaded) return;
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
    if (!(await this.sendQueue(index, positionInTrack, this.isLive()))) return;
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
    this.needsReload = false;
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

  private isLive(): boolean {
    return this.snapshot.state === 'playing' || this.snapshot.state === 'loading';
  }

  private askMove() {
    this.askedMove = { until: this.now() + ASKED_MOVE_MS };
  }

  /** The receiver's queue for a book, as sent from its start (no item requested mid-file). */
  private async prepareLoaded(tracks: PlaybackTrack[], book: BookRef): Promise<Loaded> {
    const { items } = await this.prepare(tracks, book);
    return { tracks, book, items, urls: items.map((i) => i.url), offsets: items.map(() => 0) };
  }

  /** Load the queue on the receiver starting at `(index, position)`. Resolves whether this
   * is still the latest queue sent (false: a newer one replaced it, and the receiver's
   * rejection of this one was that one's doing). */
  private async sendQueue(index: number, position: number, autoplay: boolean): Promise<boolean> {
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
    this.loadsInFlight++;
    try {
      try {
        await this.remote.load({
          items,
          startIndex: i,
          startTime: start.offset > 0 ? 0 : Math.max(0, position),
          rate: this.snapshot.rate,
          autoplay,
          book: loaded.book,
          title: loaded.tracks[0]?.album || loaded.tracks[0]?.title || '',
        });
      } catch (err) {
        if (q !== this.queueSeq) return false;
        throw err;
      }
      if (q !== this.queueSeq) return false;
      this.needsReload = false;
      return true;
    } finally {
      this.loadsInFlight--;
    }
  }

  private onStatus(status: CastMediaStatus | null) {
    if (!status) {
      // No media on the receiver: whatever was playing was stopped from elsewhere.
      if (this.loaded && this.loadsInFlight === 0) {
        this.needsReload = true;
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
    const index = loaded ? castTrackIndex(status, loaded.urls) : null;
    const trackIndex = index ?? this.snapshot.trackIndex;
    const lastTrack = !loaded || trackIndex >= loaded.items.length - 1;
    const state = castState(status, {
      prev: this.snapshot.state,
      lastTrack,
      loading: this.loadsInFlight > 0,
    });
    if (
      status.playerState === 'idle' &&
      (status.idleReason === 'cancelled' || status.idleReason === 'interrupted')
    ) {
      this.needsReload = true;
    }
    const offset = loaded?.offsets[trackIndex] ?? 0;
    const duration = loaded?.tracks[trackIndex]?.duration ?? this.snapshot.duration;
    let position = Number.isFinite(status.position)
      ? status.position + offset
      : this.snapshot.position;
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
    this.place(patch, index !== null);
  }

  /** A progress tick names no item, so it can't tell a move from the receiver running on
   * into the next file before that file's status arrives: a tick far from where the place
   * should be is dropped and the status asked for (it says which file); only statuses
   * report moves. */
  private onProgress(position: number) {
    if (!this.loaded || this.foreignMedia || !Number.isFinite(position)) return;
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

  /** Take a new place from the receiver; a jump nobody here asked for is reported as a
   * remote move AFTER the snapshot holds it (so the store's save inside the handler saves
   * the landed place, as with the native engines). */
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
    this.emit();
    if (jumped && next.state !== 'ended') this.remoteMove?.(next.trackIndex, next.position);
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
