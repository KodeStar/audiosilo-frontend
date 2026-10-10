/// <reference lib="dom" />
import { itemCustomData, fromSdkStatus, type SdkStatus } from './sdk-shapes';
import type {
  CastDriver,
  CastItem,
  CastMediaStatus,
  CastQueueLoad,
  CastRemote,
  CastSessionEvent,
} from './types';
import { loadCastSender, webCastSupported, type SenderWindow } from './web-sender';

/**
 * The web's Cast driver: the Cast Web Sender (CAF, `cast.framework` + `chrome.cast`), loaded
 * on first need (`web-sender.ts`), Chromium on https pages only. It replaces the
 * element's Remote Playback prompt (`service.web.ts`), which would hand the receiver the
 * session token in the element's URL: this sends the cast-token URLs the shared cast engine
 * builds. Only the few framework calls the app needs are typed here.
 */

type Json = Record<string, unknown>;

type ChromeMedia = {
  playerState?: string;
  idleReason?: string | null;
  currentItemId?: number | null;
  playbackRate?: number;
  mediaSessionId?: number;
  items?: { itemId?: number }[] | null;
  media?: { contentId?: string; contentUrl?: string; customData?: unknown } | null;
  getEstimatedTime(): number;
  play(req: null, ok: () => void, err: (e: unknown) => void): void;
  pause(req: null, ok: () => void, err: (e: unknown) => void): void;
  stop(req: null, ok: () => void, err: (e: unknown) => void): void;
  seek(req: unknown, ok: () => void, err: (e: unknown) => void): void;
  addUpdateListener(fn: (isAlive: boolean) => void): void;
  removeUpdateListener(fn: (isAlive: boolean) => void): void;
};

type CafSession = {
  loadMedia(request: unknown): Promise<unknown>;
  getMediaSession(): ChromeMedia | null;
  getCastDevice(): { friendlyName?: string } | null;
  sendMessage(namespace: string, message: Json): Promise<unknown>;
  getSessionObj(): { addMediaListener?(fn: (m: ChromeMedia) => void): void };
};

type CafContext = {
  setOptions(options: Json): void;
  addEventListener(
    type: string,
    fn: (e: { sessionState?: string; errorCode?: string }) => void,
  ): void;
  removeEventListener(type: string, fn: (e: { sessionState?: string }) => void): void;
  requestSession(): Promise<unknown>;
  getCurrentSession(): CafSession | null;
  endCurrentSession(stopCasting: boolean): void;
};

type CastGlobals = {
  cast: {
    framework: {
      CastContext: { getInstance(): CafContext };
      CastContextEventType: { SESSION_STATE_CHANGED: string };
      SessionState: Record<string, string>;
    };
  };
  chrome: {
    cast: {
      AutoJoinPolicy: { ORIGIN_SCOPED: string };
      Image: new (url: string) => unknown;
      media: {
        DEFAULT_MEDIA_RECEIVER_APP_ID: string;
        MediaInfo: new (contentId: string, contentType: string) => Json;
        MusicTrackMediaMetadata: new () => Json;
        QueueItem: new (mediaInfo: Json) => Json;
        QueueData: new () => Json;
        LoadRequest: new (mediaInfo: Json) => Json;
        SeekRequest: new () => Json;
        ContainerMetadata?: new () => Json;
        QueueType?: { AUDIOBOOK?: string };
        ContainerType?: { AUDIOBOOK_CONTAINER?: number };
      };
    };
  };
};

const MEDIA_NAMESPACE = 'urn:x-cast:com.google.cast.media';

function globals(): CastGlobals | null {
  const w = (typeof window !== 'undefined' ? window : undefined) as unknown as
    (Partial<CastGlobals> & SenderWindow) | undefined;
  return w?.cast?.framework && w.chrome && (w.chrome as Partial<CastGlobals['chrome']>).cast
    ? (w as CastGlobals)
    : null;
}

