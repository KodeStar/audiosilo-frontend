import type { EventSubscription } from 'expo-modules-core';
import { Platform } from 'react-native';

import { routed } from '@/cast/routed-service';
import { contentKeyOf } from '@/lib/content-key';
import { nativeNumber } from '@/lib/native-number';

import AudiosiloPlayer from '../../modules/audiosilo-player';

import { nativeBookOf } from './native-book';
import {
  type BookRef,
  bookRefOf,
  INITIAL_SNAPSHOT,
  type PlaybackChapter,
  type PlaybackConfig,
  type PlaybackService,
  type PlaybackSnapshot,
  type PlaybackTrack,
  toNativeTrack,
} from './types';

/** How long a progress tick whose place jumped waits for its move's `onRemoteMove`
 * (`NativePlaybackService.progress`): Android sends it at most 300 ms after the tick. */
const LANDING_HOLD_MS = 600;
/** How far a tick must move past what playing explains to have jumped: ahead, beyond the
 * time since the last tick at the speed; back, a second. */
const LANDING_AHEAD_S = 5;
const LANDING_BACK_S = 1;
/** Longer than the app's own move takes to settle when it does (`NativePlaybackService.ownMove`):
 * Android settles one within a second, taken or not (`MoveLandings`), iOS in AVPlayer's seek
 * completion, which waits on a stalled stream. */
const OWN_MOVE_MAX_MS = 10_000;

/** A progress tick whose place jumped while playing, held back (`LANDING_HOLD_MS`) since
 * `since`, from the last tick taken before it (`from`). `trackIndex`: the file it is in, when
 * not the snapshot's (the tick named another, or Android changed the file while it was held,
 * `NativePlaybackService.fileChanged`). */
type HeldTick = {
  position: number;
  duration: number;
  since: number;
  from: { position: number; at: number };
  trackIndex?: number;
  timer: ReturnType<typeof setTimeout>;
};

/** Does the installed binary know the car-era module surface (`load`'s 5th `book` argument
 * among it)? The JS bundle can be newer than the binary (a shipped store build lags), and
 * an Expo function called with more arguments than it declares THROWS ("received 5
 * arguments, expected 4", expo-modules-core's argument count check on both platforms), so
 * the `book` argument is only passed to a binary that also has `getLoadedBook`: the two
 * ship together. */
function moduleTakesBook(): boolean {
  return typeof AudiosiloPlayer.getLoadedBook === 'function';
}

/**
 * Native playback via the local `audiosilo-player` module (AVQueuePlayer on iOS,
 * Media3/ExoPlayer on Android). The module handles background audio, gapless
 * multi-file playback, lock-screen controls + remote commands, and pitch-corrected
 * speed. The whole-book timeline lives in the player store; this engine works
 * per-track. The module's `NativeState` values match `PlaybackState` 1:1.
 *
 * The newer events (`onRemoteMove`, `onRateChange`, `silenceSaved` on `onProgress`) are
 * listened for on every binary: an older one simply never sends them, and listening for an
 * event a module doesn't declare is harmless. (`onRemoteBookmark` is the car's: see
 * `src/car/car-native.native.ts`.)
 */
