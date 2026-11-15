const { AndroidConfig, withAndroidManifest, withMainActivity } = require('expo/config-plugins');

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
 * and adds each flag once, so it is safe to run twice. A manifest with no `.MainActivity`
 * fails the prebuild (as `withCast` does for its application): skipping it would bring the
 * restarts back with nothing to say so.
 *
 * Handling the change itself has one gap in React Native (0.88): it re-lays out the text
 * for the new scale (`ReactHostImpl.onConfigurationChanged`), but its DeviceInfo module
 * re-reads `fontScale` only in `onHostResume`, so JS (`Dimensions`, `useFontScale`) heard
 * of a change made with the app in front (a quick-settings tile, split screen, adb) only
 * at the next resume, and laid out for the old size meanwhile. The main activity's
 * `onConfigurationChanged` therefore asks DeviceInfo to re-read it then (its
 * `LifecycleEventListener.onHostResume`, which emits `didUpdateDimensions` when the font
 * scale changed; a display size change alone reaches JS through the root view's next
 * layout, as before).
 */

/** The flags this plugin makes sure the main activity handles. */
const CONFIG_CHANGES = ['fontScale', 'density'];

/** `manifest` with `.MainActivity`'s `android:configChanges` holding `CONFIG_CHANGES`. */
function addConfigChanges(manifest) {
  const main = AndroidConfig.Manifest.getMainActivityOrThrow(manifest);
  const have = (main.$['android:configChanges'] ?? '').split('|').filter(Boolean);
  for (const flag of CONFIG_CHANGES) if (!have.includes(flag)) have.push(flag);
  main.$['android:configChanges'] = have.join('|');
  return manifest;
}

/** What MainActivity.kt imports for `FORWARD`. */
const IMPORTS = [
  'android.content.res.Configuration',
  'com.facebook.react.ReactApplication',
  'com.facebook.react.bridge.LifecycleEventListener',
];

/** Marks the method, so a second run leaves it alone. */
const MARKER = '// @audiosilo-font-scale-changes';

/** The main activity's override (see the module doc). */
const FORWARD = `  ${MARKER}
  // fe#267: React Native re-lays out the text for a new font scale but tells JS (Dimensions)
  // only on the next resume, so ask its DeviceInfo now (plugins/withFontScaleChanges.js).
  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    val context = (application as ReactApplication).reactHost?.currentReactContext
    (context?.getNativeModule("DeviceInfo") as? LifecycleEventListener)?.onHostResume()
  }
`;

/** `src` (MainActivity.kt) with `FORWARD` and its imports, once. Throws on a main activity
 * it cannot place it in (a template change), rather than leave JS without the change. */
function addConfigurationForward(src) {
  if (src.includes(MARKER)) return src;
  if (/override fun onConfigurationChanged\(/.test(src)) {
    throw new Error(
      'withFontScaleChanges: MainActivity.kt already overrides onConfigurationChanged - merge the DeviceInfo call into it',
    );
  }
  const cls = /^class MainActivity\s*:\s*ReactActivity\(\)\s*\{\n/m;
  const pkg = /^package [^\n]+\n/m;
  if (!cls.test(src) || !pkg.test(src)) {
    throw new Error(
      'withFontScaleChanges: no `class MainActivity : ReactActivity()` in MainActivity.kt',
    );
  }
  return AndroidConfig.CodeMod.addImports(src, IMPORTS, false).replace(
    cls,
    (m) => `${m}${FORWARD}\n`,
  );
}

const withFontScaleChanges = (config) =>
  withMainActivity(
    withAndroidManifest(config, (cfg) => {
      cfg.modResults = addConfigChanges(cfg.modResults);
      return cfg;
    }),
    (cfg) => {
      if (cfg.modResults.language !== 'kt') {
        throw new Error('withFontScaleChanges: MainActivity is not Kotlin');
      }
      cfg.modResults.contents = addConfigurationForward(cfg.modResults.contents);
      return cfg;
    },
  );

module.exports = withFontScaleChanges;
module.exports.addConfigChanges = addConfigChanges;
module.exports.addConfigurationForward = addConfigurationForward;