function call(fn: (ok: () => void, err: (e: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => fn(resolve, reject));
}

function mediaInfo(g: CastGlobals, item: CastItem, load: CastQueueLoad): Json {
  const info = new g.chrome.cast.media.MediaInfo(item.url, item.contentType);
  info.contentUrl = item.url;
  info.streamType = 'BUFFERED';
  if (item.duration) info.duration = item.duration;
  info.customData = itemCustomData(item, load.book);
  const meta = new g.chrome.cast.media.MusicTrackMediaMetadata();
  meta.title = item.title;
  if (item.artist) meta.artist = item.artist;
  if (item.album) meta.albumName = item.album;
  if (item.cover) meta.images = [new g.chrome.cast.Image(item.cover)];
  info.metadata = meta;
  return info;
}

function loadRequest(g: CastGlobals, load: CastQueueLoad): Json {
  const items = load.items.map((item) => {
    const q = new g.chrome.cast.media.QueueItem(mediaInfo(g, item, load));
    q.autoplay = true;
    q.preloadTime = 10;
    q.customData = itemCustomData(item, load.book);
    return q;
  });
  const queue = new g.chrome.cast.media.QueueData();
  queue.items = items;
  queue.startIndex = load.startIndex;
  queue.startTime = load.startTime;
  if (g.chrome.cast.media.QueueType?.AUDIOBOOK)
    queue.queueType = g.chrome.cast.media.QueueType.AUDIOBOOK;
  const request = new g.chrome.cast.media.LoadRequest(items[load.startIndex].media as Json);
  request.queueData = queue;
  request.autoplay = load.autoplay;
  request.currentTime = load.startTime;
  request.playbackRate = load.rate;
  return request;
}

function statusOf(m: ChromeMedia | null): CastMediaStatus | null {
  if (!m) return null;
  return fromSdkStatus({
    playerState: m.playerState,
    idleReason: m.idleReason,
    currentItemId: m.currentItemId,
    playbackRate: m.playbackRate,
    streamPosition: m.getEstimatedTime(),
    queueItems: m.items,
    mediaInfo: m.media,
  } as SdkStatus);
}

function remoteOf(session: CafSession, g: CastGlobals): CastRemote {
  const media = () => session.getMediaSession();
  const statusHandlers = new Set<(s: CastMediaStatus | null) => void>();
  const watched = new WeakSet<ChromeMedia>();
  const watch = (m: ChromeMedia | null) => {
    if (!m || watched.has(m)) return;
    watched.add(m);
    const onUpdate = (alive: boolean) => {
      const s = alive ? statusOf(m) : null;
      for (const h of statusHandlers) h(s);
      if (!alive) m.removeUpdateListener(onUpdate);
    };
    m.addUpdateListener(onUpdate);
  };
  // Media another sender loaded (or this page before a reload) is ours to follow too.
  session.getSessionObj().addMediaListener?.((m) => watch(m));
  watch(media());
  const withMedia = (fn: (m: ChromeMedia) => Promise<void>) => {
    const m = media();
    return m ? fn(m) : Promise.reject(new Error('No media on the receiver'));
  };
  return {
    async load(request) {
      await session.loadMedia(loadRequest(g, request));
      watch(media());
    },
    play: () => withMedia((m) => call((ok, err) => m.play(null, ok, err))),
    pause: () => withMedia((m) => call((ok, err) => m.pause(null, ok, err))),
    stop: () => withMedia((m) => call((ok, err) => m.stop(null, ok, err))),
    seek: (position) =>
      withMedia((m) => {
        const req = new g.chrome.cast.media.SeekRequest();
        req.currentTime = position;
        return call((ok, err) => m.seek(req, ok, err));
      }),
    // The web SDK has no setPlaybackRate; the media channel's SET_PLAYBACK_RATE does it.
    setRate: (rate) =>
      withMedia(async (m) => {
        await session.sendMessage(MEDIA_NAMESPACE, {
          type: 'SET_PLAYBACK_RATE',
          mediaSessionId: m.mediaSessionId,
          playbackRate: rate,
          requestId: Math.floor(Math.random() * 1e9),
        });
      }),
    readStatus: async () => statusOf(media()),
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => {
        statusHandlers.delete(handler);
      };
    },
    onProgress(handler) {
      const timer = setInterval(() => {
        const m = media();
        if (m && m.playerState === 'PLAYING') handler(m.getEstimatedTime());
      }, 1000);
      return () => clearInterval(timer);
    },
  };
}

const win = (): SenderWindow | undefined =>
  typeof window !== 'undefined' ? (window as unknown as SenderWindow) : undefined;

let ready: Promise<boolean> | null = null;
const handlers = new Set<(e: CastSessionEvent) => void>();

function context(): CafContext | null {
  return globals()?.cast.framework.CastContext.getInstance() ?? null;
}

/** Load the sender and set it up once: the Default Media Receiver, joining a session this
 * origin already has (a page reload mid-cast), and the session events. */
function initOnce(): Promise<boolean> {
  ready ??= (async () => {
    const w = win();
    if (!w || !webCastSupported(w)) return false;
    const ok = await loadCastSender(w, document as unknown as Parameters<typeof loadCastSender>[1]);
    const g = globals();
    // Kept: the sender loads at most once per page (`loadCastSender`), so a later need
    // would fail the same way.
    if (!ok || !g) return false;
    const ctx = g.cast.framework.CastContext.getInstance();
    ctx.setOptions({
      receiverApplicationId: g.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
      autoJoinPolicy: g.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });
    const S = g.cast.framework.SessionState;
    ctx.addEventListener(g.cast.framework.CastContextEventType.SESSION_STATE_CHANGED, (e) => {
      const emit = (event: CastSessionEvent) => {
        for (const h of handlers) h(event);
      };
      const session = ctx.getCurrentSession();
      switch (e.sessionState) {
        case S.SESSION_STARTING:
          emit({ type: 'starting' });
          break;
        case S.SESSION_STARTED:
        case S.SESSION_RESUMED:
          if (session) {
            emit({
              type: e.sessionState === S.SESSION_STARTED ? 'started' : 'resumed',
              remote: remoteOf(session, g),
              deviceName: session.getCastDevice()?.friendlyName || undefined,
            });
          }
          break;
        case S.SESSION_START_FAILED:
          emit({ type: 'startFailed', error: e.errorCode });
          break;
        case S.SESSION_ENDING:
          emit({ type: 'ending' });
          break;
        case S.SESSION_ENDED:
          emit({ type: 'ended' });
          break;
      }
    });
    return true;
  })();
  return ready;
}

export const castDriver: CastDriver = {
  async supported() {
    return webCastSupported(win());
  },
  init: initOnce,
  subscribe(handler) {
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  },
  async current() {
    const g = globals();
    const session = context()?.getCurrentSession() ?? null;
    if (!g || !session) return null;
    return {
      remote: remoteOf(session, g),
      deviceName: session.getCastDevice()?.friendlyName || undefined,
    };
  },
  async endSession(stopCasting) {
    context()?.endCurrentSession(stopCasting);
  },
  async requestSession() {
    if (!(await initOnce())) return;
    // Rejects when the listener closes the chooser: not an error.
    await context()
      ?.requestSession()
      .catch(() => undefined);
  },
};
