import { transformFileSync } from '@babel/core';
import { dirname, resolve } from 'path';

/**
 * A source module as the app runs it: built by the repo's Babel config with the React
 * Compiler on (`app.json` `experiments.reactCompiler`), which Jest's own transform leaves
 * off. The compiler memoises what a render computes against its inputs, so a read that
 * only stays current because something else rendered again (a `getQueryData` at render)
 * passes under Jest and goes stale in the app; a test runs such code through this.
 *
 * `load` is the test file's own `require`: the module's imports resolve from its folder
 * when the test sits beside it, and they take the test file's `jest.mock`s.
 */
export function withReactCompiler<T>(load: NodeJS.Require, path: string): T {
  const file = load.resolve(path);
  // `supportsReactCompiler` is babel-preset-expo's caller flag, which Babel's types don't name.
  const caller = { name: 'react-compiler-test', supportsReactCompiler: true };
  // The repo's Babel config, wherever Jest was started from (babel-jest roots it the same way).
  const out = transformFileSync(file, { caller, root: resolve(__dirname, '../..') });
  if (!out?.code?.includes('react/compiler-runtime')) {
    throw new Error(`the React Compiler left ${file} as it was`);
  }
  const mod = { exports: {} as T };
  new Function('require', 'module', 'exports', '__filename', '__dirname', out.code)(
    load,
    mod,
    mod.exports,
    file,
    dirname(file),
  );
  return mod.exports;
}
