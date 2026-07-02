// Resolves the glyphs listed in manifest.mjs to raw SVG path data and writes the
// vendored, committed src/components/ui/icon-data.ts. This is the ONLY place that
// reads FontAwesome - the app itself never imports @fortawesome/*.
//
//   cd scripts/glyphs && npm install && npm run gen
//
// The npm install pulls the FontAwesome Pro packages from the private registry, so
// it needs your FA Pro token (see scripts/glyphs/README.md). Once icon-data.ts is
// regenerated and committed, building the app needs nothing from FontAwesome.

import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GLYPHS } from './manifest.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../../src/components/ui/icon-data.ts');

const PKG = {
  light: '@fortawesome/pro-light-svg-icons',
  regular: '@fortawesome/pro-regular-svg-icons',
  solid: '@fortawesome/pro-solid-svg-icons',
};

// A FontAwesome name needs quoting as an object key only when it isn't a bare
// identifier - matches Prettier's `quoteProps: "as-needed"` so the output passes
// `prettier --check` straight out of the generator.
const key = (name) => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`);

const entries = GLYPHS.map(([name, weight, faName]) => {
  const pkg = PKG[weight];
  if (!pkg) throw new Error(`${name}: unknown weight "${weight}"`);
  const def = require(`${pkg}/${faName}`)[faName];
  if (!def?.icon) throw new Error(`${name}: could not load ${faName} from ${pkg}`);
  const [width, height, , , path] = def.icon;
  if (Array.isArray(path)) {
    throw new Error(`${name}: ${faName} is a multi-path (duotone) icon - not supported`);
  }
  if (/['\\]/.test(path)) throw new Error(`${name}: ${faName} path needs escaping`);
  return (
    `  ${key(name)}: {\n` +
    `    width: ${width},\n` +
    `    height: ${height},\n` +
    `    path: '${path}',\n` +
    `  },`
  );
});

const file =
  `// AUTO-GENERATED - do not edit by hand.\n` +
  `// Source: FontAwesome Pro 7 glyphs listed in scripts/glyphs/manifest.mjs.\n` +
  `// Regenerate:  cd scripts/glyphs && npm install && npm run gen   (see scripts/glyphs/README.md)\n` +
  `//\n` +
  `// The app renders these paths with react-native-svg (src/components/ui/icon.tsx),\n` +
  `// so building AudioSilo needs no FontAwesome dependency or token.\n` +
  `\n` +
  `export const ICON_DATA = {\n` +
  `${entries.join('\n')}\n` +
  `} as const;\n` +
  `\n` +
  `export type IconName = keyof typeof ICON_DATA;\n`;

await writeFile(OUT, file);
console.log(`Wrote ${GLYPHS.length} glyphs → ${OUT}`);
