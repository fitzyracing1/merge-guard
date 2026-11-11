# merge-guard

A guard that can stand any merge. For every pull request it builds the result
of merging the PR into the **current** base branch — not just the PR's own
head — runs your project's CI on that merged result, and reports one clear
status: **lit** (safe to merge) or **dark** (merging would break CI). Made a
required status check, it blocks the merge button whenever the merged result
would go dark.

## The problem it solves

A PR can be perfectly green on its own and still break the build the moment it
lands. The classic case: your PR calls a function, and while your PR sat in
review, someone renamed that function on `main`. There is no merge conflict —
git combines the two changes without complaint — but the combined code no
longer compiles or passes tests. A check that only tests the PR's head commit
stays green and waves the breakage straight through. Big fast-moving projects
hit this constantly; it is one of the main ways a default branch "goes dark".

merge-guard closes that gap by always testing what will actually exist after
the merge, against the base branch *as it is right now*, every time it runs.

## How it works

1. Fetches the current tip of the base branch and the PR head.
2. Creates a **throwaway merge** on a detached HEAD inside a temporary git
   worktree. No existing branch is touched.
3. If the merge conflicts: reports **dark** and lists the conflicted files.
   Optionally (off by default) it retries the merge ignoring whitespace-only
   differences; if that resolves it, it can save the resolved merge to a
   **new** branch for a human to review. Anything beyond whitespace it flags
   instead of guessing.
4. If the merge succeeds: runs your CI command on the merged result.
5. Reports **lit** if CI passes, **dark** if it fails — as the step's exit
   code, as action outputs, and in the job summary.

Safety rules, enforced by the code and covered by tests:

- never force-pushes, never rewrites history;
- never modifies the base branch, the PR branch, or your checkout;
- the optional resolution branch is always a *new* branch — if a branch with
  that name already exists, merge-guard refuses to overwrite it;
- the only push it can ever do (opt-in) is a plain `git push` of that new
  branch.

## Adopting it in your repository

Copy [`examples/merge-guard.yml`](examples/merge-guard.yml) into your repo as
`.github/workflows/merge-guard.yml` and set `ci-command`:

```yaml
name: merge-guard
on:
  pull_request:
jobs:
  merge-guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: fitzyracing1/merge-guard@v0.1.0
        with:
          ci-command: npm ci && npm test
```

Then make it actually block merges: in your repository settings, under branch
protection (or a ruleset) for your default branch, add the `merge-guard` job
as a **required status check**. From then on a PR whose merged result is dark
cannot be merged until it is updated or the base changes.

Because the guard tests against the base branch as of the moment it runs,
re-running the check (or requiring branches to be up to date before merging)
re-validates a PR after the base moves.

### Inputs

| input | default | what it does |
| --- | --- | --- |
| `ci-command` | (required) | shell command that runs your CI on the merged result |
| `base-ref` | PR's base branch | base branch to merge into |
| `head-ref` | `refs/pull/N/head` | PR head to merge |
| `attempt-trivial-resolution` | `false` | retry conflicted merges ignoring whitespace-only differences |
| `resolution-branch` | (empty) | name of a NEW branch to create at a trivially-resolved merge |
| `push-resolution-branch` | `false` | plain-push that branch to origin (never force) |

### Outputs

`status` (`lit`/`dark`), `merge` (`clean`/`resolved-trivial`/`conflict`),
`ci` (`pass`/`fail`/`skipped`), `merged-sha`, `resolution-branch`,
`conflicts`.

### Using the CLI directly

The engine is a single zero-dependency Node (>=20) script, usable outside
GitHub Actions too:

```bash
node bin/merge-guard.mjs --repo /path/to/repo \
  --base origin/main --head origin/feature \
  --ci 'cargo test' --json
```

Exit code 0 means lit, 1 means dark, 2 means merge-guard itself could not run.

## The demo: catching what a plain head check misses

[`demo/run-demo.sh`](demo/run-demo.sh) builds a small throwaway project and
plays out the classic silent breakage:

- `main` starts with `calc.js` exporting `add()`;
- a PR branch adds `double.js`, which calls `add()` — the PR's own CI is green;
- meanwhile `main` renames `add()` to `sum()` and updates everything *it*
  knows about — `main`'s CI is green too;
- the merge is textually clean, but the merged code calls a function that no
  longer exists.

The script runs both checks and verifies the outcome: the plain PR-head check
**passes** (wrongly green), merge-guard reports **dark** and would block the
merge. Run it yourself with `npm run demo`; it also runs on every push and PR
as the "demo (green head, dark merge)" job in this repo's CI.

## This repo's own CI

`.github/workflows/ci.yml` runs three jobs: the unit tests (`node --test`),
the demo scenario above, and a dogfooding job that runs merge-guard on
merge-guard's own PRs.

## Notes and limitations (v0.1.0)

- GitHub's `pull_request` event already offers a merge preview ref, but it is
  only refreshed at certain times and plenty of workflows test the head
  instead. merge-guard makes the merged-result check explicit, fresh at the
  moment it runs, and adds conflict flagging and safe trivial resolution.
- "Trivial" resolution means whitespace-only, nothing else. Real conflicts are
  always flagged for a human.
- One CI command per guard. If your CI is a big matrix, point `ci-command` at
  the entry point that best predicts lit/dark (a build + core test suite), or
  run several guard jobs.

## Versioning

Each release gets its own branch and tag (`v0.1.0` is the first). Pin the tag
in your workflow: `uses: fitzyracing1/merge-guard@v0.1.0`.
