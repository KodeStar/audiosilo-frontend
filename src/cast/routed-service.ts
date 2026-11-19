import { sameConnection } from '@/lib/connection-id';
import { sameTrackOrder } from '@/playback/book-queue';
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

/** A book load asked of one side, and where it was asked to start. */
type AskedLoad = { load: LastLoad; trackIndex: number; position: number };

/** Whether two loads are the same book (`rememberLoad` swaps in the phone's own copy of the
 * loaded book: another object, the same book). */
function sameBookLoad(a: LastLoad | null, b: LastLoad | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  return (
    !!a.book &&
    !!b.book &&
    sameConnection(a.book.connectionId, b.book.connectionId) &&
    a.book.libraryId === b.book.libraryId &&
    a.book.path === b.book.path
  );
}

type Mode = 'local' | 'cast' | 'switching';

/** How long (ms) at most a session that begins waits for the store's own load into the
 * phone's engine to land (`RoutedPlaybackService.beginCast`): one that never lands must not
 * keep the session from becoming the route. */
export const LOCAL_LOAD_WAIT_MS = 10_000;

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
 *
 * The phone's engine can hold another book than the one the store loaded (Android: the car
 * started one that was not adopted). Its snapshot is then that book's, so a session that
 * begins hands the loaded book over at the place the store says it is (`onLoadedPlace`),
 * paused, and the other book stops with the phone's engine.
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
  private pending: AskedLoad | null = null;
  /** A book `load` on its way into the phone's engine (the store's own start), and where it
   * was asked to start: until it lands the engine's snapshot is still the book it replaces,
   * so a session that begins meanwhile waits for it (`beginCast`). */
  private localLoad: (AskedLoad & { done: Promise<void> }) | null = null;
  /** The session `beginCast` is making the route while it waits (`localLoad`), and the stop of
   * that wait, by a newer session or the end of the session (`endCast`, `endCastForCar`). */
  private beginning: { cast: CastPlaybackService; stop: () => void } | null = null;
  /** The book a handover gives the receiver (`beginCast`): a session that ends before it is
   * the route hands this book back, at the place being handed over (`handBack`). */
  private handover: LastLoad | null = null;
  /** A play or pause the store asked while a handover was on its way to the receiver
   * (`beginCast`): the receiver takes it once the book is there, never the phone's engine
   * the handover unloads (the store's start plays its book once its load landed, which is
   * when a session that waited for that load hands it over). */
  private handoverAsk: 'play' | 'pause' | null = null;
  /** The book a hand-back is of, while it gives the phone that book (`handBack`): it may not
   * be the store's (`reportedBook`). */
  private handingBack: BookRef | null = null;
  /** The hand-back of a session that ended, while it runs (a load the end interrupted
   * waits for it: `load`). */
  private ending: Promise<void> | null = null;
  private remoteMove:
    ((trackIndex: number, positionInTrack: number, checkpoint?: boolean) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  private landed: (() => void) | null = null;
  private playAsked: (() => void) | null = null;
  private ownLoad:
    ((trackIndex: number, positionInTrack: number, loaded: Promise<unknown>) => void) | null = null;
  private pauseAsked: (() => void) | null = null;
  private loadedPlace: (() => PlaybackSnapshot | null) | null = null;
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
    local.onLanded?.(() => {
      if (this.mode === 'local') this.landed?.();
    });
    local.onPlayAsked?.(() => {
      if (this.mode === 'local') this.playAsked?.();
    });
    local.onPauseAsked?.(() => {
      if (this.mode === 'local') this.pauseAsked?.();
    });
    if (local.swapTo) {
      const swap = local.swapTo.bind(local);
      this.swapTo = async (tracks, startIndex, positionInTrack, chapters, book, onSwitch) => {
        const load = { tracks, chapters, book };
        // While casting, the receiver streams from the server whatever the phone holds:
        // only remember the local files, for when the book comes back to the phone. Only
        // the loaded book's, in the order the other side plays (its track indices read
        // through the store's queue, which a `'swapped'` here commits): a copy holding other
        // files, or one landing after a reset or another book's load, is refused.
        if (this.mode !== 'local') {
          const now = this.lastLoad;
          if (!now || !sameBookLoad(now, load) || !sameTrackOrder(now.tracks, tracks)) {
            return 'refused';
          }
          this.lastLoad = load;
          return 'swapped';
        }
        const outcome = await swap(tracks, startIndex, positionInTrack, chapters, book, onSwitch);
        if (outcome === 'swapped') this.lastLoad = load;
        return outcome;
      };
    }
  }

  /** The loaded queue at new addresses (`PlaybackService.restream`): the phone's engine takes
   * them, and so does the queue a route switch hands over (a receiver streams on its cast
   * token, never these). */
  restream(tracks: PlaybackTrack[]): void {
    if (this.lastLoad && sameTrackOrder(this.lastLoad.tracks, tracks)) {
      this.lastLoad = { ...this.lastLoad, tracks };
    }
    this.local.restream?.(tracks);
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
   *
   * While the phone's engine holds another book than the loaded one (`onLoadedPlace` answers),
   * the place handed over is the loaded book's own, never the engine's (that other book's:
   * the receiver would play the loaded book from it), and it goes over paused: the play heard
   * was the other book's. That book stops with the phone's engine, also when the loaded book
   * has no place to hand over (it ended).
   */
  async beginCast(cast: CastPlaybackService): Promise<void> {
    if (this.cast === cast || this.beginning?.cast === cast) return;
    // A session still waiting to become the route is replaced by this one.
    this.stopBeginning();
    // A load of the store's own still on its way into the phone's engine: the engine's place
    // is the book it replaces until it lands, and the loaded book would go over at that one's
    // place. It goes over from where its load put it, so the session waits for that.
    const asked = this.localLoad ? await this.localLoadLands(cast) : null;
    if (asked === false) {
      // Never the route: it stops listening to its receiver, as a session that ends does.
      cast.detach();
      return;
    }
    if (this.cast) await this.endCast();
    // Asked while the phone is still the route: the store reads the phone's last report. A
    // load that never landed leaves the engine holding the book it replaced, as another book.
    const own = this.loadedPlace?.() ?? asked;
    // The router's snapshot is the engine's last report, that other book's: the loaded book's
    // place from here, so a session that ends mid-switch hands this one back (`handBack`),
    // never the loaded book at the other book's place.
    if (own) this.snapshot = own;
    const generation = ++this.generation;
    const current = () => generation === this.generation && this.cast === cast;
    this.mode = 'switching';
    this.cast = cast;
    this.handoverAsk = null;
    // A hand-back still loading the phone is over for the store: this session takes the route.
    this.handingBack = null;
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
    this.handover = load;
    if (!load || at.state === 'idle' || at.state === 'ended') {
      this.mode = 'cast';
      // Nothing to hand over, but the phone's engine holds that other book: it stops here too,
      // or it played on out of the app's reach (a Pause goes to the receiver from now).
      if (own) await this.local.reset().catch(() => undefined);
      return;
    }
    const wasPlaying = !own && (at.state === 'playing' || at.state === 'loading');
    await this.local.pause().catch(() => undefined);
    if (!current()) return;
    const place = {
      ...at,
      ...(own ? null : pick(this.local.getSnapshot())),
      state: 'paused' as const,
    };
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
      // A play or pause asked while the book was on its way stands over the phone's own.
      const ask = this.handoverAsk;
      this.handoverAsk = null;
      if (ask === 'play' || (ask === null && wasPlaying)) await cast.play();
    } catch (err) {
      if (!current()) return;
      this.handoverAsk = null;
      this.dropCast();
      // The book's download may have landed while the receiver was asked (`rememberLoad`,
      // the store's hot-swap sees a cast route): the phone plays its own copy then.
      const mine = this.lastLoad && sameBookLoad(this.lastLoad, load) ? this.lastLoad : load;
      await this.loadLocal(mine, place);
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
    this.stopBeginning();
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
    // unloaded: the place to restore is the one being handed over, of the book handed over.
    const pending = this.pending;
    this.pending = null;
    const at: PlaybackSnapshot = pending
      ? this.placeOf(pending)
      : this.mode === 'cast'
        ? cast.getSnapshot()
        : this.snapshot;
    // The book that place is of: the one on its way to the receiver, the one it holds, or the
    // one being handed over. Never simply the queue the store remembered (`lastLoad`): an
    // adoption that landed meanwhile remembers its own book, and that book back at the
    // receiver's place would be a place it never had. The store's own copy of the same book
    // (its download) comes back instead of the receiver's queue.
    const held = pending ? pending.load : this.mode === 'cast' ? cast.loadedQueue() : this.handover;
    const load = held && !sameBookLoad(held, this.lastLoad) ? held : this.lastLoad;
    this.mode = 'switching';
    this.dropCast();
    if (load && (pending || (at.state !== 'idle' && at.state !== 'ended'))) {
      const place = { ...at, state: 'paused' as const };
      // Named, so a book that is not the store's is held as another book's, never saved at
      // the store's book (`reportedBook`): its place, and the phone's engine while it loads
      // there (a press or the car sync reads that engine meanwhile).
      const naming = load.book ?? null;
      this.handingBack = naming;
      try {
        this.forward(place);
        await this.loadLocal(load, place, load === this.lastLoad);
      } finally {
        if (this.handingBack === naming) this.handingBack = null;
      }
    }
    if (generation === this.generation) this.mode = 'local';
  }

  /** A session is waiting to become the route (`beginCast`, the store's load into the phone's
   * engine on its way): not casting yet, but it takes the route once that load lands, so a
   * play that must stay on the phone ends it first (`endCastForCar`, `endCast`). */
  beginningCast(): boolean {
    return this.beginning !== null;
  }

  /** Stop the wait of a session that is still to become the route (`beginning`). */
  private stopBeginning() {
    const beginning = this.beginning;
    this.beginning = null;
    beginning?.stop();
  }

  /** The router's snapshot at the place a load was asked to start at. */
  private placeOf({ load, trackIndex, position }: AskedLoad): PlaybackSnapshot {
    return {
      ...this.snapshot,
      trackIndex,
      position,
      duration: load.tracks[trackIndex]?.duration ?? 0,
    };
  }

  /**
   * Wait for the store's own load into the phone's engine to land (`localLoad`, and one that
   * replaced it meanwhile), for at most `LOCAL_LOAD_WAIT_MS`: null once it landed. False when
   * the session ended or another began meanwhile (`stopBeginning`): `cast` is not to become
   * the route. A load that never landed (it failed, or outlasted the bound) is given up: the
   * place it was asked to start at, the book's own to go over from (the engine's snapshot is
   * still the book it replaced).
   */
  private async localLoadLands(
    cast: CastPlaybackService,
  ): Promise<PlaybackSnapshot | null | false> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beginning = { cast, stop: () => {} };
    const cut = new Promise<'stopped' | 'bound'>((resolve) => {
      timer = setTimeout(() => resolve('bound'), LOCAL_LOAD_WAIT_MS);
      beginning.stop = () => resolve('stopped');
    });
    this.beginning = beginning;
    try {
      for (let loading = this.localLoad; loading;) {
        const outcome = await Promise.race([
          loading.done.then(
            () => 'landed' as const,
            () => 'failed' as const,
          ),
          cut,
        ]);
        // Stopped (`stopBeginning`), also once the load landed first.
        if (outcome === 'stopped' || this.beginning !== beginning) return false;
        // A load that replaced this one meanwhile is the one to wait for (a superseded load
        // can fail: the newer one took the engine).
        const next = this.localLoad === loading ? null : this.localLoad;
        if (outcome !== 'bound' && (outcome === 'landed' || next)) {
          loading = next;
          continue;
        }
        // Never landed, and the handover's reset takes the engine: the latest load's place.
        const last = next ?? loading;
        this.localLoad = null;
        if (!sameBookLoad(last.load, this.lastLoad)) return null;
        return { ...this.placeOf(last), state: 'paused' };
      }
      return null;
    } finally {
      clearTimeout(timer);
      if (this.beginning === beginning) this.beginning = null;
    }
  }

  /** Save the cast's place now: the iPhone is about to be suspended (the Cast SDK stops
   * there and no more progress arrives until the app is back). Goes through the store's
   * "the engine is at a new place" path, which saves it at once. */
  checkpoint(): void {
    if (this.mode !== 'cast') return;
    const s = this.snapshot;
    if (s.state === 'idle' || s.state === 'ended') return;
    this.remoteMove?.(s.trackIndex, s.position, true);
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
    this.handover = null;
    this.castUnsub?.();
    this.castUnsub = null;
    this.cast?.onRemoteMove(null);
    this.cast?.onRateChange(null);
    this.cast?.detach();
    this.cast = null;
  }

  /** Load a book into the phone's engine at a place, the store's book (`own`, told as its own
   * load) or the receiver's other book (`handBack`). */
  private async loadLocal(load: LastLoad, place: PlaybackSnapshot, own = true) {
    try {
      const loaded = this.local.load(
        load.tracks,
        place.trackIndex,
        place.position,
        load.chapters,
        load.book,
      );
      // A load the store did not ask for: told as it is made, before the phone's engine
      // reports from it (`PlaybackService.onOwnLoad`). Not another book's: the store's book
      // is not where it lands.
      if (own) this.ownLoad?.(place.trackIndex, place.position, loaded);
      await loaded;
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
    if (this.handingOver()) {
      this.generation++;
      this.mode = 'cast';
      // The handover may not have unloaded the phone yet (it stands back from here): the
      // old book must not stay loaded there, playable from the lock screen out of reach.
      await this.local.reset().catch(() => undefined);
    }
    const cast = this.mode === 'cast' ? this.cast : null;
    if (!cast) {
      const loading = {
        done: this.local.load(tracks, startIndex, positionInTrack, chapters, book),
        load: mine,
        trackIndex: startIndex,
        position: positionInTrack,
      };
      this.localLoad = loading;
      try {
        await loading.done;
      } finally {
        if (this.localLoad === loading) this.localLoad = null;
      }
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
      // This book can't go to the receiver: it plays here, and the session is let go. From
      // the phone's own copy when one was remembered meanwhile, as a refused handover does.
      this.dropCast();
      this.mode = 'local';
      const here = this.lastLoad ?? mine;
      await this.local.load(here.tracks, startIndex, positionInTrack, here.chapters, here.book);
      this.onCastFailed?.(err);
    } finally {
      if (this.pending?.load === mine) this.pending = null;
    }
  }

  play() {
    if (this.handingOver()) {
      this.handoverAsk = 'play';
      return Promise.resolve();
    }
    return this.route().play();
  }
  pause() {
    if (this.handingOver()) {
      this.handoverAsk = 'pause';
      return Promise.resolve();
    }
    return this.route().pause();
  }
  /** A handover is on its way to the receiver (`beginCast`): a play or pause asked now is the
   * receiver's once the book lands there (`handoverAsk`). */
  private handingOver(): boolean {
    return this.mode === 'switching' && this.cast !== null;
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
  onRemoteMove(
    handler: ((trackIndex: number, positionInTrack: number, checkpoint?: boolean) => void) | null,
  ) {
    this.remoteMove = handler;
  }
  onRateChange(handler: ((rate: number) => void) | null) {
    this.rateChange = handler;
  }
  onSilenceSaved(handler: ((totalSeconds: number) => void) | null) {
    this.local.onSilenceSaved?.(handler);
  }
  onLanded(handler: (() => void) | null) {
    this.landed = handler;
  }
  onPlayAsked(handler: (() => void) | null) {
    this.playAsked = handler;
  }
  onOwnLoad(
    handler:
      ((trackIndex: number, positionInTrack: number, loaded: Promise<unknown>) => void) | null,
  ) {
    this.ownLoad = handler;
  }
  onPauseAsked(handler: (() => void) | null) {
    this.pauseAsked = handler;
  }
  onLoadedPlace(handler: (() => PlaybackSnapshot | null) | null) {
    this.loadedPlace = handler;
  }
  adoptPlace(snapshot: PlaybackSnapshot) {
    this.snapshot = { ...snapshot };
    this.route().adoptPlace?.(snapshot);
  }
  /** The phone's engine names its own reports' book. A receiver's reports are of the book
   * loaded there (`CastPlaybackService.loadedBook`: a `load`, a handover, the queue of a
   * session the app did not load), so they name it, and the store never holds them as another
   * book's (one the phone's engine held with no name, before the session began). Never the
   * queue the store remembered (`lastLoad`): an adoption landing mid-handover remembers its own
   * book while the receiver takes the one handed over. None while a load is on its way there
   * (`pending`: the receiver still reports the book before it), nor during a switch, but for
   * the book a hand-back gives the phone, its place and its load there (`handingBack`). */
  reportedBook() {
    if (this.mode === 'local') return this.local.reportedBook?.() ?? null;
    if (this.handingBack && !this.cast) return this.handingBack;
    return this.mode === 'cast' && !this.pending ? (this.cast?.loadedBook() ?? null) : null;
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
