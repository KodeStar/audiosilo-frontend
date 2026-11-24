/**
 * Web addresses in a text written as the server writes them in a follow's title and its
 * jobs (`internal/bridge` `redactPodcastText` over `feed.RedactURL`): each `http://` or
 * `https://` address, in any letter case, as its scheme and host, then `/...` when it has
 * a path past `/` or a query, or `[redacted URL]` when no host can be read. Never its user
 * info, path, query or fragment, so a name that is a private feed's address never shows
 * its token. The address runs to the next space (Go's `\S`), so a quote or bracket inside
 * it can't end it early and leave the rest behind.
 */
export function redactUrls(text: string): string {
  return text.replace(WEB_ADDRESS, redactUrl);
}

/** True when a text is one web address and nothing else (`redactUrls`). */
export function isWebAddress(text: string): boolean {
  return ONLY_WEB_ADDRESS.test(text.trim());
}

const WEB_ADDRESS = /https?:\/\/[^\t\n\f\r ]+/gi;
const ONLY_WEB_ADDRESS = new RegExp(`^${WEB_ADDRESS.source}$`, 'i');

const UNREADABLE = '[redacted URL]';

/** One address as Go's `url.Parse` reads it, reduced to its scheme and host. */
function redactUrl(raw: string): string {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return UNREADABLE;
  const hash = raw.indexOf('#');
  const url = hash === -1 ? raw : raw.slice(0, hash);
  if (hash !== -1 && !validEscapes(raw.slice(hash + 1))) return UNREADABLE;
  const sep = url.indexOf('://');
  const scheme = url.slice(0, sep).toLowerCase();
  let rest = url.slice(sep + 3);
  const q = rest.indexOf('?');
  if (q !== -1) rest = rest.slice(0, q);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  if (at !== -1 && !USER_INFO.test(authority.slice(0, at))) return UNREADABLE;
  const host = readHost(authority.slice(at + 1));
  if (!host || !validEscapes(path)) return UNREADABLE;
  return `${scheme}://${host}${(path !== '' && path !== '/') || q !== -1 ? '/...' : ''}`;
}

const USER_INFO = /^[A-Za-z0-9\-._~!$&'()*+,;=:%@]*$/;
// What Go's host reader refuses outright (`shouldEscape` in host mode).
const HOST_REFUSED = /[\\^`{|}]/;

/** A host as `url.Parse` keeps it (escapes decoded), or null when it refuses it: empty,
 * a character a host can't hold, a port that isn't digits, an unclosed `[`, or an escape
 * of an ASCII character other than `%25`. */
function readHost(host: string): string | null {
  if (!host || HOST_REFUSED.test(host)) return null;
  // A port: what follows an IPv6 literal's `]`, else the last `:`.
  const bracket = host.startsWith('[');
  const close = bracket ? host.lastIndexOf(']') : -1;
  if (bracket && close === -1) return null;
  const colon = close === -1 ? host.lastIndexOf(':') : close + 1;
  if (colon !== -1 && !/^(:\d*)?$/.test(host.slice(colon))) return null;
  for (let i = host.indexOf('%'); i !== -1; i = host.indexOf('%', i + 1)) {
    const hex = host.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    if (parseInt(hex[0], 16) < 8 && hex !== '25') return null;
  }
  try {
    return decodeURIComponent(host);
  } catch {
    return host;
  }
}

/** Every `%` in a path or fragment starts an escape of two hex digits (else Go refuses
 * the address). */
function validEscapes(s: string): boolean {
  return !/%(?![0-9a-f]{2})/i.test(s);
}
