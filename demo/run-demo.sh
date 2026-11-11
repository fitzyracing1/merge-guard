#!/usr/bin/env bash
# Demo: a PR that is GREEN on its own head but DARK once merged into the
# current base branch. A plain PR-head check passes it; merge-guard blocks it.
#
# The script builds a scratch git repo, plays out the scenario, runs both
# checks, and exits 0 only if the demo proves the point:
#   - plain head check:  PASS (wrongly green)
#   - merge-guard:       DARK (correctly blocked)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MERGE_GUARD="$HERE/../bin/merge-guard.mjs"
SCRATCH="$(mktemp -d)"
trap 'rm -rf "$SCRATCH"' EXIT

say() { printf '\n=== %s ===\n' "$*"; }

say "Setting up a demo project (main branch)"
git -C "$SCRATCH" init -q -b main
git -C "$SCRATCH" config user.name demo
git -C "$SCRATCH" config user.email demo@invalid

cat > "$SCRATCH/calc.js" <<'EOF'
exports.add = (a, b) => a + b;
EOF
cat > "$SCRATCH/test-calc.js" <<'EOF'
const assert = require('assert');
const { add } = require('./calc');
assert.strictEqual(add(1, 2), 3);
console.log('test-calc: ok');
EOF
cat > "$SCRATCH/ci.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for t in test-*.js; do node "$t"; done
echo "CI: all tests passed"
EOF
git -C "$SCRATCH" add -A
git -C "$SCRATCH" commit -qm 'initial: calc.js with add()'

say "Opening a PR branch 'feature' that builds double() on top of add()"
git -C "$SCRATCH" checkout -qb feature
cat > "$SCRATCH/double.js" <<'EOF'
const { add } = require('./calc');
exports.double = (x) => add(x, x);
EOF
cat > "$SCRATCH/test-double.js" <<'EOF'
const assert = require('assert');
const { double } = require('./double');
assert.strictEqual(double(4), 8);
console.log('test-double: ok');
EOF
git -C "$SCRATCH" add -A
git -C "$SCRATCH" commit -qm 'feature: double() built on add()'

say "Meanwhile main moves on: add() is renamed to sum() everywhere main knows about"
git -C "$SCRATCH" checkout -q main
cat > "$SCRATCH/calc.js" <<'EOF'
exports.sum = (a, b) => a + b;
EOF
cat > "$SCRATCH/test-calc.js" <<'EOF'
const assert = require('assert');
const { sum } = require('./calc');
assert.strictEqual(sum(1, 2), 3);
console.log('test-calc: ok');
EOF
git -C "$SCRATCH" add -A
git -C "$SCRATCH" commit -qm 'main: rename add() to sum()'

say "1) Plain PR-head check (what a naive CI setup tests)"
git -C "$SCRATCH" checkout -q feature
HEAD_CHECK=pass
(cd "$SCRATCH" && bash ci.sh) || HEAD_CHECK=fail
git -C "$SCRATCH" checkout -q main
echo "Plain PR-head check result: $HEAD_CHECK"

say "2) merge-guard (tests the MERGED result against the current base)"
GUARD=lit
node "$MERGE_GUARD" --repo "$SCRATCH" --base main --head feature --ci 'bash ci.sh' \
  || GUARD=dark
echo "merge-guard result: $GUARD"

say "Verdict"
if [ "$HEAD_CHECK" = pass ] && [ "$GUARD" = dark ]; then
  echo "DEMO PROVEN: the PR head is green on its own, so a plain head check"
  echo "would let it merge -- but the merged result is dark (double.js still"
  echo "calls add(), which main renamed to sum()). merge-guard caught it and"
  echo "would block the merge."
  exit 0
else
  echo "DEMO FAILED: expected head check = pass and merge-guard = dark,"
  echo "got head check = $HEAD_CHECK, merge-guard = $GUARD"
  exit 1
fi
