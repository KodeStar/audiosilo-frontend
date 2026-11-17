// Tests for the wire goldens' sync and check (`npm test` runs them with node's
// own test runner, before jest), against a throwaway git repository laid out as
// the server's.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { compareCopy, fromCheckout, pinnedRef, sync } from './wire-sync.mjs';

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
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
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
