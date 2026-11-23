import { IdentityCard } from '@/components/account/identity-card';

// Jest builds the app's code as the app ships it, with the React Compiler on (the transform
// in jest.config.js): a component's body opens with the compiler's memo cache. Without it, a
// render read the compiler memoises (fe#280) would pass here and go stale in the app.
it('builds app components with the React Compiler', () => {
  expect(String(IdentityCard)).toMatch(/compilerRuntime\.c\)\(\d+\)/);
});

// The tests themselves are not the app's: built as written.
it('leaves the test files as written', () => {
  function Local() {
    return null;
  }
  expect(String(Local)).not.toMatch(/compilerRuntime/);
});
