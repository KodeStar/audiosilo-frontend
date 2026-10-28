const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const uniwindOptions = require('./uniwind.config');
const { withWebStartChunks } = require('./scripts/web-start-chunks.cjs');

// The web export's start scripts compiled off the main thread (a compile hint, the big ones
// in parts): see scripts/web-start-chunks.cjs. Web export only.
const config = withWebStartChunks(getDefaultConfig(__dirname));

// Uniwind (Tailwind v4) must be the outermost Metro wrapper.
module.exports = withUniwindConfig(config, uniwindOptions);
