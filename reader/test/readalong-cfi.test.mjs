// Read-along on a real book: the Bridge-written map of Alice (reader/test/fixtures, copied
// from audiosilo-bridge's internal/readalong/testdata and internal/epubcfi/testdata) read
// with the vendored epubcfi.js on jsdom. Every span's CFI names its own section and text
// in it; the reader's index, its tap search (a caret's CFI compared in text order) and its
// follow loop (highlight, page turns, a sentence over the page end, a seek, a stale span)
// run over those documents with a stand-in for foliate's View.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as CFI from '../vendor/foliate-js/epubcfi.js';

import {
  createReadalong,
  findInOrder,
  indexMap,
  MOVE_MS,
  spanAt,
  spineStepIndex,
} from '../src/readalong.js';
import { fakeView, loadAlice, resolveCFI } from './epub-fixture.mjs';

const book = loadAlice();
const byHref = new Map(book.map.sections.map((s) => [s.href, s.spans]));
const spansOf = (index) => byHref.get(book.sections[index].href) ?? [];
const sectionOf = spineStepIndex(book.sections.map((s) => s.cfi));

test('every span of the Bridge map resolves to text in its own section', () => {
  let spans = 0;
  for (const section of book.map.sections) {
    const own = book.sections.find((s) => s.href === section.href);
    assert.ok(own, `${section.href} is in the spine`);
    for (const span of section.spans) {
      const { index, anchor } = resolveCFI(span.cfi);
      assert.equal(index, own.index, span.cfi);
      assert.equal(sectionOf(span.cfi), own.index, span.cfi);
      const range = anchor(own.doc);
      assert.ok(range.toString().trim().length > 0, span.cfi);
      spans++;
    }
  }
  assert.ok(spans >= 1400, `${spans} spans`);
});

test('the index holds every span in time order, none unresolved', () => {
  const idx = indexMap(book.map, (cfi) => sectionOf(cfi) ?? -1);
  assert.equal(idx.unresolved, 0);
  assert.ok(idx.spans.length >= 1400);
  for (let i = 1; i < idx.starts.length; i++) assert.ok(idx.starts[i - 1] <= idx.starts[i]);
  // The narration's place finds its sentence.
  const s = idx.spans[700];
  assert.equal(idx.spans[spanAt(idx, (s.start + s.end) / 2)].cfi, s.cfi);
});

test('a caret inside a sentence finds it by CFI order; one between sentences finds none', () => {
  const section = book.sections.find((s) => spansOf(s.index).length > 20);
  const spans = spansOf(section.index);
  const parsed = spans.map((s) => CFI.parse(s.cfi));
  const order = spans.map((_, i) => i);
  order.sort((a, b) => CFI.compare(CFI.collapse(parsed[a]), CFI.collapse(parsed[b])));
  // The map's spans are in text order already.
  assert.deepEqual(
    order,
    spans.map((_, i) => i),
  );
  const startOf = (i) => CFI.collapse(parsed[i]);
  const endOf = (i) => CFI.collapse(parsed[i], true);
  for (const k of [0, 5, 13, spans.length - 1]) {
    const range = resolveCFI(spans[k].cfi).anchor(section.doc);
    const caret = section.doc.createRange();
    caret.setStart(range.startContainer, range.startOffset + 1);
    caret.collapse(true);
    const at = CFI.collapse(CFI.parse(CFI.joinIndir(section.cfi, CFI.fromRange(caret))));
    assert.equal(findInOrder(order, startOf, endOf, at, CFI.compare), k, spans[k].cfi);
  }
  // A caret in text the narration has no sentence for (a gap of the map): none.
  const gapped = book.map.sections.find((g) => g.gaps?.length && g.spans.length > 1);
  const gapSection = book.sections.find((x) => x.href === gapped.href);
  const gapSpans = spansOf(gapSection.index);
  const gapParsed = gapSpans.map((x) => CFI.parse(x.cfi));
  const gapOrder = gapSpans.map((_, i) => i);
  const gap = resolveCFI(gapped.gaps.at(-1).cfi).anchor(gapSection.doc);
  const inGap = gapSection.doc.createRange();
  inGap.setStart(gap.startContainer, gap.startOffset + 1);
  inGap.collapse(true);
  const atGap = CFI.collapse(CFI.parse(CFI.joinIndir(gapSection.cfi, CFI.fromRange(inGap))));
  assert.equal(
    findInOrder(
      gapOrder,
      (i) => CFI.collapse(gapParsed[i]),
      (i) => CFI.collapse(gapParsed[i], true),
      atGap,
      CFI.compare,
    ),
    -1,
  );
});

