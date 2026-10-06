const { getDefaultConfig } = require('expo/metro-config');
const { withUniwindConfig } = require('uniwind/metro');

const uniwindOptions = require('./uniwind.config');

const config = getDefaultConfig(__dirname);

// Uniwind (Tailwind v4) must be the outermost Metro wrapper.
module.exports = withUniwindConfig(config, uniwindOptions);
