/**
 * Raw color values, mirroring the NativeWind/Tailwind theme, for the places that
 * need an actual color string rather than a className: status bar, native
 * component props (ActivityIndicator, TextInput placeholders), react-native-svg
 * fills, navigation theme, etc. Ported from the old client's design.
 */
export const colors = {
  primary: '#db2777', // pink-600
  // LEGACY: the loud blue that filled chapter/file tiles. The design refresh
  // demotes it (books/chapters distinguish by icon + subtle tint, not a filled
  // block); screens migrate off it in later tasks. Kept until then - still
  // referenced by existing code. Prefer the semantic tokens below for new work.
  blue: '#3b82f6', // blue-500
  // Semantic status colors, mirroring tailwind.config.js `danger`/`success` for
  // native props (icon fills, ActivityIndicator, svg) that need a raw string.
  danger: '#ef4444', // red-500 (DEFAULT) - see tailwind danger.600/700 for light-surface text
  success: '#22c55e', // green-500 (DEFAULT) - downloaded/done indicators
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

/**
 * Tabular (monospaced) numerals for `style=` on native/`<Text>` - locks figures to
 * a fixed advance so a value doesn't jitter as its digit count changes (clocks,
 * durations, counts). NativeWind screens can use `className="tabular-nums"` instead.
 */
export const tabularNums = { fontVariant: ['tabular-nums' as const] };
