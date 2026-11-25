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
// 3. Themed colour tokens. The Stacks semantic colours are Uniwind theme variables
//    (`@variant light` / `@variant dark` in the generated region of global.css), which
//    only become utilities through the `@theme` block Uniwind writes into its own CSS
//    artifact. This asserts `bg-background` exists and resolves to each theme's value
//    on iOS (also through an opacity modifier, `bg-brand/10`), and that the web CSS
//    switches it under `.dark`.
// 4. Large text on the web (fe#267). px text does not follow the browser's font size, rem
//    does, so every `text-[Npx]` / `leading-[Npx]` carries a `web:` twin in rem (N/16) with
//    the same variants (`lg:text-[17px] web:lg:text-[1.0625rem]`). This asserts the twin
//    wins on the web (its rule comes after the px rule, and `web:lg:` after `lg:`), that iOS
//    has no rule for it (native text scales with fontScale already), and that no source
//    line has a px size without its twin (the art drawn to a fixed box is exempt: covers,
//    the A-Z rail, the connect cascade).
// 5. Display titles on the web (fe#305). Every `text-display-N` / `leading-display-N` the
//    source uses is N on iOS (none for a `web:` one) and N times the capped unit Text
//    supplies (`--display-px`) on the web; a named size on a display title uses the unit.
//
// It runs the same steps Uniwind's Metro transformer runs (`generateArtifacts`, then
// `compileCSS`, read out of the installed transformer because Uniwind doesn't export
// it). If a Uniwind upgrade renames them, this fails loudly - update the hook below,
// don't delete the guard.

const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
process.chdir(root); // Uniwind resolves cssEntryFile against the cwd.

