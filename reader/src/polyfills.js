// Object.groupBy and Map.groupBy (ES2024) where the engine has neither. foliate's EPUB parser
// (getMetadata in epub.js) calls both on every open, and they came only with Safari 17.4 and
// Chrome 117: without them no book opens on the app's oldest iOS (16.4) or the web reader's
// oldest browsers (Safari 16.4, Chrome 111). Each is defined only when it is missing, the way
// the built-ins are (writable, configurable, not enumerable). The exports are for the tests.

/** The spec's GroupBy: each key's items, keys in the order first seen. for...of throws for
 * null and undefined as the built-ins do, and takes any iterable (foliate passes an
 * HTMLCollection). A Map compares keys by SameValueZero and keeps -0 as 0, as GroupBy does. */
function group(items, callback, toKey) {
  if (typeof callback !== 'function') throw new TypeError('groupBy needs a callback');
  const groups = new Map();
  let index = 0;
  for (const item of items) {
    const key = toKey(callback(item, index++));
    const list = groups.get(key);
    if (list) list.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

// ToPropertyKey: a symbol stays a symbol, anything else becomes a string.
const propertyKey = (key) => (typeof key === 'symbol' ? key : String(key));

export function objectGroupBy(items, callback) {
  const result = Object.create(null);
  for (const [key, list] of group(items, callback, propertyKey)) result[key] = list;
  return result;
}

export function mapGroupBy(items, callback) {
  return group(items, callback, (key) => key);
}

const define = (target, value) =>
  Object.defineProperty(target, 'groupBy', {
    value,
    writable: true,
    configurable: true,
    enumerable: false,
  });

if (typeof Object.groupBy !== 'function') define(Object, objectGroupBy);
if (typeof Map.groupBy !== 'function') define(Map, mapGroupBy);