class NativePlaybackService implements PlaybackService {
  private snapshot: PlaybackSnapshot = { ...INITIAL_SNAPSHOT };
  private listeners = new Set<(s: PlaybackSnapshot) => void>();
  private subscriptions: EventSubscription[] = [];
  private setupDone = false;
  private remoteMove: ((trackIndex: number, positionInTrack: number) => void) | null = null;
  private rateChange: ((rate: number) => void) | null = null;
  private silenceSaved: ((totalSeconds: number) => void) | null = null;
  private landed: (() => void) | null = null;
  private playAsked: (() => void) | null = null;
  private pauseAsked: (() => void) | null = null;
  /** The engine's playWhenReady as its last `onState` told it (Android), else null. */
  private playWhenReady: boolean | null = null;
  private held: HeldTick | null = null;
  /** The last progress tick the snapshot took in this stretch of playing, and when. Always
   * of the snapshot's file: a new file starts the measure afresh (`update`). */
  private lastTick: { position: number; at: number } | null = null;
  /** The book the engine's last report named (`reportedBook`), else null. */
  private named: BookRef | null = null;
  /** The book the app's load replaced in the engine (`load`, its content key), until a report
   * names another book: a report of it the engine sent before the load reaches JS after the
   * load landed (the events and the load's answer are two channels), and it is dropped
   * (`name`), never read as the loaded book's nor as another book the engine plays (the
   * car's), so the store's Pause and place are the loaded book's. */
  private replaced: string | null = null;
  /** The tags of this run's loads (`load`): each takes the next number past `lastLoad`, from
   * one past `loadBase` (the time this service was made, so a tag an earlier run of the JS gave
   * the engine is below every one of this run's). `standing`: the loads asked since the last
   * one that landed, that one first, none that failed. `loadFloor`: the latest of them, below
   * which a tagged report is of a superseded load (`name`); 0 while none stands (this run has
   * loaded and reset nothing yet, so the queue an earlier run left in the engine, adopted, is
   * the one it holds, and its reports are taken). A load that fails leaves the list, so the
   * floor goes back to the latest load still standing, also when two that overlap both fail
   * (a floor put back to the first one's tag would drop every report of the load before it).
   * A `reset` takes a number of its own and stands as a load does: no report carries it, so
   * every tagged report still on its way is of a queue the reset unloaded, and is dropped. */
  private readonly loadBase = Date.now();
  private lastLoad = this.loadBase;
  private standing: number[] = [];
  private loadFloor = 0;
  /** The app's own moves out (`seekTo`, `skipToTrack`), and when the latest was made: their
   * ticks are never held (`progress`, `ownMoveOut`). */
  private moving = 0;
  private movedAt = 0;

  private emit() {
    for (const listener of this.listeners) listener(this.snapshot);
  }
  private update(patch: Partial<PlaybackSnapshot>) {
    // A place set by anything else (the app's own seek, a new file) replaces a held tick's,
    // and the next tick starts the measure afresh (taken at once, never for a jump).
    if (patch.position !== undefined || patch.trackIndex !== undefined) {
      this.dropHeld();
      this.lastTick = null;
    }
    // Another file told with no length of its own (a file change before its first tick, a
    // skip no tick told) has none yet (0), never the length of the file it left: the store
    // would keep that as the engine's measure of the new file (fe#351).
    const unmeasured =
      patch.trackIndex !== undefined &&
      patch.trackIndex !== this.snapshot.trackIndex &&
      patch.duration === undefined;
    this.snapshot = { ...this.snapshot, ...patch, ...(unmeasured ? { duration: 0 } : null) };
    if (patch.state !== undefined && patch.state !== 'playing') this.lastTick = null;
    this.emit();
  }
  private dropHeld() {
    if (this.held) clearTimeout(this.held.timer);
    this.held = null;
  }
  /** Take the book a report names, before the report itself; false when the report is to be
   * dropped whole. A report tagged with a load (`load`, `isLoadTag`: one of this run's, or of
   * an earlier run of the JS, whose queue this run adopted) is dropped when a later load
   * superseded it (its tag below `loadFloor`: sent before that load, heard after it), whatever
   * book it names (FE-ANDROID-5: on A, then B, then A again, the one slot below let B's late
   * reports pass; an adopted book loaded again, its old queue's late tick named the same
   * book); one of the latest load ends the watch below. A report with no such tag (an older
   * binary, a queue the Android service loaded itself) is dropped
   * when it names the book a load replaced (`replaced`). A report naming any other book ends
   * that, as the engine's reports come in order: the replaced book's late ones are over, and
   * one naming it later is a new play of it (the car). Another book than the last
   * one named starts the measure afresh: a tick held back, or the last one taken, was the
   * other book's. The same book keeps the object it was named by (`reportedBook`). */
  private name(book: unknown, load: unknown): boolean {
    const named = nativeBookOf(book);
    const key = named && contentKeyOf(named);
    if (named && this.isLoadTag(load)) {
      if (load < this.loadFloor) return false;
      this.replaced = null;
    }
    if (key && this.replaced !== null) {
      if (key === this.replaced) return false;
      this.replaced = null;
    }
    if (key && this.named && key === contentKeyOf(this.named)) return true;
    if (named || this.named) {
      this.dropHeld();
      this.lastTick = null;
    }
    this.named = named;
    return true;
  }
  /** The tag of a load (or a reset) asked now: it stands, and is the floor (`loadFloor`). */
  private nextLoad(): number {
    const tag = ++this.lastLoad;
    this.standing.push(tag);
    this.loadFloor = tag;
    return tag;
  }
  /** That load failed: it stands no more, and the floor is the latest one that does. */
  private loadFailed(tag: number) {
    this.standing = this.standing.filter((t) => t !== tag);
    this.loadFloor = this.standing[this.standing.length - 1] ?? 0;
  }
  /** That load landed: every one asked before it is superseded for good, failed or not. */
  private loadLanded(tag: number) {
    this.standing = this.standing.filter((t) => t >= tag);
  }
  /** Is `load` a tag the floor measures: one of this run's loads, or of an earlier run's (below
   * `loadBase`, so below every load of this run)? Not one past this run's latest (a clock set
   * back since the run that gave it): told apart from no load, it is taken as untagged. */
  private isLoadTag(load: unknown): load is number {
    return typeof load === 'number' && load > 0 && load <= this.lastLoad;
  }