function loadUniwindCompiler() {
  const file = require.resolve('uniwind/metro').replace(/index\.cjs$/, 'transformer.cjs');
  const src = fs.readFileSync(file, 'utf8');
  if (
    !/\bconst compileCSS = /.test(src) ||
    !/\bconst config = require\(/.test(src) ||
    !/\bconst cssArtifactPath = /.test(src)
  ) {
    throw new Error(
      `check-styles: ${file} no longer defines compileCSS/config/cssArtifactPath - update this script`,
    );
  }
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(`${src}\nmodule.exports.__probe = { compileCSS, config, cssArtifactPath };`, file);
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

/** One pass over the source: the lines with a px text size or line height and no `web:`
 * rem twin (guard 4), and every `text-display-N` / `leading-display-N` with its variants
 * (guard 5). */
function scanSource() {
  const exempt = new Set([
    'src/components/ui/cover.tsx',
    'src/components/library/books/az-rail.tsx',
    'src/components/connect/cover-cascade.tsx',
  ]);
  const px = /(^|[\s"'`{])((?:[a-z0-9-]+:)*)(text|leading)-\[([0-9.]+)px\](?![\w\]-])/g;
  const display = /(?:^|[\s"'`{])((?:[a-z0-9-]+:)*(?:text|leading)-display-\d+)(?![\w-])/g;
  const found = [];
  const displayClasses = new Set();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name)) {
        const rel = path.relative(root, p);
        if (exempt.has(rel)) continue;
        fs.readFileSync(p, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            for (const [, cls] of line.matchAll(display)) displayClasses.add(cls);
            for (const [, , variants, kind, n] of line.matchAll(px)) {
              if (variants.split(':').includes('web')) continue;
              // The twin is N/16 rem exactly (any other value would change the size at the
              // browser's default), or a capped one (`[length:min(...rem,...px)]`) where the
              // slot cannot grow.
              const twin = `web:${variants}${kind}-[${+(Number(n) / 16).toFixed(5)}rem]`;
              if (!line.includes(twin) && !line.includes(`web:${variants}${kind}-[length:`))
                found.push(`${rel}:${i + 1} ${variants}${kind}-[${n}px] (add ${twin})`);
            }
          });
      }
    }
  };
  walk(path.join(root, 'src'));
  return { untwinned: found, displayClasses };
}
const { untwinned, displayClasses } = scanSource();

const failures = [];
const check = (ok, message) => ok || failures.push(message);

(async () => {
  const { compileCSS, config, cssArtifactPath } = loadUniwindCompiler();
  // The options metro.config.js passes, from the same module (dtsFile included:
  // generating artifacts rewrites it).
  const uniwind = require(path.join(root, 'uniwind.config.js'));
  const bundler = (platform) => config.UniwindBundlerConfig.fromMetroConfig(uniwind, platform);
  // Uniwind's CSS artifact (its variants + the @theme block for theme variables), as the
  // Metro transformer refreshes it before every compile.
  await bundler(config.Platform.Web).generateArtifacts(cssArtifactPath);

  // 1. web: a dark: utility the app uses must have an unscoped rule.
  const webCss = await compileCSS(bundler(config.Platform.Web));
  const darkClass = '.dark\\:border-border';
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

  // 3. themed tokens: iOS resolves each theme's value (scoped theme vars over the base),
  // web overrides the variable under `.dark`.
  const tokens = require(path.join(root, 'src/theme/tokens.json')).themes;
  for (const theme of ['light', 'dark']) {
    const themed = { ...vars, ...scopedVars[`${config.UNIWIND_THEME_VARIABLES}${theme}`] };
    const bg = entry('bg-background', 'backgroundColor')?.(themed);
    check(
      bg === tokens[theme].background,
      `ios ${theme}: bg-background is ${bg}, expected ${tokens[theme].background} (themed tokens, see the generated region of src/global.css)`,
    );
    const mixes = [];
    const mixRt = { colorMix: (c, pct) => mixes.push([c, pct]) };
    const tinted = new Function('rt', `return ${nativeCode}`)(mixRt).stylesheet['bg-brand/10'];
    for (const s of tinted ?? []) s.entries.forEach(([, f]) => f(themed));
    check(
      mixes.some(([c, pct]) => c === tokens[theme].brand && pct === '10%'),
      `ios ${theme}: bg-brand/10 does not mix the ${theme} brand colour`,
    );
  }
  check(
    new RegExp(`\\.dark\\s*\\{[^}]*--color-background:\\s*${tokens.dark.background}`).test(
      webCss,
    ) && /\.bg-background\s*\{\s*background-color:\s*var\(--color-background\)/.test(webCss),
    'web: bg-background is not a themed variable switched under .dark',
  );

  // 4. web twins of px text sizes.
  const pos = (cls) => webCss.indexOf(`.${cls.replace(/[[\]:.]/g, '\\$&')} {`);
  for (const [px, twin] of [
    ['text-[13px]', 'web:text-[0.8125rem]'],
    ['lg:text-[17px]', 'web:lg:text-[1.0625rem]'],
  ]) {
    check(pos(twin) !== -1, `web: no rule for ${twin}`);
    check(pos(twin) > pos(px), `web: ${twin} comes before ${px}, so the px size wins`);
  }
  check(
    stylesheet['web:text-[0.8125rem]'] === undefined &&
      entry('text-[13px]', 'fontSize')?.(vars) === 13,
    'ios: web:text-[0.8125rem] has a native rule, or text-[13px] is no longer 13',
  );
  check(
    untwinned.length === 0,
    `px text without its web: rem twin (fe#267):\n  ${untwinned.join('\n  ')}`,
  );

  // A display size uses native pixels and the web unit supplied by Text. Every one the
  // source uses, size and leading, must survive the actual Metro transform, including md:.
  // A `web:` one (beside a rem class for native) has no native rule at all.
  check(displayClasses.size > 0, 'no text-display-N class found in src: update this guard');
  for (const cls of displayClasses) {
    const [, variants, kind, n] = /^((?:[a-z0-9-]+:)*)(text|leading)-display-(\d+)$/.exec(cls);
    const [cssProp, nativeProp] =
      kind === 'text' ? ['font-size', 'fontSize'] : ['line-height', 'lineHeight'];
    const size = Number(n);
    const start = webCss.lastIndexOf(`.${cls.replace(/:/g, '\\:')} {`);
    const rule = webCss.slice(start, webCss.indexOf('}', start));
    check(
      start >= 0 && rule.includes(`${cssProp}: calc(${size} * var(--display-px, `),
      `web: ${cls} does not follow the capped display unit`,
    );
    // Like `leading-[Npx]`, a display leading sets --tw-leading, so a named size after it
    // (a breakpoint's `md:text-lg`) keeps it instead of the size's own line height.
    check(
      kind === 'text' || rule.includes(`--tw-leading: calc(${size} * var(--display-px, `),
      `web: ${cls} does not set --tw-leading, so a later named size replaces its line height`,
    );
    if (variants.split(':').includes('web')) {
      check(stylesheet[cls] === undefined, `ios: ${cls} has a native rule`);
    } else {
      check(entry(cls, nativeProp)?.(vars) === size, `ios: ${cls} is no longer ${size}`);
    }
  }

  // The named title sizes share Tailwind's default metrics. Check the named
  // steps in this build against the real theme so an upgrade cannot resize one.
  for (const [name, [rem]] of Object.entries(require('tailwindcss/defaultTheme').fontSize)) {
    if (pos(`text-${name}`) === -1) continue;
    const step = `--display-step-${name}`;
    check(
      webCss.includes(`${step}: ${parseFloat(rem) * 16};`) &&
        webCss.includes(`.text-${name}:where(.display-title)`) &&
        webCss.includes(`font-size: calc(var(${step}) * var(--display-px))`),
      `web: text-${name} does not retain the role's default size and cap`,
    );
  }

  if (failures.length) {
    console.error(`Style guards failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
