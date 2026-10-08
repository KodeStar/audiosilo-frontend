import { requireOptionalNativeModule } from 'expo';
import { Directory, File } from 'expo-file-system';
import type { LiveActivity, LiveActivityFactory, Widget } from 'expo-widgets';
import type { TFunction } from 'i18next';
import i18next from 'i18next';
import { AppState } from 'react-native';

import { resolveClient } from '@/api/connection-clients';
import { useSleepTimer } from '@/playback/sleep-timer';
import { usePlayer, type NowPlaying } from '@/playback/store';
import { onConnectionRemoved, useSession } from '@/stores/session';

import {
  ACTIVITY_COVER_MAX,
  ACTIVITY_COVER_SIZE,
  continueListeningProps,
  coverStem,
  emptyContinueListeningProps,
  fitsCover,
  MIN_WRITE_MS,
  sameActivity,
  sleepActivityProps,
  WIDGET_COVER_MAX,
  WIDGET_COVER_SIZE,
  widgetMark,
  writeDecision,
  type ContinueListeningProps,
  type SleepTimerActivityProps,
  type WidgetMark,
} from './widget-model';

/**
 * The iOS widget sync (decision 9, contract 2.6): keeps the `ContinueListening` widget
 * and the `SleepTimer` Live Activity in step with the player and the sleep timer.
 * Framework-free like the other `start*` controllers in the root layout: subscriptions,
 * no rendering. What to write and when is `widget-model.ts` (pure, tested); this is the
 * wiring.
 *
 * - **Widget.** Rewritten when the book, the chapter, play/pause or the speed changes, on
 *   a jump of more than 30 s, when playback stops (same book, not playing), and once a
 *   minute while playing (the time left). Bursts coalesce into one write per
 *   `MIN_WRITE_MS`. WidgetKit does not count these reloads against the widget's budget
 *   while the app is the Now Playing app, which is the only time most of them happen.
 * - **Covers.** Written once per book into `widgetsDirectory` (the extension cannot
 *   fetch): the server's 320 px thumbnail for the widget and its 160 px one for the Live
 *   Activity, else the downloaded book's cover, each only when its header says it is
 *   small enough (`fitsCover`; there is no image resizer in the app). Other books'
 *   covers are deleted, so the folder holds one book.
 * - **Live Activity.** Started when a timer counts down and the app is in the foreground
 *   (ActivityKit refuses a start from the background; a timer armed in the background,
 *   like the nightly auto sleep timer, gets its activity the next time the app comes to
 *   the front), updated when the end moves (extend, freeze, seek or speed under an
 *   end-of-chapter timer, a new chapter), ended IMMEDIATELY when the timer fires or is
 *   cancelled. One the listener swiped away is not started again for that timer.
 * - **Sign-out.** Removing the connection whose book the widget shows clears it.
 */

type T = TFunction;

/** What the sync needs from expo-widgets and the platform, injected so the wiring is
 * testable without the native module. `startWidgetSync` supplies the real ones. */
export type WidgetSyncDeps = {
  widget: Pick<Widget<ContinueListeningProps>, 'updateSnapshot' | 'getTimeline'>;
  activity: Pick<LiveActivityFactory<SleepTimerActivityProps>, 'start' | 'getInstances'>;
  /** Writes (or finds) the book's two cover files; resolves their URLs. */
  prepareCovers: (np: NowPlaying) => Promise<Covers>;
  /** Deletes every cover file (sign-out). */
  clearCovers: () => void;
  isForeground: () => boolean;
  /** Subscribe to the app coming to the foreground. */
  onForeground: (fn: () => void) => () => void;
  t: () => T;
  now: () => number;
};

export type Covers = { widget?: string; activity?: string };

type Activity = Pick<LiveActivity<SleepTimerActivityProps>, 'update' | 'end'>;

function warn(what: string, e: unknown) {
  console.warn(`[widgets] ${what}`, e);
}

