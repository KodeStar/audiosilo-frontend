// AudioSilo's ebook reader (Bridge Phase 3b). Built by scripts/build-reader.mjs into ONE
// self-contained document, public/reader.html (served as /web/reader.html under its own
// CSP), which the player shows in a sandboxed, same-origin iframe
// (src/reader/reader-host.web.tsx). It has no network access of its own (connect-src
// 'none'): the host posts the EPUB bytes, the place to open at and the appearance; the
// reader posts back what it opened and where the reader is. The protocol's host side,
// with every message's shape, is src/reader/protocol.ts.
//
// EPUB scripts never run. Three layers: the loader never loads a script file and strips
// <meta http-equiv=refresh> (here); the document's CSP, inherited by foliate's blob:
// section frames, allows only this script by hash; and the iframe's sandbox (no popups,
// top navigation, forms or modals).
import { View } from '../vendor/foliate-js/view.js';

import { BookError, openEpub } from './epub-open.js';

void View; // registers <foliate-view>

const HEX = /^#[0-9a-f]{6}$/i;
const MAX_TOC = 2000;
const MAX_LABEL = 300;

let view = null;
let opened = false;
let lastProgress = null;
let busy = false;
let moves = 0;
let theme = { dark: false, background: '#ffffff', foreground: '#000000' };
let fontScale = 1;

// ---- transport -----------------------------------------------------------------------

function send(msg) {
  if (window.parent !== window) window.parent.postMessage(msg, location.origin);
}

window.addEventListener('message', (e) => {
  // Only the page that embeds this frame, on our own origin, may drive the reader.
  if (e.source !== window.parent || e.origin !== location.origin) return;
  const msg = e.data;
  if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
  handle(msg).catch((err) => report('runtime', err));
});

function report(code, err) {
  send({ type: 'error', code, message: String(err?.message ?? err).slice(0, 500) });
}

window.addEventListener('error', (e) => {
  if (/ResizeObserver loop/.test(String(e.message))) return;
  report('runtime', e.error ?? e.message);
});
window.addEventListener('unhandledrejection', (e) => report('runtime', e.reason));

function reportCsp(e) {
  send({
    type: 'csp',
    directive: String(e.violatedDirective).slice(0, 100),
    blocked: String(e.blockedURI).slice(0, 200),
  });
}
document.addEventListener('securitypolicyviolation', reportCsp);

async function handle(msg) {
  switch (msg.type) {
    case 'open':
      return open(msg);
    case 'goto':
      return move(() => go(msg));
    case 'appearance':
      setAppearance(msg);
      return;
    case 'next':
      return move(() => view.next());
    case 'prev':
      return move(() => view.prev());
  }
}

// ---- appearance ----------------------------------------------------------------------

function setAppearance(msg) {
  const t = msg.theme;
  if (t && typeof t === 'object' && HEX.test(t.background) && HEX.test(t.foreground)) {
    theme = { dark: t.scheme === 'dark', background: t.background, foreground: t.foreground };
  }
  if (typeof msg.fontScale === 'number' && Number.isFinite(msg.fontScale)) {
    fontScale = Math.min(2, Math.max(0.5, msg.fontScale));
  }
  const root = document.documentElement.style;
  root.setProperty('--bg', theme.background);
  root.setProperty('--fg', theme.foreground);
  root.colorScheme = theme.dark ? 'dark' : 'light';
  view?.renderer?.setStyles?.(bookCss());
}

function bookCss() {
  const { dark, background: bg, foreground: fg } = theme;
  const size = Math.round(fontScale * 100);
  // Dark: a book's own text colours were chosen for paper, so the theme's win.
  const darkRules = dark
    ? `body * { color: inherit !important; background-color: transparent !important;
         border-color: currentColor !important; }`
    : '';
  return `
    html { color-scheme: ${dark ? 'dark' : 'light'}; font-size: ${size}% !important; }
    html, body { background-color: ${bg} !important; color: ${fg} !important; }
    body { line-height: 1.5; }
    a:any-link { color: inherit; text-decoration: underline; }
    ${darkRules}
  `;
}

