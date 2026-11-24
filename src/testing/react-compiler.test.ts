import { transformFileSync, type TransformCaller } from '@babel/core';
import { join, resolve } from 'path';

import { IdentityCard } from '@/components/account/identity-card';
import { GhostCovers } from '@/components/ui/ghost-art';

import { builtByCompiler, compiledByCompiler } from './react-compiler';

// Jest builds the app's code as the app ships it, with the React Compiler on (the transform
// in jest.config.js): a component's body opens with the compiler's memo cache. Without it, a
// render read the compiler memoises (fe#280) would pass here and go stale in the app.
// GhostCovers' default prop checks it holds under CI's `--coverage` run too (the plugin order
// in jest.config.js).
it.each([
  ['IdentityCard', IdentityCard],
  ['GhostCovers, a default prop', GhostCovers],
])('builds %s with the React Compiler', (_, component) => {
  expect(builtByCompiler(component)).toBe(true);
});

// Which files that transform takes: the app's code, never the tests, their helpers or a
// package's own `src/`.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transform } = require('../../jest.config') as {
  transform: Record<string, [string, { caller: TransformCaller; plugins?: [string, unknown][] }]>;
};
const [compilerPattern] = Object.entries(transform).find(([, [, options]]) =>
  options?.plugins?.some(([plugin]) => plugin.includes('babel-plugin-react-compiler')),
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

// Ahead of the preset, the transform's compiler plugin builds what the preset's own would.
it('compiles as babel-preset-expo does', () => {
  const [, { caller, plugins }] = transform[compilerPattern];
  const build = (options: { caller: TransformCaller; plugins?: [string, unknown][] }) =>
    transformFileSync(join(root, 'src/components/ui/ghost-art.tsx'), {
      root,
      compact: true,
      ...options,
    })!.code!;
  const preset = build({ caller: { ...caller, supportsReactCompiler: true } as TransformCaller });
  expect(compiledByCompiler(preset)).toBe(true);
  expect(build({ caller, plugins })).toBe(preset);
});