/** The sync over injected deps. Returns the teardown. */
export function runWidgetSync(deps: WidgetSyncDeps): () => void {
  // --- the widget ---------------------------------------------------------------------
  let lastMark: WidgetMark | null = null;
  let lastProps: ContinueListeningProps | null = null;
  let lastWriteAt = -Infinity;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  /** The covers of the book they were made for (`stem`), once ready. */
  let covers: { stem: string; files: Covers } | null = null;
  /** The book whose covers are being (or have been) prepared this session. */
  let coverJob: string | null = null;
  let disposed = false;

  const write = (props: ContinueListeningProps) => {
    lastProps = props;
    lastWriteAt = deps.now();
    try {
      deps.widget.updateSnapshot(props);
    } catch (e) {
      warn('widget write failed', e);
    }
  };

  const coversFor = (np: NowPlaying): Covers => {
    const stem = coverStem(np.connectionId, np.libraryId, np.path);
    return covers?.stem === stem ? covers.files : {};
  };

  const connectionExists = (id: string) =>
    useSession.getState().connections.some((c) => c.id === id);

  const writeNow = () => {
    trailing = null;
    if (disposed) return;
    const player = usePlayer.getState();
    lastMark = widgetMark(player, deps.now());
    const np = player.nowPlaying;
    // Nothing loaded any more (stopped, finished): the widget keeps the book it shows -
    // that is what "continue listening" means - but it is no longer playing.
    if (!np) {
      if (lastProps?.isPlaying) write({ ...lastProps, isPlaying: false });
      return;
    }
    // A book of a server that has just been signed out of is not written back.
    if (!connectionExists(np.connectionId)) return;
    const props = continueListeningProps(player, deps.t(), coversFor(np).widget);
    if (props) write(props);
  };

  const scheduleWrite = () => {
    if (trailing) return; // the pending write will read the latest state
    const wait = MIN_WRITE_MS - (deps.now() - lastWriteAt);
    if (wait <= 0) writeNow();
    else trailing = setTimeout(writeNow, wait);
  };

  const ensureCovers = (np: NowPlaying | null) => {
    if (!np) return;
    const stem = coverStem(np.connectionId, np.libraryId, np.path);
    if (coverJob === stem) return;
    coverJob = stem;
    void deps
      .prepareCovers(np)
      .catch((e: unknown) => {
        warn('cover failed', e);
        return {} as Covers;
      })
      .then((files) => {
        if (disposed || coverJob !== stem) return; // another book since
        covers = { stem, files };
        // Show it: the props written meanwhile had no cover.
        lastMark = null;
        scheduleWrite();
        reconcileActivity();
      });
  };

  const onPlayer = () => {
    const player = usePlayer.getState();
    ensureCovers(player.nowPlaying);
    const decision = writeDecision(lastMark, widgetMark(player, deps.now()));
    if (decision !== 'skip') scheduleWrite();
    reconcileActivity();
  };

  // --- the Live Activity -----------------------------------------------------------
  let activity: Activity | null = null;
  let sent: SleepTimerActivityProps | null = null;
  /** No (new) activity for the timer that is counting down: ActivityKit refused it
   * (Live Activities off in Settings) or the listener swiped it away. Cleared when that
   * timer ends. */
  let refused = false;

  const endActivity = () => {
    const a = activity;
    activity = null;
    sent = null;
    if (a) void a.end('immediate').catch((e: unknown) => warn('activity end failed', e));
  };

  function reconcileActivity() {
    if (disposed) return;
    const timer = useSleepTimer.getState();
    // The cheap answer for nearly every call: no timer counting down, nothing shown.
    if (!activity && timer.phase !== 'running' && timer.phase !== 'ending') {
      refused = false;
      return;
    }
    const np = usePlayer.getState().nowPlaying;
    const desired = sleepActivityProps(
      timer,
      usePlayer.getState(),
      deps.now(),
      deps.t(),
      np ? coversFor(np).activity : undefined,
    );
    if (!desired) {
      endActivity();
      refused = false;
      return;
    }
    if (!activity) {
      if (refused || !deps.isForeground()) return;
      try {
        activity = deps.activity.start(desired, desired.deepLink);
        sent = desired;
      } catch (e) {
        refused = true;
        warn('activity start refused', e);
      }
      return;
    }
    if (sent && sameActivity(sent, desired)) return;
    sent = desired;
    const current = activity;
    void current.update(desired).catch((e: unknown) => {
      // Gone: the listener dismissed it from the lock screen. Respect that for this timer.
      if (activity === current) {
        activity = null;
        sent = null;
        refused = true;
      }
      warn('activity update failed', e);
    });
  }

  // --- start --------------------------------------------------------------------------

  // A previous process's activity outlives it (the app was killed under a running timer,
  // or a JS reload): the timer it showed is gone, so it goes too.
  try {
    for (const stale of deps.activity.getInstances()) {
      void stale.end('immediate').catch(() => {});
    }
  } catch (e) {
    warn('stale activities', e);
  }

  // What the widget showed last, from before this launch: a book left "playing" by a
  // killed app is not playing now, and a never-written widget gets its localized empty
  // line (the gallery preview).
  void deps.widget
    .getTimeline()
    .then((entries) => {
      if (disposed || lastProps) return; // already written this launch
      const props = entries[entries.length - 1]?.props;
      if (!props || Object.keys(props).length === 0) {
        write(emptyContinueListeningProps(deps.t()));
      } else {
        lastProps = props;
        if (props.isPlaying && !usePlayer.getState().nowPlaying) {
          write({ ...props, isPlaying: false });
        }
      }
    })
    .catch((e: unknown) => warn('timeline read failed', e));

  const unsubPlayer = usePlayer.subscribe(onPlayer);
  const unsubTimer = useSleepTimer.subscribe(() => reconcileActivity());
  const unsubForeground = deps.onForeground(() => reconcileActivity());
  const unsubRemoved = onConnectionRemoved((id) => {
    if (lastProps?.connectionId !== id) return;
    covers = null;
    coverJob = null;
    deps.clearCovers();
    write(emptyContinueListeningProps(deps.t()));
  });
  // A new language: every string the widget and the activity show is the app's.
  const onLanguage = () => {
    lastMark = null;
    onPlayer();
  };
  i18next.on('languageChanged', onLanguage);

  onPlayer();

  return () => {
    disposed = true;
    if (trailing) clearTimeout(trailing);
    unsubPlayer();
    unsubTimer();
    unsubForeground();
    unsubRemoved();
    i18next.off('languageChanged', onLanguage);
  };
}

