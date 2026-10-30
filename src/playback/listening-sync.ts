import { sessionReady } from '@/api/connection-clients';
import { onReconnect } from '@/api/reachability';
import { onForeground } from '@/lib/when-active';
import { useSession } from '@/stores/session';

import { flushAllOutboxes, flushOutbox, recoverOpenSpan } from './listening-outbox';
import { cutListeningSpanNow } from './store';

/**
 * Sync v2's sending triggers (`listening-outbox.ts`), for the life of the app: a span a kill
 * left open is closed and every outbox sent once the session is ready (the launch); the
 * playing span is cut and the outbox sent when its server comes back; every outbox is sent
 * when the app comes to the front, and the playing span is cut when it leaves (native
 * backgrounding: the OS may end the app there). The store sends after each cut and close
 * itself, and the web's `pagehide`/`hidden` are the store's (`watchPageHide`).
 *
 * Shared like the place reconcile: the root layout starts it and so does the car's headless
 * task; it runs once until the last holder releases it.
 */
let holders = 0;
let teardown: (() => void) | null = null;

export function startListeningSync(): () => void {
  holders++;
  teardown ??= runListeningSync();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders--;
    if (holders > 0 || !teardown) return;
    const stop = teardown;
    teardown = null;
    stop();
  };
}

function runListeningSync(): () => void {
  const stops: (() => void)[] = [];
  const launch = () => void recoverOpenSpan().then(() => flushAllOutboxes());
  if (sessionReady()) launch();
  else {
    stops.push(
      useSession.subscribe((state, prev) => {
        if (prev.status === 'loading' && state.status !== 'loading' && sessionReady()) launch();
      }),
    );
  }
  stops.push(
    onReconnect((cid) => {
      cutListeningSpanNow(cid);
      void flushOutbox(cid);
    }),
  );
  stops.push(
    onForeground(
      () => void flushAllOutboxes(),
      () => cutListeningSpanNow(),
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