  /**
   * A progress tick (fe#211). A lock-screen, headset or car move lands in a tick (`onProgress`)
   * before its `onRemoteMove`: iOS sends the two together, Android the move with the next
   * position change or 300 ms later. Taken at once, the store's save, its 15 s cut or its 5 s
   * keep could end the listening span at the landed place before it heard of the move, so the
   * move read as listening up to there. So a tick whose place jumped while playing (in the
   * same file, past what the time since the last tick plays at the speed, or back) waits up to
   * `LANDING_HOLD_MS` for that move, which then replaces it; a move the engine made by itself
   * (never reported) is taken once the wait is over. The first tick of a play is never held
   * (a resume's auto-rewind is the engine's own move).
   *
   * A pause or the book's end leaves a held tick held: taken as playing stops, its place
   * would end the span there, the very thing the hold prevents. So the store's save as playing
   * stops has the place before the jump; the move's own save follows it, and a held tick no
   * move replaces is told once it is taken (`onLanded`), to be saved again.
   *
   * A tick while the app's own move is out (`ownMoveOut`) is taken at once: no `onRemoteMove`
   * follows it, and the store already knows of the move. Held, the call's place would replace
   * it as the call resolves, so a move the engine took clamped (Media3 or AVPlayer at the end
   * of a VBR file it measures short) would read as landed where it asked, and the store would
   * hear of the clamp only as the engine ran on into the next file.
   *
   * `trackIndex`: the file the engine names with the tick. Android sends a new file's tick
   * before its `onTrackChange`: the tick changes the file itself, so its place and length are
   * never read as the old file's (`fileChanged` then has nothing to tell). Absent, the tick is
   * of the snapshot's file.
   */
  private progress(position: number, duration: number, trackIndex?: number) {
    const now = Date.now();
    // A hold past its time ends at the next tick even when its timer never fired: Android
    // pauses the JS timers in the background, and every tick would otherwise fold into the
    // hold, the store hearing none (no save, cut or keep) until the next state change.
    if (this.held && now - this.held.since >= LANDING_HOLD_MS) this.releaseHeld();
    const ownMove = this.ownMoveOut(now);
    if (ownMove) this.dropHeld();
    const file =
      trackIndex === undefined || trackIndex === this.snapshot.trackIndex ? undefined : trackIndex;
    const last = this.lastTick;
    const playing = this.snapshot.state === 'playing';
    if (this.held) {
      // A later tick while one is held: the newest place waits, on the first one's clock, in
      // the file the tick names (else the one the hold has).
      const held = trackIndex === undefined ? this.held.trackIndex : file;
      this.held = { ...this.held, position, duration, trackIndex: held };
      return;
    }
    const jumped =
      playing &&
      last !== null &&
      !ownMove &&
      (file === undefined
        ? !this.plays(position - last.position, now - last.at) ||
          position < last.position - LANDING_BACK_S
        : !this.ranOn(file, last, position, now));
    if (jumped) {
      const timer = setTimeout(() => this.releaseHeld(), LANDING_HOLD_MS);
      this.held = { position, duration, since: now, from: last, trackIndex: file, timer };
      return;
    }
    this.takeTick(
      file === undefined ? { position, duration } : { trackIndex: file, position, duration },
      now,
    );
  }
  /** Does playing explain covering `seconds` of audio in `ms`, at the speed? */
  private plays(seconds: number, ms: number) {
    return seconds <= (ms / 1000) * (this.snapshot.rate || 1) + LANDING_AHEAD_S;
  }
  private releaseHeld() {
    const held = this.held;
    if (!held) return;
    this.dropHeld();
    const { position, duration, trackIndex } = held;
    this.takeTick(
      trackIndex === undefined ? { position, duration } : { trackIndex, position, duration },
      Date.now(),
    );
    if (this.snapshot.state !== 'playing') this.landed?.();
  }
  /**
   * The engine's file changed. The snapshot never pairs the new file with a place in the old
   * one: a pause right after would save that place under the new file (the old file's end,
   * so the book's end, after a run-on).
   *
   * Android (Media3) reports the new file's tick before the item change, the tick naming its
   * file (`progress`): the change is told already, by the tick taken or by the one held for
   * its move, and there is nothing more to tell. A change no tick told (an item change with no
   * discontinuity) is the file's from here, and a tick held in another file meanwhile is read
   * as `progress` reads a tick naming the new one: a held tick that playing explains (on from
   * the old file's end) is a run-on, told at once with the new file; any other is a move whose
   * report may still come (`onRemoteMove`, up to 300 ms on), told with its place, the move's or
   * at the wait's end; until then the snapshot keeps the place before the jump, with its own
   * file.
   *
   * iOS tells the change before the new file's first tick: a held tick was the file it
   * leaves, taken first, and a new file starts at 0 until its tick.
   *
   * A new file no tick told has no length until its own tick (`update`), on either platform.
   */
  private fileChanged(index: number) {
    const held = this.held;
    if (Platform.OS !== 'android') {
      this.releaseHeld();
      // A rebuild in the same file (a remote move, a skip) tells it too: its place stands
      // until the tick that follows.
      this.update(
        index === this.snapshot.trackIndex
          ? { trackIndex: index }
          : { trackIndex: index, position: 0 },
      );
    } else if (held ? held.trackIndex === index : index === this.snapshot.trackIndex) {
      return;
    } else if (!held) {
      this.update({ trackIndex: index });
    } else if (this.ranOn(index, held.from, held.position, held.since)) {
      this.update({ trackIndex: index, position: held.position, duration: held.duration });
    } else {
      this.held = { ...held, trackIndex: index };
    }
  }
  /** Did playing carry a tick at `position` in file `index`, sent at `at`, on from the
   * snapshot's file's end, its last tick `from` (`lastTick`), into the next file? */
  private ranOn(
    index: number,
    from: { position: number; at: number },
    position: number,
    at: number,
  ) {
    const { trackIndex, duration } = this.snapshot;
    if (index !== trackIndex + 1 || !(duration > 0)) return false;
    return this.plays(duration - from.position + position, at - from.at);
  }
  private takeTick(place: Partial<PlaybackSnapshot>, at: number) {
    this.setPlace(place, at);
    this.emit();
  }
  /** Set the snapshot's place without telling the listeners; while playing, it is the
   * last tick the next one is measured from (`progress`). */
  private setPlace(patch: Partial<PlaybackSnapshot>, at: number) {
    this.snapshot = { ...this.snapshot, ...patch };
    const { state, position } = this.snapshot;
    this.lastTick = state === 'playing' ? { position, at } : null;
  }

