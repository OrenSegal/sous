#!/usr/bin/env bash
# sous fleet: every worktree of a repo in one table. Real `git worktree add` in a
# temp dir: a path with a space, a detached HEAD, a prunable entry whose directory
# is gone, a bare repository, and a repo with no extra worktrees. Read-only: the
# run must not prune, refresh the index or write anywhere. Temp HOME, no network.
# Runs on bash 3.2.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOUS="$HERE/../bin/sous"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sous-test.XXXXXX") || exit 1  # macOS bare mktemp ignores TMPDIR
trap 'chmod -R u+w "$WORK"; rm -r "$WORK"' EXIT
export HOME="$WORK/home" CI=1 SOUS_LOG="$WORK/blocks.tsv"
export GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
unset CLAUDE_PROJECT_DIR SOUS_TEST_LOG
mkdir -p "$HOME" "$WORK/bin"
NOSCOPED=""
IFS=: read -r -a dirs <<<"$PATH"
for d in "${dirs[@]}"; do [ -x "$d/scoped" ] || NOSCOPED="$NOSCOPED${NOSCOPED:+:}$d"; done
export PATH="$NOSCOPED"
cat >"$WORK/bin/scoped" <<'SH'
#!/bin/sh
[ "$1 $2" = "status --json" ] || exit 2
cat "$SCOPED_FAKE_JSON"
SH
chmod +x "$WORK/bin/scoped"
pass=0
fail=0

expect() { # $1 label, $2 expected exit, rest = command
  local label="$1" want="$2"; shift 2
  "$@" >"$WORK/out.txt" 2>&1
  local got=$?
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); printf 'FAIL %s: want=%s got=%s\n' "$label" "$want" "$got" >&2; cat "$WORK/out.txt" >&2
  fi
}
R="$WORK/repo"
g() { git -C "$R" "$@" >/dev/null 2>&1; }
fleet_json() { python3 "$SOUS" fleet "$R" --json >"$WORK/fleet.json"; }
# $1 label, $2 python expression over `rows` (the --json list) and `by` (rows by path basename)
row() {
  expect "$1" 0 python3 -c '
import json, os, sys
rows = json.load(open(sys.argv[1]))["worktrees"]
by = {os.path.basename(r["path"]): r for r in rows}
assert eval(sys.argv[2]), json.dumps(rows, indent=1)' "$WORK/fleet.json" "$2"
}

git init -q -b main "$R"
printf 'x = 1\n' >"$R/app.py"; g add -A; g commit -qm base

# A repo with no extra worktrees is one row.
expect "a lone checkout lists" 0 python3 "$SOUS" fleet "$R"
fleet_json
row "...as exactly one row on main" 'len(rows) == 1 and rows[0]["branch"] == "main" and rows[0]["dirty"] is False'
row "scoped absent: claims is null, not zero" 'rows[0]["claims"] is None'

# Worktrees: a space in the path, a detached HEAD, and one whose directory is gone.
git -C "$R" worktree add -q "$WORK/wt two" -b feature >/dev/null 2>&1
git -C "$R" worktree add -q --detach "$WORK/det" >/dev/null 2>&1
git -C "$R" worktree add -q "$WORK/gone" -b gone >/dev/null 2>&1
rm -r "$WORK/gone"
W="$WORK/wt two"
printf 'x = 2\n' >"$W/app.py"; git -C "$W" commit -qam one; printf 'x = 3\n' >"$W/app.py"; git -C "$W" commit -qam two
printf 'x = 9\n' >"$W/app.py"   # and dirty
printf 'y = 1\n' >"$R/lib.py"; g add -A; g commit -qm "main moves on"
printf '===== 3 passed in 0.1s =====\n' >"$(git -C "$W" rev-parse --absolute-git-dir)/sous-test.log"
printf 'collected 0 items\n===== no tests ran in 0.01s =====\n' >"$(git -C "$WORK/det" rev-parse --absolute-git-dir)/sous-test.log"
now=$(date +%s)
{ printf '%s\tBLOCKED (sous): force push.\t%s\n' "$now" "$W" "$now" "$W" "$now" "$R"
  printf '%s\tBLOCKED (sous): force push.\n' "$now"; } >"$SOUS_LOG"

