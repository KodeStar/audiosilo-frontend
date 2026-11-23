// Jest config for the Expo SDK 58 app. The jest-expo preset (jest 30 runtime)
// resolves and transforms React Native / Expo modules; jest.setup.ts installs
// in-memory mocks for the native storage modules. Run with `npm test`.
const path = require('path');

const [babelJest, babelOptions] = require('jest-expo/jest-preset').transform['\\.[jt]sx?$'];

// This checkout's `src/`, as the start of a transform pattern (a `src` folder above the
// checkout is not the app's).
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SRC = escapeRegExp(path.join(__dirname, 'src') + path.sep);
const SEP = escapeRegExp(path.sep);

module.exports = {
  preset: 'jest-expo',
  // gesture-handler's own mocks of its native module (gesture-handler 3 calls it on
  // every detector mount); the preset's setup files run first.
  setupFiles: ['react-native-gesture-handler/jestSetup.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // The app's own code is built as the app ships it: with the React Compiler on (`app.json`
  // `experiments.reactCompiler`, babel-preset-expo's `supportsReactCompiler` caller flag),
  // which memoises what a render computes against its inputs. The tests and their helpers
  // (`src/testing/`) are not the app's and stay as written; everything else takes the
  // preset's own transform.
  transform: {
    [`^${SRC}(?!testing${SEP})(?!.*\\.test\\.).*\\.[jt]sx?$`]: [
      babelJest,
      { ...babelOptions, caller: { ...babelOptions.caller, supportsReactCompiler: true } },
    ],
  },
  // jest-expo excludes node_modules from transform; re-include the ESM packages
  // this app imports so they're transpiled rather than failing on `import`.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|@rn-primitives/.*|@react-navigation/.*|react-native-.*|uniwind|@tanstack/.*|zustand|standard-navigation|@shopify/flash-list))',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/app/**'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
};
