import { AppState, Platform } from 'react-native';

import { toast } from '@/components/ui/toast';
import i18n from '@/i18n';
import { bootstrapPlayback } from '@/lib/bootstrap';
import { initializePlayback, usePlayer } from '@/playback/store';
import { bookRefOf } from '@/playback/types';
import { onConnectionRemoved } from '@/stores/session';

import { castStreamOffset } from './cast-media';
import { CastBlockedError, type PrepareCast, prepareCast } from './cast-prepare';
import { CastPlaybackService } from './cast-service';
import { castTokens } from './cast-token';
import { useCast } from './cast-state';
import { castDriver } from './driver';
import { currentRouter, type RoutedPlaybackService, whenRouter } from './routed-service';
import type { CastDriver, CastRemote, CastSessionEvent } from './types';

/** Tell the listener a book could not go to the receiver (it stays on this device). */
function explain(err: unknown, deviceName: string | null) {
  const t = i18n.t.bind(i18n);
  if (err instanceof CastBlockedError) {
    toast({
      title: t(err.reason === 'episode' ? 'cast.blocked.titleEpisode' : 'cast.blocked.title'),
      description: t(`cast.blocked.${err.reason}`),
    });
    return;
  }
  toast({
    title: deviceName
      ? t('cast.failed.titleDevice', { device: deviceName })
      : t('cast.failed.title'),
    description: t('cast.failed.description'),
  });
}

/**
 * A session resumed with media of ours playing while the app has no book loaded (it was
 * killed or relaunched mid-cast): take that book into the store the way the Android car
 * adoption does (`adoptLoaded`: no reload, the receiver's place and speed, its play state),
 * then give the cast route the queue the store built, so seeks and file jumps work and the
 * book can come back to the phone when the session ends.
 */
async function adoptReceiverBook(
  router: RoutedPlaybackService,
  cast: CastPlaybackService,
  remote: CastRemote,
) {
  const status = await remote.readStatus();
  const book = status?.book;
  if (!status || !book || status.playerState === 'idle') return;
  const playing = status.playerState === 'playing' || status.playerState === 'buffering';
  const adopted = await usePlayer.getState().adoptLoaded({
    ...book,
    trackIndex: typeof status.customIndex === 'number' ? status.customIndex : 0,
    position: (Number.isFinite(status.position) ? status.position : 0) + castStreamOffset(status),
    rate: status.rate,
    playing,
  });
  const np = usePlayer.getState().nowPlaying;
  if (!adopted || !np || router.castRoute() !== cast) return;
  router.rememberLoad({
    tracks: np.queue.tracks,
    chapters: np.queue.chapterClips,
    book: bookRefOf(np),
  });
  await cast.adoptQueue(np.queue.tracks, bookRefOf(np), status).catch((err) => {
    console.warn('[cast] could not rebuild the receiver queue', err);
  });
}

/**
 * Start following Cast sessions for the app's lifetime (the root layout calls it once; the
 * returned function stops it, for tests). Framework-free: the driver's session events switch
 * the store's playback route (`RoutedPlaybackService`) to the receiver and back, and keep
 * `useCast` current. On the web nothing is loaded until the Cast button asks
 * (`ensureCastReady`).
 */
