// Flat ESLint config (ESLint 9). Extends Expo's React-Native/React/import rules,
// disables formatting rules that conflict with Prettier, and teaches the linter
// about Jest globals in test files. Run with `npm run lint` (= `expo lint`).
const expoConfig = require('eslint-config-expo/flat');
const prettier = require('eslint-config-prettier/flat');
const i18next = require('eslint-plugin-i18next');

module.exports = [
  ...expoConfig,
  prettier,
  {
    // i18n regression guard: flag untranslated literal text in JSX so new screens
    // can't ship hardcoded English. `jsx-text-only` catches visible
    // `<Text>literal</Text>` content without false-positiving on
    // className/variant/icon-name/testID attributes. App screens only; tests, the
    // i18n catalogs and the static pre-render web shell are exempt.
    files: ['src/**/*.tsx'],
    ignores: ['**/*.test.tsx', 'src/app/+html.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': ['error', { mode: 'jsx-text-only' }],
    },
  },
  {
    // Uniwind only resolves `className` on React Native's own components; this
    // third-party one drops its classes on native unless wrapped (see the wrapper).
    files: ['**/*.ts', '**/*.tsx'],
    ignores: ['src/components/ui/safe-area-view.tsx'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'react-native-safe-area-context',
              importNames: ['SafeAreaView'],
              message:
                "Import SafeAreaView from '@/components/ui/safe-area-view' (it resolves className; this one drops it on native).",
            },
          ],
        },
      ],
    },
  },
  {
    // Build output, native projects, generated types and root tooling configs
    // aren't app source - keep them out of linting.
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
      'src/uniwind-types.d.ts',
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
