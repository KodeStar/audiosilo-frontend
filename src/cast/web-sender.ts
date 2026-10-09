/**
 * The Cast Web Sender, loaded on first need (never at startup: most listeners never cast, and
 * the script is Google's). Chromium only, in a secure context (the framework refuses
 * anything else), from `www.gstatic.com`, which the server's web CSP allows in `script-src`
 * for exactly this (capability `cast`).
 *
 * Framework-free and given its `window`/`document`, so the loader is testable without a
 * browser.
 */

export const CAST_SENDER_URL =
  'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';

/** How long the script may take to say it is ready (ms) before casting counts as unavailable. */
export const CAST_SENDER_TIMEOUT_MS = 15_000;

/** The parts of `window` the loader reads. */
export type SenderWindow = {
  isSecureContext?: boolean;
  navigator?: { userAgent?: string; userAgentData?: { brands?: { brand: string }[] } };
  chrome?: unknown;
  __onGCastApiAvailable?: (available: boolean, reason?: string) => void;
  cast?: { framework?: unknown };
};

/** The parts of `document` the loader uses. */
export type SenderDocument = {
  createElement(tag: 'script'): {
    src: string;
    async: boolean;
    onerror: ((e: unknown) => void) | null;
  };
  head: { appendChild(node: unknown): unknown };
};

/** Is this a Chromium browser (desktop or Android Chrome, Edge...)? Not Safari, Firefox or any
 * iOS browser (all WebKit: Chrome on iOS reports `CriOS`, never `Chrome/`). The client hints'
 * brands when the browser gives them, else the user agent. */
export function isChromium(win: SenderWindow): boolean {
  const brands = win.navigator?.userAgentData?.brands;
  if (brands && brands.length > 0)
    return brands.some((b) => /Chromium|Google Chrome/.test(b.brand));
  const ua = win.navigator?.userAgent ?? '';
  return /\bChrome\/\d+/.test(ua) && !/\bCriOS\//.test(ua) && win.chrome !== undefined;
}

/** Can this page cast at all (without loading anything)? Chromium in a secure context. */
export function webCastSupported(win: SenderWindow | undefined): boolean {
  if (!win) return false;
  return win.isSecureContext === true && isChromium(win);
}

let loading: Promise<boolean> | null = null;

/**
 * Load the sender once; resolves whether the Cast framework is available (false: a script
 * error, the API saying it isn't, or no answer within `CAST_SENDER_TIMEOUT_MS`). A failed load
 * may be retried by a later call.
 */
export function loadCastSender(
  win: SenderWindow,
  doc: SenderDocument,
  timeoutMs = CAST_SENDER_TIMEOUT_MS,
): Promise<boolean> {
  if (win.cast?.framework) return Promise.resolve(true);
  if (loading) return loading;
  const attempt = new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) loading = null;
      resolve(ok);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    // The framework calls this global once it has decided (it must exist before the script runs).
    const previous = win.__onGCastApiAvailable;
    win.__onGCastApiAvailable = (available, reason) => {
      previous?.(available, reason);
      settle(available && !!win.cast?.framework);
    };
    const script = doc.createElement('script');
    script.src = CAST_SENDER_URL;
    script.async = true;
    script.onerror = () => settle(false);
    doc.head.appendChild(script);
  });
  loading = attempt;
  return attempt;
}

/** Tests only. */
export function forgetCastSender() {
  loading = null;
}