# Read-only: the index keeps its old mtime (no `git status` refresh), the
# prunable entry is still there, and nothing under $WORK is written.
touch -t 200001010000 "$R/.git/index"
before=$(git -C "$R" worktree list --porcelain; ls -l "$R/.git/index")
touch "$WORK/marker"
expect "fleet over four worktrees" 0 python3 "$SOUS" fleet "$R"
cp "$WORK/out.txt" "$WORK/fleet.txt"   # expect rewrites out.txt
expect "text output names the spaced path whole" 0 grep -qF "/wt two" "$WORK/fleet.txt"
fleet_json
after=$(git -C "$R" worktree list --porcelain; ls -l "$R/.git/index")
writes=$(find "$WORK" -newer "$WORK/marker" -type f ! -name out.txt ! -name fleet.txt ! -name fleet.json)
expect "fleet is read-only (no prune, no index refresh, no writes)" 0 sh -c '[ "$1" = "$2" ] && [ -z "$3" ]' _ "$before" "$after" "$writes"
row "four rows" 'len(rows) == 4'
row "main: clean, base itself, no log" 'by["repo"]["dirty"] is False and by["repo"]["tests_ran"] is None'
row "spaced worktree: branch, dirty, 2 ahead 1 behind" 'by["wt two"]["branch"] == "feature" and by["wt two"]["dirty"] is True and (by["wt two"]["ahead"], by["wt two"]["behind"]) == (2, 1)'
row "tests ran is tests-ran's count" 'by["wt two"]["tests_ran"] == 3 and by["det"]["tests_ran"] == 0'
row "detached: no branch, a head sha" 'by["det"]["detached"] is True and by["det"]["branch"] is None and len(by["det"]["head"]) >= 7'
row "prunable: flagged, nothing read from the missing dir" 'by["gone"]["prunable"] is True and by["gone"]["dirty"] is None'
row "blocks attributed by path; pathless rows count nowhere" 'by["wt two"]["blocks"] == 2 and by["repo"]["blocks"] == 1 and by["det"]["blocks"] == 0'

# scoped present: claims are counted under each worktree's path.
export SCOPED_FAKE_JSON="$WORK/claims.json"
printf '{"active_claims":2,"claims":[{"file_path":"%s","issue_id":"A","session_id":"s1","claimed_at":1,"ttl_seconds":9},{"file_path":"%s","issue_id":"B","session_id":"s2","claimed_at":1,"ttl_seconds":9}]}\n' "$W/app.py" "$R/lib.py" >"$SCOPED_FAKE_JSON"
expect "fleet with scoped on PATH" 0 env PATH="$WORK/bin:$PATH" sh -c 'python3 "$1" fleet "$2" --json >"$3"' _ "$SOUS" "$R" "$WORK/fleet.json"
row "claims per worktree" 'by["wt two"]["claims"] == 1 and by["repo"]["claims"] == 1 and by["det"]["claims"] == 0'

# From inside a linked worktree, the same fleet.
expect "run from a linked worktree" 0 sh -c 'cd "$1" && python3 "$2" fleet --json | python3 -c "import json,sys; assert len(json.load(sys.stdin)[\"worktrees\"]) == 4"' _ "$W" "$SOUS"

# A bare repository: listed as bare, nothing read from a working tree it lacks.
git clone -q --bare "$R" "$WORK/bare.git" >/dev/null 2>&1
expect "bare repository" 0 sh -c 'python3 "$1" fleet "$2" --json | python3 -c "
import json, sys; rows = json.load(sys.stdin)[\"worktrees\"]
assert len(rows) == 1 and rows[0][\"bare\"] is True and rows[0][\"dirty\"] is None, rows"' _ "$SOUS" "$WORK/bare.git"

expect "outside a git repository is a usage error" 64 sh -c 'mkdir -p "$1/plain" && GIT_CEILING_DIRECTORIES="$1" python3 "$2" fleet "$1/plain"' _ "$WORK" "$SOUS"
expect "unknown option" 64 python3 "$SOUS" fleet "$R" --fix

printf 'fleet: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
