// The read-along core (reader/src/readalong.js): the checks on a map's spans, the index,
// the lookups both ways (time -> sentence, caret -> sentence) and the narration's clock.
// The follow loop over a real book is readalong-cfi.test.mjs.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkSpan,
  findInOrder,
  HOLD_GAP,
  indexMap,
  JUMP,
  MAX_AHEAD,
  PositionClock,
  SEEK_GRACE_MS,
  spanAt,
  spineStepIndex,
} from '../src/readalong.js';

const span = (start, end, cfi = `epubcfi(/6/4!/4/${start})`) => ({ cfi, start, end });

test('a span passes only with a CFI and finite times, 0 <= start <= end', () => {
  assert.deepEqual(checkSpan(span(1, 2)), span(1, 2));
  assert.deepEqual(checkSpan(span(0, 0)), span(0, 0));
  for (const bad of [
    null,
    'x',
    { cfi: 'epubcfi(/6/4)', start: 2, end: 1 },
    { cfi: 'epubcfi(/6/4)', start: -1, end: 1 },
    { cfi: 'epubcfi(/6/4)', start: Number.NaN, end: 1 },
    { cfi: 'epubcfi(/6/4)', start: 0, end: Infinity },
    { cfi: 'epubcfi(/6/4)', start: '0', end: 1 },
    { cfi: '/6/4', start: 0, end: 1 },
    { cfi: 42, start: 0, end: 1 },
    { cfi: `epubcfi(${'x'.repeat(1100)})`, start: 0, end: 1 },
  ]) {
    assert.equal(checkSpan(bad), null, JSON.stringify(bad));
  }
});

test('the index sorts by time, keeps each span its section, and counts what it leaves out', () => {
  const map = {
    sections: [
      {
        href: 'b',
        spans: [span(30, 31, 'epubcfi(/6/6!/4/2)'), span(10, 11, 'epubcfi(/6/6!/4/4)')],
      },
      { href: 'a', spans: [span(20, 21, 'epubcfi(/6/4!/4/2)'), { cfi: 'bad', start: 0, end: 1 }] },
      { href: 'gone', spans: [span(5, 6, 'epubcfi(/6/99!/4/2)')] },
      { href: 'no spans' },
      'not a section',
    ],
  };
  const sectionOf = (cfi) => ({ 4: 1, 6: 2 })[/\/6\/(\d+)/.exec(cfi)[1]] ?? -1;
  const idx = indexMap(map, sectionOf);
  assert.deepEqual(
    idx.spans.map((s) => [s.start, s.si, s.i]),
    [
      [10, 2, 0],
      [20, 1, 1],
      [30, 2, 2],
    ],
  );
  assert.deepEqual([...idx.starts], [10, 20, 30]);
  assert.equal(idx.unresolved, 2);
  assert.equal(indexMap(null, sectionOf).spans.length, 0);
});

test("a CFI's spine step finds its section by the book's own section CFIs", () => {
  const of = spineStepIndex(['epubcfi(/6/2[cover])', 'epubcfi(/6/4[ch1])', '/6/6', undefined]);
  assert.equal(of('epubcfi(/6/2!/4/2,/1:0,/1:5)'), 0);
  assert.equal(of('epubcfi(/6/4[ch1]!/4)'), 1);
  assert.equal(of('epubcfi(/6/6!/4)'), 2);
  // A step no section has, or no step at all: ask foliate (null).
  assert.equal(of('epubcfi(/6/8!/4)'), null);
  assert.equal(of('epubcfi(/4/2)'), null);
});

