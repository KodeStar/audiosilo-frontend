// The ES2024 statics foliate's EPUB parser calls on every open (reader/src/polyfills.js):
// defined only where the engine has none (iOS 16.4-17.3, Chrome 111-116), and grouping as
// the built-ins do. Node has the built-ins, so each case is compared with them.
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Saved before the module ever runs: it is only imported below, never statically.
const native = { object: Object.groupBy, map: Map.groupBy };
const descriptors = {
  object: Object.getOwnPropertyDescriptor(Object, 'groupBy'),
  map: Object.getOwnPropertyDescriptor(Map, 'groupBy'),
};

let loads = 0;
/** A new instance of the module, which runs it again (Node keeps one per URL). */
const load = () => import(`../src/polyfills.js?fresh=${++loads}`);

const { objectGroupBy, mapGroupBy } = await load();

test('leaves the built-ins in place where the engine has them', async () => {
  await load();
  assert.equal(Object.groupBy, native.object);
  assert.equal(Map.groupBy, native.map);
});

test('defines each where the engine has none, as the built-ins are defined', async () => {
  let mod, defined;
  delete Object.groupBy;
  delete Map.groupBy;
  try {
    mod = await load();
    defined = {
      object: Object.getOwnPropertyDescriptor(Object, 'groupBy'),
      map: Object.getOwnPropertyDescriptor(Map, 'groupBy'),
    };
  } finally {
    Object.defineProperty(Object, 'groupBy', descriptors.object);
    Object.defineProperty(Map, 'groupBy', descriptors.map);
  }
  // Writable and configurable, not enumerable: the built-ins' own flags.
  assert.deepEqual(defined.object, { ...descriptors.object, value: mod.objectGroupBy });
  assert.deepEqual(defined.map, { ...descriptors.map, value: mod.mapGroupBy });
  assert.equal(defined.object.enumerable, false);
  assert.equal(defined.map.enumerable, false);
});

/** Both polyfills give what the built-ins give for the same items (`items()` makes them),
 * keys in the same order. */
function same(items, callback) {
  const object = objectGroupBy(items(), callback);
  const nativeObject = native.object(items(), callback);
  assert.equal(Object.getPrototypeOf(object), null);
  assert.deepEqual(Reflect.ownKeys(object), Reflect.ownKeys(nativeObject));
  assert.deepEqual(object, nativeObject);
  const map = mapGroupBy(items(), callback);
  assert.ok(map instanceof Map);
  assert.deepEqual([...map], [...native.map(items(), callback)]);
}

test('groups numbers by parity', () => {
  same(
    () => [1, 2, 3, 4, 5, 6, 7],
    (n) => (n % 2 ? 'odd' : 'even'),
  );
});

test('keeps keys in the order first seen (integer-like ones first, as on any object)', () => {
  same(
    () => ['b', 'a', '10', 'c', '2', 'a', 'b', '__proto__', 'constructor', 'toString'],
    (s) => s,
  );
});

test('a null key is a key of its own in a Map (foliate groups metas by refines)', () => {
  const metas = () => [
    { refines: null },
    { refines: '#a' },
    {},
    { refines: 'null' },
    { refines: null },
  ];
  same(metas, (el) => el.refines);
  const refines = mapGroupBy(metas(), (el) => el.refines);
  assert.deepEqual(refines.get(null), [{ refines: null }, { refines: null }]);
  assert.equal(refines.get('null').length, 1);
  // On an object every key is a string: null and 'null' are one group.
  assert.equal(objectGroupBy(metas(), (el) => el.refines).null.length, 3);
});

test('keys of every kind: numbers, -0 and NaN, symbols, objects', () => {
  const symbol = Symbol('s');
  const object = { toString: () => 'object' };
  same(
    () => [1, '1', -0, 0, NaN, NaN, symbol, object, true, undefined],
    (x) => x,
  );
  // -0 is stored as 0, as the spec has it.
  assert.ok(Object.is([...mapGroupBy([-0], (x) => x).keys()][0], 0));
});

test('takes any iterable, not only an array', () => {
  same(
    () => new Set([3, 1, 4, 1, 5, 9]),
    (n) => n > 2,
  );
  same(
    function* () {
      yield 'x';
      yield 'yy';
      yield 'z';
    },
    (s) => s.length,
  );
  same(
    () => 'hello',
    (c) => c,
  );
});

test('passes each item and its index, and no this', () => {
  const calls = (groupBy) => {
    const seen = [];
    groupBy(new Set(['a', 'b', 'c']), function (...args) {
      seen.push([this, ...args]);
      return args[1] % 2;
    });
    return seen;
  };
  for (const [polyfill, original] of [
    [objectGroupBy, native.object],
    [mapGroupBy, native.map],
  ]) {
    assert.deepEqual(calls(polyfill), calls(original));
    assert.deepEqual(calls(polyfill), [
      [undefined, 'a', 0],
      [undefined, 'b', 1],
      [undefined, 'c', 2],
    ]);
  }
  same(
    () => ['a', 'b', 'c', 'd'],
    (_, i) => i % 2,
  );
});

test('a callback that is not a function, or items that are not iterable, is a TypeError', () => {
  for (const groupBy of [objectGroupBy, mapGroupBy, native.object, native.map]) {
    // Before anything is iterated, so an empty list throws too.
    for (const callback of [undefined, null, 'key', {}, 1]) {
      assert.throws(() => groupBy([], callback), TypeError);
    }
    for (const items of [null, undefined, 42, { length: 1, 0: 'a' }]) {
      assert.throws(() => groupBy(items, () => 'key'), TypeError);
    }
  }
});

test("the callback's error stops the grouping and closes the iterator", () => {
  for (const groupBy of [objectGroupBy, mapGroupBy, native.object, native.map]) {
    let closed = false;
    function* items() {
      try {
        yield 1;
        yield 2;
      } finally {
        closed = true;
      }
    }
    const fail = () => {
      throw new RangeError('no');
    };
    assert.throws(() => groupBy(items(), fail), RangeError);
    assert.ok(closed);
  }
});
