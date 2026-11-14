const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Android: the main activity handles a font size or display size change itself (fe#267)
 * instead of being destroyed and recreated. Expo's template lists `keyboard`,
 * `orientation`, `screenSize`, `uiMode` and the rest, but not `fontScale` or `density`, so
 * changing the text size or display size in the system settings restarted the activity:
 * the app came back on the connect screen re-running a pairing link it had already used,
 * or on Home with the mini player gone. With both listed, React Native gets the new
 * configuration (its dimensions change, `fontScale` included) and re-lays out the same
 * screen.
 *
 * Merges with whatever the template (or another plugin) already lists, keeps the order,
 * and adds each flag once, so it is safe to run twice.
 */

/** The flags this plugin makes sure the main activity handles. */
const CONFIG_CHANGES = ['fontScale', 'density'];

/** `manifest` with `.MainActivity`'s `android:configChanges` holding `CONFIG_CHANGES`. */
function addConfigChanges(manifest) {
  const app = manifest.manifest.application?.[0];
  const main = app?.activity?.find((a) => a.$['android:name'] === '.MainActivity');
  if (!main) return manifest;
  const have = (main.$['android:configChanges'] ?? '').split('|').filter(Boolean);
  for (const flag of CONFIG_CHANGES) if (!have.includes(flag)) have.push(flag);
  main.$['android:configChanges'] = have.join('|');
  return manifest;
}

const withFontScaleChanges = (config) =>
  withAndroidManifest(config, (cfg) => {
    cfg.modResults = addConfigChanges(cfg.modResults);
    return cfg;
  });

module.exports = withFontScaleChanges;
module.exports.CONFIG_CHANGES = CONFIG_CHANGES;
module.exports.addConfigChanges = addConfigChanges;
