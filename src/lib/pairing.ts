// Pairing helpers shared by the connect screen and the QR scanner.

import type { ServerAddresses } from '@/api/types';

/**
 * Trim, add a default https:// scheme, validate, and strip trailing slashes from
 * a server URL. Returns '' when the input isn't a valid http(s) URL (so callers
 * treat it as "no/invalid server address" rather than passing a malformed base
 * to fetch). Host:port and any base-path prefix are preserved.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return '';
  }
  if (!parsed.hostname || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    return '';
  }
  return (parsed.origin + parsed.pathname).replace(/\/+$/, '');
}

/** A server URL's host (and port), without the scheme or a path: an eyebrow or a caption
 * ("Hearthside · books.example.com:8443"). */
export function hostOf(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || url;
}

/** One address as the server sends it: an http(s) URL with its scheme (`normalizeUrl`
 * alone would read `ftp://nas` as a host and add https), normalised; '' otherwise. */
function addressUrl(value: unknown): string {
  return typeof value === 'string' && /^\s*https?:\/\//i.test(value) ? normalizeUrl(value) : '';
}

/**
 * A server's home and away addresses as the device keeps them: each normalised with
 * `normalizeUrl` and dropped when it isn't a valid http(s) URL with its scheme, and `home` dropped when
 * it is the away address too (one address is no choice). Undefined when neither is
 * left. Accepts anything (a pairing link's params, a wire answer), so a malformed value
 * never reaches the address picker.
 */
export function cleanAddresses(
  raw: { home?: unknown; away?: unknown } | null | undefined,
): ServerAddresses | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const away = addressUrl(raw.away);
  let home = addressUrl(raw.home);
  if (home === away) home = '';
  if (!home && !away) return undefined;
  return { ...(home ? { home } : {}), ...(away ? { away } : {}) };
}

/** The `{ base, token }` of a pairing link, plus the server's addresses when the link
 * carries them (`home=` / `away=`, capability `addresses`). */
export type PairingScan = { base: string; token: string; addresses?: ServerAddresses };

function queryParam(query: string, key: string): string | null {
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? '' : pair.slice(eq + 1);
    if (decodeURIComponent(k) === key) return decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return null;
}

/** A param the link may carry: a malformed one (a stray `%`) is dropped instead of
 * failing the whole link, which pairs without it. */
function optionalParam(query: string, key: string): string | null {
  try {
    return queryParam(query, key);
  } catch {
    return null;
  }
}

// parsePairingScan extracts the server base URL and pairing token from the text
// encoded in a server's pairing QR (token redeemability follows its origin - see
// the PairingPayload doc in api/types.ts). The QR carries the web handoff URL
// `https://<base>/web/connect?token=<token>` (audiosilo-server internal/api/qr.go);
// we also accept the custom-scheme deep link `audiosilo://connect?server=&token=`.
// Both may also carry the server's `home=` and `away=` addresses (capability
// `addresses`), returned as `addresses` (cleaned by `cleanAddresses`; absent when the
// link has none, so an older server's link parses exactly as before).
// Returns null when the text is not a recognizable pairing payload.
export function parsePairingScan(raw: string): PairingScan | null {
  const text = raw.trim();
  const query = text.split('?')[1] ?? '';
  const token = queryParam(query, 'token');
  if (!token) return null;
  const addresses = cleanAddresses({
    home: optionalParam(query, 'home'),
    away: optionalParam(query, 'away'),
  });
  const scan = (base: string): PairingScan | null =>
    base ? { base, token, ...(addresses ? { addresses } : {}) } : null;

  if (/^audiosilo:/i.test(text)) {
    const server = queryParam(query, 'server');
    // A present-but-unnormalizable server (blank, wrong scheme) must fail the
    // parse rather than returning a truthy result with an empty/garbage base.
    return scan(server ? normalizeUrl(server) : '');
  }

  if (!/^https?:\/\//i.test(text)) return null;
  // Strip the `/web/connect` suffix (and query) rather than using the URL origin,
  // so a configured host:port or base-path prefix is preserved.
  const before = text.split('?')[0];
  return scan(normalizeUrl(before.replace(/\/web\/connect\/?$/i, '')));
}
