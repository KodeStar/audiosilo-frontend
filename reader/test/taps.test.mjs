// The centre tap (reader/src/taps.js, fe#246): a tap in the middle of the page shows or hides
// the host's top bar, even on a sentence the read-along seeks to (readalong-cfi.test.mjs); a
// link, a selection, a swipe or a tap near the sides does not.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { frameViewportX, isCentre, TAP_SLOP, watchTaps } from '../src/taps.js';

/** A document's stand-in: its listeners by type, and its selection. */
function fakeDoc({ collapsed = true } = {}) {
  const listeners = {};
  return {
    listeners,
    selection: { isCollapsed: collapsed },
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    getSelection() {
      return this.selection;
    },
  };
}

/** A press at (x, y) and a click where it ended (`to`), on a 1000 px reader. */
function tap(
  doc,
  { x = 500, y = 300, to = { x, y }, target = {}, prevented = false, ...rest } = {},
) {
  for (const fn of doc.listeners.pointerdown ?? []) fn({ screenX: x, screenY: y });
  const click = {
    screenX: to.x,
    screenY: to.y,
    clientX: to.x,
    button: 0,
    target,
    defaultPrevented: prevented,
    ...rest,
  };
  for (const fn of doc.listeners.click ?? []) fn(click);
  return click;
}

function watched(doc = fakeDoc()) {
  const taps = [];
  watchTaps(doc, {
    onTap: () => taps.push('tap'),
    viewportX: (e) => e.clientX,
    width: () => 1000,
    defer: (fn) => fn(),
  });
  return { doc, taps };
}

test('the middle half of the reader is its centre; an unknown place counts as the middle', () => {
  assert.equal(isCentre(500, 1000), true);
  assert.equal(isCentre(250, 1000), true);
  assert.equal(isCentre(750, 1000), true);
  assert.equal(isCentre(249, 1000), false);
  assert.equal(isCentre(751, 1000), false);
  assert.equal(isCentre(null, 1000), true);
  assert.equal(isCentre(10, 0), true);
});

test('a tap in the middle of the page is said', () => {
  const { doc, taps } = watched();
  tap(doc);
  assert.deepEqual(taps, ['tap']);
});

test('a tap near the sides is not (one that just missed a page edge)', () => {
  const { doc, taps } = watched();
  tap(doc, { x: 100 });
  tap(doc, { x: 900 });
  assert.deepEqual(taps, []);
});

test('a swipe is not a tap, a press that moved a little is', () => {
  const { doc, taps } = watched();
  tap(doc, { x: 600, to: { x: 400, y: 300 } });
  assert.deepEqual(taps, []);
  tap(doc, { x: 500, to: { x: 500 + TAP_SLOP - 2, y: 302 } });
  assert.deepEqual(taps, ['tap']);
});

test('a click something else took is not a tap: a link, a selection', () => {
  const { doc, taps } = watched();
  // A link, by its element or by foliate's handler having prevented the click.
  tap(doc, { target: { closest: (s) => (s === 'a[href]' ? {} : null) } });
  tap(doc, { prevented: true });
  assert.deepEqual(taps, []);
  // Foliate's link handler prevents the click after this listener ran: judged later.
  const later = [];
  const doc2 = fakeDoc();
  const heard = [];
  watchTaps(doc2, {
    onTap: () => heard.push('tap'),
    viewportX: (e) => e.clientX,
    width: () => 1000,
    defer: (fn) => later.push(fn),
  });
  const click = tap(doc2);
  click.defaultPrevented = true;
  for (const fn of later) fn();
  assert.deepEqual(heard, []);
  // A selection being made.
  const selecting = watched(fakeDoc({ collapsed: false }));
  tap(selecting.doc);
  assert.deepEqual(selecting.taps, []);
});

test('a modified or secondary click is not a tap', () => {
  const { doc, taps } = watched();
  tap(doc, { button: 2 });
  tap(doc, { metaKey: true });
  tap(doc, { ctrlKey: true });
  assert.deepEqual(taps, []);
});

test("a section's click is placed by its frame on the page", () => {
  const frame = { getBoundingClientRect: () => ({ left: -2000 }) };
  assert.equal(frameViewportX({ view: { frameElement: frame }, clientX: 2500 }), 500);
  assert.equal(frameViewportX({ view: { frameElement: null }, clientX: 10 }), null);
  assert.equal(
    frameViewportX({
      get view() {
        throw new Error('cross-origin');
      },
      clientX: 10,
    }),
    null,
  );
});
