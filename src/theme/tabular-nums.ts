/**
 * Tabular (monospaced) numerals for `style=` on native/`<Text>` - locks figures to
 * a fixed advance so a value doesn't jitter as its digit count changes (clocks,
 * durations, counts). Import it from here (`@/theme/tokens` is generated and only holds
 * `colors`). Prefer it over `className="tabular-nums"`: on iOS/Android Uniwind turns
 * that class into a `fontVariant` list padded with empty entries, which React Native
 * logs as "Unsupported FontVariant value" on every render.
 */
export const tabularNums = { fontVariant: ['tabular-nums' as const] };
