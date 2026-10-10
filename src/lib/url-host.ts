/** The host part of an absolute URL, lower-cased, without brackets (IPv6) or port. A regex
 * rather than `URL.hostname`: React Native's URL polyfill does not implement it. */
export function urlHost(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/i.exec(url.trim());
  if (!m) return null;
  return m[1].replace(/^\[|\]$/g, '').toLowerCase();
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
