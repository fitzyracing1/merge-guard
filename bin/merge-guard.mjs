#!/usr/bin/env node
// merge-guard: build the result of merging a PR into the current base branch,
// run CI on that merged result, and report a single lit/dark status.
//
// Safety guarantees:
//   - All merge work happens on a detached HEAD inside a temporary git worktree.
//   - Existing branches (base, PR head, anything else) are never moved,
//     rewritten, force-pushed or deleted.
//   - Optional trivial-conflict resolution only ever CREATES a new branch,
//     and refuses to touch a branch that already exists.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(repo, args, opts = {}) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8', ...opts });
}

function gitOk(repo, args) {
  const res = git(repo, args);
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function branchExists(repo, name) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).status === 0;
}

/**
 * Run merge-guard.
 *
 * @param {object} options
 * @param {string} options.repo - path to the git repository
 * @param {string} options.base - ref of the base branch (what the PR merges into)
 * @param {string} options.head - ref of the PR head
 * @param {string} options.ciCommand - shell command that runs the project's CI
 * @param {boolean} [options.attemptTrivialResolution] - retry conflicted merges
 *   ignoring whitespace-only differences
 * @param {string} [options.resolutionBranch] - name of a NEW branch to create
 *   at the resolved merge commit (never overwrites an existing branch)
 * @param {boolean} [options.quiet] - suppress CI output passthrough
 * @returns {object} result - { status, merge, ci, baseSha, headSha, mergedSha,
 *   conflicts, resolution, messages }
 */
export function runMergeGuard(options) {
  const {
    repo,
    base,
    head,
    ciCommand,
    attemptTrivialResolution = false,
    resolutionBranch = null,
    quiet = false,
  } = options;

  const result = {
    status: 'dark',
    merge: null, // 'clean' | 'resolved-trivial' | 'conflict'
    ci: null, // 'pass' | 'fail' | 'skipped'
    baseSha: null,
    headSha: null,
    mergedSha: null,
    conflicts: [],
    resolution: null,
    messages: [],
  };

  result.baseSha = gitOk(repo, ['rev-parse', '--verify', `${base}^{commit}`]);
  result.headSha = gitOk(repo, ['rev-parse', '--verify', `${head}^{commit}`]);

  const worktree = mkdtempSync(join(tmpdir(), 'merge-guard-'));
  gitOk(repo, ['worktree', 'add', '--detach', worktree, result.baseSha]);

  try {
    const mergeEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'merge-guard',
      GIT_AUTHOR_EMAIL: 'merge-guard@invalid',
      GIT_COMMITTER_NAME: 'merge-guard',
      GIT_COMMITTER_EMAIL: 'merge-guard@invalid',
    };
    const mergeArgs = ['merge', '--no-ff', '--no-edit', result.headSha];
    const firstTry = git(worktree, mergeArgs, { env: mergeEnv });

    if (firstTry.status !== 0) {
      const conflicted = git(worktree, ['diff', '--name-only', '--diff-filter=U'])
        .stdout.trim().split('\n').filter(Boolean);
      result.conflicts = conflicted;
      git(worktree, ['merge', '--abort']);

      let resolved = false;
      if (attemptTrivialResolution) {
        const retry = git(
          worktree,
          ['merge', '--no-ff', '--no-edit', '-Xignore-space-change', result.headSha],
          { env: mergeEnv },
        );
        if (retry.status === 0) {
          resolved = true;
          result.merge = 'resolved-trivial';
          result.resolution = { strategy: 'ignore-space-change', branch: null };
          result.messages.push(
            `Conflict in [${conflicted.join(', ')}] was whitespace-only; resolved automatically.`,
          );
        } else {
          git(worktree, ['merge', '--abort']);
        }
      }

      if (!resolved) {
        result.merge = 'conflict';
        result.ci = 'skipped';
        result.messages.push(
          `Merge of ${head} into ${base} has conflicts that merge-guard will not resolve ` +
          `automatically: ${conflicted.join(', ')}. Flagging for a human.`,
        );
        return result;
      }
    } else {
      result.merge = 'clean';
    }

    result.mergedSha = gitOk(worktree, ['rev-parse', 'HEAD']);

    if (result.merge === 'resolved-trivial' && resolutionBranch) {
      if (branchExists(repo, resolutionBranch)) {
        result.messages.push(
          `Branch '${resolutionBranch}' already exists; refusing to overwrite it.`,
        );
      } else {
        gitOk(repo, ['branch', resolutionBranch, result.mergedSha]);
        result.resolution.branch = resolutionBranch;
        result.messages.push(
          `Created NEW branch '${resolutionBranch}' with the resolved merge.`,
        );
      }
    }

    const ci = spawnSync(ciCommand, {
      cwd: worktree,
      shell: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!quiet) {
      // stderr keeps stdout clean for --json consumers
      process.stderr.write(ci.stdout ?? '');
      process.stderr.write(ci.stderr ?? '');
    }
    result.ci = ci.status === 0 ? 'pass' : 'fail';
    if (ci.status !== 0) {
      result.messages.push(
        `CI command exited with status ${ci.status} on the merged result.`,
      );
    }

    result.status = result.ci === 'pass' ? 'lit' : 'dark';
    return result;
  } finally {
    git(repo, ['worktree', 'remove', '--force', worktree]);
    rmSync(worktree, { recursive: true, force: true });
  }
}