  async setup() {
    if (this.setupDone) return;
    this.subscriptions.push(
      AudiosiloPlayer.addListener('onState', ({ state, playWhenReady, book, load }) => {
        if (!this.name(book, load)) return;
        // Android: the engine turned to wanting to play, or stopped (asked by anyone), told
        // first.
        if (typeof playWhenReady === 'boolean') {
          const asked = playWhenReady && this.playWhenReady === false;
          const stopped = !playWhenReady && this.playWhenReady === true;
          this.playWhenReady = playWhenReady;
          if (asked) this.playAsked?.();
          if (stopped) this.pauseAsked?.();
        }
        this.update({ state });
      }),
      AudiosiloPlayer.addListener('onProgress', (tick) => {
        const { position, duration, silenceSaved, book, load } = tick;
        if (!this.name(book, load)) return;
        const file = nativeNumber(tick.trackIndex, -1);
        this.progress(position, duration, Number.isInteger(file) && file >= 0 ? file : undefined);
        // Absent on binaries older than Smart Speed.
        if (typeof silenceSaved === 'number' && Number.isFinite(silenceSaved)) {
          this.silenceSaved?.(silenceSaved);
        }
      }),
      AudiosiloPlayer.addListener('onTrackChange', ({ index, book, load }) => {
        if (!this.name(book, load)) return;
        this.fileChanged(index);
      }),
      // The engine already moved (the lock screen, a headset, the car): the store hears of
      // the move first, its landed place (this snapshot's, `getSnapshot`) right after, so its
      // listening span ends where the engine was, never at the landed place (fe#211). A tick
      // held for it (`progress`) is replaced, its length kept: a move into another file lands
      // in a tick with that file's length. The listeners take the place whatever the handler
      // does.
      AudiosiloPlayer.addListener('onRemoteMove', ({ trackIndex, position, book, load }) => {
        if (!Number.isFinite(trackIndex) || !Number.isFinite(position)) return;
        if (!this.name(book, load)) return;
        const duration = this.held?.duration ?? this.snapshot.duration;
        this.dropHeld();
        this.setPlace({ trackIndex, position, duration }, Date.now());
        try {
          this.remoteMove?.(trackIndex, position);
        } finally {
          this.emit();
        }
      }),
      AudiosiloPlayer.addListener('onRateChange', ({ rate, book, load }) => {
        if (!Number.isFinite(rate) || rate <= 0) return;
        if (!this.name(book, load)) return;
        this.update({ rate });
        this.rateChange?.(rate);
      }),
    );
    await AudiosiloPlayer.setup();
    this.setupDone = true;
  }

