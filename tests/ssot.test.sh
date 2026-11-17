#!/usr/bin/env bash
# Single sources of truth: facts the bash guard and the Python side must agree
# on, checked where they meet. A guard that writes one block-log shape while
# `sous report`, `gate` and `fleet` read another fails silently, so this runs
# the real guard and reads its output back through the real readers.
# Runs on bash 3.2.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$HERE/.."
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sous-ssot.XXXXXX") || exit 1
trap 'rm -r "$WORK"' EXIT
pass=0
fail=0

expect() { # $1 name, $2 expected, $3 actual
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1 (want '$2', got '$3')"; fi
}
guard() { # $1 command; log and project dir come from the environment
  # shellcheck disable=SC2069 # the guard speaks on stderr; stdout is dropped
  jq -cn --arg c "$1" '{tool_input:{command:$c}}' | bash "$ROOT/hooks/sous-guard.sh" 2>&1 >/dev/null
}

# One default log path: with SOUS_LOG unset, the guard writes where `sous report` reads.
H="$WORK/home"; mkdir -p "$H"
jq -cn '{tool_input:{command:"rm -rf vendor"}}' | env -u SOUS_LOG HOME="$H" bash "$ROOT/hooks/sous-guard.sh" >/dev/null 2>&1
default=$(env -u SOUS_LOG HOME="$H" python3 "$ROOT/bin/sous" report 2>&1 | sed -n 1p)
case "$default" in
  "sous report: 1 blocks"*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: default log path: guard and report disagree: $default" ;;
esac

# Round trip: real guard writes, real readers read.
export SOUS_LOG="$WORK/blocks.tsv"
export CLAUDE_PROJECT_DIR="$WORK/proj dir"
guard 'git status' >/dev/null
guard 'rm -rf vendor' >/dev/null
rows=$(PYTHONPATH="$ROOT/lib" python3 -c "
import sous_blocks
for ts, reason, where in sous_blocks.rows('$SOUS_LOG'):
    print(ts.__class__.__name__, reason.split('.')[0], where)")
expect "log row: epoch, reason, project dir" "int BLOCKED (sous): recursive force delete $WORK/proj dir" "$rows"
report=$(python3 "$ROOT/bin/sous" report 2>&1 | sed -n 1p)
case "$report" in
  "sous report: 1 blocks, 1 allowed (50.0% blocked) in the last 30 days"*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: report line: $report" ;;
esac

echo "ssot: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
