import type {
  BookRef,
  PlaybackChapter,
  PlaybackConfig,
  PlaybackService,
  PlaybackSnapshot,
  PlaybackTrack,
} from '@/playback/types';

import type { CastPlaybackService } from './cast-service';

/** What the store last asked to load: the route switch reloads it on the other side. */
type LastLoad = { tracks: PlaybackTrack[]; chapters?: PlaybackChapter[]; book?: BookRef };

/** Whether two loads are the same book (`rememberLoad` swaps in the phone's own copy of the
 * loaded book: another object, the same book). */
function sameBookLoad(a: LastLoad | null, b: LastLoad | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    !!a.book &&
    !!b.book &&
    a.book.connectionId === b.book.connectionId &&
    a.book.libraryId === b.book.libraryId &&
    a.book.path === b.book.path
  );
}

type Mode = 'local' | 'cast' | 'switching';

/**
 * The service indirection (decision 7): the ONE `PlaybackService` the store gets from
 * `createPlaybackService()` on every platform. It forwards every call to the route in use,
 * the phone's own engine or, while a Cast session is connected, the `CastPlaybackService`,
 * and forwards only that route's snapshots, so `store.ts`, `book-queue.ts` and
 * `progress-sync.ts` drive a cast exactly as they drive the phone and never know which it is.
 *
 * Switching (`beginCast`, `endCast`) is a pause on one side and a paused load on the other:
 * the router itself emits a `paused` snapshot at the place being handed over, which the
 * store reads as any pause (it saves that place and stops its save loop, with no play
 * intent left for the stall watchdog to time out), then loads the book on the other side at
 * that place. A cast started while the book was playing plays on; the phone never plays
 * again by itself when a cast ends (the place comes back paused). Nothing the old side
 * emits during the switch reaches the store.
 */
export class RoutedPlaybackService implements PlaybackService {
  private mode: Mode = 'local';
  private generation = 0;
  private cast: CastPlaybackService | null = null;
  private castUnsub: (() => void) | null = null;
  private snapshot: PlaybackSnapshot;
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private lastLoad: LastLoad | null = null;
  /** A book `load` sent to the receiver that has not landed there yet, and where it was
   * asked to start: until it lands the receiver's snapshot is still the previous book's,
   * so a session ending meanwhile hands this place back instead (`endCast`). */
  private pending: { load: LastLoad; trackIndex: number; position: number } | null = null;
  /** The hand-back of a session that ended, while it runs (a load the end interrupted
   * waits for it: `load`). */
  private ending: Promise<void> | null = null;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  /** Called when a book can't be cast (the session glue explains it and ends the session);
   * the router has already put the book back on the phone. */
  onCastFailed: ((err: unknown) => void) | null = null;

  /** Present only when the phone's engine can swap gaplessly (see `PlaybackService.swapTo`):
   * the store falls back to load + play without it. */
  swapTo?: PlaybackService['swapTo'];

  constructor(readonly local: PlaybackService) {
    this.snapshot = local.getSnapshot();
    local.subscribe((s) => {
      if (this.mode === 'local') this.forward(s);
    });
    local.onRemoteMove?.((trackIndex, position) => {
      if (this.mode === 'local') this.remoteMove?.(trackIndex, position);
    });
    local.onRateChange?.((rate) => {
      if (this.mode === 'local') this.rateChange?.(rate);
    });
    if (local.swapTo) {
      const swap = local.swapTo.bind(local);
      this.swapTo = async (tracks, startIndex, positionInTrack, chapters, book) => {
        const load = { tracks, chapters, book };
        // While casting, the receiver streams from the server whatever the phone holds:
        // only remember the local files, for when the book comes back to the phone.
        if (this.mode !== 'local') {
          this.lastLoad = load;
          return true;
        }
        const ok = await swap(tracks, startIndex, positionInTrack, chapters, book);
        if (ok) this.lastLoad = load;
        return ok;
      };
    }
  }

  /** The cast route, while there is one. */
  castRoute(): CastPlaybackService | null {
    return this.cast;
  }

