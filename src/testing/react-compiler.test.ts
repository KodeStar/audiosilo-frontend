import { join, resolve } from 'path';

import { IdentityCard } from '@/components/account/identity-card';

import { builtByCompiler } from './react-compiler';

// Jest builds the app's code as the app ships it, with the React Compiler on (the transform
// in jest.config.js): a component's body opens with the compiler's memo cache. Without it, a
// render read the compiler memoises (fe#280) would pass here and go stale in the app.
it('builds app components with the React Compiler', () => {
  expect(builtByCompiler(IdentityCard)).toBe(true);
});

// Which files that transform takes: the app's code, never the tests, their helpers or a
// package's own `src/`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transform } = require('../../jest.config') as {
  transform: Record<string, [string, { caller?: { supportsReactCompiler?: boolean } }]>;
};
const [compilerPattern] = Object.entries(transform).find(
  ([, [, options]]) => options?.caller?.supportsReactCompiler,
)!;
const root = resolve(__dirname, '../..');

it.each([
  ['src/components/account/identity-card.tsx', true],
  ['src/app/(app)/(tabs)/index.tsx', true],
  ['src/api/hooks.ts', true],
  ['src/components/account/identity-card.test.tsx', false],
  ['src/lib/paths.test.ts', false],
  ['src/testing/mock-hooks.ts', false],
  ['node_modules/expo-router/src/hooks.ts', false],
])('builds %s with the compiler: %s', (file, built) => {
  expect(new RegExp(compilerPattern).test(join(root, file))).toBe(built);
});
