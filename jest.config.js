// Jest config for the Expo SDK 56 app. The jest-expo preset (jest 29 runtime)
// resolves and transforms React Native / Expo modules; jest.setup.ts installs
// in-memory mocks for the native storage modules. Run with `npm test`.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/assets/(.*)$': '<rootDir>/assets/$1',
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // jest-expo excludes node_modules from transform; re-include the ESM packages
  // this app imports so they're transpiled rather than failing on `import`.
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|@react-navigation/.*|react-native-.*|nativewind|react-native-css-interop|@tanstack/.*|zustand))',
  ],
  collectCoverageFrom: ['src/**/*.{ts,tsx}', '!src/**/*.d.ts', '!src/app/**'],
  testMatch: ['**/*.test.ts', '**/*.test.tsx'],
};
