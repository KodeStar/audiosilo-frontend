// The paginator's relayout guard (reader/src/render-guard.js, fe#239): foliate's
// `render()` runs on every resize, also while the section it shows is still loading and its
// document has no root or body; that relayout is skipped, any other goes through.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canLayout, guardRender } from '../src/render-guard.js';

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