  /**
   * Make a Cast session the route. When a book is loaded, hand it over: pause the phone
   * at its place (reported as a pause, so the store saves it), unload the phone's engine,
   * load the book on the receiver there at the same speed, and play it when the phone was
   * playing. A book that can't be cast stays on the phone (paused) and `onCastFailed` says
   * why; the route is then the phone again.
   */
  async beginCast(cast: CastPlaybackService): Promise<void> {
    if (this.cast === cast) return;
    if (this.cast) await this.endCast();
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.cast === cast;
    this.mode = 'switching';
    this.cast = cast;
    /** This session is still the route (not mid-switch, not replaced or ended). */
    const live = () => this.mode === 'cast' && this.cast === cast;
    this.castUnsub = cast.subscribe((s) => {
      if (live()) this.forward(s);
    });
    cast.onRemoteMove((trackIndex, position) => {
      if (live()) this.remoteMove?.(trackIndex, position);
    });
    cast.onRateChange((rate) => {
      if (live()) this.rateChange?.(rate);
    });

    const at = this.snapshot;
    const load = this.lastLoad;
    if (!load || at.state === 'idle' || at.state === 'ended') {
      this.mode = 'cast';
      return;
    }
    const wasPlaying = at.state === 'playing' || at.state === 'loading';
    await this.local.pause().catch(() => undefined);
    if (!current()) return;
    const place = { ...at, ...pick(this.local.getSnapshot()), state: 'paused' as const };
    this.forward(place);
    await this.local.reset().catch(() => undefined);
    if (!current()) return;
    try {
      await cast.load(load.tracks, place.trackIndex, place.position, load.chapters, load.book);
      if (!current()) {
        // A reset while the book was on its way (a switch of person, a stop): take it off
        // the receiver. A newer book started meanwhile (`load`) owns the receiver, and a
        // session that ended has nothing of ours to stop: both are left alone.
        if (this.lastLoad === null && this.cast === cast) await cast.reset();
        return;
      }
      await cast.setRate(place.rate);
      if (!current()) return; // the session ended meanwhile
      this.mode = 'cast';
      if (wasPlaying) await cast.play();
    } catch (err) {
      if (!current()) return;
      this.dropCast();
      await this.loadLocal(load, place);
      this.mode = 'local';
      this.onCastFailed?.(err);
    }
  }

  /**
   * Make the phone the route again (the session ended). The receiver's last place (the
   * caller refreshes it first where it still can) comes back to the phone paused: reported
   * as a pause, so the store saves it, then loaded into the phone's engine there.
   */
  async endCast(): Promise<void> {
    const cast = this.cast;
    if (!cast) return;
    const run = this.handBack(cast);
    this.ending = run;
    try {
      await run;
    } finally {
      if (this.ending === run) this.ending = null;
    }
  }

  private async handBack(cast: CastPlaybackService): Promise<void> {
    const generation = ++this.generation;
    // A book started on the receiver that has not landed there yet comes back at the place
    // it was started at: the receiver's snapshot is still the previous book's, and that
    // place mapped onto this book is one it never had. Mid-handover (the session ended
    // while the book was on its way to the receiver) the phone's engine is already
    // unloaded: the place to restore is the one being handed over.
    const pending =
      this.pending && sameBookLoad(this.pending.load, this.lastLoad) ? this.pending : null;
    this.pending = null;
    const at: PlaybackSnapshot = pending
      ? {
          ...this.snapshot,
          trackIndex: pending.trackIndex,
          position: pending.position,
          duration: pending.load.tracks[pending.trackIndex]?.duration ?? 0,
        }
      : this.mode === 'cast'
        ? cast.getSnapshot()
        : this.snapshot;
    this.mode = 'switching';
    this.dropCast();
    const load = this.lastLoad;
    if (load && (pending || (at.state !== 'idle' && at.state !== 'ended'))) {
      const place = { ...at, state: 'paused' as const };
      this.forward(place);
      await this.loadLocal(load, place);
    }
    if (generation === this.generation) this.mode = 'local';
  }

  /** Save the cast's place now: the iPhone is about to be suspended (the Cast SDK stops
   * there and no more progress arrives until the app is back). Goes through the store's
   * "the engine is at a new place" path, which saves it at once. */
  checkpoint(): void {
    if (this.mode !== 'cast') return;
    const s = this.snapshot;
    if (s.state === 'idle' || s.state === 'ended') return;
    this.remoteMove?.(s.trackIndex, s.position);
  }

  /** The queue of a book the store took over without `load` (a Cast session the app did
   * not load, relaunched mid-cast; the Android service's book, `adoptLoaded`), or the
   * phone's own copy of the loaded book (its download landed while casting): a session
   * that starts later hands it to the receiver, and one that ends hands it back. */
  rememberLoad(load: LastLoad): void {
    this.lastLoad = load;
  }

  /** On a receiver, or on its way there: the receiver streams the book from the server
   * whatever the phone holds. */
  isCasting(): boolean {
    return this.cast !== null;
  }

  private dropCast() {
    this.castUnsub?.();
    this.castUnsub = null;
    this.cast?.onRemoteMove(null);
    this.cast?.onRateChange(null);
    this.cast?.detach();
    this.cast = null;
  }

  private async loadLocal(load: LastLoad, place: PlaybackSnapshot) {
    try {
      await this.local.load(
        load.tracks,
        place.trackIndex,
        place.position,
        load.chapters,
        load.book,
      );
      await this.local.setRate(place.rate);
    } catch (err) {
      console.warn('[cast] could not load the book back on this device', err);
    }
  }

  private route(): PlaybackService {
    return this.mode === 'cast' && this.cast ? this.cast : this.local;
  }

  private forward(s: PlaybackSnapshot) {
    this.snapshot = s;
    for (const l of this.listeners) l(s);
  }

  // --- PlaybackService ----------------------------------------------------

  setup() {
    return this.local.setup();
  }