// ---- opening -------------------------------------------------------------------------

function setBusy(value) {
  if (busy === value) return;
  busy = value;
  send({ type: 'loading', value });
}

/** EPUB scripts are never loaded; a meta refresh (navigation without script) is removed. */
function harden(book) {
  const target = book.transformTarget;
  if (!target) return;
  target.addEventListener('load', (e) => {
    if (e.detail.isScript) e.detail.allow = false;
  });
  target.addEventListener('data', (e) => {
    const { type } = e.detail;
    if (!/html|svg/.test(type)) return;
    e.detail.data = Promise.resolve(e.detail.data).then(async (d) => {
      // foliate's re-serialized markup, or a Blob for a document it passes as it is (one
      // that references itself).
      const markup = typeof d === 'string' ? d : d instanceof Blob ? await d.text() : null;
      return (markup !== null && /refresh/i.test(markup) && withoutRefresh(markup, type)) || d;
    });
  });
}

/** An (X)HTML or SVG document without its meta refreshes (null when it has none): found
 * through the DOM, so in any namespace or prefix (an XHTML meta inside SVG) and however
 * its attributes are written. */
function withoutRefresh(markup, type) {
  const doc = new DOMParser().parseFromString(markup, type);
  const refreshes = [...doc.getElementsByTagNameNS('*', 'meta')].filter((meta) =>
    /^\s*refresh\s*$/i.test(meta.getAttribute('http-equiv') ?? ''),
  );
  if (refreshes.length === 0) return null;
  for (const meta of refreshes) meta.remove();
  return new XMLSerializer().serializeToString(doc);
}

/** A section's first load can take seconds (a whole novel in one spine item): the host
 * shows a spinner from the load until the reader lands somewhere. */
function watchSections(book) {
  for (const section of book.sections) {
    const load = section.load;
    if (typeof load !== 'function') continue;
    section.load = async (...args) => {
      setBusy(true);
      try {
        return await load(...args);
      } catch (err) {
        setBusy(false);
        throw err;
      }
    };
  }
}

const text = (v) => (typeof v === 'string' ? v.trim().slice(0, MAX_LABEL) : '');

function titleOf(book, fallback) {
  const t = book.metadata?.title;
  if (typeof t === 'string' && t.trim()) return text(t);
  if (t && typeof t === 'object') {
    const first = Object.values(t).find((v) => typeof v === 'string' && v.trim());
    if (first) return text(first);
  }
  return text(fallback);
}

function flattenToc(items, depth = 0, out = []) {
  for (const item of items ?? []) {
    if (out.length >= MAX_TOC) break;
    const href = typeof item?.href === 'string' ? item.href.slice(0, 2048) : '';
    if (href) out.push({ label: text(item.label) || href, href, depth: Math.min(depth, 5) });
    if (Array.isArray(item?.subitems)) flattenToc(item.subitems, depth + 1, out);
  }
  return out;
}

async function openAt(at) {
  if (!at || typeof at !== 'object') return false;
  if (typeof at.cfi === 'string' && at.cfi.startsWith('epubcfi(')) {
    // View.goTo never throws: it resolves the target, or nothing when going there failed.
    // A CFI naming no section of this EPUB (one from another edition of the book) resolves
    // to index -1 and shows nothing: the fraction then.
    const resolved = await view.goTo(at.cfi);
    if (resolved?.index >= 0) return true;
  }
  if (typeof at.fraction === 'number' && Number.isFinite(at.fraction)) {
    try {
      await view.goToFraction(Math.min(1, Math.max(0, at.fraction)));
      return true;
    } catch {
      // fall back to the start
    }
  }
  return false;
}

/** The book's text start (its bodymatter landmark); its first page when foliate's
 * goToTextStart throws (a landmark with no epub:type). */
async function goToStart() {
  try {
    await view.goToTextStart();
  } catch {
    await view.next();
  }
}

