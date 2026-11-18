// The paginator's relayout guard (reader/src/render-guard.js, fe#239): foliate's
// `render()` runs on every resize, also while the section it shows is still loading and its
// document has no root or body; that relayout is skipped, any other goes through.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canLayout, guardRender, watchRelayouts } from '../src/render-guard.js';

const loaded = { documentElement: {}, body: {} };

/** A stand-in for foliate's paginator: `render()` lays out what `getContents()` shows,
 * and its own resize handler calls `this.render()` the way foliate's does. */
function paginator(contents) {
  const calls = [];
  return {
    localName: 'foliate-paginator',
    contents,
    calls,
    getContents() {
      return this.contents;
    },
    render(...args) {
      calls.push(args);
      return 'rendered';
    },
    onResize() {
      return this.render();
    },
  };
}

test('a document lays out only with its root element and its body', () => {
  assert.equal(canLayout(loaded), true);
  assert.equal(canLayout({ documentElement: {}, body: null }), false);
  assert.equal(canLayout({ documentElement: null, body: null }), false);
  // A frame taken out of the page has no document at all.
  assert.equal(canLayout(null), false);
  assert.equal(canLayout(undefined), false);
});

test('skips a relayout while the shown section is still loading, then lays it out', () => {
  const r = paginator([{ index: 3, doc: { documentElement: {}, body: null } }]);
  assert.equal(guardRender(r), true);
  // The frame grew (the Follow pill went away) while the section loads: nothing to lay out.
  assert.equal(r.onResize(), undefined);
  r.contents = [{ index: 3, doc: { documentElement: null, body: null } }];
  assert.equal(r.onResize(), undefined);
  r.contents = [{ index: 3, doc: null }];
  assert.equal(r.onResize(), undefined);
  assert.equal(r.calls.length, 0);
  // Loaded: the next resize lays it out, with what it was called with.
  r.contents = [{ index: 3, doc: loaded }];
  assert.equal(r.render('x'), 'rendered');
  assert.equal(r.onResize(), 'rendered');
  assert.deepEqual(r.calls, [['x'], []]);
});

test('leaves a paginator that shows nothing yet to foliate (its render returns at once)', () => {
  const r = paginator([]);
  guardRender(r);
  assert.equal(r.onResize(), 'rendered');
  assert.equal(r.calls.length, 1);
});

test("guards only foliate's paginator: a fixed-layout book's renderer is left as it is", () => {
  const fxl = { ...paginator([]), localName: 'foliate-fxl' };
  const render = fxl.render;
  assert.equal(guardRender(fxl), false);
  assert.equal(fxl.render, render);
  assert.equal(guardRender(null), false);
  assert.equal(guardRender({ localName: 'foliate-paginator' }), false);
});

/** A stand-in for foliate's paginator dispatching its relocates in the layout it has (its
 * box, its section's laid-out length and text size), and for its view, which hears each one
 * inside the dispatch and passes it on without the reason. */
function relocating() {
  const heard = [];
  const renderer = new EventTarget();
  const layout = { width: 390, height: 700, viewSize: 3900, textSize: '16px', index: 2 };
  const doc = {
    documentElement: {},
    defaultView: { getComputedStyle: () => ({ fontSize: layout.textSize }) },
  };
  renderer.getBoundingClientRect = () => ({ width: layout.width, height: layout.height });
  renderer.getContents = () => [{ index: layout.index, doc }];
  Object.defineProperty(renderer, 'viewSize', { get: () => layout.viewSize });
  renderer.relocate = function (reason) {
    this.dispatchEvent(new CustomEvent('relocate', { detail: { reason, index: layout.index } }));
  };
  return { renderer, heard, layout };
}

test('says whether the relocate being passed on is a relayout (fe#172)', () => {
  const { renderer, heard, layout } = relocating();
  const isRelayout = watchRelayouts(renderer);
  // The view's listener, as foliate's: it reads nothing of the reason.
  renderer.addEventListener('relocate', () => heard.push(isRelayout()));
  renderer.relocate('navigation'); // where the book opens
  renderer.relocate('page'); // a page turn
  renderer.relocate('snap'); // a swipe
  assert.deepEqual(heard.splice(0), [false, false, false]);

  // Back on its place in a layout that changed: a relayout, whatever changed.
  Object.assign(layout, { width: 700, height: 390 }); // a rotation
  renderer.relocate('anchor');
  layout.height = 330; // the frame alone (the Follow pill came)
  renderer.relocate('anchor');
  layout.textSize = '20px'; // a new text size
  renderer.relocate('anchor');
  layout.viewSize = 4680; // its fonts loaded: the section runs a page longer
  renderer.relocate('anchor');
  assert.deepEqual(heard.splice(0), [true, true, true, true]);
  // The page it is on after that is a page turn like any other.
  renderer.relocate('page');
  assert.deepEqual(heard.splice(0), [false]);
});

test('takes an `anchor` relocate in an unchanged layout for the move it is', () => {
  const { renderer, heard, layout } = relocating();
  const isRelayout = watchRelayouts(renderer);
  renderer.addEventListener('relocate', () => heard.push(isRelayout()));
  renderer.relocate('page');
  // foliate says `anchor` too when focus goes to a link on another page, and when a
  // keyboard selection crosses a page: the reader moved, and the place is saved.
  renderer.relocate('anchor');
  renderer.relocate('anchor');
  assert.deepEqual(heard.splice(0), [false, false, false]);
  // A relayout after it is still one. foliate relocates twice for one relayout: the second
  // lands in the layout the first left, on the same page, which the reader says once.
  layout.width = 500;
  renderer.relocate('anchor');
  renderer.relocate('anchor');
  assert.deepEqual(heard.splice(0), [true, false]);
});

test("a newly loaded section laid out on the last one's place is no relayout", () => {
  const { renderer, heard, layout } = relocating();
  const isRelayout = watchRelayouts(renderer);
  renderer.addEventListener('relocate', () => heard.push(isRelayout()));
  renderer.relocate('navigation');
  // The next section loads: foliate first puts it on the place the last one held (a
  // fraction), then goes where it was asked to. Often that is the same page, and the reader
  // says each page once: said as a relayout, a page turned into a section was never saved.
  Object.assign(layout, { index: 3, viewSize: 2340 });
  renderer.relocate('anchor');
  renderer.relocate('navigation');
  // Its fonts load after that: a relayout of the section it is in.
  layout.viewSize = 3120;
  renderer.relocate('anchor');
  assert.deepEqual(heard, [false, false, false, true]);
});

test('passes every event on as it was dispatched', () => {
  const { renderer } = relocating();
  watchRelayouts(renderer);
  let got = null;
  renderer.addEventListener('load', (e) => (got = e.detail));
  assert.equal(renderer.dispatchEvent(new CustomEvent('load', { detail: 'doc' })), true);
  assert.equal(got, 'doc');
  // A renderer that dispatches nothing: never a relayout.
  assert.equal(watchRelayouts(null)(), false);
});

test('a renderer whose layout cannot be read never says relayout: every place is saved', () => {
  const renderer = new EventTarget();
  Object.defineProperty(renderer, 'viewSize', {
    get() {
      throw new TypeError('no view');
    },
  });
  const isRelayout = watchRelayouts(renderer);
  const heard = [];
  renderer.addEventListener('relocate', () => heard.push(isRelayout()));
  for (const reason of ['navigation', 'anchor', 'anchor'])
    renderer.dispatchEvent(new CustomEvent('relocate', { detail: { reason, index: 0 } }));
  assert.deepEqual(heard, [false, false, false]);
});
