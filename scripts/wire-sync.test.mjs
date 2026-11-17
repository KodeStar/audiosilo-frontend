// Tests for the wire goldens' sync and check (`npm test` runs them with node's
// own test runner, before jest), against a throwaway git repository laid out as
// the server's.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { compareCopy, fromCheckout, git as gitIn, pinnedRef, sync } from './wire-sync.mjs';

function commit(git, message) {
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  );
}

function serverRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'wire-server-'));
  const git = (...args) => gitIn(dir, ...args);
  git('init', '-q');
  const wire = path.join(dir, 'internal', 'api', 'testdata', 'wire');
  mkdirSync(wire, { recursive: true });
  writeFileSync(path.join(wire, 'a.json'), '{"route":"GET /a","shape":{"x":"number"}}\n');
  writeFileSync(path.join(wire, 'b.json'), '{"route":"GET /b","shape":{"y":"string"}}\n');
  git('add', '.');
  commit(git, 'one');
  return { dir, git, wire };
}

test('sync copies the goldens at a commit and pins it; the check then passes', (t) => {
  const { dir, git, wire } = serverRepo();
  const out = mkdtempSync(path.join(tmpdir(), 'wire-out-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  const first = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(sync(dir, 'HEAD', out), { sha: first, count: 2 });
  assert.equal(pinnedRef(out), first);
  assert.deepEqual(compareCopy(fromCheckout(dir, first), out), []);

  // The server moves on: the copy still matches its pinned commit, not the new one.
  rmSync(path.join(wire, 'b.json'));
  writeFileSync(path.join(wire, 'a.json'), '{"route":"GET /a","shape":{"x":"string"}}\n');
  writeFileSync(path.join(wire, 'c.json'), '{"route":"GET /c","shape":{}}\n');
  git('add', '-A');
  commit(git, 'two');
  assert.deepEqual(compareCopy(fromCheckout(dir, pinnedRef(out)), out), []);
  assert.deepEqual(compareCopy(fromCheckout(dir, 'HEAD'), out), [
    'differs a.json',
    'missing c.json',
    'not on the server b.json',
  ]);

  // A re-sync takes the new commit and drops the golden the server dropped.
  sync(dir, 'HEAD', out);
  assert.equal(pinnedRef(out), git('rev-parse', 'HEAD').trim());
  assert.deepEqual(compareCopy(fromCheckout(dir, 'HEAD'), out), []);
});

test('the check reports a hand edit to the copy', (t) => {
  const { dir } = serverRepo();
  const out = mkdtempSync(path.join(tmpdir(), 'wire-out-'));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  sync(dir, 'HEAD', out);
  writeFileSync(path.join(out, 'a.json'), '{"route":"GET /a","shape":{"x":"boolean"}}\n');
  writeFileSync(path.join(out, 'extra.json'), '{}\n');
  assert.deepEqual(compareCopy(fromCheckout(dir, pinnedRef(out)), out), [
    'differs a.json',
    'not on the server extra.json',
  ]);
});

test('git runs in the directory given, not the repository a hook names', (t) => {
  // A git hook and `git rebase --exec` export these for the repository they run in.
  const other = mkdtempSync(path.join(tmpdir(), 'wire-other-'));
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
  process.env.GIT_DIR = path.join(other, '.git');
  process.env.GIT_INDEX_FILE = path.join(other, '.git', 'index');
  let dir;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(other, { recursive: true, force: true });
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const repo = serverRepo();
  dir = repo.dir;
  assert.equal(realpathSync(repo.git('rev-parse', '--show-toplevel').trim()), realpathSync(dir));
  assert.equal(Object.keys(fromCheckout(dir, 'HEAD')).length, 2);
  assert.equal(existsSync(path.join(other, '.git')), false);
});
