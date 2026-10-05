// GENERATED FILE - DO NOT EDIT. Source: src/theme/tokens.json; regenerate with `npm run gen:tokens`.

/** Raw values for native props that need a colour string rather than a className (status bar, ActivityIndicator, TextInput placeholders, react-native-svg fills, navigation theme). The same palette backs the Tailwind classes (src/global.css). */
export const colors = {
  primary: '#db2777', // primary
  /** LEGACY: the loud blue that filled chapter/file tiles. The design refresh demotes it (books/chapters distinguish by icon + subtle tint, not a filled block); screens migrate off it in later tasks. Kept until then - still referenced by existing code. Prefer the semantic tokens below for new work. */
  blue: '#3b82f6', // blue-500
  /** Status colours for native props (icon fills, ActivityIndicator, svg). For text on light surfaces use the danger-600/700 classes. */
  danger: '#ef4444', // danger
  /** Downloaded/done indicators. */
  success: '#22c55e', // success
  white: '#ffffff', // white
  light: {
    bg: '#e5e7eb', // gray-200
    surface: '#ffffff', // white
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
