const { withSettingsGradle } = require('expo/config-plugins');
const { mergeContents } = require('@expo/config-plugins/build/utils/generateCode');

/**
 * The Wear OS app (Track W4): wires `wear/` (the application module `:wear`) and `wear-core/`
 * (a pure Kotlin/JVM build, the Core boundary) into the Gradle build that `expo prebuild`
 * generates under `android/`. Both live at the repo root, outside `android/`, so
 * `prebuild --clean` never deletes them.
 *
 *  - `include ':wear'` with its projectDir at `../wear`, and `includeBuild('../wear-core')`
 *    (a composite build: `:wear` depends on `app.audiosilo:wear-core`, which Gradle
 *    substitutes with the included build's project). One generated block, so prebuild run
 *    twice holds one include.
 *  - Nothing in the root `build.gradle`: `wear/build.gradle` puts the Compose compiler plugin
 *    on its own buildscript classpath at the root's `kotlinVersion` (expo-modules-core does
 *    the same), and React Native's root plugin already makes every subproject evaluate after
 *    `:app` (so `:wear` can read the version code EAS set on `:app`).
 *  - `AUDIOSILO_NO_WEAR=1` skips the wiring: a `:wear` that fails to configure would
 *    otherwise break the phone's build too (RN's root plugin makes `:app:preBuild` depend on
 *    every subproject's `preBuild`).
 */
const TAG = 'audiosilo-wear-app';

const SETTINGS_BLOCK = [
  "include ':wear'",
  "project(':wear').projectDir = new File(rootDir, '../wear')",
  "includeBuild('../wear-core')",
].join('\n');

function addWearToSettings(contents) {
  return mergeContents({
    tag: TAG,
    src: contents,
    newSrc: SETTINGS_BLOCK,
    // After `include ':app'`, so `:app` stays the first project.
    anchor: /^include ':app'/m,
    offset: 1,
    comment: '//',
  }).contents;
}

const withWearApp = (config) => {
  if (process.env.AUDIOSILO_NO_WEAR === '1') return config;
  return withSettingsGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withWearApp: expected a Groovy settings.gradle');
    }
    cfg.modResults.contents = addWearToSettings(cfg.modResults.contents);
    return cfg;
  });
};

module.exports = withWearApp;
module.exports.addWearToSettings = addWearToSettings;
