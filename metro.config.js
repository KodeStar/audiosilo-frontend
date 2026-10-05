const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const config = getDefaultConfig(__dirname);

// Uniwind (Tailwind v4) must be the outermost Metro wrapper.
module.exports = withUniwindConfig(config, {
  // Relative to the project root (Uniwind rejects absolute paths). Tailwind scans
  // for classNames from this file's directory, i.e. all of src/.
  cssEntryFile: './src/global.css',
  // Generated className/theme typings, checked in so `tsc` passes without Metro.
  dtsFile: './src/uniwind-types.d.ts',
  // Native only: keep NativeWind's 14px rem so native layouts don't grow. Web keeps
  // real CSS rems against the browser's 16px root, exactly as NativeWind did.
  polyfills: { rem: 14 },
});