export function formatSummary(result) {
  const lamp = result.status === 'lit' ? 'LIT' : 'DARK';
  const lines = [];
  lines.push(`merge-guard: ${lamp}`);
  lines.push(`  base:   ${result.baseSha}`);
  lines.push(`  head:   ${result.headSha}`);
  lines.push(`  merge:  ${result.merge}${result.mergedSha ? ` (${result.mergedSha})` : ''}`);
  lines.push(`  ci:     ${result.ci}`);
  for (const m of result.messages) lines.push(`  note:   ${m}`);
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = {
    repo: process.cwd(),
    base: null,
    head: null,
    ciCommand: null,
    attemptTrivialResolution: false,
    resolutionBranch: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--repo': opts.repo = argv[++i]; break;
      case '--base': opts.base = argv[++i]; break;
      case '--head': opts.head = argv[++i]; break;
      case '--ci': opts.ciCommand = argv[++i]; break;
      case '--attempt-trivial-resolution': opts.attemptTrivialResolution = true; break;
      case '--resolution-branch': opts.resolutionBranch = argv[++i]; break;
      case '--json': opts.json = true; break;
      case '--help':
      case '-h':
        console.log(
          'Usage: merge-guard --base <ref> --head <ref> --ci <command> [options]\n\n' +
          'Options:\n' +
          '  --repo <path>                  git repository to operate on (default: cwd)\n' +
          '  --base <ref>                   base branch the PR merges into (required)\n' +
          '  --head <ref>                   PR head ref or sha (required)\n' +
          '  --ci <command>                 shell command that runs the project CI (required)\n' +
          '  --attempt-trivial-resolution   retry conflicted merges ignoring whitespace\n' +
          '  --resolution-branch <name>     create a NEW branch at the resolved merge\n' +
          '  --json                         print the result as JSON\n\n' +
          'Exit code 0 when the merged result is lit, 1 when it is dark.',
        );
        process.exit(0);
        break;
      default:
        console.error(`Unknown argument: ${a}`);
        process.exit(2);
    }
  }
  if (!opts.base || !opts.head || !opts.ciCommand) {
    console.error('merge-guard: --base, --head and --ci are required (see --help)');
    process.exit(2);
  }
  return opts;
}

function writeGithubStepSummary(result) {
  const out = process.env.GITHUB_STEP_SUMMARY;
  if (!out) return;
  const lamp = result.status === 'lit' ? ':green_circle: LIT' : ':black_circle: DARK';
  const lines = [
    `## merge-guard: ${lamp}`,
    '',
    `| field | value |`,
    `| --- | --- |`,
    `| base | \`${result.baseSha}\` |`,
    `| head | \`${result.headSha}\` |`,
    `| merge | ${result.merge} |`,
    `| merged sha | ${result.mergedSha ? `\`${result.mergedSha}\`` : '—'} |`,
    `| ci on merged result | ${result.ci} |`,
  ];
  for (const m of result.messages) lines.push('', `> ${m}`);
  appendFileSync(out, `${lines.join('\n')}\n`);
}

function writeGithubOutput(result) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  const kv = {
    status: result.status,
    merge: result.merge,
    ci: result.ci,
    merged_sha: result.mergedSha ?? '',
    resolution_branch: result.resolution?.branch ?? '',
    conflicts: result.conflicts.join(' '),
  };
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n');
  appendFileSync(out, `${text}\n`);
}

const invokedAsScript = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedAsScript) {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = runMergeGuard(opts);
  } catch (err) {
    console.error(`merge-guard: error: ${err.message}`);
    process.exit(2);
  }
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  }
  console.error(formatSummary(result));
  writeGithubOutput(result);
  writeGithubStepSummary(result);
  process.exit(result.status === 'lit' ? 0 : 1);
}
