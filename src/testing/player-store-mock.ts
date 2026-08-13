import { create } from 'zustand';

import type { Chapter } from '@/api/types';

/**
 * The shared stand-in for `@/playback/store`, for the tests around the sleep timer.
 *
 * Three suites need the player store without the engine, the API layer or a device
 * behind it - the timer store itself, the auto sleep controller, and the sleep-timer
 * button - and each used to carry its own copy. Two were the same factory (one said so
 * in a comment); the third hand-rolled a fake `subscribe` over a module-level listener
 * set, which is precisely the suite where store-subscription semantics are load-bearing
 * (the timer freezes its countdown off a store notification). One double, used by all
 * three, means the fidelity is decided once - and it is a REAL zustand store, so
 * `subscribe(state, prev)` behaves exactly as it does in production rather than as a
 * fake that could drift from it.
 *
 * Use it as the whole mocked module:
 *
 * ```ts
 * jest.mock('@/playback/store', () =>
 *   // `require` because a jest.mock factory is hoisted above every import.
 *   require('@/testing/player-store-mock').createPlayerStoreMock(),
 * );
 * const player = playerStoreMock(); // the same instance, typed, for driving it
 * ```
 */

/** Just enough of `NowPlaying` for the selectors and the timer's chapter scan. */
export type MockNowPlaying = {
  connectionId: string;
  libraryId: number;
  path: string;
  queue: { chapters: Chapter[]; total: number };
};

export type MockSnapshot = {
  state: string;
  trackIndex: number;
  position: number;
  duration: number;
  rate: number;
};

export type PlayerMockState = {
  snapshot: MockSnapshot;
  nowPlaying: MockNowPlaying | null;
  rate: number;
  /** Whole-book position, i.e. what `selectBookPosition` reads. The real store derives
   * it from the queue's offsets; here it is simply set. */
  bookPosition: number;
  pause: () => Promise<void>;
  toggle: () => Promise<void>;
  setOutputVolume: (volume: number) => Promise<void>;
};

const IDLE_SNAPSHOT: MockSnapshot = {
  state: 'idle',
  trackIndex: 0,
  position: 0,
  duration: 0,
  rate: 1,
};

function buildPlayerStoreMock() {
  const spies = {
    pause: jest.fn(() => Promise.resolve()),
    toggle: jest.fn(() => Promise.resolve()),
    /**
     * Every gain actually written to the ENGINE. The real `setOutputVolume` holds the
     * gain the engine is at and drops a write that would not change it (see
     * `store.ts`), and so does this - otherwise the timer's many defensive restores
     * would show up here as writes that production never makes.
     */
    setVolume: jest.fn((volume: number) => Promise.resolve(volume)),
  };
  let outputVolume = 1;

  const initialState = (): PlayerMockState => ({
    snapshot: { ...IDLE_SNAPSHOT },
    nowPlaying: null,
    rate: 1,
    bookPosition: 0,
    /**
     * Records the call and then writes the paused snapshot the way the real store
     * does - in that order, so a listener reacting to the write (the timer's freeze
     * watch does) is ordered after the pause itself, as it is in production.
     *
     * Writing the snapshot at all matters rather than being decoration: the sleep
     * timer FIRING calls this, and whether playback is left playing decides whether an
     * automatic timer could re-arm itself with no play edge from the listener.
     */
    pause: () => {
      const done = spies.pause();
      usePlayer.setState({ snapshot: { ...usePlayer.getState().snapshot, state: 'paused' } });
      return done;
    },
    /** A pure spy: the real `toggle` goes through the engine, and a resume that
     * synthesised a `playing` snapshot here would test the double, not the code. Tests
     * that need the resume to land write the snapshot themselves. */
    toggle: () => spies.toggle(),
    setOutputVolume: (volume: number) => {
      if (volume === outputVolume) return Promise.resolve(); // the store's no-op write
      outputVolume = volume;
      void spies.setVolume(volume);
      return Promise.resolve();
    },
  });

  const usePlayer = create<PlayerMockState>()(() => initialState());

  // Wrap `subscribe` so a test can drop every live subscription - the reachable shape
  // of "the watch was not installed for this write", which the timer's tick-backstop
  // test needs. Everything else about it is zustand's own.
  const storeSubscribe = usePlayer.subscribe.bind(usePlayer);
  const unsubscribes = new Set<() => void>();
  usePlayer.subscribe = ((listener: Parameters<typeof storeSubscribe>[0]) => {
    const off = storeSubscribe(listener);
    const drop = () => {
      unsubscribes.delete(drop);
      off();
    };
    unsubscribes.add(drop);
    return drop;
  }) as typeof usePlayer.subscribe;

  return {
    usePlayer,

    // The store's real selectors, over the stand-in state.
    selectBookPosition: (s: PlayerMockState) => s.bookPosition,
    /** The book's `contentKey` identity - the one the timer scopes itself to and auto
     * sleep keys its memory on. */
    selectBookKey: (s: PlayerMockState) =>
      s.nowPlaying
        ? `${s.nowPlaying.connectionId}:${s.nowPlaying.libraryId}:${s.nowPlaying.path}`
        : null,
    /** The strict reading: audio is coming out of the speaker. */
    selectIsPlaying: (s: PlayerMockState) => s.snapshot.state === 'playing',
    /** The loose reading, which counts a book buffering with playback intended. */
    selectIsTransportLive: (s: PlayerMockState) =>
      s.snapshot.state === 'playing' || s.snapshot.state === 'loading',

    // --- driving the double ------------------------------------------------

    /** The spies to assert on. */
    spies,
    /** Change the play state the way the real store does: a write that NOTIFIES. */
    setPlayState(state: string) {
      usePlayer.setState({ snapshot: { ...usePlayer.getState().snapshot, state } });
    },
    /** Set the world up WITHOUT notifying - fixture setup, and the shape of a change
     * that happened while nothing was subscribed. */
    patch(partial: Partial<PlayerMockState>) {
      Object.assign(usePlayer.getState(), partial);
    },
    /** Unsubscribe every live subscriber: "nobody is watching the store any more". */
    dropSubscribers() {
      for (const drop of [...unsubscribes]) drop();
    },
    /** How many subscriptions are live - for the callers that attach and detach theirs
     * rather than holding one for the process lifetime. */
    subscriberCount() {
      return unsubscribes.size;
    },
    /** Back to an idle player with nothing loaded (spies are left alone - a test
     * clears them where it wants the count to start). */
    reset() {
      outputVolume = 1;
      usePlayer.setState(initialState(), true);
    },
    clearSpies() {
      spies.pause.mockClear();
      spies.toggle.mockClear();
      spies.setVolume.mockClear();
    },
  };
}

export type PlayerStoreMock = ReturnType<typeof buildPlayerStoreMock>;

let current: PlayerStoreMock | null = null;

/** Build the double. The `jest.mock` factory calls this; it also stashes the instance
 * for `playerStoreMock()` below, so a test can drive the very module it mocked. */
export function createPlayerStoreMock(): PlayerStoreMock {
  current = buildPlayerStoreMock();
  return current;
}

/**
 * The double the `jest.mock` factory created, for tests that drive it. Throws rather
 * than handing back a stale instance, since the factory runs once per module registry
 * (a test that calls `jest.resetModules()` must re-require both).
 */
export function playerStoreMock(): PlayerStoreMock {
  if (!current)
    throw new Error('createPlayerStoreMock() has not run - is @/playback/store mocked?');
  return current;
}
