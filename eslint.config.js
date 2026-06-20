// Flat ESLint config (ESLint 9). Extends Expo's React-Native/React/import rules,
// disables formatting rules that conflict with Prettier, and teaches the linter
// about Jest globals in test files. Run with `npm run lint` (= `expo lint`).
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier/flat');

module.exports = [
  ...expoConfig,
  prettier,
  {
    // Build output, native projects, generated types and root tooling configs
    // aren't app source — keep them out of linting.
    ignores: [
      'dist/',
      '.expo/',
      'android/',
      'ios/',
      'public/',
      'scripts/',
      '*.config.js',
      'expo-env.d.ts',
      'expo-globals.d.ts',
      'nativewind-env.d.ts',
    ],
  },
  {
    // Jest globals for the test suite + setup file.
    files: ['**/*.test.ts', '**/*.test.tsx', 'jest.setup.ts'],
    languageOptions: {
      globals: {
        jest: 'readonly',
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
      },
    },
  },
];
