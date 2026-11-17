/** An absolute URL's scheme, host and port, lower-cased: the host without brackets (IPv6),
 * the port the scheme's default (443 for https, 80 for http, else '') when it names none. A
 * regex rather than `URL.hostname`/`port`: React Native's URL polyfill does not implement them. */
export function urlEndpoint(url: string): { scheme: string; host: string; port: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(
    url.trim(),
  );
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] ?? (scheme === 'https' ? '443' : scheme === 'http' ? '80' : '');
  return { scheme, host: m[2].replace(/^\[|\]$/g, '').toLowerCase(), port };
}

/** The host part of an absolute URL, as `urlEndpoint` reads it. */
export function urlHost(url: string): string | null {
  return urlEndpoint(url)?.host ?? null;
}

/** Whether a host (as `urlHost` reads it) means "this device": `localhost` (and
 * `*.localhost`), the loopback range, `::1` and the unspecified `0.0.0.0` / `::`. No other
 * device can reach it. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0.0.0.0' || h === '::') return true;
  return /^127\.\d+\.\d+\.\d+$/.test(h);
}

/** RFC 1918 and link-local IPv4. */
function isPrivateV4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** Unique local and link-local IPv6. */
function isPrivateV6(host: string): boolean {
  if (!host.includes(':')) return false;
  // fc00::/7 (unique local) and fe80::/10 (link-local).
  return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
}

/**
 * Whether an address (with or without a scheme) is a home-network address: one that answers
 * only on the server's own network (a private or link-local IP, a `.local`, `.lan` or
 * `.home.arpa` name, or a single-label name), so another box can answer at the same address
 * on another network. Loopback is not: no other device can reach it anyway. The same rule the
 * server uses to derive a home address. For the connect screen's "Couldn't reach" hint, and
 * the sign-in that must not read another box there as this server reset (`staleIdentities`).
 */
export function looksLikeHomeAddress(url: string): boolean {
  const u = url.trim();
  const host = urlHost(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`);
  if (!host || isLoopbackHost(host)) return false;
  if (isPrivateV4(host) || isPrivateV6(host)) return true;
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(':')) return false;
  return /\.(local|lan|home\.arpa)$/.test(host) || !host.includes('.');
}
