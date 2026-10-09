/** Where a page is: its origin, and its full address for resolving a relative url. */
export type PageLocation = { origin: string; href?: string };

/**
 * Is `url` served from `page`'s own origin? A relative `url` is resolved against
 * `page.href`; without an `href` only an absolute `url` can match. False with no page
 * or a url that can't be parsed. Two rules ask this on the web: the API client sends
 * its identity header only same-origin (`shouldIdentify`), and Voice Boost routes only a
 * same-origin stream through Web Audio (`service.web.ts`).
 */
export function sameOrigin(url: string, page: PageLocation | null | undefined): boolean {
  if (!page) return false;
  try {
    return new URL(url, page.href).origin === page.origin;
  } catch {
    return false;
  }
}
