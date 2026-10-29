// The native reader's chunk assembly (reader/src/chunks.js): what it accepts and everything
// it refuses (out of order, repeated, missing, not base64, the wrong size).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ChunkError,
  createAssembly,
  createTextAssembly,
  MAX_BOOK_BYTES,
  MAX_CHUNKS,
  MAX_MAP_LENGTH,
} from '../src/chunks.js';

const b64 = (bytes) => Buffer.from(bytes).toString('base64');

test('assembles the chunks in order into the announced bytes', () => {
  const book = createAssembly(5, 2);
  assert.equal(book.add(0, b64([1, 2, 3])), null);
  const bytes = book.add(1, b64([4, 5]));
  assert.ok(bytes instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(bytes)], [1, 2, 3, 4, 5]);
});

test('refuses a size or count that cannot be right, before allocating', () => {
  for (const [size, chunks] of [
    [0, 1],
    [-1, 1],
    [1.5, 1],
    [MAX_BOOK_BYTES + 1, 1],
    ['5', 1],
    [5, 0],
    [5, 6],
    [5, 1.5],
    [MAX_CHUNKS + 2, MAX_CHUNKS + 1],
  ]) {
    assert.throws(() => createAssembly(size, chunks), ChunkError, `${size}/${chunks}`);
  }
});

test('refuses a chunk out of order, and anything after a refusal', () => {
  const book = createAssembly(4, 2);
  assert.throws(() => book.add(1, b64([3, 4])), /chunk 1 arrived, chunk 0 was expected/);
  assert.throws(() => book.add(0, b64([1, 2])), ChunkError);
});

test('refuses a repeated chunk', () => {
  const book = createAssembly(4, 2);
  book.add(0, b64([1, 2]));
  assert.throws(() => book.add(0, b64([1, 2])), ChunkError);
});

test('refuses a chunk after the last one', () => {
  const book = createAssembly(2, 1);
  book.add(0, b64([1, 2]));
  assert.throws(() => book.add(1, b64([3])), /no chunk was expected/);
});

test('refuses data that is not base64', () => {
  for (const data of [undefined, 42, '', 'abc', 'ab!=', 'AQID\n', '====']) {
    assert.throws(() => createAssembly(3, 1).add(0, data), ChunkError, String(data));
  }
});

test('refuses more bytes than announced', () => {
  const book = createAssembly(3, 2);
  book.add(0, b64([1, 2]));
  assert.throws(() => book.add(1, b64([3, 4])), /larger than announced/);
});

test('refuses fewer bytes than announced once the last chunk is in', () => {
  const book = createAssembly(6, 2);
  book.add(0, b64([1, 2]));
  assert.throws(() => book.add(1, b64([3, 4])), /smaller than announced/);
});

test('takes a seq only as the exact integer expected', () => {
  assert.throws(() => createAssembly(2, 1).add('0', b64([1, 2])), ChunkError);
  assert.throws(() => createAssembly(2, 1).add(0.0000001, b64([1, 2])), ChunkError);
});

// The app's large read-along map (Bridge Phase 3c): its JSON text in pieces.
test('assembles a map text in order', () => {
  const map = createTextAssembly(7, 3);
  assert.equal(map.add(0, '{"a'), null);
  assert.equal(map.add(1, '":'), null);
  assert.equal(map.add(2, '1}'), '{"a":1}');
});

test('refuses a map length or count that cannot be right', () => {
  for (const [length, chunks] of [
    [0, 1],
    [1.5, 1],
    [MAX_MAP_LENGTH + 1, 1],
    ['7', 1],
    [7, 0],
    [7, 8],
    [7, MAX_CHUNKS + 1],
  ]) {
    assert.throws(() => createTextAssembly(length, chunks), ChunkError, `${length}/${chunks}`);
  }
});

test('refuses a map piece out of order, repeated, extra, not text, or the wrong length', () => {
  const cases = [
    (m) => m.add(1, 'abc'),
    (m) => (m.add(0, 'abc'), m.add(0, 'abc')),
    (m) => m.add(0, ''),
    (m) => m.add(0, 42),
    (m) => m.add(0, 'abcdefgh'),
    (m) => (m.add(0, 'ab'), m.add(1, 'c')),
    (m) => (m.add(0, 'abc'), m.add(1, 'def'), m.add(2, 'x')),
  ];
  for (const run of cases) {
    const m = createTextAssembly(6, 2);
    assert.throws(() => run(m), ChunkError);
    // Once refused, nothing more is taken.
    assert.throws(() => m.add(0, 'abc'), ChunkError);
  }
});
