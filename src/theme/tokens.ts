/**
 * Raw color values, mirroring the NativeWind/Tailwind theme, for the places that
 * need an actual color string rather than a className: status bar, native
 * component props (ActivityIndicator, TextInput placeholders), react-native-svg
 * fills, navigation theme, etc. Ported from the old client's design.
 */
export const colors = {
  primary: '#db2777', // pink-600
  blue: '#3b82f6', // blue-500 — chapters/files (distinct from pink folders)
  white: '#ffffff',
  light: {
    bg: '#e5e7eb', // gray-200
    surface: '#ffffff',
    surfaceAlt: '#f3f4f6', // gray-100
    text: '#4b5563', // gray-600
    textStrong: '#374151', // gray-700
    textMuted: '#6b7280', // gray-500
    border: '#f3f4f6', // gray-100
  },
  dark: {
    bg: '#1f2937', // gray-800
    surface: '#1a2331', // gray-840
    surfaceAlt: '#161f2c', // gray-860
    text: '#9ca3af', // gray-400
    textStrong: '#e5e7eb', // gray-200
    textMuted: '#6b7280', // gray-500
    border: '#2c3340', // gray-750
  },
} as const;

export type ColorScheme = 'light' | 'dark';