/** Lets every promise chain started so far settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A read-along over the fake view, with the tick driven by the test and a set clock. A
 * move's MOVE_MS timeout fires only when the test calls it (`timeouts`). */
function followAlong(map = book.map, opts) {
  const sent = [];
  const timeouts = [];
  let tick = null;
  let now = 0;
  const readalong = createReadalong({
    send: (m) => sent.push(m),
    CFI,
    draw: () => null,
    now: () => now,
    every: (fn) => {
      tick = fn;
      return 1;
    },
    stop: () => {
      tick = null;
    },
    after: (fn) => timeouts.push(fn),
    cancel: () => {},
  });
  const fake = fakeView(book, spansOf, opts);
  readalong.setMap(map);
  readalong.attach(fake.view);
  return {
    ...fake,
    readalong,
    sent,
    timeouts,
    pass: (ms) => (now += ms),
    /** One tick, not waited for (its moves can be held): `settle` lets it finish. */
    startTick: () => void tick?.(),
    tick: async () => {
      await tick?.();
      // let the tick's awaits settle
      await settle();
    },
    of: (type) => sent.filter((m) => m.type === type),
  };
}

/** Holds the fake view's goTo until the test lets each one go (`release`), as a section
 * that takes a while to load. */
function holdGoTo(view) {
  const held = [];
  const goTo = view.goTo;
  view.goTo = (target) =>
    new Promise((resolve) => held.push({ target, release: () => resolve(goTo(target)) }));
  return held;
}

const chapter = book.sections.find((s) => spansOf(s.index).length > 30);
const spans = spansOf(chapter.index);

test('a map in a book says ok; following turns to the sentence and highlights it', async () => {
  const r = followAlong();
  assert.deepEqual(r.of('readalong').at(-1), { type: 'readalong', state: 'ok', unresolved: 0 });
  r.readalong.position({ t: spans[10].start + 0.1, rate: 1, playing: false });
  await r.readalong.follow();
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
  assert.deepEqual(r.view.calls.at(-1), ['goTo', spans[10].cfi]);
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[10].cfi]);
  // The narration moves on within the page: the highlight moves, the page stays.
  r.readalong.position({ t: spans[11].start + 0.1, rate: 1, playing: false });
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[11].cfi]);
  assert.equal(r.view.calls.filter(([c]) => c === 'goTo').length, 1);
  // Past the page: it turns to the next sentence's page.
  r.readalong.position({ t: spans[14].start + 0.1, rate: 1, playing: false });
  await r.tick();
  assert.deepEqual(r.view.calls.filter(([c]) => c === 'goTo').at(-1), ['goTo', spans[14].cfi]);
  assert.deepEqual(r.view.annotations, [spans[14].cfi]);
});

test('the clock moves the highlight on between samples while playing', async () => {
  const r = followAlong();
  const k = spans.findIndex((x, i) => i > 0 && spans[i + 1] && spans[i + 1].start - x.start < 3);
  r.readalong.position({ t: spans[k].start, rate: 2, playing: true });
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[k].cfi]);
  // At twice the speed, half the time to the next sentence's start reaches it.
  r.pass(((spans[k + 1].start - spans[k].start) / 2) * 1000 + 10);
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[k + 1].cfi]);
  // Paused: the clock stays at the sample.
  r.readalong.position({ t: spans[k].start, rate: 2, playing: false });
  r.pass(5000);
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[k].cfi]);
});