  async configure(config: PlaybackConfig) {
    // `smartSpeed` / `voiceBoost` ride along on every binary: the config is a record, and
    // a binary that predates the effects ignores fields it doesn't read.
    await AudiosiloPlayer.setConfig(config);
  }

  async load(
    tracks: PlaybackTrack[],
    startIndex: number,
    positionInTrack: number,
    chapters?: PlaybackChapter[],
    book?: BookRef,
  ) {
    // chapters are the per-chapter clips: Android builds clipped media items from them, iOS
    // drives its chapter lock screen with them. PlaybackChapter and NativeChapter are the
    // same shape, so they pass straight through. `book` goes only to a binary that takes it
    // (see `moduleTakesBook`), tagged with this load (`name`).
    const native = tracks.map(toNativeTrack);
    const told = book && moduleTakesBook() ? book : null;
    const tag = this.nextLoad();
    // From the ask on, a report of the book the engine held is that book's last (`name`). A
    // reload of the same book keeps one a load before it replaced, as no report has named
    // another book since: that book's late reports may still be on their way. A load of that
    // replaced book itself ends it: its reports are this load's.
    const was = this.named && contentKeyOf(this.named);
    const key = told && contentKeyOf(told);
    if (!key || key === this.replaced) this.replaced = null;
    else if (was && was !== key) this.replaced = was;
    try {
      if (told) {
        await AudiosiloPlayer.load(native, startIndex, positionInTrack, chapters ?? [], {
          ...bookRefOf(told),
          load: tag,
        });
      } else {
        await AudiosiloPlayer.load(native, startIndex, positionInTrack, chapters);
      }
    } catch (err) {
      // Not loaded: the engine may still hold that book, and its reports are its own.
      this.replaced = null;
      this.loadFailed(tag);
      throw err;
    }
    this.loadLanded(tag);
    // The engine holds this queue now: the report below is its book's, as the engine's own
    // reports name it from here.
    this.named = told ? bookRefOf(told) : null;
    this.update({
      trackIndex: startIndex,
      position: positionInTrack,
      duration: tracks[startIndex]?.duration ?? 0,
      state: 'ready',
    });
  }

