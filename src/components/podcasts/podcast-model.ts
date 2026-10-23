import type { ParseKeys, TFunction } from 'i18next';

import type {
  Book,
  PodcastEpisode,
  PodcastEpisodeOrder,
  PodcastFetchStatus,
  PodcastShow,
} from '@/api/types';
import { formatDuration, formatRecordDate } from '@/lib/format';
import type { PendingEpisodeFetch } from '@/playback/episode-fetch';

/**
 * The podcast views' pure rules (Bridge Phase 2d-1): what an episode's fetch says to a
 * listener. Framework-free, so the player's fetch panel, the episode rows and the episode
 * page read the same answers.
 */

/** The fetch refusals and failure codes a listener has a sentence for
 * (`podcasts.fetch.reason.*`); any other code reads as `other`. */
const FETCH_REASONS = [
  'module_off',
  'bridge_unavailable',
  'library_not_writable',
  'fetch_limit',
  'demo_account',
  'too_large',
  'identity_changed',
] as const;

type FetchReason = (typeof FETCH_REASONS)[number] | 'other';

const KNOWN_REASONS: ReadonlySet<string> = new Set(FETCH_REASONS);

/** The sentence key for why an episode could not be fetched (`code` is the server's safe
 * code from a refusal or a status's `error`; null or unknown reads as `other`). Never the
 * server's English. */
export function fetchReasonKey(code: string | null | undefined): ParseKeys {
  const reason: FetchReason = code && KNOWN_REASONS.has(code) ? (code as FetchReason) : 'other';
  return `podcasts.fetch.reason.${reason}`;
}

/** The sentence key for why an episode row's file is stopped (Couldn't get it, Not
 * available now), or null in any other state. */
export function rowStateReasonKey(state: EpisodeRowState): ParseKeys | null {
  return state.kind === 'failed' || state.kind === 'unavailable'
    ? fetchReasonKey(state.code)
    : null;
}

/** Whether a stopped fetch offers Try again (a manual ask, `retryEpisodeFetch`): a failed
 * one, or one not available for a reason this build has no sentence for (no code, or an
 * unknown one: asking again may well work). A known reason (the module off, no Bridge
 * online, the library not writable, ...) needs a person first, so Play stays disabled
 * with that reason beside it. */
export function canRetryFetch(state: EpisodeRowState): boolean {
  return (
    state.kind === 'failed' ||
    (state.kind === 'unavailable' && !(state.code && KNOWN_REASONS.has(state.code)))
  );
}

/** How far a fetch has got: the bytes so far, the size when the server knows it, and the
 * share done (0..100, whole) when it does. */
export function fetchProgress(status: PodcastFetchStatus | null): {
  received: number;
  total: number | null;
  percent: number | null;
} {
  const received = Math.max(0, status?.bytes_received ?? 0);
  const total = status?.bytes_total ?? null;
  if (total === null || total <= 0) return { received, total: null, percent: null };
  return { received, total, percent: Math.min(100, Math.floor((received / total) * 100)) };
}

/** How long an episode stays "new" (the show tiles' caption, Home's rail). */
export const NEW_EPISODE_DAYS = 14;

const DAY_MS = 86_400_000;

/** Whether `published` falls within the last `days` (an undated one never does). */
export function isRecent(
  published: string | null | undefined,
  now: Date,
  days: number = NEW_EPISODE_DAYS,
): boolean {
  if (!published) return false;
  const at = Date.parse(published);
  return Number.isFinite(at) && now.getTime() - at <= days * DAY_MS && at <= now.getTime() + DAY_MS;
}

/** A show's episode order when the link names none: a serial show reads from its first
 * episode, any other (episodic, or a type this build does not know) newest first. */
export function defaultEpisodeOrder(
  show: Pick<PodcastShow, 'type'> | undefined,
): PodcastEpisodeOrder {
  return show?.type === 'serial' ? 'oldest' : 'newest';
}

/** "S2 E5", "E5", or null when the feed numbers neither. */
export function episodeLabel(
  ep: { season: number | null; episode: number | null },
  t: TFunction,
): string | null {
  if (ep.episode === null) return null;
  return ep.season !== null
    ? t('podcasts.episode.label', { season: ep.season, episode: ep.episode })
    : t('podcasts.episode.labelEpisodeOnly', { episode: ep.episode });
}

/** An episode's meta line: its date, its length (when known) and its number ("21 Oct ·
 * 32m · S2 E5"). */