test('turning the page away stops following; a player seek follows again', async () => {
  const r = followAlong();
  // Two sentences less than a seek apart.
  const k = spans.findIndex((x, i) => i > 0 && spans[i + 1] && spans[i + 1].start - x.start < 3);
  r.readalong.position({ t: spans[k].start + 0.1, rate: 1, playing: false });
  await r.readalong.follow();
  await r.tick();
  r.view.turnTo(chapter.index, k + 8);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: false });
  // The narration moves on: highlighted, but the page stays where the reader turned.
  r.readalong.position({ t: spans[k + 1].start + 0.1, rate: 1, playing: false });
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[k + 1].cfi]);
  assert.ok(!r.view.calls.some(([c, t]) => c === 'goTo' && t === spans[k + 1].cfi));
  // A seek in the player (a jump of minutes): following again, at the new sentence.
  r.readalong.position({ t: spans[25].start + 0.1, rate: 1, playing: false });
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
  await r.tick();
  assert.deepEqual(r.view.calls.filter(([c]) => c === 'goTo').at(-1), ['goTo', spans[25].cfi]);
  // Turning the page onto the sentence being read keeps following.
  r.view.turnTo(chapter.index, 24);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
});

test('a seek never follows a reader that never followed', async () => {
  const r = followAlong();
  r.readalong.position({ t: spans[3].start, rate: 1, playing: false });
  r.readalong.position({ t: spans[25].start, rate: 1, playing: false });
  assert.equal(r.of('following').length, 0);
  await r.tick();
  assert.ok(!r.view.calls.some(([c]) => c === 'goTo'));
});

test('a sentence over the page end turns the page once the narration reaches its hidden part', async () => {
  const r = followAlong();
  const s = spans[8];
  r.readalong.position({ t: s.start + 0.01, rate: 1, playing: false });
  await r.readalong.follow();
  await r.tick();
  // The page ends a few characters into the sentence.
  const range = r.rangeOfSpan(chapter.index, 8);
  const page = chapter.doc.createRange();
  page.setStart(range.startContainer, range.startOffset);
  page.setEnd(range.startContainer, range.startOffset + 3);
  r.view.show(chapter.index, page, 'anchor');
  await r.tick();
  assert.ok(!r.view.calls.some(([c]) => c === 'next'), 'not yet: the narration is at its start');
  // The narration reaches its end (a sample far on is a seek: the first tick checks the
  // sentence is in sight, which it is, the next turns the page).
  r.readalong.position({ t: s.end - 0.01, rate: 1, playing: false });
  await r.tick();
  await r.tick();
  assert.ok(r.view.calls.some(([c]) => c === 'next'));
  // The reader's own turn never stops following.
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
});

test('a tap on a sentence seeks to its start and follows', async () => {
  const r = followAlong();
  r.readalong.position({ t: spans[2].start, rate: 1, playing: true });
  await r.tick();
  await r.view.goTo(spans[2].cfi); // loads the section: the reader listens for taps there
  const target = r.rangeOfSpan(chapter.index, 6);
  chapter.doc.caretRangeFromPoint = () => {
    const caret = chapter.doc.createRange();
    caret.setStart(target.startContainer, target.startOffset + 2);
    return caret;
  };
  chapter.doc.body.dispatchEvent(new book.window.MouseEvent('click', { bubbles: true }));
  assert.deepEqual(r.of('seek').at(-1), { type: 'seek', t: spans[6].start });
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
  // A sample from before the player moved is ignored; the clock stays at the tap.
  r.readalong.position({ t: spans[2].start + 1, rate: 1, playing: true });
  assert.ok(Math.abs(r.readalong.state().t - spans[6].start) < 0.5);
  delete chapter.doc.caretRangeFromPoint;
});

