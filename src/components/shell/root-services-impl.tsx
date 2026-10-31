import { useEffect } from 'react';

import { startAddressRouting } from '@/api/address-runner';
import { startCarSync } from '@/car/car-controller';
import { startCastSync } from '@/cast/cast-session';
import { BookEndedListener } from '@/components/player/book-ended-listener';
import { CompanionRevealListener } from '@/components/player/companion/reveal-listener';
import { ShakeToExtendListener } from '@/components/player/shake-to-extend-listener';
import { startKeepAhead } from '@/downloads/keep-ahead-controller';
import { startChapterRefresh, startReadalongRefresh } from '@/downloads/store';
import { startAutoSleep } from '@/playback/auto-sleep-controller';
import { startDriftWatch } from '@/playback/drift-controller';
import { startJumpUndo } from '@/playback/jump-undo';
import { startListeningSync } from '@/playback/listening-sync';
import { startPlaceReconcile } from '@/playback/place-reconcile';
import { startWidgetSync } from '@/widgets/widget-sync';

/**
 * The app's lifetime services, started by the root layout (`useRootServices`; the web's
 * `RootServices`) and stopped in the same order: framework-free controllers (subscriptions,
 * no rendering), so they are started rather than mounted as components that render null. Each runs whether or not
 * the player is open, on every screen. Returns the stop.
 */
export function startRootServices({ late = false }: { late?: boolean } = {}): () => void {
  const stops = [
    // The nightly auto sleep timer: it must arm for a book started from the mini player,
    // the library, or a lock-screen play.
    startAutoSleep(),
    // "Fell asleep": the bookmark and the "You drifted off" prompt after a sleep timer
    // stopped a book nobody was awake for.
    startDriftWatch({ late }),
    // "Keep the next books ready" (downloads the books after the loaded one when the
    // listener opted in); see the controller.
    startKeepAhead(),
    // A downloaded book takes the server's changed chapters (a rescan, community chapters)
    // whenever they arrive online, while its audio files are unchanged; see the store.
    startChapterRefresh(),
    // A downloaded book keeps its read-along map in step: fetched again once it is made
    // again, dropped once the server has none ready; see the store.
    startReadalongRefresh(),
    // Undo jump: remembers where the listener was after any jump of more than a minute
    // (scrub, chapter tap, lock-screen seek...) for the "Back to 17:26:50" chip. Watches the
    // player's snapshots, so it must run whatever is on screen; see the module.
    startJumpUndo(),
    // A loaded book picked up again (the app back in front, its server back, a play after
    // a long pause) first asks its server whether another device moved its place on, and
    // follows it with an Undo; see the module.
    startPlaceReconcile(),
    // Sync v2 (`listening_sync`): sends the listening outbox at launch, on reconnect and in
    // the foreground, and cuts the playing span when the app leaves; see the module.
    startListeningSync(),
    // Home and away addresses: picks the address each server is reached at (native only)
    // and keeps the playing book on it; see the module.
    startAddressRouting(),
    // iOS: the Continue listening widget and the sleep timer Live Activity follow the
    // player and the sleep timer (a no-op elsewhere); see the module.
    startWidgetSync(),
  ];
  // CarPlay and Android Auto: keeps the car's lists (the car snapshot) current, plays what
  // the car asks for, saves the car's bookmarks and adopts a book the car started. Native
  // only (a no-op on the web and on a binary without the car functions); it waits for the
  // launch steps itself. Never stopped (like the car's headless task): the JS runtime
  // outlives the root layout on Android (the activity is destroyed, the store and its book
  // live on), and while it runs the car's requests must reach it, never start a book
  // natively under the store's.
  startCarSync();
  // Chromecast: follows Cast sessions and switches the player's route to the receiver and
  // back (the cast is a playback route, not a second player). A no-op where this device or
  // binary can't cast. See `src/cast/cast-session.ts`.
  stops.push(startCastSync());
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * The root's listeners, which render nothing: the end-of-book flow when a book reaches its
 * natural end (root-level so it covers every layout); "New in Who's who" wherever the
 * listener is when the playing book crosses into a chapter that introduces someone; and a
 * shake that keeps the listener going while the phone is locked and no player screen is
 * mounted.
 */
export function RootListeners() {
  return (
    <>
      <BookEndedListener />
      <CompanionRevealListener />
      <ShakeToExtendListener />
    </>
  );
}

/**
 * The services and the listeners in one component, for the web: `root-services.web.tsx`
 * mounts it once the first screen has painted, and the services stop when it goes.
 */
export function RootServices() {
  useEffect(() => startRootServices({ late: true }), []);
  return <RootListeners />;
}