  async play() {
    await AudiosiloPlayer.play();
  }
  async pause() {
    await AudiosiloPlayer.pause();
  }
  async seekTo(positionInTrack: number) {
    // The callers chose a seek for a place in the snapshot's file. Android may already be in
    // another one, a move held for its report (`progress`, `fileChanged`): back to the
    // snapshot's file.
    const moved = this.held?.trackIndex;
    if (moved !== undefined && moved !== this.snapshot.trackIndex) {
      return this.skipToTrack(this.snapshot.trackIndex, positionInTrack);
    }
    await this.ownMove(() => AudiosiloPlayer.seekTo(positionInTrack));
    this.update({ position: positionInTrack });
  }
  async skipToTrack(index: number, positionInTrack = 0) {
    await this.ownMove(() => AudiosiloPlayer.skipToTrack(index, positionInTrack));
    this.update({ trackIndex: index, position: positionInTrack });
  }
  /** `call` makes the app's own move: its ticks are taken at once while it is out (`progress`). */
  private async ownMove(call: () => Promise<void>) {
    this.moving++;
    this.movedAt = Date.now();
    try {
      await call();
    } finally {
      this.moving--;
    }
  }
  /** Is a move of the app's own out? Not one out `OWN_MOVE_MAX_MS` or more: a call that never
   * settles would otherwise leave every later tick taken at once, no jump held for its move. */
  private ownMoveOut(now: number) {
    return this.moving > 0 && now - this.movedAt < OWN_MOVE_MAX_MS;
  }
  async setRate(rate: number) {
    await AudiosiloPlayer.setRate(rate);
    this.update({ rate });
  }
  async setVolume(volume: number) {
    // The JS bundle can be newer than the native binary it runs on: an installed dev
    // build, or a shipped App Store / Play build, that predates `setVolume`. Calling a
    // function a native module doesn't define THROWS, so an unguarded call would turn a
    // sleep-timer fade into a playback-breaking rejection on every older install.
    // Feature-detect, and still catch, so an old binary degrades to "no fade" and resolves.
    if (typeof AudiosiloPlayer.setVolume !== 'function') return;
    try {
      // Not re-clamped here: the store clamps every value on its way out (see
      // `PlaybackService.setVolume`), and the native side clamps again on the far
      // side of the bridge.
      await AudiosiloPlayer.setVolume(volume);
    } catch {
      // no volume control on this binary - silently keep playing at the current volume
    }
  }
  async reset() {
    // The queue is unloaded from the ask on: a tagged report of it heard after this (sent
    // before the reset reached the engine) is dropped (`name`), never taken as the place or
    // state of an engine that holds nothing, or of the book loaded next.
    const tag = this.nextLoad();
    try {
      await AudiosiloPlayer.reset();
    } catch (err) {
      this.loadFailed(tag);
      throw err;
    }
    this.loadLanded(tag);
    this.named = null;
    this.replaced = null;
    this.update({ ...INITIAL_SNAPSHOT, rate: this.snapshot.rate });
  }
  // The native picker is a system UI affordance, always available on iOS/Android.
  canShowRoutePicker() {
    return true;
  }
  async showRoutePicker() {
    return AudiosiloPlayer.showRoutePicker();
  }
  onRemoteMove(handler: ((trackIndex: number, positionInTrack: number) => void) | null) {
    this.remoteMove = handler;
  }
  onRateChange(handler: ((rate: number) => void) | null) {
    this.rateChange = handler;
  }
  onSilenceSaved(handler: ((totalSeconds: number) => void) | null) {
    this.silenceSaved = handler;
  }
  onLanded(handler: (() => void) | null) {
    this.landed = handler;
  }
  onPlayAsked(handler: (() => void) | null) {
    this.playAsked = handler;
  }
  onPauseAsked(handler: (() => void) | null) {
    this.pauseAsked = handler;
  }
  adoptPlace(snapshot: PlaybackSnapshot) {
    // No emit: the store sets its own snapshot when it adopts; this only makes the next
    // engine event (a progress tick carries no track or state) re-emit the right ones.
    this.dropHeld();
    this.lastTick = null;
    this.snapshot = { ...snapshot };
  }
  reportedBook() {
    return this.named;
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

/** The store's one engine: this platform's, behind the Cast route switch (`routed`), which
 * hands playback to a Cast receiver while a session is connected and back after it. */
export function createPlaybackService(): PlaybackService {
  return routed(new NativePlaybackService());
}
