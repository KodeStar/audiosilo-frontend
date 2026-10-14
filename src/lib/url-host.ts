/** An absolute URL's scheme, host and port, lower-cased: the host without brackets (IPv6),
 * the port the scheme's default (443 for https, 80 for http, else '') when it names none. A
 * regex rather than `URL.hostname`/`port`: React Native's URL polyfill does not implement them. */
export function urlEndpoint(url: string): { scheme: string; host: string; port: string } | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?/i.exec(
    url.trim(),
  );
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] ?? ({ https: '443', http: '80' } as Record<string, string>)[scheme] ?? '';
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