async function open(msg) {
  if (!(msg.book instanceof ArrayBuffer)) return report('unreadable', 'no book');
  setAppearance(msg);
  setBusy(true);
  opened = false;
  lastProgress = null;
  let book;
  try {
    book = await openEpub(msg.book);
  } catch (err) {
    setBusy(false);
    return report(err instanceof BookError ? err.code : 'unreadable', err);
  }
  harden(book);
  watchSections(book);

  try {
    // Releases the last book's listeners and blob URLs; throws when it never showed a page.
    view?.close();
  } catch {
    // nothing shown, nothing more to release
  }
  view?.remove();
  view = document.createElement('foliate-view');
  view.addEventListener('relocate', onRelocate);
  view.addEventListener('load', onSectionLoad);
  // Links out of the book never open: the sandbox would refuse the popup anyway.
  view.addEventListener('external-link', (e) => e.preventDefault());
  document.getElementById('book').append(view);
  try {
    await view.open(book);
    view.renderer.setAttribute('flow', 'paginated');
    view.renderer.setAttribute('margin', '32px');
    view.renderer.setAttribute('gap', '6%');
    view.renderer.setAttribute('max-inline-size', '720px');
    view.renderer.setStyles?.(bookCss());
    if (!(await openAt(msg.at))) await goToStart();
    // Still no page (a start landmark outside the spine): the first one.
    if (!lastProgress) await view.next();
  } catch (err) {
    // Whatever keeps the book from showing is said, never left as a spinner.
    setBusy(false);
    return report('unreadable', err);
  }

  opened = true;
  send({
    type: 'opened',
    title: titleOf(book, msg.name),
    toc: flattenToc(book.toc),
    // Its next page is on the left: the host's page edges and arrows follow it.
    rtl: book.dir === 'rtl',
  });
  if (lastProgress) send(lastProgress);
  setBusy(false);
}

// ---- moving --------------------------------------------------------------------------

function onRelocate(e) {
  const { cfi, fraction, tocItem } = e.detail ?? {};
  setBusy(false);
  // A relayout relocates to the same place again: say each place once.
  if (typeof cfi !== 'string' || cfi === lastProgress?.cfi) return;
  lastProgress = {
    type: 'progress',
    cfi,
    fraction: typeof fraction === 'number' && Number.isFinite(fraction) ? fraction : 0,
    sectionLabel: text(tocItem?.label),
  };
  if (opened) send(lastProgress);
}

function onSectionLoad(e) {
  const doc = e.detail?.doc;
  if (!doc) return;
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('securitypolicyviolation', reportCsp);
}

const KEY_MOVES = {
  ArrowLeft: () => view.goLeft(),
  ArrowRight: () => view.goRight(),
  PageUp: () => view.prev(),
  PageDown: () => view.next(),
};

function onKey(e) {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  // The host closes the reader on Escape, but a key pressed in here never reaches it.
  if (e.key === 'Escape') {
    if (!e.repeat) send({ type: 'escape' });
    return;
  }
  const step = Object.hasOwn(KEY_MOVES, e.key) ? KEY_MOVES[e.key] : null;
  if (!step) return;
  e.preventDefault();
  void move(step);
}
document.addEventListener('keydown', onKey);

/** A move in the open book (never while it opens: two layouts would race). The spinner a
 * section's load raised drops when the moves settle, also when one lands nowhere new (a
 * hidden anchor relocates nothing). */
async function move(step) {
  if (!view || !opened) return;
  moves++;
  try {
    await step();
  } finally {
    if (--moves === 0) setBusy(false);
  }
}

async function go(msg) {
  if (typeof msg.cfi === 'string') await view.goTo(msg.cfi);
  else if (typeof msg.href === 'string') await view.goTo(msg.href);
  else if (typeof msg.fraction === 'number' && Number.isFinite(msg.fraction)) {
    await view.goToFraction(Math.min(1, Math.max(0, msg.fraction)));
  }
}

send({ type: 'ready' });
