// Committed counterpart to the auto-generated, git-ignored `expo-env.d.ts`.
//
// `expo-env.d.ts` is created by the Expo CLI and is in `.gitignore`, so it does
// not exist in a clean CI checkout (`npm ci` + `tsc`). It is what pulls in
// Expo's ambient module declarations — notably the CSS side-effect import in
// `src/theme/theme-provider.tsx` (`import '@/global.css'`, declared in
// `expo/types/global.d.ts`) and static-asset imports. Referencing `expo/types`
// from this committed file makes those declarations available everywhere, so
// `tsc --noEmit` passes in CI as well as locally. Locally it de-dupes harmlessly
// with the generated `expo-env.d.ts`.
/// <reference types="expo/types" />
