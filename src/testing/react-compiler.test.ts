import { transformFileSync, type TransformCaller } from '@babel/core';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

import { IdentityCard } from '@/components/account/identity-card';
import { GhostCovers } from '@/components/ui/ghost-art';

import { builtByCompiler, memoCaches } from './react-compiler';

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
type BabelOptions = { caller: TransformCaller; plugins?: [string, unknown][] };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { transform } = require('../../jest.config') as {
  transform: Record<string, [string, BabelOptions]>;
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
// ghost-art.tsx holds two components, GhostCovers with a default prop and GhostSpines.
const ghostArt = join(root, 'src/components/ui/ghost-art.tsx');
it('compiles as babel-preset-expo does', () => {
  const [, { caller, plugins }] = transform[compilerPattern];
  const build = (options: BabelOptions) =>
    transformFileSync(ghostArt, {
      root,
      compact: true,
      ...options,
    })!.code!;
  const preset = build({ caller: { ...caller, supportsReactCompiler: true } as TransformCaller });
  expect(memoCaches(preset)).toBe(2);
  expect(build({ caller, plugins })).toBe(preset);
});

// Under `--coverage` (CI's run) babel-jest adds istanbul's counters after the transform's
// plugins, so the compiler still builds a default prop: checked here without `--coverage`.
it('compiles ahead of the coverage counters', () => {
  const [babelJest, options] = transform[compilerPattern];
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createTransformer } = require(babelJest) as {
    createTransformer: (options: BabelOptions) => {
      process: (source: string, file: string, jestOptions: object) => { code: string };
    };
  };
  const { code } = createTransformer(options).process(readFileSync(ghostArt, 'utf8'), ghostArt, {
    config: { cwd: root, rootDir: root },
    configString: '',
    instrument: true,
  });
  expect(code).toContain('__coverage__');
  expect(memoCaches(code)).toBe(2);
});
