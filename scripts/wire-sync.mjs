#!/usr/bin/env node
// The server's wire goldens (audiosilo-server internal/api/testdata/wire/, one
// JSON shape per player envelope) copied into src/api/__wire__/, where
// src/api/wire-parity.test.ts checks each against its type in src/api/types.ts.
// The copy is committed so the parity test runs offline and the same on every
// machine; src/api/__wire__/source.json pins the server commit it came from.
//
//   node scripts/wire-sync.mjs [--server <dir>] [--ref <rev>]
//       copy the goldens at <rev> (default origin/main) of the server checkout
//       <dir> (default ../audiosilo-server) and pin that commit
//   node scripts/wire-sync.mjs --check [--server <dir>]
//       fail when the copy differs from the pinned commit's goldens, read from
//       the checkout when --server is given, else from GitHub (CI)
//
// npm run wire:sync / npm run wire:check run them.

import { execFileSync } from 'node:child_process';
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

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 16 << 20 });
}

/** The goldens at ref in a server checkout: { 'name.json': text }. */
export function fromCheckout(dir, ref) {
  const names = git(dir, 'ls-tree', '--name-only', `${ref}:${GOLDENS}`)
    .split('\n')
    .filter((n) => n.endsWith('.json'));
  if (names.length === 0) throw new Error(`no goldens at ${ref}:${GOLDENS} in ${dir}`);
  return Object.fromEntries(names.map((n) => [n, git(dir, 'show', `${ref}:${GOLDENS}/${n}`)]));
}

/** The goldens at a commit on GitHub (the server repository is public). */
async function fromGitHub(sha) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'audiosilo-wire-check' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const list = await fetch(`https://api.github.com/repos/${REPO}/contents/${GOLDENS}?ref=${sha}`, {
    headers,
  });
  if (!list.ok) throw new Error(`listing ${GOLDENS} at ${sha}: HTTP ${list.status}`);
  const entries = (await list.json()).filter((e) => e.type === 'file' && e.name.endsWith('.json'));
  const out = {};
  for (const e of entries) {
    const r = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${GOLDENS}/${e.name}`);
    if (!r.ok) throw new Error(`${e.name} at ${sha}: HTTP ${r.status}`);
    out[e.name] = await r.text();
  }
  return out;
}

function localCopy(out) {
  if (!existsSync(out)) return {};
  return Object.fromEntries(
    readdirSync(out)
      .filter((n) => n.endsWith('.json') && n !== 'source.json')
      .map((n) => [n, readFileSync(path.join(out, n), 'utf8')]),
  );
}

/** How the copy in out differs from want (the pinned commit's goldens). */
export function compareCopy(want, out) {
  const have = localCopy(out);
  const problems = [];
  for (const [n, text] of Object.entries(want)) {
    if (!(n in have)) problems.push(`missing ${n}`);
    else if (have[n] !== text) problems.push(`differs ${n}`);
  }
  for (const n of Object.keys(have)) if (!(n in want)) problems.push(`not on the server ${n}`);
  return problems.sort();
}

/** The pinned commit in out's source.json. */
export function pinnedRef(out) {
  return JSON.parse(readFileSync(path.join(out, 'source.json'), 'utf8')).ref;
}

/** Copies the goldens at rev of the server checkout into out and pins the commit. */
export function sync(server, rev, out) {
  const sha = git(server, 'rev-parse', `${rev}^{commit}`).trim();
  const goldens = fromCheckout(server, sha);
  mkdirSync(out, { recursive: true });
  for (const n of Object.keys(localCopy(out))) if (!(n in goldens)) rmSync(path.join(out, n));
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
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const server = arg('--server');
  if (!process.argv.includes('--check')) {
    const { sha, count } = sync(
      server ?? path.resolve(ROOT, '..', 'audiosilo-server'),
      arg('--ref') ?? 'origin/main',
      OUT,
    );
    console.log(`copied ${count} goldens from ${REPO}@${sha}`);
    return;
  }
  const ref = pinnedRef(OUT);
  const want = server ? fromCheckout(server, ref) : await fromGitHub(ref);
  const problems = compareCopy(want, OUT);
  if (problems.length > 0) {
    console.error(`src/api/__wire__ does not match ${REPO}@${ref}:\n  ${problems.join('\n  ')}`);
    console.error('Run npm run wire:sync (it re-pins source.json), then the parity test.');
    process.exit(1);
  }
  console.log(`src/api/__wire__ matches ${REPO}@${ref} (${Object.keys(want).length} goldens)`);
}

// Run only as a script, not when the test imports the helpers.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
