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
  private cast: CastPlaybackService | null = null;
  private castUnsub: (() => void) | null = null;
  private snapshot: PlaybackSnapshot;
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private lastLoad: LastLoad | null = null;
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
        // While casting, the receiver streams from the server whatever the phone holds:
        // only remember the local files, for when the book comes back to the phone.
        if (this.mode !== 'local') {
          this.lastLoad = { tracks, chapters, book };
          return true;
        }
        const ok = await swap(tracks, startIndex, positionInTrack, chapters, book);
        if (ok) this.lastLoad = { tracks, chapters, book };
        return ok;
      };
    }
  }

  /** Is a Cast session the route now? */
  isCasting(): boolean {
    return this.mode === 'cast';
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
    this.mode = 'switching';
    this.cast = cast;
    this.castUnsub = cast.subscribe((s) => {
      if (this.mode === 'cast' && this.cast === cast) this.forward(s);
    });
    cast.onRemoteMove((trackIndex, position) => {
      if (this.mode === 'cast' && this.cast === cast) this.remoteMove?.(trackIndex, position);
    });
    cast.onRateChange((rate) => {
      if (this.mode === 'cast' && this.cast === cast) this.rateChange?.(rate);
    });

    const at = this.snapshot;
    const load = this.lastLoad;
    if (!load || at.state === 'idle' || at.state === 'ended') {
      this.mode = 'cast';
      return;
    }
    const wasPlaying = at.state === 'playing' || at.state === 'loading';
    await this.local.pause().catch(() => undefined);
    const place = { ...at, ...pick(this.local.getSnapshot()), state: 'paused' as const };
    this.forward(place);
    await this.local.reset().catch(() => undefined);
    try {
      await cast.load(load.tracks, place.trackIndex, place.position, load.chapters, load.book);
      await cast.setRate(place.rate);
      if (this.cast !== cast) return; // the session ended meanwhile
      this.mode = 'cast';
      if (wasPlaying) await cast.play();
    } catch (err) {
      if (this.cast !== cast) return;
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
    // Mid-handover (the session ended while the book was on its way to the receiver) the
    // phone's engine is already unloaded: the place to restore is the one being handed over.
    const at = this.mode === 'cast' ? cast.getSnapshot() : this.snapshot;
    this.mode = 'switching';
    this.dropCast();
    const load = this.lastLoad;
    if (load && at.state !== 'idle' && at.state !== 'ended') {
      const place = { ...at, state: 'paused' as const };
      this.forward(place);
      await this.loadLocal(load, place);
    }
    this.mode = 'local';
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

  /** A session the app did not load (relaunched mid-cast): remember the queue the store
   * built for the receiver's book, so a later switch back to the phone can load it. */
  rememberLoad(load: LastLoad): void {
    this.lastLoad = load;
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
    this.lastLoad = { tracks, chapters, book };
    const cast = this.mode === 'cast' ? this.cast : null;
    if (!cast) {
      await this.local.load(tracks, startIndex, positionInTrack, chapters, book);
      return;
    }
    try {
      await cast.load(tracks, startIndex, positionInTrack, chapters, book);
    } catch (err) {
      // This book can't go to the receiver: it plays here, and the session is let go.
      if (this.cast !== cast) throw err;
      this.dropCast();
      this.mode = 'local';
      await this.local.load(tracks, startIndex, positionInTrack, chapters, book);
      this.onCastFailed?.(err);
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
    this.lastLoad = null;
    await this.route().reset();
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
