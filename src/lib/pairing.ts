// Pairing helpers shared by the connect screen and the QR scanner.

/** Trim, add a default https:// scheme, and strip trailing slashes from a server URL. */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  return withScheme.replace(/\/+$/, '');
}

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

// parsePairingScan extracts the server base URL and single-use pairing token from
// the text encoded in a server's pairing QR. The QR carries the web handoff URL
// `https://<base>/web/connect?token=<token>` (audiosilo-server internal/api/qr.go);
// we also accept the custom-scheme deep link `audiosilo://connect?server=&token=`.
// Returns null when the text is not a recognizable pairing payload.
export function parsePairingScan(raw: string): { base: string; token: string } | null {
  const text = raw.trim();
  const query = text.split('?')[1] ?? '';
  const token = queryParam(query, 'token');
  if (!token) return null;

  if (/^audiosilo:/i.test(text)) {
    const server = queryParam(query, 'server');
    return server ? { base: normalizeUrl(server), token } : null;
  }

  if (!/^https?:\/\//i.test(text)) return null;
  // Strip the `/web/connect` suffix (and query) rather than using the URL origin,
  // so a configured host:port or base-path prefix is preserved.
  const before = text.split('?')[0];
  const base = before.replace(/\/web\/connect\/?$/i, '');
  return { base: normalizeUrl(base), token };
}
