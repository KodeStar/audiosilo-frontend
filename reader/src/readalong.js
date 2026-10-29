// Read-along (Bridge Phase 3c): the reader follows the narration through the book. The
// host sends a map (`readalong {map}`: each section's narrated sentences, a CFI and their
// whole-book times), the narration's place once a second (`position {t, rate, playing}`) and
// `follow`; this highlights the sentence being read, turns the page to it while following,
// and says when a sentence is tapped (`seek {t}`), whether it follows (`following
// {value}`) and what it made of the map (`readalong {state, unresolved}`).
//
// Ported from the read-along spike's readalong-core.js and its reader (.readalong-spike):
// - the map is indexed only once the book has opened at its first place (a follow `goTo`
//   racing the opening one would supersede it, and that one would never resolve);
// - a sentence's Range is resolved only when it is needed (lazily, per section document):
//   resolving every CFI of a section on its load cost ~1.8 s on a long one;
// - a 50 ms tick reads an interpolating clock (`PositionClock`, fed ~1 Hz) and finds the
//   sentence by binary search on start times;
// - a tap is located by comparing CFIs (a binary search in text order), not by a Range per
//   sentence;
// - a sentence running over the page end turns the page once the narration reaches its
//   part off the page (by the share of its characters shown);
// - a player seek (the narration jumps) follows again, once the reader has followed;
// - the view's moves, the reader's own and the listener's, are made one at a time (a goTo
//   started while another section loads leaves that one never settling);
// - a span whose CFI names no section of this EPUB, or nothing in its section, is skipped
//   and counted, never breaking the loop;
// - the highlight is foliate's own annotation, drawn with `Overlayer.highlight`.
//
// The pure parts (index, lookups, clock, CFI search) are exported for reader/test.

/** How long after a sentence ends it stays lit while nothing follows it (seconds): the
 * highlight does not flicker off between sentences; a longer gap (music, a passage the
 * text does not have) shows none. */
export const HOLD_GAP = 2;
/** A sample this far (seconds) from where the clock says the narration is, is a seek. */
export const JUMP = 3;
/** The clock never runs further than this (seconds) past its last sample. */
export const MAX_AHEAD = 3;
/** After a tap, how long the reader waits for the narration to arrive near its sentence
 * (ms), ignoring samples from before the player moved. */
export const SEEK_GRACE_MS = 2500;
/** How near the tapped sentence a sample must be to count as the player having moved. */
const SEEK_NEAR = 1.5;
/** How long one move of the view may hold the moves after it (ms): foliate drops a section
 * still loading when another goTo starts, and that goTo never settles. */
export const MOVE_MS = 10_000;
const TICK_MS = 50;
const MAX_CFI = 1024;

/** One span, checked field by field; null when it fails. */
export function checkSpan(s) {
  if (!s || typeof s !== 'object') return null;
  const { cfi, start, end } = s;
  if (typeof cfi !== 'string' || !cfi.startsWith('epubcfi(') || cfi.length > MAX_CFI) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) return null;
  return { cfi, start, end };
}

/**
 * The map's spans in one list sorted by start time, each with the spine index of its
 * section (`sectionOf(cfi)`, -1 for none in this book) and its place in the list (`i`).
 * Spans that fail their checks, or name no section here, are left out and counted in
 * `unresolved`.
 */