export function startCastSync(
  deps: { driver?: CastDriver; prepare?: PrepareCast } = {},
): () => void {
  const driver = deps.driver ?? castDriver;
  const prepare = deps.prepare ?? prepareCast;
  let stopped = false;
  /** A connect still awaiting the stores gives way when a session replaces it or ends. */
  let generation = 0;
  // The driver's live session, including one still waiting to become the route.
  let session = currentRouter()?.castSession() ?? null;
  /** The receiver being read for hand-back, kept until the driver reports its end. */
  let ending: {
    generation: number;
    session: CastPlaybackService | null;
    read: Promise<void>;
  } | null = null;
  const cleanups: (() => void)[] = [];

  const connect = async (
    type: 'started' | 'resumed',
    remote: CastRemote,
    deviceName: string | undefined,
  ) => {
    const gen = ++generation;
    useCast.setState({ status: 'connected', deviceName: deviceName ?? null });
    await bootstrapPlayback(); // the session's books need the stores hydrated
    if (gen !== generation || stopped) return;
    if (type === 'resumed' && !currentRouter()) await initializePlayback();
    if (gen !== generation || stopped) return;
    cleanups.push(
      // The store creates its engine (and with it the router) on the first play: a session
      // that connects before that becomes the route then.
      whenRouter((router) => {
        if (gen !== generation || stopped) return;
        // The app back from the background (iOS suspends the sender there): the same
        // session, already the route. Read where the receiver got to.
        const existing = router.castRoute();
        if (existing && existing === session && type === 'resumed') {
          void existing.refresh();
          return;
        }
        const cast = new CastPlaybackService(remote, prepare);
        session = cast;
        router.onCastFailed = (err) => {
          explain(err, useCast.getState().deviceName);
          void driver.endSession(true);
        };
        const hadBook = usePlayer.getState().nowPlaying !== null;
        void router.beginCast(cast).then(() => {
          // Not a session that never took the route (it ended, or another replaced it, while
          // it waited for the phone's load): its book is not the store's to adopt.
          if (router.castRoute() !== cast) return;
          if (type === 'resumed' && !hadBook) void adoptReceiverBook(router, cast, remote);
        });
      }),
    );
  };

  const onEvent = (event: CastSessionEvent) => {
    if (stopped) return;
    switch (event.type) {
      case 'starting':
        useCast.setState({ status: 'connecting' });
        break;
      case 'started':
      case 'resumed':
        void connect(event.type, event.remote, event.deviceName);
        break;
      case 'startFailed':
        generation++;
        useCast.setState({ status: 'off', deviceName: null });
        toast({ title: i18n.t('cast.failed.connect') });
        break;
      case 'suspended':
        // iOS stops the sender in the background: save where the receiver is now.
        currentRouter()?.checkpoint();
        break;
      case 'ending':
        // A last read of the receiver's place while the session can still answer. The
        // session is the driver's no longer: a resume after this is a new one.
        ending = {
          generation,
          session,
          read: currentRouter()?.castRoute()?.refresh() ?? Promise.resolve(),
        };
        session = null;
        break;
      case 'ended': {
        const router = currentRouter();
        const ended = ending ? ending.session : session;
        const read = ending?.read ?? Promise.resolve();
        if (!ending || ending.generation === generation) {
          generation++;
          session = null;
          useCast.setState({ status: 'off', deviceName: null });
        }
        ending = null;
        if (router && ended) void read.then(() => router.endCast(ended));
        break;
      }
    }
  };

  void (async () => {
    const supported = await driver.supported().catch(() => false);
    if (stopped) return;
    useCast.setState({ supported });
    if (!supported) return;
    cleanups.push(driver.subscribe(onEvent));
    // The web loads its sender only when the Cast button needs it; native is ready now, and
    // a session may already be running (the app was relaunched while the TV played on).
    if (Platform.OS === 'web') return;
    if (!(await driver.init())) return;
    const running = await driver.current().catch(() => null);
    if (running && !stopped) void connect('resumed', running.remote, running.deviceName);
  })();

  // iOS suspends the app (and with it the sender) soon after it leaves the foreground: the
  // receiver's place is saved as it goes.
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'background' && useCast.getState().status === 'connected') {
      currentRouter()?.checkpoint();
    }
  });
  cleanups.push(() => appState.remove());
  cleanups.push(onConnectionRemoved((id) => castTokens.clear(id)));

  return () => {
    stopped = true;
    for (const c of cleanups) c();
  };
}

/** Stop casting (from the app's own UI): the session ends and the book comes back here. */
export function stopCasting(driver: CastDriver = castDriver): Promise<void> {
  return driver.endSession(true);
}

/**
 * End a cast for the car (CarPlay / Android Auto asked to play while a book was on a Cast
 * receiver): the car is where the listener is, so the book plays there. The receiver's
 * latest place is read, the book comes back to this device paused there (the store saves
 * it), and only then is the session ended and the receiver stopped, so the car's play that
 * follows starts on this device and never on the TV. Resolves whether a cast was ended.
 */
export async function endCastForCar(driver: CastDriver = castDriver): Promise<boolean> {
  const router = currentRouter();
  // A session still waiting to take the route (`beginningCast`) would take the car's play to
  // the TV once the phone's load landed: it is ended too.
  if (!router || (!router.isCasting() && !router.beginningCast())) return false;
  await router.castRoute()?.refresh();
  await router.endCast();
  await driver.endSession(true).catch(() => undefined);
  return true;
}
