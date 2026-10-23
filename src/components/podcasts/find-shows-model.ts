import type { ParseKeys } from 'i18next';

import { ApiError, apiErrorKind } from '@/api/client';
import type { OpmlImportRow, PodcastRequest } from '@/api/types';
import { FIND_SHOWS_SECTIONS, type FindShowsSection } from '@/lib/paths';
import { utf8 } from '@/lib/sha256';

/**
 * Find shows' pure rules (Bridge Phase 2d-2): which sections a server offers, the search
 * text as the server cleans it, a feed address's local check, and every refusal in the
 * listener's words (never the server's English, never "Bridge").
 */

/** The sections a server offers: Search with `podcast_discovery`, Import with
 * `podcast_opml`, a feed address always (absent flags read as unsupported). */
export function availableSections(caps: {
  discovery: boolean | undefined;
  opml: boolean | undefined;
}): FindShowsSection[] {
  return FIND_SHOWS_SECTIONS.filter(
    (s) => s === 'address' || (s === 'search' ? caps.discovery === true : caps.opml === true),
  );
}

/** The section to show: the link's when the server offers it, else the first offered. */
export function resolveSection(
  asked: FindShowsSection | null,
  offered: FindShowsSection[],
): FindShowsSection {
  return asked && offered.includes(asked) ? asked : (offered[0] ?? 'address');
}

/** The search text as the server reads it: trimmed, runs of whitespace one space. */
export function cleanSearchText(q: string): string {
  return q.trim().replace(/\s+/g, ' ');
}

/** The least search text the server takes, in code points (as the server counts it: one
 * emoji is one, not two UTF-16 units). */
export const MIN_SEARCH_LENGTH = 2;

/** The longest feed address the server takes, in bytes. */
const MAX_FEED_URL_BYTES = 2048;

/** What is wrong with a feed address before anything is sent, or null when it may go:
 * empty, not http(s) with a host, or over 2,048 bytes. The server checks it again. */
