// node --test scripts/check-native-dupes.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SINGLETONS, findDuplicates } from './check-native-dupes.mjs';

const node = (name, version, location) => ({ name, version, location });

test('one copy of each singleton passes', () => {
  const nodes = [
    node('react', '19.3.0', 'node_modules/react'),
    node('react-native', '0.88.1', 'node_modules/react-native'),
    node('@shopify/flash-list', '2.3.2', 'node_modules/@shopify/flash-list'),
  ];
  assert.deepEqual(findDuplicates(nodes), []);
});

test('a nested second copy fails, listing both', () => {
  const nodes = [
    node('react-native-svg', '15.16.0', 'node_modules/react-native-svg'),
    node('react', '19.3.0', 'node_modules/react'),
    node('react', '19.2.3', 'node_modules/some-lib/node_modules/react'),
  ];
  assert.deepEqual(findDuplicates(nodes), [
    {
      name: 'react',
      copies: [
        { version: '19.3.0', location: 'node_modules/react' },
        { version: '19.2.3', location: 'node_modules/some-lib/node_modules/react' },
      ],
    },
  ]);
});

test('two copies at the same version still fail (each registers its own native module)', () => {
  const nodes = [
    node('expo-modules-core', '58.0.30', 'node_modules/expo-modules-core'),
    node('expo-modules-core', '58.0.30', 'node_modules/expo/node_modules/expo-modules-core'),
  ];
  assert.equal(findDuplicates(nodes).length, 1);
});

test('the same location reported twice is one copy', () => {
  const nodes = [
    node('react-native-screens', '4.30.1', 'node_modules/react-native-screens'),
    node('react-native-screens', '4.30.1', 'node_modules/react-native-screens'),
  ];
  assert.deepEqual(findDuplicates(nodes), []);
});

test('packages outside the list are ignored, and results sort by name', () => {
  const nodes = [
    node('lodash', '4.17.21', 'node_modules/lodash'),
    node('lodash', '4.17.20', 'node_modules/a/node_modules/lodash'),
    node('react-native', '0.88.1', 'node_modules/react-native'),
    node('react-native', '0.88.0', 'node_modules/b/node_modules/react-native'),
    node('react', '19.3.0', 'node_modules/react'),
    node('react', '19.2.0', 'node_modules/c/node_modules/react'),
  ];
  assert.deepEqual(
    findDuplicates(nodes).map((d) => d.name),
    ['react', 'react-native'],
  );
});

test('the list covers the renderer and the native modules that must be single', () => {
  for (const name of ['react', 'react-native', 'react-native-reanimated', 'expo-modules-core']) {
    assert.ok(SINGLETONS.includes(name), name);
  }
});
