#!/usr/bin/env bash
# Install sous into throwaway projects and prove doctor passes on the result,
# that install is additive (keeps existing values), and that a second install
# is a no-op. Runs on bash 3.2.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOUS="$HERE/../bin/sous"
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT
export CI=1   # skip user-scope checks: this host's ~/.claude is not under test
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

# Fresh project: doctor fails before install, passes after.
p1="$WORK/fresh"; mkdir -p "$p1"
expect "doctor before install" 1 python3 "$SOUS" doctor "$p1"
expect "install" 0 python3 "$SOUS" install "$p1"
expect "doctor after install" 0 python3 "$SOUS" doctor "$p1"
expect "hook copied + executable" 0 test -x "$p1/.claude/hooks/sous-guard.sh"
expect "skill copied" 0 test -f "$p1/.claude/skills/test-audit/SKILL.md"

# Second install changes nothing.
cp "$p1/.claude/settings.json" "$WORK/first.json"
expect "reinstall" 0 python3 "$SOUS" install "$p1"
expect "reinstall is a no-op" 0 cmp "$WORK/first.json" "$p1/.claude/settings.json"

# Existing settings: values kept, lists extended.
p2="$WORK/existing"; mkdir -p "$p2/.claude"
cat > "$p2/.claude/settings.json" <<'JSON'
{"permissions": {"allow": ["Bash(npm test:*)"], "deny": ["Read(secrets/**)"]},
 "sandbox": {"enabled": false}, "model": "opus"}
JSON
expect "install over existing" 0 python3 "$SOUS" install "$p2"
expect "kept allow + custom deny + model" 0 python3 -c '
import json,sys; d=json.load(open(sys.argv[1]))
assert d["model"]=="opus"
assert "Bash(npm test:*)" in d["permissions"]["allow"]
assert "Read(secrets/**)" in d["permissions"]["deny"]
assert "Read(.env)" in d["permissions"]["deny"]
assert d["sandbox"]["enabled"] is False' "$p2/.claude/settings.json"
expect "doctor flags sandbox left off" 1 python3 "$SOUS" doctor "$p2"

# iOS project: auto-detected, toolchain excluded.
p3="$WORK/ios"; mkdir -p "$p3/App.xcodeproj"
expect "install ios" 0 python3 "$SOUS" install "$p3"
expect "xcodebuild excluded" 0 python3 -c '
import json,sys; d=json.load(open(sys.argv[1]))
assert "xcodebuild *" in d["sandbox"]["excludedCommands"]' "$p3/.claude/settings.json"
expect "doctor ios" 0 python3 "$SOUS" doctor "$p3"

# Strict tightens a scalar the base profile would only fill.
p5="$WORK/strict"; mkdir -p "$p5"
expect "install base" 0 python3 "$SOUS" install "$p5"
expect "doctor strict fails on base" 1 python3 "$SOUS" doctor "$p5" --strict
expect "install strict" 0 python3 "$SOUS" install "$p5" --strict
expect "doctor strict" 0 python3 "$SOUS" doctor "$p5" --strict
expect "probe prints" 0 python3 "$SOUS" probe

# Dry run writes nothing.
p4="$WORK/dry"; mkdir -p "$p4"
expect "dry run" 0 python3 "$SOUS" install "$p4" --dry-run
expect "dry run wrote nothing" 1 test -e "$p4/.claude"

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
