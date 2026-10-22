import type { ParseKeys } from 'i18next';

import type { PodcastFetchStatus } from '@/api/types';

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