  configure(config: PlaybackConfig) {
    return this.local.configure(config);
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ) {
    const mine: LastLoad = { tracks, chapters, book };
    this.lastLoad = mine;
    // A book started while a handover is on its way to the receiver supersedes the one
    // being handed over: the handover stands back (`current()`) and this book goes to the
    // receiver itself. Loaded on the phone instead, it would play there, out of the app's
    // reach, while the receiver played the old book and the store saved its place as this
    // one's.
    if (this.mode === 'switching' && this.cast) {
      this.generation++;
      this.mode = 'cast';
      // The handover may not have unloaded the phone yet (it stands back from here): the
      // old book must not stay loaded there, playable from the lock screen out of reach.
      await this.local.reset().catch(() => undefined);
    }
    const cast = this.mode === 'cast' ? this.cast : null;
    if (!cast) {
      await this.local.load(tracks, startIndex, positionInTrack, chapters, book);
      return;
    }
    this.pending = { load: mine, trackIndex: startIndex, position: positionInTrack };
    try {
      await cast.load(tracks, startIndex, positionInTrack, chapters, book);
    } catch (err) {
      // A newer book (or a reset) took over while this one was on its way: the receiver
      // answers a load another replaced with a rejection, which is no failure of this book.
      // (The phone's own copy of this book, remembered meanwhile, is still this book.)
      if (!sameBookLoad(this.lastLoad, mine)) return;
      // The session ended meanwhile: its hand-back put this book on the phone, paused at
      // the place it was started at, and it never plays there by itself: this start fails.
      if (this.cast !== cast) {
        await this.ending;
        throw err;
      }
      // This book can't go to the receiver: it plays here, and the session is let go.
      this.dropCast();
      this.mode = 'local';
      await this.local.load(tracks, startIndex, positionInTrack, chapters, book);
      this.onCastFailed?.(err);
    } finally {
      if (this.pending?.load === mine) this.pending = null;
    }
  }

  play() {
    return this.route().play();
  }
  pause() {
    return this.route().pause();
  }
  seekTo(positionInTrack: number) {
    return this.route().seekTo(positionInTrack);
  }
  skipToTrack(index: number, positionInTrack?: number) {
    return this.route().skipToTrack(index, positionInTrack);
  }
  setRate(rate: number) {
    return this.route().setRate(rate);
  }
  setVolume(volume: number) {
    return this.route().setVolume(volume);
  }
  async reset() {
    this.generation++;
    this.lastLoad = null;
    this.pending = null;
    // A handover can still have a remote load in flight while route() is local.
    this.mode = this.cast ? 'cast' : 'local';
    await Promise.all([this.local.reset(), this.cast?.reset()]);
  }
  canShowRoutePicker() {
    return this.local.canShowRoutePicker?.() ?? false;
  }
  async showRoutePicker() {
    return (await this.local.showRoutePicker?.()) ?? false;
  }
  onRemoteSeek(handler: ((positionInTrack: number) => void) | null) {
    this.local.onRemoteSeek?.(handler);
  }
  onRemoteMove(handler: ((trackIndex: number, positionInTrack: number) => void) | null) {
    this.remoteMove = handler;
  }
  onRateChange(handler: ((rate: number) => void) | null) {
    this.rateChange = handler;
  }
  onSilenceSaved(handler: ((totalSeconds: number) => void) | null) {
    this.local.onSilenceSaved?.(handler);
  }
  adoptPlace(snapshot: PlaybackSnapshot) {
    this.snapshot = { ...snapshot };
    this.route().adoptPlace?.(snapshot);
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
}

/** The place fields of a snapshot (the phone's engine may have moved on a little while the
 * pause landed). */
function pick(s: PlaybackSnapshot): Pick<PlaybackSnapshot, 'trackIndex' | 'position' | 'rate'> {
  return { trackIndex: s.trackIndex, position: s.position, rate: s.rate };
}

// --- the one router ---------------------------------------------------------

let router: RoutedPlaybackService | null = null;
const routerWaiters = new Set<(r: RoutedPlaybackService) => void>();

/** Wrap the platform engine in the route switch (`service.native.ts`, `service.web.ts`). The
 * store creates its service once, so there is one router per JS runtime. */
export function routed(local: PlaybackService): RoutedPlaybackService {
  const r = new RoutedPlaybackService(local);
  router = r;
  for (const w of routerWaiters) w(r);
  routerWaiters.clear();
  return r;
}

/** The router, once the store has created its service. */
export function currentRouter(): RoutedPlaybackService | null {
  return router;
}

/** Be called with the router when it exists (at once when it does). Returns the cancel. */
export function whenRouter(fn: (r: RoutedPlaybackService) => void): () => void {
  if (router) {
    fn(router);
    return () => {};
  }
  routerWaiters.add(fn);
  return () => {
    routerWaiters.delete(fn);
  };
}

/** Tests only. */
export function forgetRouter() {
  router = null;
  routerWaiters.clear();
}
