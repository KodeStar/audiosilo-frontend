#!/usr/bin/env node
// The server's wire goldens (audiosilo-server internal/api/testdata/wire/, one
// JSON shape per player envelope) copied into src/api/__wire__/, where
// src/api/wire-parity.test.ts checks each against its type in src/api/types.ts.
// The copy is committed so the parity test runs offline and the same on every
// machine; src/api/__wire__/source.json pins the server commit it came from.
//
//   node scripts/wire-sync.mjs [--server <dir>] [--ref <rev>]
//       fetch origin in the server checkout <dir> (default ../audiosilo-server),
//       then copy and pin the goldens at <rev> (default origin/main)
//   node scripts/wire-sync.mjs --check [--server <dir>]
//       fail when the copy differs from the pinned commit's goldens (compared
//       by git blob id), read from the checkout when --server is given, else
//       from GitHub (CI). Warn when main has at least 50 commits beyond the pin.
//
// npm run wire:sync / npm run wire:check run them.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'api', '__wire__');
const GOLDENS = 'internal/api/testdata/wire';
const REPO = 'KodeStar/audiosilo-server';
const WARN_BEHIND = 50;

// Inside a git hook or `git rebase --exec`, git's own variables name the caller's
// repository and win over -C. They are dropped, or every call here would read
// (and the test's throwaway commits would land in) that repository, not dir.
const GIT_LOCAL = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX',
];

/** Runs git in dir and returns its output. */
export function git(dir, ...args) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !GIT_LOCAL.includes(k)),
  );
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 16 << 20, env });
}

/** The goldens' git blob ids at ref in a server checkout: { 'name.json': id }. */
export function idsInCheckout(dir, ref) {
  // One `<mode> <type> <id>\t<name>` line per entry.
  const ids = Object.fromEntries(
    [
      ...git(dir, 'ls-tree', `${ref}:${GOLDENS}`).matchAll(/^\d+ blob ([0-9a-f]+)\t(.+\.json)$/gm),
    ].map(([, id, name]) => [name, id]),
  );
  if (Object.keys(ids).length === 0) throw new Error(`no goldens at ${ref}:${GOLDENS} in ${dir}`);
  return ids;
}

/** The goldens at ref in a server checkout: { 'name.json': text }. */
function fromCheckout(dir, ref) {
  return Object.fromEntries(
    Object.keys(idsInCheckout(dir, ref)).map((n) => [
      n,
      git(dir, 'show', `${ref}:${GOLDENS}/${n}`),
    ]),
  );
}

async function github(endpoint, what) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'audiosilo-wire-check' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  let r;
  try {
    r = await fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (r.ok) return await r.json();
  } catch (e) {
    throw new Error(`${what}: ${e.message}`, { cause: e });
  }
  const limited =
    r.status === 429 || (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0');
  const hint = limited ? ' (GitHub rate limit: set GITHUB_TOKEN, or pass --server <checkout>)' : '';
  throw new Error(`${what}: HTTP ${r.status}${hint}`);
}

/** The directory listing contains one blob id per golden. */
async function idsOnGitHub(sha) {
  const list = await github(`contents/${GOLDENS}?ref=${sha}`, `listing ${GOLDENS} at ${sha}`);
  return Object.fromEntries(
    list.filter((e) => e.type === 'file' && e.name.endsWith('.json')).map((e) => [e.name, e.sha]),
  );
}

/** The golden file names in out (source.json is the pin, not a golden). */
function goldenNames(out) {
  return readdirSync(out).filter((n) => n.endsWith('.json') && n !== 'source.json');
}

/** A file's git blob id, what `git hash-object` prints: equal ids are equal bytes. */
function blobId(file) {
  const bytes = readFileSync(file);
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** How the copy in out differs from want (the pinned commit's goldens, by blob id). */
export function compareCopy(want, out) {
  const have = Object.fromEntries(goldenNames(out).map((n) => [n, blobId(path.join(out, n))]));
  const problems = [];
  for (const [n, id] of Object.entries(want)) {
    if (!(n in have)) problems.push(`missing ${n}`);
    else if (have[n] !== id) problems.push(`differs ${n}`);
  }
  for (const n of Object.keys(have)) if (!(n in want)) problems.push(`not on the server ${n}`);
  return problems.sort();
}

/** The pinned commit in out's source.json. */
export function pinnedRef(out) {
  return JSON.parse(readFileSync(path.join(out, 'source.json'), 'utf8')).ref;
}

/** Number of commits on main absent from the pin, including when the pin is on a review branch. */
export async function freshnessWarning(ref, server) {
  const behind = server
    ? Number(git(server, 'rev-list', '--count', `${ref}..origin/main`).trim())
    : (await github(`compare/${ref}...main?per_page=1`, `comparing ${ref} to main`)).ahead_by;
  if (!Number.isSafeInteger(behind) || behind < 0) throw new Error('invalid server commit count');
  if (behind >= WARN_BEHIND)
    return `Wire pin ${ref} is ${behind} commits behind server main. Run npm run wire:sync and review the goldens.`;
}

/** Copies the goldens at rev of the server checkout into out and pins the commit. */
export function sync(server, rev, out) {
  git(server, 'fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main');
  const sha = git(server, 'rev-parse', `${rev}^{commit}`).trim();
  const goldens = fromCheckout(server, sha);
  mkdirSync(out, { recursive: true });
  for (const n of goldenNames(out)) if (!(n in goldens)) rmSync(path.join(out, n));
  for (const [n, text] of Object.entries(goldens)) writeFileSync(path.join(out, n), text);
  writeFileSync(
    path.join(out, 'source.json'),
    JSON.stringify({ repo: REPO, ref: sha }, null, 2) + '\n',
  );
  return { sha, count: Object.keys(goldens).length };
}

async function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    if (i === -1) return undefined;
    const value = process.argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    return value;
  };
  const server = arg('--server');
  if (!process.argv.includes('--check')) {
    const dir = server ?? path.resolve(ROOT, '..', 'audiosilo-server');
    if (!existsSync(dir)) {
      throw new Error(`no server checkout at ${dir}: pass --server <dir>`);
    }
    const { sha, count } = sync(dir, arg('--ref') ?? 'origin/main', OUT);
    console.log(`copied ${count} goldens from ${REPO}@${sha}`);
    return;
  }
  const ref = pinnedRef(OUT);
  const want = server ? idsInCheckout(server, ref) : await idsOnGitHub(ref);
  const problems = compareCopy(want, OUT);
  if (problems.length > 0) {
    console.error(`src/api/__wire__ does not match ${REPO}@${ref}:\n  ${problems.join('\n  ')}`);
    console.error('Run npm run wire:sync (it re-pins source.json), then the parity test.');
    process.exit(1);
  }
  console.log(`src/api/__wire__ matches ${REPO}@${ref} (${Object.keys(want).length} goldens)`);
  const warning = await freshnessWarning(ref, server);
  if (warning)
    console.warn(process.env.GITHUB_ACTIONS ? `::warning::${warning}` : `Warning: ${warning}`);
}

// Run only as a script, not when the test imports the helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
