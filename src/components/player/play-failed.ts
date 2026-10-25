import { t } from 'i18next';

import { toast } from '@/components/ui/toast';
import { PlaybackStartError } from '@/playback/types';
import { useSession } from '@/stores/session';

/** Why a start failed, in the listener's words: the server it plays from can't be
 * reached, or its audio didn't load. Undefined when there is nothing more to say than
 * the title (an unknown failure, a failure before the engine, an offline server whose
 * connection is gone). */
export function playFailedReason(err: unknown): string | undefined {
  if (!(err instanceof PlaybackStartError)) return undefined;
  if (err.reason === 'audio') return t('player.startFailed.audio');
  if (err.reason !== 'offline' || !err.connectionId) return undefined;
  const server = useSession.getState().connections.find((c) => c.id === err.connectionId)?.name;
  return server ? t('player.startFailed.offline', { server }) : undefined;
}

/** The toast for a start that failed (a play button, Play now, the next book): `title`
 * says which (by default "Couldn't start this book"), and the reason, when the engine
 * gave one (`PlaybackStartError`), is its description. */
export function playFailedToast(err: unknown, title: string = t('library.bookActions.playFailed')) {
  toast({ title, description: playFailedReason(err) });
}
