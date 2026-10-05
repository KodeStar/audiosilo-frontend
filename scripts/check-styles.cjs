// Regression guards for src/global.css that only Uniwind's real compiler can show. Run
// by `npm test` (before jest, next to the colour-token check):
//   node scripts/check-styles.cjs
//
// 1. Web dark mode without CSS `@scope`. Uniwind wraps a `dark:` rule in
//    `@scope (.dark) to (.light)`, which browsers without @scope drop, and its other
//    branch is a `prefers-color-scheme` media query that never matches once `.dark`
//    is on <html>; our `@custom-variant dark` adds an unscoped `:where(.dark) &`
//    branch. This asserts a `dark:` utility still has a rule outside every `@scope`
//    and `prefers-color-scheme` block.
// 2. Native letter-spacing. NativeWind pinned px tracking on native; Tailwind v4's em
//    values would scale with the font size. This asserts `tracking-wider` resolves to
//    0.5 on an iOS `text-base` element.
//
// It runs the same compile step Uniwind's Metro transformer runs (`compileCSS`, read
// out of the installed transformer because Uniwind doesn't export it). If a Uniwind
// upgrade renames it, this fails loudly - update the hook below, don't delete the guard.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.chdir(root); // Uniwind resolves cssEntryFile against the cwd.

function loadUniwindCompiler() {
  const file = require.resolve('uniwind/metro').replace(/index\.cjs$/, 'transformer.cjs');
  const src = fs.readFileSync(file, 'utf8');
  if (!/\bconst compileCSS = /.test(src) || !/\bconst config = require\(/.test(src)) {
    throw new Error(
      `check-styles: ${file} no longer defines compileCSS/config - update this script`,
    );
  }
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(`${src}\nmodule.exports.__probe = { compileCSS, config };`, file);
  return mod.exports.__probe;
}

/** CSS text with every block whose prelude starts with `prelude` removed (balanced braces). */
function withoutBlocks(css, prelude) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf(prelude, i);
    if (at === -1) return out + css.slice(i);
    out += css.slice(i, at);
    let depth = 0;
    let j = css.indexOf('{', at);
    for (; j < css.length; j++) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}' && --depth === 0) break;
    }
    i = j + 1;
  }
  return out;
}

const failures = [];
const check = (ok, message) => ok || failures.push(message);

(async () => {
  const { compileCSS, config } = loadUniwindCompiler();
  const uniwind = { cssEntryFile: './src/global.css', polyfills: { rem: 14 } };
  const bundler = (platform) => config.UniwindBundlerConfig.fromMetroConfig(uniwind, platform);

  // 1. web: a dark: utility the app uses must have an unscoped rule.
  const webCss = await compileCSS(bundler(config.Platform.Web));
  const darkClass = '.dark\\:bg-gray-800';
  check(webCss.includes(darkClass), `web CSS has no ${darkClass} rule at all`);
  check(
    withoutBlocks(withoutBlocks(webCss, '@scope'), '@media (prefers-color-scheme').includes(
      darkClass,
    ),
    `web: no ${darkClass} rule outside @scope / prefers-color-scheme, so browsers without @scope lose dark mode (see @custom-variant dark in src/global.css)`,
  );

  // 2. iOS: resolve tracking-wider the way Uniwind's native store does (theme vars,
  // overlaid with the native and iOS platform vars).
  const nativeCode = await compileCSS(bundler(config.Platform.iOS));
  const rt = new Proxy({}, { get: () => () => 0 });
  // eslint-disable-next-line no-new-func
  const { vars, scopedVars, stylesheet } = new Function('rt', `return ${nativeCode}`)(rt);
  const P = config.UNIWIND_PLATFORM_VARIABLES;
  Object.assign(vars, scopedVars[`${P}native`], scopedVars[`${P}ios`]);
  const entry = (cls, prop) =>
    (stylesheet[cls] ?? []).flatMap((s) => s.entries).find(([p]) => p === prop)?.[1];
  const fontSize = entry('text-base', 'fontSize')?.(vars);
  const letterSpacing = entry(
    'tracking-wider',
    'letterSpacing',
  )?.({
    ...vars,
    '--uniwind-em': () => fontSize,
  });
  check(fontSize === 14, `ios: text-base fontSize is ${fontSize}, expected 14 (rem 14)`);
  check(
    letterSpacing === 0.5,
    `ios: tracking-wider letterSpacing is ${letterSpacing}, expected 0.5 (NativeWind's px value)`,
  );

  if (failures.length) {
    console.error(`Style guards failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
