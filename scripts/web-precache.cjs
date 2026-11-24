// Emit sw.js alongside the Metro bundles. Expo writes serializer artifacts after copying
// public/, including for a plain "expo export" and a caller-supplied output directory.
'use strict';

const { createHash } = require('node:crypto');
const { readFileSync } = require('node:fs');
const path = require('node:path');

function buildWorker(artifacts, assets) {
  const start = [];
  const routes = [];
  const catalogs = {};
  for (const { type, filename, originFilename, metadata } of artifacts) {
    if (type !== 'js' && type !== 'css') continue;
    const catalog =
      metadata.isAsync && /^src\/i18n\/locales\/([a-z-]+)\.json$/.exec(originFilename);
    if (catalog) catalogs[catalog[1]] = filename;
    else if (metadata.isAsync) routes.push(filename);
    else start.push(filename);
  }
  // Expo's web asset names already contain the content hash. Its httpServerLocation
  // includes the deployment base before /assets/; the worker resolves from its own scope.
  const fonts = assets
    .filter((a) => /^(ttf|otf|woff2?)$/.test(a.type))
    .map((a) => {
      const dir = a.httpServerLocation.slice(a.httpServerLocation.indexOf('/assets/') + 1);
      if (!dir.startsWith('assets/')) throw new Error('Unexpected exported font path: ' + dir);
      return dir + '/' + a.name + '.' + a.type;
    });
  const manifest = { start: start.sort(), routes: routes.sort(), catalogs, fonts: fonts.sort() };
  const id = createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 20);
  const source = readFileSync(path.join(__dirname, '../public/sw.js'), 'utf8');
  return {
    filename: 'sw.js',
    originFilename: 'public/sw.js',
    type: 'js',
    // A worker has no route entry point, so Expo never adds it to the page's script tags.
    metadata: { isAsync: true, modulePaths: [] },
    source: source.replace('/* precache manifest */ null', () =>
      JSON.stringify({ id, ...manifest }),
    ),
  };
}

module.exports = { buildWorker };
