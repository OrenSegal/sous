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

# Versions: the guard stamp, plugin.json and the marketplace entry for sous.
guard_v=$(sed -n 's/^SOUS_GUARD_VERSION=//p' "$ROOT/hooks/sous-guard.sh")
plugin_v=$(jq -r .version "$ROOT/.claude-plugin/plugin.json")
market_v=$(jq -r '[.plugins[] | select(.name == "sous") | .version // empty][0] // empty' "$ROOT/.claude-plugin/marketplace.json")
expect "guard stamp equals plugin.json version" "$plugin_v" "$guard_v"
[[ -n "$market_v" ]] && expect "marketplace sous entry equals plugin.json version" "$plugin_v" "$market_v"

# One default log path, spelled the same way in both languages.
want=".claude/sous/blocks.tsv"
expect "guard default log path" 1 "$(grep -c "\$HOME/$want" "$ROOT/hooks/sous-guard.sh" | awk '{print ($1 > 0)}')"
# shellcheck disable=SC2088 # the literal ~ is what the Python file spells
expect "python default log path" 1 "$(grep -c "~/$want" "$ROOT/lib/sous_blocks.py" | awk '{print ($1 > 0)}')"

# Round trip: real guard writes, real readers read.
export SOUS_LOG="$WORK/blocks.tsv"
export CLAUDE_PROJECT_DIR="$WORK/proj dir"
guard 'git status' >/dev/null
guard 'rm -rf build' >/dev/null
rows=$(PYTHONPATH="$ROOT/lib" python3 -c "
import sous_blocks
for ts, reason, where in sous_blocks.rows('$SOUS_LOG'):
    print(ts.__class__.__name__, reason.split('.')[0], where)")
expect "log row: epoch, reason, project dir" "int BLOCKED (sous): recursive force delete $WORK/proj dir" "$rows"
expect "allowed command counted as one byte" 1 "$(cat "$SOUS_LOG".allowed.* | wc -c | tr -d ' ')"
report=$(python3 "$ROOT/bin/sous" report 2>&1 | sed -n 1p)
case "$report" in
  "sous report: 1 blocks, 1 allowed (50.0% blocked) in the last 30 days"*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: report line: $report" ;;
esac

# The loop breaker reads the same log with the third column present.
guard 'rm -rf build' >/dev/null
third=$(guard 'rm -rf build')
case "$third" in
  *"Stop retrying this"*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: loop breaker silent on third block with a 3-column log: $third" ;;
esac

echo "ssot: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
