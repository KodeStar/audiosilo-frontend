/** Where a page is: its origin, and its full address for resolving a relative url. */
export type PageLocation = { origin: string; href?: string };

/** The page this code runs in, null outside a browser (native, Node). */
export function pageLocation(): PageLocation | null {
  return typeof location !== 'undefined' ? location : null;
}

/**
 * Is `url` served from `page`'s own origin? A relative `url` is resolved against
 * `page.href`; without an `href` only an absolute `url` can match. False with no page
 * or a url that can't be parsed. Two rules ask this on the web: the API client sends
 * its identity header only same-origin (`shouldIdentify`), and Voice Boost routes a
 * same-origin stream through Web Audio (`service.web.ts`; another origin's only in CORS
 * mode, `corsModeFor`).
 */
export function sameOrigin(url: string, page: PageLocation | null | undefined): boolean {
  if (!page) return false;
  try {
    return new URL(url, page.href).origin === page.origin;
  } catch {
    return false;
  }
}