export function indexMap(map, sectionOf) {
  const spans = [];
  let unresolved = 0;
  const sections = Array.isArray(map?.sections) ? map.sections : [];
  for (const section of sections) {
    const list = Array.isArray(section?.spans) ? section.spans : [];
    for (const raw of list) {
      const span = checkSpan(raw);
      const si = span ? sectionOf(span.cfi) : -1;
      if (!span || !Number.isInteger(si) || si < 0) {
        unresolved++;
        continue;
      }
      spans.push({ ...span, si, i: 0 });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const starts = new Float64Array(spans.length);
  spans.forEach((s, i) => {
    s.i = i;
    starts[i] = s.start;
  });
  return { spans, starts, unresolved };
}

/** A section's spine index from a CFI's first step (`/6/N`: N / 2 - 1), when the book's
 * sections' own CFIs (`book.sections[i].cfi`) name that step; else null (ask foliate). */
export function spineStepIndex(sectionCfis) {
  const byStep = new Map();
  sectionCfis.forEach((cfi, i) => {
    const step = /^(?:epubcfi\()?\/6\/(\d+)/.exec(cfi ?? '')?.[1];
    if (step && !byStep.has(step)) byStep.set(step, i);
  });
  return (cfi) => {
    const step = /^epubcfi\(\/6\/(\d+)/.exec(cfi)?.[1];
    return step !== undefined && byStep.has(step) ? byStep.get(step) : null;
  };
}

/** The last index below `n` for which `atOrBefore(i)` holds (a binary search: it holds for
 * a prefix of the indices), or -1 for none. */
function lastAtOrBefore(n, atOrBefore) {
  let lo = 0;
  let hi = n - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (atOrBefore(mid)) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * The span to highlight at whole-book time `t`, or -1: the last one starting at or before
 * `t` (a binary search), while `t` is within `holdGap` of its end.
 */
export function spanAt(idx, t, holdGap = HOLD_GAP) {
  const { starts, spans } = idx;
  const ans = lastAtOrBefore(starts.length, (i) => starts[i] <= t);
  if (ans < 0) return -1;
  return t <= spans[ans].end + holdGap ? ans : -1;
}

/** The first span starting after whole-book time `t` (where the narration goes on from a
 * gap), or -1. */
export function spanAfter(idx, t) {
  const next = lastAtOrBefore(idx.starts.length, (i) => idx.starts[i] <= t) + 1;
  return next < idx.starts.length ? next : -1;
}

/**
 * The span (an entry of `order`, the section's spans in text order) holding the caret at
 * `at`, or -1: the last whose start is at or before it (a binary search by `compare`, the
 * CFI order), when the caret is not past its end.
 */
export function findInOrder(order, startOf, endOf, at, compare) {
  const ans = lastAtOrBefore(order.length, (k) => compare(startOf(order[k]), at) <= 0);
  if (ans < 0) return -1;
  const i = order[ans];
  return compare(at, endOf(i)) <= 0 ? i : -1;
}

/** The narration's clock: ~1 Hz samples, moved on between them at the sample's speed while
 * it plays (never more than MAX_AHEAD past the last). */
export class PositionClock {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.t0 = 0;
    this.at = now();
    this.rate = 1;
    this.playing = false;
    this.known = false;
    this.pending = null;
  }

  /** Takes a sample; true when it is a seek (it lands JUMP or more from where the clock
   * was, and from where the narration would be had it played on: a gap in the samples, a
   * phone's timers paused in the background, is no seek however long). A sample from
   * before a tap's seek reached the player is dropped (false). */
  sample({ t, rate, playing }) {
    if (!Number.isFinite(t) || t < 0) return false;
    if (this.pending) {
      if (this.now() < this.pending.until && Math.abs(t - this.pending.t) > SEEK_NEAR) {
        return false;
      }
      this.pending = null;
    }
    const playedOn = this.playing ? this.t0 + ((this.now() - this.at) / 1000) * this.rate : this.t0;
    const jumped = this.known && Math.abs(this.get() - t) >= JUMP && Math.abs(playedOn - t) >= JUMP;
    this.t0 = t;
    this.at = this.now();
    this.rate = Number.isFinite(rate) && rate > 0 ? rate : 1;
    this.playing = playing === true;
    this.known = true;
    return jumped;
  }

  /** A tap asked the player to seek to `t`: the clock is there now, and samples far from it
   * are dropped for SEEK_GRACE_MS. */
  seekTo(t) {
    this.t0 = t;
    this.at = this.now();
    this.known = true;
    this.pending = { t, until: this.now() + SEEK_GRACE_MS };
  }

  get() {
    if (!this.playing) return this.t0;
    const dt = Math.min((this.now() - this.at) / 1000, MAX_AHEAD);
    return this.t0 + dt * this.rate;
  }
}

/** The relocations a person makes (a page turn, a swipe, a link or a contents jump): one
 * that leaves the sentence being read stops following. A relayout's (`anchor`) never. */
const MOVES = new Set(['page', 'scroll', 'snap', 'navigation']);

/**
 * The read-along of the open book. `send` posts to the host; `CFI` is foliate's epubcfi.js;
 * `draw` the highlight's drawing function (`Overlayer.highlight`); `color()` its colour.
 * The view is handed over with `attach` once its book shows its first place, and taken
 * back with `detach` before another opens; the map comes any time (`setMap`).
 */
export function createReadalong({
  send,
  CFI,
  draw,
  color = () => '#f5a524',
  now = () => performance.now(),
  every = (fn, ms) => setInterval(fn, ms),
  stop = (id) => clearInterval(id),
  after = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
}) {
  const clock = new PositionClock(now);
  let map = null;
  let view = null;
  let idx = null;
  let timer = null;
  let cur = -1;
  let drawn = null; // the CFI highlighted
  let following = false;
  let followedOnce = false;
  let programmatic = 0;
  let moving = Promise.resolve(); // the view's moves, one at a time (`inTurn`)
  let busy = false;
  let jumped = false; // a seek came: the next tick turns to the sentence
  let lastLoc = null; // the renderer's last relocate: { range, index }
  let turn = null; // the sentence being read's page turn on lastLoc's page: { cur, loc, at }
  let docRanges = new WeakMap(); // section document -> Map(span i -> Range | null)
  let sections = new Map(); // spine index -> { order, starts, ends } (lazy)
  const wired = new WeakSet();
  const bad = new Set(); // spans whose CFI resolved to nothing

  function setFollowing(value) {
    if (value) followedOnce = true;
    if (following === value) return;
    following = value;
    send({ type: 'following', value });
  }

  /**
   * One move of the view, after the moves before it, the reader's and the listener's:
   * foliate drops a section still loading when another goTo starts, and that goTo never
   * settles. One that has not settled after MOVE_MS is given up on, so it cannot hold the
   * moves after it. `quiet`: the reader's own (following), never taken for the listener's.
   */
  function inTurn(move, quiet = false) {
    const run = moving.then(async () => {
      if (quiet) programmatic++;
      let timeout = null;
      try {
        await Promise.race([
          move(),
          new Promise((resolve) => {
            timeout = after(resolve, MOVE_MS);
          }),
        ]);
      } finally {
        cancel(timeout);
        if (quiet) programmatic--;
      }
    });
    moving = run.catch(() => {});
    return run;
  }

  /** The reader's own move of the view it has now, made in turn while it still follows
   * there (a listener's move or another book can come first). */
  function ownMove(step) {
    const shown = view;
    return inTurn(() => (following && view === shown ? step(shown) : undefined), true);
  }

  const go = (target) => ownMove((v) => v.goTo(target));

  // ---- ranges, lazily -----------------------------------------------------------------

  function rangeIn(doc, i) {
    let ranges = docRanges.get(doc);
    if (!ranges) docRanges.set(doc, (ranges = new Map()));
    if (!ranges.has(i)) {
      let range = null;
      try {
        range = view.resolveCFI(idx.spans[i].cfi).anchor(doc);
        if (!range || typeof range.toString !== 'function' || !range.toString().trim()) {
          range = null;
        }
      } catch {
        range = null;
      }
      if (!range) bad.add(i);
      ranges.set(i, range);
    }
    return ranges.get(i);
  }

  function docOf(index) {
    if (lastLoc?.index === index) {
      const doc = lastLoc.range?.startContainer?.ownerDocument;
      if (doc) return doc;
    }
    return view.renderer?.getContents?.().find((c) => c.index === index)?.doc ?? null;
  }

  function rangeOf(i) {
    const doc = docOf(idx.spans[i].si);
    return doc ? rangeIn(doc, i) : null;
  }

  function isVisible(i) {
    if (!lastLoc?.range || lastLoc.index !== idx.spans[i].si) return false;
    const r = rangeOf(i);
    if (!r) return false;
    try {
      return lastLoc.range.comparePoint(r.startContainer, r.startOffset) === 0;
    } catch {
      return false;
    }
  }

  // ---- taps ---------------------------------------------------------------------------

  /** A section's spans in text order, with their parsed start and end CFIs (made once). */
  function sectionSpans(index) {
    let entry = sections.get(index);
    if (entry) return entry;
    const order = [];
    const starts = new Map();
    const ends = new Map();
    for (const s of idx.spans) {
      if (s.si !== index) continue;
      try {
        const parsed = CFI.parse(s.cfi);
        starts.set(s.i, CFI.collapse(parsed));
        ends.set(s.i, CFI.collapse(parsed, true));
        order.push(s.i);
      } catch {
        bad.add(s.i);
      }
    }
    order.sort((a, b) => CFI.compare(starts.get(a), starts.get(b)));
    entry = { order, starts, ends };
    sections.set(index, entry);
    return entry;
  }

  /** The span holding the caret at `node`/`offset` of a section's document, or -1. */
  function spanAtCaret(index, doc, node, offset) {
    const { order, starts, ends } = sectionSpans(index);
    const caret = doc.createRange();
    caret.setStart(node, offset);
    caret.collapse(true);
    const at = CFI.collapse(CFI.parse(view.getCFI(index, caret)));
    return findInOrder(
      order,
      (i) => starts.get(i),
      (i) => ends.get(i),
      at,
      CFI.compare,
    );
  }

  function caretAt(doc, x, y) {
    if (doc.caretPositionFromPoint) {
      const p = doc.caretPositionFromPoint(x, y);
      return p && { node: p.offsetNode, offset: p.offset };
    }
    const r = doc.caretRangeFromPoint?.(x, y);
    return r && { node: r.startContainer, offset: r.startOffset };
  }

  function onTap(index, doc, e) {
    if (!idx || e.defaultPrevented || e.target?.closest?.('a[href]')) return;
    const selection = doc.getSelection?.();
    if (selection && !selection.isCollapsed) return;
    const pos = caretAt(doc, e.clientX, e.clientY);
    if (!pos?.node) return;
    let hit = -1;
    try {
      hit = spanAtCaret(index, doc, pos.node, pos.offset);
    } catch {
      return;
    }
    if (hit < 0 || bad.has(hit)) return;
    const { start } = idx.spans[hit];
    setFollowing(true);
    clock.seekTo(start);
    send({ type: 'seek', t: start });
  }

  function wire(doc, index) {
    if (!doc || wired.has(doc)) return;
    wired.add(doc);
    doc.addEventListener('click', (e) => onTap(index, doc, e));
  }

  // ---- following ----------------------------------------------------------------------

  /** Whether two relocations show the same text: a touch snapping back to the page shown
   * (any tap, on a touch screen) moved nothing. */
  function samePage(a, b) {
    if (!a?.range || !b?.range || a.index !== b.index) return false;
    try {
      // Range.START_TO_START (0) and END_TO_END (2), the same in every frame's realm.
      return (
        a.range.compareBoundaryPoints(0, b.range) === 0 &&
        a.range.compareBoundaryPoints(2, b.range) === 0
      );
    } catch {
      return false;
    }
  }

  function onRelocate(e) {
    const detail = e.detail ?? {};
    const was = lastLoc;
    lastLoc = { range: detail.range, index: detail.index };
    if (programmatic || !idx || !MOVES.has(detail.reason) || samePage(was, lastLoc)) return;
    // The reader moved: following only while the sentence being read (between sentences,
    // the next, where the narration goes on) is still in sight. Landing on it follows
    // again only a reader that has followed: one that never did follows when asked.
    const at = cur >= 0 ? cur : spanAfter(idx, clock.get());
    if (at < 0 || !isVisible(at)) setFollowing(false);
    else if (followedOnce) setFollowing(true);
  }

  /** When the sentence being read, starting on the page shown and running over its end,
   * turns the page (by the share of its characters shown), else null; worked out once per
   * sentence and page, not every tick. Undefined while its section has not loaded. */
  function turnTime() {
    if (turn && turn.cur === cur && turn.loc === lastLoc) return turn.at;
    const r = rangeOf(cur);
    if (!r) return undefined;
    const shownRange = lastLoc.range;
    let at = null;
    try {
      if (
        shownRange.comparePoint(r.startContainer, r.startOffset) === 0 &&
        shownRange.comparePoint(r.endContainer, r.endOffset) > 0
      ) {
        const shown = r.cloneRange();
        shown.setEnd(shownRange.endContainer, shownRange.endOffset);
        const share = shown.toString().length / Math.max(1, r.toString().length);
        const s = idx.spans[cur];
        at = s.start + share * (s.end - s.start);
      }
    } catch {
      at = null;
    }
    turn = { cur, loc: lastLoc, at };
    return at;
  }

  /** A sentence running over the page's end: turn once the narration reaches the part that
   * is off the page (`turnTime`). */
  async function turnMidSentence(t) {
    if (!following || cur < 0 || bad.has(cur) || !lastLoc?.range) return;
    const at = turnTime();
    if (typeof at !== 'number' || t < at) return;
    await ownMove((v) => v.next());
  }

  async function unhighlight() {
    if (!drawn) return;
    const value = drawn;
    drawn = null;
    try {
      await view.deleteAnnotation({ value });
    } catch {
      // its section went away with the old view
    }
  }

  async function tick() {
    if (!idx || !view || busy) return;
    busy = true;
    // The map indexed (and the view) this tick works on: one that changes while it waits
    // (`setMap`, another book) leaves the rest to the next tick.
    const at = idx;
    try {
      const t = clock.get();
      const i = spanAt(at, t);
      const resync = jumped;
      jumped = false;
      if (i === cur) {
        // A seek within the sentence being read: back to its page, else the page end.
        if (resync && following && i >= 0 && !bad.has(i) && !isVisible(i)) {
          await go(at.spans[i].cfi);
        } else await turnMidSentence(t);
        return;
      }
      await unhighlight();
      if (idx !== at) return;
      cur = i;
      if (i < 0 || bad.has(i)) return;
      const s = at.spans[i];
      if (following && !isVisible(i)) await go(s.cfi);
      if (!view || idx !== at) return;
      // A CFI that names nothing in its section (a stale map, an edited EPUB) is skipped.
      if (docOf(s.si) && !rangeOf(i)) return;
      const shown = view;
      try {
        await shown.addAnnotation({ value: s.cfi });
      } catch {
        if (idx === at) bad.add(i);
        return;
      }
      if (idx === at && view === shown) drawn = s.cfi;
      else shown.deleteAnnotation({ value: s.cfi }).catch(() => {});
    } finally {
      busy = false;
    }
  }

  // ---- the view and the map -----------------------------------------------------------

  function activate() {
    if (!map || !view || idx) return;
    const sectionCfis = (view.book?.sections ?? []).map((s) => s.cfi);
    const fromStep = spineStepIndex(sectionCfis);
    const count = sectionCfis.length;
    const sectionOf = (cfi) => {
      const quick = fromStep(cfi);
      if (quick !== null) return quick;
      try {
        const { index } = view.resolveCFI(cfi);
        return Number.isInteger(index) && index >= 0 && index < count ? index : -1;
      } catch {
        return -1;
      }
    };
    idx = indexMap(map, sectionOf);
    turn = null;
    docRanges = new WeakMap();
    sections = new Map();
    bad.clear();
    cur = -1;
    send({
      type: 'readalong',
      state: idx.spans.length > 0 ? 'ok' : 'none',
      unresolved: idx.unresolved,
    });
    if (idx.spans.length === 0) {
      idx = null;
      return;
    }
    for (const { doc, index } of view.renderer?.getContents?.() ?? []) wire(doc, index);
    timer = every(() => void tick(), TICK_MS);
  }

  function deactivate() {
    if (timer !== null) stop(timer);
    timer = null;
    void (view && unhighlight());
    idx = null;
    cur = -1;
    jumped = false;
  }

  return {
    /** The open book's view, once it shows its first place. */
    attach(next) {
      deactivate();
      view = next;
      const loc = next.lastLocation;
      lastLoc = loc?.range ? { range: loc.range, index: loc.section?.current } : null;
      next.renderer?.addEventListener('relocate', onRelocate);
      next.addEventListener('load', (e) => wire(e.detail?.doc, e.detail?.index));
      // The reader's only annotation is the sentence being read.
      next.addEventListener('draw-annotation', (e) => e.detail?.draw?.(draw, { color: color() }));
      next.addEventListener('create-overlay', (e) => {
        const s = cur >= 0 && idx ? idx.spans[cur] : null;
        if (s && drawn === s.cfi && s.si === e.detail?.index) {
          view.addAnnotation({ value: drawn }).catch(() => {});
        }
      });
      activate();
    },
    /** The view is going (another book opens): nothing more is drawn on it. */
    detach() {
      deactivate();
      view = null;
      lastLoc = null;
    },
    /** A map from the host; null (none, or one that came wrong) is said as `none`. */
    setMap(next) {
      deactivate();
      map = next && typeof next === 'object' ? next : null;
      if (!map) {
        followedOnce = false;
        setFollowing(false);
        send({ type: 'readalong', state: 'none', unresolved: 0 });
        return;
      }
      activate();
    },
    /** A sample of the narration's place. A seek follows again, once the reader has. */
    position(sample) {
      if (!sample || typeof sample !== 'object') return;
      const seek = clock.sample(sample);
      if (seek && followedOnce && idx) {
        setFollowing(true);
        jumped = true; // the next tick turns to the sentence, even the same one
      }
    },
    /** Back to the narration: follow, and turn to the sentence being read. */
    async follow() {
      setFollowing(true);
      if (!idx || !view) return;
      const i = spanAt(idx, clock.get());
      if (i >= 0 && !bad.has(i) && !isVisible(i)) await go(idx.spans[i].cfi);
    },
    /** A listener's move of the view (a page edge, a key, the contents): made in turn with
     * the reader's own, so no two goTo race. */
    move: (step) => inTurn(step),
    /** For tests and the screen's state: what it is doing now. */
    state: () => ({ cur, following, active: idx !== null, t: clock.get(), bad: bad.size }),
  };
}
