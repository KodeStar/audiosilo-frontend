import { SafeAreaView as RNSafeAreaView } from 'react-native-safe-area-context';
import { withUniwind } from 'uniwind';

/**
 * react-native-safe-area-context's `SafeAreaView`, with `className` support.
 *
 * Uniwind only resolves `className` on React Native's own components (its Metro
 * resolver swaps them for className-aware ones); this is a third-party native
 * component, so without the wrapper its classes are silently dropped on iOS/Android
 * (no `flex-1`, no background - the connect screen rendered on the navigator's
 * light default card). NativeWind wrapped this component for us; Uniwind needs it
 * done explicitly, once, here. Import this instead of the library's SafeAreaView
 * whenever you pass a `className`.
 */
export const SafeAreaView = withUniwind(RNSafeAreaView);
