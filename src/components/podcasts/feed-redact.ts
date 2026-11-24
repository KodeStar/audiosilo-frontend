/**
 * Web addresses in a text written as the server writes them in a follow's title and its
 * jobs (`internal/bridge` `redactPodcastText` over `feed.RedactURL`, Go 1.26's `net/url`):
 * each `http://` or `https://` address, in any letter case, as its scheme and host, then
 * `/...` when it has a path past `/` or a query, or `[redacted URL]` when no host can be
 * read. Never its user info, path, query or fragment, so a name that is a private feed's
 * address never shows its token. The address runs to the next space (Go's `\S`), so a
 * quote or bracket inside it can't end it early and leave the rest behind.
 */
export function redactUrls(text: string): string {
  return text.replace(WEB_ADDRESS, redactUrl);
}

/** True when a text is one web address and nothing else, as written or as `redactUrls`
 * writes it (`[redacted URL]` included). */
export function isWebAddress(text: string): boolean {
  const t = text.trim();
  return t === UNREADABLE || ONLY_WEB_ADDRESS.test(t);
}

// `u`: Go's `(?i)` folds by Unicode, so `ſ` matches `s` there too.
const WEB_ADDRESS = /https?:\/\/[^\t\n\f\r ]+/giu;
const ONLY_WEB_ADDRESS = new RegExp(`^${WEB_ADDRESS.source}$`, WEB_ADDRESS.flags.replace('g', ''));

const UNREADABLE = '[redacted URL]';

/** One address as Go's `url.Parse` reads it, reduced to its scheme and host. */
function redactUrl(raw: string): string {
  if (/[\u0000-\u001f\u007f]/.test(raw)) return UNREADABLE;
  const hash = raw.indexOf('#');
  const url = hash === -1 ? raw : raw.slice(0, hash);
  if (hash !== -1 && !validEscapes(raw.slice(hash + 1))) return UNREADABLE;
  const sep = url.indexOf('://');
  const scheme = url.slice(0, sep).toLowerCase();
  // A scheme is ASCII: `httpſ` gives `url.Parse` none, and it refuses the colon.
  if (scheme !== 'http' && scheme !== 'https') return UNREADABLE;
  let rest = url.slice(sep + 3);
  const q = rest.indexOf('?');
  if (q !== -1) rest = rest.slice(0, q);
  const slash = rest.indexOf('/');
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash);
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    const userInfo = authority.slice(0, at);
    if (!USER_INFO.test(userInfo) || !validEscapes(userInfo)) return UNREADABLE;
  }
  const host = readHost(authority.slice(at + 1));
  if (!host || !validEscapes(path)) return UNREADABLE;
  return `${scheme}://${host}${(path !== '' && path !== '/') || q !== -1 ? '/...' : ''}`;
}

const USER_INFO = /^[A-Za-z0-9\-._~!$&'()*+,;=:%@]*$/;
// What Go's host reader refuses outright (`shouldEscape` in host mode).
const HOST_REFUSED = /[\\^`{|}]/;
// What a host may hold as it is (`shouldEscape` false in host mode).
const HOST_CHAR = /^[A-Za-z0-9!$&'()*+,;=:[\]<>"\-_.~]$/;
const PORT = /^(:\d*)?$/;

/** A host as `url.Parse` keeps it (escapes decoded), or null when it refuses it: empty,
 * a character a host can't hold, a port that isn't digits, a second `:` outside brackets
 * (an http address's strict colons), a `[` anywhere but first, brackets around anything
 * but an IPv6 address, or a bad escape. */
function readHost(host: string): string | null {
  if (!host || HOST_REFUSED.test(host)) return null;
  const open = host.lastIndexOf('[');
  if (open > 0) return null;
  if (open === 0) {
    // An IPv6 literal (its zone after `%25`), then an optional port.
    const close = host.lastIndexOf(']');
    if (close === -1 || !PORT.test(host.slice(close + 1))) return null;
    const inner = host.slice(1, close);
    const z = inner.indexOf('%25');
    const addr = unescapeHost(z === -1 ? inner : inner.slice(0, z));
    const zone = z === -1 ? '' : unescapeZone(inner.slice(z));
    if (addr === null || zone === null || !isIPv6(addr + zone)) return null;
    return `[${addr}${zone}]${host.slice(close + 1)}`;
  }
  const colon = host.indexOf(':');
  if (colon !== host.lastIndexOf(':') || !PORT.test(colon === -1 ? '' : host.slice(colon))) {
    return null;
  }
  return unescapeHost(host);
}

/** A host's escapes decoded, or null unless each is two hex digits naming a byte past
 * ASCII, or `%25`. */
function unescapeHost(s: string): string | null {
  for (let i = s.indexOf('%'); i !== -1; i = s.indexOf('%', i + 1)) {
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex) || (parseInt(hex[0], 16) < 8 && hex !== '25')) return null;
  }
  return decode(s);
}

/** An IPv6 zone's escapes decoded (from its `%25`), or null unless each is `%25`, a
 * space, or a character a host may hold as it is. */
function unescapeZone(s: string): string | null {
  for (let i = s.indexOf('%'); i !== -1; i = s.indexOf('%', i + 1)) {
    const hex = s.slice(i + 1, i + 3);
    if (!/^[0-9a-f]{2}$/i.test(hex)) return null;
    const c = String.fromCharCode(parseInt(hex, 16));
    if (hex !== '25' && c !== ' ' && !HOST_CHAR.test(c)) return null;
  }
  return decode(s);
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}$`);

/** An IPv6 address as Go's `netip.ParseAddr` reads one: groups of one to four hex digits,
 * eight, or fewer around one `::` (which stands for at least one), the last two of them
 * may be a dotted IPv4 address, then an optional zone after `%` (never empty). */
function isIPv6(s: string): boolean {
  const pct = s.indexOf('%');
  if (pct === s.length - 1) return false;
  const halves = (pct === -1 ? s : s.slice(0, pct)).split('::');
  if (halves.length > 2) return false;
  const groups = halves.map((h) => (h === '' ? [] : h.split(':')));
  const last = groups[groups.length - 1];
  if (last.length > 0 && IPV4.test(last[last.length - 1])) last.splice(-1, 1, '0', '0');
  const fields = groups.flat();
  if (!fields.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return false;
  return halves.length === 2 ? fields.length < 8 : fields.length === 8;
}

/** Every `%` in a path, a fragment or user info starts an escape of two hex digits (else
 * Go refuses the address). */
function validEscapes(s: string): boolean {
  return !/%(?![0-9a-f]{2})/i.test(s);
}