export function episodeMetaLine(
  ep: Pick<PodcastEpisode, 'published' | 'duration' | 'duration_source' | 'season' | 'episode'>,
  t: TFunction,
  now: Date,
): string {
  const at = ep.published ? new Date(ep.published) : null;
  return [
    at && Number.isFinite(at.getTime()) ? formatRecordDate(at, now) : '',
    ep.duration_source !== 'none' ? formatDuration(ep.duration) : '',
    episodeLabel(ep, t) ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** An episode's badges, in order: Trailer or Bonus, then Explicit. */
export function episodeMarks(
  ep: Pick<PodcastEpisode, 'episode_type' | 'explicit'>,
  t: TFunction,
): string[] {
  const marks: string[] = [];
  if (ep.episode_type === 'trailer') marks.push(t('podcasts.episode.trailer'));
  if (ep.episode_type === 'bonus') marks.push(t('podcasts.episode.bonus'));
  if (ep.explicit) marks.push(t('podcasts.episode.explicit'));
  return marks;
}

/** The rows a show lists: an episode gone from the feed only while its file is kept. */
export function visibleEpisodes<T extends { removed: boolean; downloaded: boolean }>(
  episodes: readonly T[],
): T[] {
  return episodes.filter((e) => !(e.removed && !e.downloaded));
}

/** An episode row's state line. */
export type EpisodeRowState =
  | { kind: 'ready' }
  | { kind: 'onDemand' }
  | { kind: 'getting'; percent: number | null }
  | { kind: 'failed'; code: string | null }
  | { kind: 'unavailable'; code: string | null };

/**
 * What an episode row says about its file: on the server (Ready), fetched when played
 * (Plays on demand), on its way (Getting it, with the share when known), or stopped
 * (Couldn't get it, Not available now, with the server's `code` for why: `fetchReasonKey`;
 * a server that can't fetch at all reads as `bridge_unavailable`). `pending` is the player's fetch of THIS episode,
 * which knows more than the list's batched `fetch`; `canFetch` is the server's
 * `podcast_fetch` (an episode not on a server that can't fetch it is not available).
 */
export function episodeRowState(
  ep: Pick<PodcastEpisode, 'downloaded' | 'fetch'>,
  pending: Pick<PendingEpisodeFetch, 'phase' | 'status' | 'code'> | null,
  canFetch: boolean | undefined,
): EpisodeRowState {
  if (pending) {
    switch (pending.phase) {
      case 'failed':
      case 'refused':
        return { kind: 'failed', code: pending.code };
      case 'unavailable':
        return { kind: 'unavailable', code: pending.code };
      default:
        return { kind: 'getting', percent: fetchProgress(pending.status).percent };
    }
  }
  if (ep.downloaded) return { kind: 'ready' };
  if (canFetch === false) return { kind: 'unavailable', code: 'bridge_unavailable' };
  switch (ep.fetch?.state) {
    case 'queued':
    case 'fetching':
      return { kind: 'getting', percent: fetchProgress(ep.fetch).percent };
    case 'failed':
      return { kind: 'failed', code: ep.fetch.error?.code ?? null };
    case 'unavailable':
      return { kind: 'unavailable', code: ep.fetch.error?.code ?? null };
    default:
      return { kind: 'onDemand' };
  }
}

/** An episode row as the player's `Book` (the shape a start, the actions and the fetch
 * take): its show's author, the episode facts, `episode` set so it is never downloaded. */
export function episodeAsBook(ep: PodcastEpisode, show: PodcastShow): Book {
  return {
    id: 0,
    library_id: show.library_id,
    rel_path: ep.path,
    is_folder: false,
    title: ep.title,
    author: show.author,
    series: '',
    series_index: 0,
    narrator: '',
    duration: ep.duration,
    format: '',
    size: ep.size,
    episode: {
      show_path: show.path,
      published: ep.published,
      season: ep.season,
      episode: ep.episode,
      episode_type: ep.episode_type,
      explicit: ep.explicit,
      downloaded: ep.downloaded,
      duration_source: ep.duration_source,
      removed: ep.removed,
      ...(ep.fetch ? { fetch: ep.fetch } : {}),
    },
  };
}

/** Why a follow request (`PodcastRequest.error.code`) did not finish, in the listener's
 * words (`podcasts.requests.reason.*`): the feed could not be reached (`dns`, `timeout`,
 * `tls`, `network`), is not a podcast (`not_a_feed`, `not_a_podcast`), is gone (`gone`:
 * HTTP 410), was not found (`http_404`), refused the request (`http_401`, `http_403`),
 * answered another error (`http_<status>`), is on a local network the server may not
 * reach (`blocked_address`: the admin can allow it), is too large (`too_large`), or needs
 * following again (`request_expired`: the server restarted before the request was taken
 * up; `feed_secret_missing`: a private feed's address was lost); anything else reads
 * generically. Never the server's English. */
export function requestReasonKey(code: string | null | undefined): ParseKeys {
  switch (code) {
    case 'dns':
    case 'timeout':
    case 'tls':
    case 'network':
      return 'podcasts.requests.reason.unreachable';
    case 'not_a_feed':
    case 'not_a_podcast':
      return 'podcasts.requests.reason.notAFeed';
    case 'gone':
      return 'podcasts.requests.reason.gone';
    case 'http_404':
      return 'podcasts.requests.reason.notFound';
    case 'http_401':
    case 'http_403':
      return 'podcasts.requests.reason.denied';
    case 'blocked_address':
      return 'podcasts.requests.reason.localAddress';
    case 'too_large':
      return 'podcasts.requests.reason.tooLarge';
    case 'request_expired':
    case 'feed_secret_missing':
      return 'podcasts.requests.reason.followAgain';
    default:
      return code?.startsWith('http_')
        ? 'podcasts.requests.reason.feedError'
        : 'podcasts.requests.reason.other';
  }
}