// --- the real deps -------------------------------------------------------------------

async function fetchBytes(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url);
    return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

async function readBytes(uri: string): Promise<Uint8Array | null> {
  if (uri.startsWith('http')) return fetchBytes(uri);
  try {
    const file = new File(uri);
    return file.exists ? await file.bytes() : null;
  } catch {
    return null;
  }
}

/** Write (or find) the book's widget and activity covers in `dir`, and delete every
 * other book's. */
async function prepareCovers(dir: Directory, np: NowPlaying): Promise<Covers> {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const stem = coverStem(np.connectionId, np.libraryId, np.path);
  for (const entry of dir.list()) {
    if (entry instanceof File && entry.name.startsWith('cover-') && !entry.name.startsWith(stem)) {
      try {
        entry.delete();
      } catch {
        // best effort; the next book prunes it again
      }
    }
  }
  const client = resolveClient(np.connectionId);
  const want = [
    { key: 'widget', size: WIDGET_COVER_SIZE, max: WIDGET_COVER_MAX },
    { key: 'activity', size: ACTIVITY_COVER_SIZE, max: ACTIVITY_COVER_MAX },
  ] as const;
  const out: Covers = {};
  for (const { key, size, max } of want) {
    const file = new File(dir, `${stem}-${key === 'widget' ? 'w' : 'a'}.jpg`);
    if (file.exists) {
      out[key] = file.uri;
      continue;
    }
    // The server's thumbnail first (small by construction when it supports `size`), then
    // the downloaded or streamed cover the player shows, which is usually the full art.
    const sources = [client?.coverUrl(np.libraryId, np.path, { size }), np.cover].filter(
      (s): s is string => !!s,
    );
    for (const source of sources) {
      const bytes = await readBytes(source);
      if (bytes && fitsCover(bytes, max)) {
        file.write(bytes);
        out[key] = file.uri;
        break;
      }
    }
  }
  return out;
}

/**
 * Start the sync (one call, from the root layout). A no-op on a binary built without
 * the ExpoWidgets module: the JS bundle can be newer than the installed app, and
 * importing expo-widgets there would throw at load, so it is required lazily behind the
 * native module check.
 */
export function startWidgetSync(): () => void {
  if (!requireOptionalNativeModule('ExpoWidgets')) return () => {};
  try {
    /* eslint-disable @typescript-eslint/no-require-imports -- lazy: see above */
    const { widgetsDirectory } = require('expo-widgets') as typeof import('expo-widgets');
    const { ContinueListeningWidget } =
      require('./continue-listening') as typeof import('./continue-listening');
    const { SleepTimerLiveActivity } =
      require('./sleep-timer-activity') as typeof import('./sleep-timer-activity');
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Null without an App Group (a build whose entitlements lost it): no covers then.
    const dir = widgetsDirectory ? new Directory(widgetsDirectory) : null;
    return runWidgetSync({
      widget: ContinueListeningWidget,
      activity: SleepTimerLiveActivity,
      prepareCovers: (np) => (dir ? prepareCovers(dir, np) : Promise.resolve({})),
      clearCovers: () => {
        try {
          if (dir?.exists) {
            for (const entry of dir.list()) if (entry.name.startsWith('cover-')) entry.delete();
          }
        } catch (e) {
          warn('clear covers', e);
        }
      },
      isForeground: () => AppState.currentState === 'active',
      onForeground: (fn) => {
        const sub = AppState.addEventListener('change', (s) => {
          if (s === 'active') fn();
        });
        return () => sub.remove();
      },
      // eslint-disable-next-line import/no-named-as-default-member -- the i18next instance's own `t`, read per write so a language switch applies.
      t: () => i18next.t.bind(i18next) as T,
      now: () => Date.now(),
    });
  } catch (e) {
    warn('start failed', e);
    return () => {};
  }
}
