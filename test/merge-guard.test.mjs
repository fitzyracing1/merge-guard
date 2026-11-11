import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { runMergeGuard, git } from '../bin/merge-guard.mjs';

const CI = 'bash ci.sh';

function sh(repo, args) {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

function write(repo, file, contents) {
  writeFileSync(join(repo, file), contents);
}

function commitAll(repo, message) {
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-m', message]);
  return sh(repo, ['rev-parse', 'HEAD']);
}

/**
 * Creates a scratch repo with:
 *  - main: calc.js exporting add(), test uses add(), ci.sh runs all test-*.js
 */
function makeScratchRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'mg-test-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  sh(repo, ['init', '-b', 'main']);
  sh(repo, ['config', 'user.name', 'test']);
  sh(repo, ['config', 'user.email', 'test@invalid']);
  write(repo, 'calc.js', 'exports.add = (a, b) => a + b;\n');
  write(repo, 'test-calc.js',
    "const assert = require('assert');\n" +
    "const { add } = require('./calc');\n" +
    'assert.strictEqual(add(1, 2), 3);\n' +
    "console.log('calc ok');\n");
  write(repo, 'ci.sh',
    '#!/usr/bin/env bash\nset -euo pipefail\nfor t in test-*.js; do node "$t"; done\n');
  commitAll(repo, 'initial: calc with add()');
  return repo;
}