test('spanAt: the last sentence started, held across a short gap, none in a long one', () => {
  const idx = indexMap(
    { sections: [{ spans: [span(10, 12), span(13, 15), span(30, 31)] }] },
    () => 0,
  );
  assert.equal(spanAt(idx, 5), -1);
  assert.equal(spanAt(idx, 10), 0);
  assert.equal(spanAt(idx, 12.5), 0);
  assert.equal(spanAt(idx, 13), 1);
  assert.equal(spanAt(idx, 15 + HOLD_GAP), 1);
  assert.equal(spanAt(idx, 15 + HOLD_GAP + 0.01), -1);
  assert.equal(spanAt(idx, 30.5), 2);
  assert.equal(spanAt(idx, 1e6), -1);
  assert.equal(spanAt(idx, 1e6, Infinity), 2);
  assert.equal(
    spanAt(
      indexMap({ sections: [] }, () => 0),
      3,
    ),
    -1,
  );
});

test('findInOrder: the sentence holding the caret, by the order given', () => {
  // Sentences [0,10] [12,20] [20,30] (adjacent: the end of one is the start of the next).
  const starts = [0, 12, 20];
  const ends = [10, 20, 30];
  const order = [0, 1, 2];
  const find = (at) =>
    findInOrder(
      order,
      (i) => starts[i],
      (i) => ends[i],
      at,
      (a, b) => a - b,
    );
  assert.equal(find(-1), -1);
  assert.equal(find(0), 0);
  assert.equal(find(10), 0);
  assert.equal(find(11), -1);
  assert.equal(find(15), 1);
  assert.equal(find(20), 2);
  assert.equal(find(31), -1);
  assert.equal(
    findInOrder(
      [],
      () => 0,
      () => 0,
      1,
      (a, b) => a - b,
    ),
    -1,
  );
});

test('the clock moves on at the speed while playing, never far past its last sample', () => {
  let now = 0;
  const clock = new PositionClock(() => now);
  assert.equal(clock.sample({ t: 100, rate: 1.5, playing: true }), false);
  now = 1000;
  assert.equal(clock.get(), 101.5);
  now = 60_000;
  assert.equal(clock.get(), 100 + MAX_AHEAD * 1.5);
  clock.sample({ t: 50, rate: 1, playing: false });
  now = 90_000;
  assert.equal(clock.get(), 50);
  // A bad sample is ignored; a bad speed reads as 1.
  assert.equal(clock.sample({ t: Number.NaN, rate: 1, playing: true }), false);
  assert.equal(clock.get(), 50);
  clock.sample({ t: 50, rate: -2, playing: true });
  now += 1000;
  assert.equal(clock.get(), 51);
});

test('a sample far from where the clock is, is a seek; the first one never is', () => {
  let now = 0;
  const clock = new PositionClock(() => now);
  assert.equal(clock.sample({ t: 500, rate: 1, playing: true }), false);
  now = 1000;
  assert.equal(clock.sample({ t: 501.2, rate: 1, playing: true }), false);
  now = 2000;
  assert.equal(clock.sample({ t: 502.2 + JUMP, rate: 1, playing: true }), true);
  now = 3000;
  assert.equal(clock.sample({ t: 100, rate: 1, playing: true }), true);
});

test('after a tap, samples from before the player moved are dropped, for a while', () => {
  let now = 0;
  const clock = new PositionClock(() => now);
  clock.sample({ t: 10, rate: 1, playing: true });
  clock.seekTo(200);
  assert.equal(clock.get(), 200);
  now = 500;
  assert.equal(clock.sample({ t: 10.5, rate: 1, playing: true }), false);
  assert.equal(clock.get(), 200.5);
  // The player arrived: taken (and no seek: the clock was there).
  now = 1000;
  assert.equal(clock.sample({ t: 201, rate: 1, playing: true }), false);
  assert.equal(clock.get(), 201);
  // Once arrived, a far sample is a seek again.
  now = 1500;
  assert.equal(clock.sample({ t: 20, rate: 1, playing: true }), true);
  // A player that never moves: after the grace, its place is taken (and is a seek).
  clock.seekTo(300);
  now += SEEK_GRACE_MS + 1;
  assert.equal(clock.sample({ t: 20, rate: 1, playing: false }), true);
  assert.equal(clock.get(), 20);
});