export function feedAddressProblem(raw: string): 'empty' | 'notHttp' | 'tooLong' | null {
  const url = raw.trim();
  if (!url) return 'empty';
  if (!/^https?:\/\/[^\s/?#]+(?:[/?#]\S*)?$/i.test(url)) return 'notHttp';
  if (utf8(url).length > MAX_FEED_URL_BYTES) return 'tooLong';
  return null;
}

/** The largest OPML file the server reads (1 MiB). */
export const OPML_MAX_BYTES = 1_048_576;

/** A refused search in the listener's words, and the wait it asked for when known. */
export function searchErrorCopy(e: unknown): { key: ParseKeys; seconds?: number } {
  const seconds = e instanceof ApiError ? e.retryAfterSeconds : undefined;
  const waits = seconds !== undefined && seconds > 0;
  switch (apiErrorKind(e)) {
    case 'discovery_rate_limited':
    case 'too_many':
      return waits
        ? { key: 'podcasts.find.searchError.rateLimitedWait', seconds: Math.ceil(seconds) }
        : { key: 'podcasts.find.searchError.rateLimited' };
    case 'provider_rate_limited':
      return waits
        ? { key: 'podcasts.find.searchError.providerBusyWait', seconds: Math.ceil(seconds) }
        : { key: 'podcasts.find.searchError.providerBusy' };
    case 'discovery_busy':
      return { key: 'podcasts.find.searchError.busy' };
    case 'discovery_timeout':
      return { key: 'podcasts.find.searchError.timeout' };
    case 'provider_rejected':
      return { key: 'podcasts.find.searchError.rejected' };
    case 'discovery_unavailable':
      return { key: 'podcasts.find.searchError.unavailable' };
    case 'provider_unavailable':
      return { key: 'podcasts.find.searchError.providerUnavailable' };
    case 'discovery_off':
      return { key: 'podcasts.find.searchError.off' };
    case 'invalid_query':
      return { key: 'podcasts.find.searchError.invalidQuery' };
    case 'invalid_country':
      return { key: 'podcasts.find.searchError.invalidCountry' };
    default:
      return { key: accountRefusalKey(apiErrorKind(e)) ?? 'podcasts.find.searchError.other' };
  }
}

/** The refusals any of these routes can give a caller who may not use them here (by
 * error code): the module off, a kid's or the demo account, no grant on the library. Null
 * for others. */
function accountRefusalKey(code: string | null): ParseKeys | null {
  switch (code) {
    case 'module_off':
      return 'podcasts.find.refusal.moduleOff';
    case 'kid_account':
      return 'podcasts.find.refusal.kid';
    case 'demo_account':
      return 'podcasts.find.refusal.demo';
    case 'no_library_access':
      return 'podcasts.find.refusal.noAccess';
    case 'not_podcast_library':
      return 'podcasts.find.refusal.notPodcastLibrary';
    default:
      return null;
  }
}

/** A refused follow by address (a result's Follow, a pasted address). */
export function followByUrlErrorKey(e: unknown): ParseKeys {
  switch (apiErrorKind(e)) {
    case 'invalid_feed_url':
      return 'podcasts.find.followError.invalidFeedUrl';
    case 'privacy_conflict':
      return 'podcasts.find.followError.privacyConflict';
    case 'bridge_unavailable':
      return 'podcasts.find.followError.cantAddNow';
    case 'library_not_writable':
      return 'podcasts.find.followError.notWritable';
    case 'too_many_requests':
      return 'podcasts.find.followError.tooMany';
    default:
      return accountRefusalKey(apiErrorKind(e)) ?? 'podcasts.find.followError.other';
  }
}

/** Why an import stopped with `failed` (`code` the refusal's, null for no answer). */
export function importFailureKey(code: string | null): ParseKeys {
  switch (code) {
    case 'invalid_opml':
    case 'unsupported_opml_type':
      return 'podcasts.import.fail.notOpml';
    case 'opml_limit':
      return 'podcasts.import.fail.tooLarge';
    default:
      return accountRefusalKey(code) ?? 'podcasts.import.fail.other';
  }
}

/** A refused export. */
export function exportErrorKey(e: unknown): ParseKeys {
  switch (apiErrorKind(e)) {
    case 'opml_export_limit':
      return 'podcasts.export.error.tooMany';
    case 'opml_rate_limited':
    case 'opml_busy':
    case 'too_many':
      return 'podcasts.export.error.busy';
    case 'demo_account':
      return 'podcasts.find.refusal.demo';
    default:
      return 'podcasts.export.error.other';
  }
}

/** A refused Check for new episodes. */
export function checkErrorKey(e: unknown): ParseKeys {
  switch (apiErrorKind(e)) {
    case 'checked_recently':
    case 'too_many':
      return 'podcasts.check.recently';
    case 'bridge_unavailable':
      return 'podcasts.check.cantNow';
    case 'show_not_found':
      return 'podcasts.follow.errorGone';
    default:
      return accountRefusalKey(apiErrorKind(e)) ?? 'podcasts.check.failed';
  }
}

/** What an import row says. */
export function importRowKey(row: Pick<OpmlImportRow, 'status'>): ParseKeys {
  switch (row.status) {
    case 'followed':
      return 'podcasts.import.row.followed';
    case 'already_following':
      return 'podcasts.import.row.alreadyFollowing';
    case 'queued':
    case 'already_queued':
      return 'podcasts.import.row.queued';
    case 'duplicate':
      return 'podcasts.import.row.duplicate';
    case 'invalid':
      return 'podcasts.import.row.invalid';
    case 'limited':
      return 'podcasts.import.row.limited';
    case 'unavailable':
      return 'podcasts.import.row.unavailable';
    default:
      return 'podcasts.import.row.error';
  }
}

/** How far an import is: the rows following now or on their way, of every row that can
 * be (duplicates and invalid ones never can). */
export function importProgress(rows: readonly OpmlImportRow[]): { settled: number; total: number } {
  const counted = rows.filter((r) => r.status !== 'duplicate' && r.status !== 'invalid');
  const settled = counted.filter((r) =>
    ['followed', 'already_following', 'queued', 'already_queued'].includes(r.status),
  ).length;
  return { settled, total: counted.length };
}

/** A follow request's state word. */
export function requestStateKey(r: Pick<PodcastRequest, 'state'>): ParseKeys {
  switch (r.state) {
    case 'queued':
    case 'needs_attention':
      return 'podcasts.requests.state.waiting';
    case 'claimed':
    case 'running':
      return 'podcasts.requests.state.adding';
    case 'done':
      return 'podcasts.requests.state.done';
    case 'cancelled':
      return 'podcasts.requests.state.cancelled';
    default:
      return 'podcasts.requests.state.failed';
  }
}