function allBranchShas(repo) {
  const out = sh(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads']);
  return out;
}

test('clean merge with passing CI is lit', (t) => {
  const repo = makeScratchRepo(t);
  sh(repo, ['checkout', '-b', 'feature']);
  write(repo, 'test-extra.js', "console.log('extra ok');\n");
  commitAll(repo, 'feature: add harmless test');
  sh(repo, ['checkout', 'main']);

  const result = runMergeGuard({ repo, base: 'main', head: 'feature', ciCommand: CI, quiet: true });
  assert.equal(result.status, 'lit');
  assert.equal(result.merge, 'clean');
  assert.equal(result.ci, 'pass');
  assert.ok(result.mergedSha);
});

test('green PR head but dark merged result is caught', (t) => {
  const repo = makeScratchRepo(t);

  // Feature branch (from the old main): adds double.js that calls add().
  sh(repo, ['checkout', '-b', 'feature']);
  write(repo, 'double.js',
    "const { add } = require('./calc');\nexports.double = (x) => add(x, x);\n");
  write(repo, 'test-double.js',
    "const assert = require('assert');\n" +
    "const { double } = require('./double');\n" +
    'assert.strictEqual(double(4), 8);\n' +
    "console.log('double ok');\n");
  commitAll(repo, 'feature: double() built on add()');

  // Meanwhile main renames add() to sum() everywhere IT knows about.
  sh(repo, ['checkout', 'main']);
  write(repo, 'calc.js', 'exports.sum = (a, b) => a + b;\n');
  write(repo, 'test-calc.js',
    "const assert = require('assert');\n" +
    "const { sum } = require('./calc');\n" +
    'assert.strictEqual(sum(1, 2), 3);\n' +
    "console.log('calc ok');\n");
  commitAll(repo, 'main: rename add() to sum()');

  // A plain PR-head check stays green: the head's own tree still has add().
  const headCheck = git(repo, ['stash']); // no-op guard; repo is clean
  assert.equal(headCheck.status, 0);
  sh(repo, ['checkout', 'feature']);
  execFileSync('bash', ['ci.sh'], { cwd: repo }); // throws if head CI fails
  sh(repo, ['checkout', 'main']);

  // merge-guard sees the truth: the merge is textually clean but dark.
  const result = runMergeGuard({ repo, base: 'main', head: 'feature', ciCommand: CI, quiet: true });
  assert.equal(result.merge, 'clean', 'merge should not conflict');
  assert.equal(result.ci, 'fail');
  assert.equal(result.status, 'dark');
});

test('real conflict is flagged, CI skipped, nothing resolved', (t) => {
  const repo = makeScratchRepo(t);
  sh(repo, ['checkout', '-b', 'feature']);
  write(repo, 'calc.js', 'exports.add = (a, b) => Number(a) + Number(b);\n');
  commitAll(repo, 'feature: coerce to number');
  sh(repo, ['checkout', 'main']);
  write(repo, 'calc.js', 'exports.add = (a, b) => b + a;\n');
  commitAll(repo, 'main: flip operands');

  const result = runMergeGuard({
    repo, base: 'main', head: 'feature', ciCommand: CI,
    attemptTrivialResolution: true, quiet: true,
  });
  assert.equal(result.status, 'dark');
  assert.equal(result.merge, 'conflict');
  assert.equal(result.ci, 'skipped');
  assert.deepEqual(result.conflicts, ['calc.js']);
  assert.equal(result.resolution, null);
});

test('whitespace-only conflict is trivially resolved on a NEW branch', (t) => {
  const repo = makeScratchRepo(t);
  // main reindents the line (whitespace-only change)...
  write(repo, 'calc.js', 'exports.add = (a, b)  =>  a + b;\n');
  commitAll(repo, 'main: reformat');
  // ...while feature (from the original line) changes it for real.
  sh(repo, ['checkout', '-b', 'feature', 'HEAD~1']);
  write(repo, 'calc.js', 'exports.add = (a, b) => a + b; // commutative\n');
  commitAll(repo, 'feature: annotate');
  sh(repo, ['checkout', 'main']);

  // Without resolution: conflict.
  const plain = runMergeGuard({ repo, base: 'main', head: 'feature', ciCommand: CI, quiet: true });
  assert.equal(plain.merge, 'conflict');

  // With resolution: resolved, CI runs, new branch created.
  const result = runMergeGuard({
    repo, base: 'main', head: 'feature', ciCommand: CI,
    attemptTrivialResolution: true, resolutionBranch: 'merge-guard/resolved-feature',
    quiet: true,
  });
  assert.equal(result.merge, 'resolved-trivial');
  assert.equal(result.status, 'lit');
  assert.equal(result.resolution.branch, 'merge-guard/resolved-feature');
  const branchSha = sh(repo, ['rev-parse', 'refs/heads/merge-guard/resolved-feature']);
  assert.equal(branchSha, result.mergedSha);
});

test('an existing resolution branch is never overwritten', (t) => {
  const repo = makeScratchRepo(t);
  write(repo, 'calc.js', 'exports.add = (a, b)  =>  a + b;\n');
  commitAll(repo, 'main: reformat');
  sh(repo, ['checkout', '-b', 'feature', 'HEAD~1']);
  write(repo, 'calc.js', 'exports.add = (a, b) => a + b; // note\n');
  commitAll(repo, 'feature: annotate');
  sh(repo, ['checkout', 'main']);

  sh(repo, ['branch', 'merge-guard/resolved-feature', 'main']);
  const before = sh(repo, ['rev-parse', 'refs/heads/merge-guard/resolved-feature']);

  const result = runMergeGuard({
    repo, base: 'main', head: 'feature', ciCommand: CI,
    attemptTrivialResolution: true, resolutionBranch: 'merge-guard/resolved-feature',
    quiet: true,
  });
  assert.equal(result.merge, 'resolved-trivial');
  assert.equal(result.resolution.branch, null);
  assert.ok(result.messages.some((m) => m.includes('refusing to overwrite')));
  const after = sh(repo, ['rev-parse', 'refs/heads/merge-guard/resolved-feature']);
  assert.equal(before, after, 'existing branch must not move');
});

test('never touches base, head, or the working checkout', (t) => {
  const repo = makeScratchRepo(t);
  sh(repo, ['checkout', '-b', 'feature']);
  write(repo, 'test-extra.js', "console.log('extra ok');\n");
  commitAll(repo, 'feature: extra test');
  sh(repo, ['checkout', 'main']);

  const branchesBefore = allBranchShas(repo);
  const headBefore = sh(repo, ['rev-parse', 'HEAD']);
  const statusBefore = sh(repo, ['status', '--porcelain']);

  runMergeGuard({ repo, base: 'main', head: 'feature', ciCommand: CI, quiet: true });

  assert.equal(allBranchShas(repo), branchesBefore, 'no branch may move');
  assert.equal(sh(repo, ['rev-parse', 'HEAD']), headBefore, 'checkout must stay put');
  assert.equal(sh(repo, ['status', '--porcelain']), statusBefore, 'working tree must stay clean');
  assert.equal(sh(repo, ['worktree', 'list']).split('\n').length, 1, 'no leftover worktrees');
});

test('CLI exits 0 when lit and 1 when dark', (t) => {
  const repo = makeScratchRepo(t);
  sh(repo, ['checkout', '-b', 'feature']);
  write(repo, 'test-extra.js', "console.log('extra ok');\n");
  commitAll(repo, 'feature: extra test');
  sh(repo, ['checkout', 'main']);

  const cli = new URL('../bin/merge-guard.mjs', import.meta.url).pathname;
  const lit = git(repo, ['status']); // ensure repo path valid
  assert.equal(lit.status, 0);

  const ok = execFileSync('node',
    [cli, '--repo', repo, '--base', 'main', '--head', 'feature', '--ci', CI, '--json'],
    { encoding: 'utf8' });
  const parsed = JSON.parse(ok);
  assert.equal(parsed.status, 'lit');

  // Now make the merged result dark: main renames add(), feature uses it.
  sh(repo, ['checkout', 'feature']);
  write(repo, 'test-uses-add.js',
    "const { add } = require('./calc');\nconsole.log(add(1, 1));\n");
  commitAll(repo, 'feature: use add directly');
  sh(repo, ['checkout', 'main']);
  write(repo, 'calc.js', 'exports.sum = (a, b) => a + b;\n');
  write(repo, 'test-calc.js',
    "const { sum } = require('./calc');\nconsole.log(sum(1, 2));\n");
  commitAll(repo, 'main: rename add to sum');

  let code = 0;
  try {
    execFileSync('node',
      [cli, '--repo', repo, '--base', 'main', '--head', 'feature', '--ci', CI],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status;
  }
  assert.equal(code, 1, 'dark result must exit 1');
});
