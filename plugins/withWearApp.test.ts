/* eslint-disable @typescript-eslint/no-require-imports -- config plugins are CommonJS */
const withWearApp = require('./withWearApp');
const appJson = require('../app.json');
/* eslint-enable @typescript-eslint/no-require-imports */

// The shape `expo prebuild` writes for SDK 58 (android/settings.gradle, trimmed).
const SETTINGS = [
  'pluginManagement {',
  '  includeBuild("../node_modules/@react-native/gradle-plugin")',
  '}',
  "plugins { id('com.facebook.react.settings') }",
  "rootProject.name = 'AudioSilo'",
  '',
  "include ':app'",
  'includeBuild(expoAutolinking.reactNativeGradlePlugin)',
  '',
].join('\n');

describe('withWearApp', () => {
  const saved = process.env.AUDIOSILO_NO_WEAR;
  afterEach(() => {
    if (saved === undefined) delete process.env.AUDIOSILO_NO_WEAR;
    else process.env.AUDIOSILO_NO_WEAR = saved;
  });

  it('includes :wear from ../wear and the wear-core build, right after :app', () => {
    const out: string = withWearApp.addWearToSettings(SETTINGS);
    const lines = out.split('\n');
    const app = lines.indexOf("include ':app'");
    expect(lines[app + 2]).toBe("include ':wear'");
    expect(lines[app + 3]).toBe("project(':wear').projectDir = new File(rootDir, '../wear')");
    expect(lines[app + 4]).toBe("includeBuild('../wear-core')");
    // The rest of the file is untouched.
    expect(out).toContain('includeBuild(expoAutolinking.reactNativeGradlePlugin)');
    expect(out.indexOf("include ':app'")).toBeLessThan(out.indexOf("include ':wear'"));
  });

  it('is idempotent: prebuild run twice holds one include', () => {
    const once: string = withWearApp.addWearToSettings(SETTINGS);
    const twice: string = withWearApp.addWearToSettings(once);
    expect(twice).toBe(once);
    expect(twice.match(/include ':wear'/g)).toHaveLength(1);
    expect(twice.match(/includeBuild\('\.\.\/wear-core'\)/g)).toHaveLength(1);
  });

  it('adds a settings mod, and none with AUDIOSILO_NO_WEAR=1', () => {
    delete process.env.AUDIOSILO_NO_WEAR;
    const wired = withWearApp({ name: 'AudioSilo', slug: 'audiosilo' });
    expect(typeof wired.mods?.android?.settingsGradle).toBe('function');

    process.env.AUDIOSILO_NO_WEAR = '1';
    const skipped = withWearApp({ name: 'AudioSilo', slug: 'audiosilo' });
    expect(skipped.mods?.android?.settingsGradle).toBeUndefined();
  });

  it('runs after expo-build-properties in app.json', () => {
    const plugins: unknown[] = appJson.expo.plugins;
    const name = (p: unknown) => (Array.isArray(p) ? p[0] : p);
    const wear = plugins.findIndex((p) => name(p) === './plugins/withWearApp');
    const props = plugins.findIndex((p) => name(p) === 'expo-build-properties');
    expect(wear).toBeGreaterThan(-1);
    expect(props).toBeGreaterThan(-1);
    expect(wear).toBeGreaterThan(props);
  });
});
