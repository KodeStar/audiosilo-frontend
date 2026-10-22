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

/** The `?order=` a link asks for, or null (the show's default then). */
export function parseEpisodeOrder(v: string | string[] | undefined): PodcastEpisodeOrder | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === 'newest' || s === 'oldest' ? s : null;
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
  | { kind: 'failed' }
  | { kind: 'unavailable' };

/**
 * What an episode row says about its file: on the server (Ready), fetched when played
 * (Plays on demand), on its way (Getting it, with the share when known), or stopped
 * (Couldn't get it, Not available now). `pending` is the player's fetch of THIS episode,
 * which knows more than the list's batched `fetch`; `canFetch` is the server's
 * `podcast_fetch` (an episode not on a server that can't fetch it is not available).
 */
export function episodeRowState(
  ep: Pick<PodcastEpisode, 'downloaded' | 'fetch'>,
  pending: Pick<PendingEpisodeFetch, 'phase' | 'status'> | null,
  canFetch: boolean | undefined,
): EpisodeRowState {
  if (pending) {
    switch (pending.phase) {
      case 'failed':
      case 'refused':
        return { kind: 'failed' };
      case 'unavailable':
        return { kind: 'unavailable' };
      default:
        return { kind: 'getting', percent: fetchProgress(pending.status).percent };
    }
  }
  if (ep.downloaded) return { kind: 'ready' };
  if (canFetch === false) return { kind: 'unavailable' };
  switch (ep.fetch?.state) {
    case 'queued':
    case 'fetching':
      return { kind: 'getting', percent: fetchProgress(ep.fetch).percent };
    case 'failed':
      return { kind: 'failed' };
    case 'unavailable':
      return { kind: 'unavailable' };
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
