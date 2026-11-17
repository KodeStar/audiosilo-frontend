import { transformFileSync } from '@babel/core';

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
  const out = transformFileSync(file, { caller });
  if (!out?.code?.includes('react/compiler-runtime')) {
    throw new Error(`the React Compiler left ${file} as it was`);
  }
  const mod = { exports: {} as T };
  new Function('require', 'module', 'exports', out.code)(load, mod, mod.exports);
  return mod.exports;
}