test('spans in no section of this book, or naming nothing, are skipped and counted', async () => {
  const broken = {
    sections: [
      {
        href: 'missing.xhtml',
        spans: [{ cfi: 'epubcfi(/6/998!/4/2,/1:0,/1:5)', start: 0, end: 1 }],
      },
      {
        href: chapter.href,
        spans: [
          { cfi: spans[0].cfi.replace(/!\/4\/\d+/, '!/4/9998'), start: 2, end: 3 },
          spans[1],
          { cfi: 'not a cfi', start: 5, end: 6 },
        ],
      },
    ],
  };
  const r = followAlong(broken);
  assert.deepEqual(r.of('readalong').at(-1), { type: 'readalong', state: 'ok', unresolved: 2 });
  await r.view.goTo(spans[1].cfi);
  r.readalong.position({ t: 2.5, rate: 1, playing: false });
  await r.tick();
  assert.deepEqual(r.view.annotations, [], 'the span naming nothing is not drawn');
  assert.equal(r.readalong.state().bad, 1);
  r.readalong.position({ t: spans[1].start, rate: 1, playing: false });
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[1].cfi]);
});

test('a map with nothing of this book says none; taking the map away says none', () => {
  const r = followAlong({
    sections: [{ href: 'x', spans: [{ cfi: 'epubcfi(/6/998!/4)', start: 0, end: 1 }] }],
  });
  assert.deepEqual(r.of('readalong').at(-1), { type: 'readalong', state: 'none', unresolved: 1 });
  const ok = followAlong();
  ok.readalong.setMap(null);
  assert.deepEqual(ok.of('readalong').at(-1), { type: 'readalong', state: 'none', unresolved: 0 });
  assert.equal(ok.readalong.state().active, false);
});

test('a follow and a place before the book shows: it turns there once it does', async () => {
  const sent = [];
  let tick = null;
  const readalong = createReadalong({
    send: (m) => sent.push(m),
    CFI,
    draw: () => null,
    now: () => 0,
    every: (fn) => ((tick = fn), 1),
    stop: () => {},
  });
  readalong.setMap(book.map);
  readalong.position({ t: spans[5].start + 0.1, rate: 1, playing: false });
  await readalong.follow();
  assert.deepEqual(sent.at(-1), { type: 'following', value: true });
  const { view } = fakeView(book, spansOf);
  readalong.attach(view);
  await tick();
  await settle();
  assert.deepEqual(view.calls[0], ['goTo', spans[5].cfi]);
  assert.deepEqual(view.annotations, [spans[5].cfi]);
});

test('turning onto the sentence being read never follows a reader that never followed', async () => {
  const r = followAlong();
  r.readalong.position({ t: spans[10].start + 0.1, rate: 1, playing: false });
  await r.tick();
  r.view.turnTo(chapter.index, 9);
  assert.equal(r.of('following').length, 0);
  // Nor does a seek in the player after it: the reader still never followed.
  r.readalong.position({ t: spans[25].start + 0.1, rate: 1, playing: false });
  await r.tick();
  assert.equal(r.of('following').length, 0);
  assert.ok(!r.view.calls.some(([c]) => c === 'goTo'));
});

test("a touch's snap back to the page shown is no move: a tapped sentence is followed", async () => {
  const r = followAlong();
  r.readalong.position({ t: spans[2].start + 0.1, rate: 1, playing: false });
  await r.readalong.follow();
  await r.tick();
  r.view.turnTo(chapter.index, 9);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: false });
  // A tap on a sentence of this page seeks there and follows; the paginator then snaps back
  // to the same page (after the click), which keeps it.
  const target = r.rangeOfSpan(chapter.index, 10);
  chapter.doc.caretRangeFromPoint = () => {
    const caret = chapter.doc.createRange();
    caret.setStart(target.startContainer, target.startOffset + 2);
    return caret;
  };
  chapter.doc.body.dispatchEvent(new book.window.MouseEvent('click', { bubbles: true }));
  delete chapter.doc.caretRangeFromPoint;
  assert.deepEqual(r.of('seek').at(-1), { type: 'seek', t: spans[10].start });
  r.view.show(chapter.index, r.pageRange(chapter.index, 9), 'snap');
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
  await r.tick();
  assert.deepEqual(r.view.annotations, [spans[10].cfi]);
});

