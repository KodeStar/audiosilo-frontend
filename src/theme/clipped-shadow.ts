import type { ViewStyle } from 'react-native';

/**
 * The inline legacy shadow a clipping (`overflow-hidden`) cover frame needs, or
 * undefined. `lightOnly` mirrors a `dark:shadow-none` on the frame. Both platform files
 * implement this one type, so `tsc` (which resolves the import to this file) also checks
 * clipped-shadow.ios.ts against it.
 */
export type UseClippedShadow = (size: 'xs' | 'lg', lightOnly: boolean) => ViewStyle | undefined;

/** iOS only (`clipped-shadow.ios.ts`; see the native-shadow notes in src/global.css). */
export const useClippedShadow: UseClippedShadow = () => undefined;
