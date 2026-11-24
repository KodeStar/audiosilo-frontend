/** Whether `code` is the React Compiler's output: it opens a memo cache. */
export function compiledByCompiler(code: string): boolean {
  return /compilerRuntime\.c\)\(\d+\)/.test(code);
}

/**
 * Whether the React Compiler built `fn` (Jest builds the app's code with it, as the app
 * ships): its body opens with the compiler's memo cache. The compiler skips a component or
 * hook it can't build (a condition inside a `try`, say) without a word, so a test that
 * guards what it memoises asserts this of its subject first: otherwise the guard passes
 * whatever the code does.
 */
export function builtByCompiler(fn: (...args: never[]) => unknown): boolean {
  return compiledByCompiler(String(fn));
}