test('between sentences, a move away stops following; one to where it goes on keeps it', async () => {
  const r = followAlong();
  // Before the first sentence (the recording's opening words): nothing is lit.
  assert.ok(spans[0].start > 5);
  r.readalong.position({ t: 5, rate: 1, playing: true });
  await r.readalong.follow();
  await r.tick();
  assert.equal(r.readalong.state().cur, -1);
  r.view.turnTo(chapter.index, 0);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: true });
  r.view.turnTo(chapter.index, 12);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: false });
  // So the narration playing on to its first sentence leaves the page where the reader is.
  for (let t = 6; t < spans[0].start; t++) {
    r.pass(1000);
    r.readalong.position({ t, rate: 1, playing: true });
  }
  r.pass(1000);
  r.readalong.position({ t: spans[0].start + 0.1, rate: 1, playing: true });
  await r.tick();
  assert.equal(r.readalong.state().cur, 0);
  assert.ok(!r.view.calls.some(([c, t]) => c === 'goTo' && t === spans[0].cfi));
});

test("the reader's moves and the listener's are made one at a time", async () => {
  const r = followAlong();
  const held = holdGoTo(r.view);
  r.readalong.position({ t: spans[5].start + 0.1, rate: 1, playing: false });
  const follow = r.readalong.follow();
  await settle();
  assert.deepEqual(
    held.map((h) => h.target),
    [spans[5].cfi],
  );
  // A seek far on while that section loads: the tick's move waits for it, and so does a
  // listener's.
  r.readalong.position({ t: spans[25].start + 0.1, rate: 1, playing: false });
  r.startTick();
  await settle();
  let turned = false;
  const listener = r.readalong.move(() => {
    turned = true;
  });
  await settle();
  assert.equal(held.length, 1);
  held.shift().release();
  await follow;
  await settle();
  assert.deepEqual(
    held.map((h) => h.target),
    [spans[25].cfi],
  );
  assert.equal(turned, false);
  held.shift().release();
  await listener;
  await settle();
  assert.equal(turned, true);
  assert.deepEqual(r.view.annotations, [spans[25].cfi]);
});

test('a move that never settles is given up on after MOVE_MS', async () => {
  assert.ok(MOVE_MS >= 5000);
  const r = followAlong();
  const held = holdGoTo(r.view);
  r.readalong.position({ t: spans[5].start + 0.1, rate: 1, playing: false });
  const follow = r.readalong.follow();
  await settle();
  assert.equal(held.length, 1);
  // Its section never loads (another goTo took its place): the timeout lets the rest go.
  r.timeouts.at(-1)();
  await follow;
  // The reader no longer counts its own move: the listener's next one stops following.
  r.view.turnTo(chapter.index, 20);
  assert.deepEqual(r.of('following').at(-1), { type: 'following', value: false });
});

test('a map changed while a move waits leaves the rest to the next tick', async (t) => {
  // The tick runs off the timer, so what it throws is an unhandled rejection.
  const thrown = [];
  const onThrown = (e) => thrown.push(e);
  process.on('unhandledRejection', onThrown);
  t.after(() => process.off('unhandledRejection', onThrown));
  const r = followAlong();
  r.readalong.position({ t: spans[2].start + 0.1, rate: 1, playing: false });
  await r.readalong.follow();
  await r.tick();
  const held = holdGoTo(r.view);
  // A seek into the next chapter: its section loads while the map is replaced by a
  // shorter one.
  const next = book.sections.find((s) => s.index > chapter.index && spansOf(s.index).length > 0);
  const far = spansOf(next.index)[0];
  r.readalong.position({ t: far.start + 0.1, rate: 1, playing: false });
  r.startTick();
  await settle();
  assert.deepEqual(
    held.map((h) => h.target),
    [far.cfi],
  );
  r.readalong.setMap({ sections: [{ href: chapter.href, spans: [spans[0], spans[1]] }] });
  held.shift().release();
  await settle();
  assert.deepEqual(thrown, []);
  assert.ok(!r.view.annotations.includes(far.cfi));
  assert.equal(r.readalong.state().bad, 0);
});
