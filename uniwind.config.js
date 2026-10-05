/**
 * The Uniwind options, in one place: Metro passes them to `withUniwindConfig`
 * (metro.config.js), and the style guard (scripts/check-styles.cjs) compiles with the
 * very same object, so the guard can never test a stale copy of the config.
 */
module.exports = {
  // Relative to the project root (Uniwind rejects absolute paths). Tailwind scans
  // for classNames from this file's directory, i.e. all of src/.
  cssEntryFile: './src/global.css',
  // Generated className/theme typings, checked in so `tsc` passes without Metro.
  dtsFile: './src/uniwind-types.d.ts',
  // Native only: keep NativeWind's 14px rem so native layouts don't grow. Web keeps
  // real CSS rems against the browser's 16px root, exactly as NativeWind did.
  polyfills: { rem: 14 },
};
