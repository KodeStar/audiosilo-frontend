// node scripts/check-native-dupes.mjs
// Fails when a package that must exist ONCE in the app resolves to more than one installed
// copy. React Native's renderer is built against one exact react, and a native module (or
// expo-modules-core) nested under another package registers twice or links against the
// wrong copy: it can bundle, build and still crash on a device. `npx expo install --check`
// only reads the top-level versions, so a nested copy (a dependency's own range that npm
// could not dedupe) passes it. Run by CI after `npm ci`.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The packages that must resolve to a single installed copy. */
export const SINGLETONS = [
  'react',
  'react-dom',
  'react-native',
  'react-native-reanimated',
  'react-native-worklets',
  'react-native-screens',
  'react-native-safe-area-context',
  'react-native-svg',
  'react-native-gesture-handler',
  '@shopify/flash-list',
  'react-native-webview',
  'react-native-view-shot',
  'react-native-google-cast',
  '@react-native-async-storage/async-storage',
  'expo',
  '@expo/ui',
  'expo-modules-core',
];

/**
 * The singletons installed more than once, from `npm query` nodes (`{ name, version,
 * location }`), as `{ name, copies: [{ version, location }] }`, sorted by name.
 */
export function findDuplicates(nodes, names = SINGLETONS) {
  const wanted = new Set(names);
  const byName = new Map();
  for (const { name, version, location } of nodes) {
    if (!wanted.has(name)) continue;
    const copies = byName.get(name) ?? new Map();
    copies.set(location, { version, location });
    byName.set(name, copies);
  }
  return [...byName]
    .filter(([, copies]) => copies.size > 1)
    .map(([name, copies]) => ({ name, copies: [...copies.values()] }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const selector = `:is(${SINGLETONS.map((name) => `#${name}`).join(',')})`;
  const out = execFileSync('npm', ['query', selector], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const dupes = findDuplicates(JSON.parse(out));
  if (dupes.length === 0) {
    console.log(`check-native-dupes: ${SINGLETONS.length} packages, one copy each.`);
    return;
  }
  for (const { name, copies } of dupes) {
    console.error(`check-native-dupes: ${name} is installed ${copies.length} times:`);
    for (const { version, location } of copies) console.error(`  ${version}  ${location}`);
  }
  console.error(
    'Align the dependent package with the Expo SDK pin (`npx expo install --fix`) or add an ' +
      '`overrides` entry, so npm installs one copy.',
  );
  process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
