#!/usr/bin/env bash
# Install sous into throwaway projects and prove doctor passes on the result,
# that install is additive (keeps existing values), and that a second install
# is a no-op. Runs on bash 3.2.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOUS="$HERE/../bin/sous"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sous-test.XXXXXX") || exit 1  # macOS bare mktemp ignores TMPDIR
trap 'rm -r "$WORK"' EXIT
export CI=1   # skip user-scope checks: this host's ~/.claude is not under test
export SOUS_LOG="$WORK/blocks.tsv"   # never read or write the real block log
export XDG_CACHE_HOME="$WORK/cache"  # table cache starts cold per run
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

# Bloat: memory file over budget fails; the budget is per-project tunable.
p6="$WORK/bloat"; mkdir -p "$p6"
expect "install bloat" 0 python3 "$SOUS" install "$p6"
seq 1 450 | sed 's/^/line /' > "$p6/CLAUDE.md"
expect "doctor flags bloated memory" 1 python3 "$SOUS" doctor "$p6"
expect "budget override" 0 env SOUS_MEMORY_LINES=1000 python3 "$SOUS" doctor "$p6"
: > "$p6/CLAUDE.md"

# Rot: duplicate rules and rules naming a deleted script both fail doctor.
addrule() { python3 -c 'import json,sys
p,k,v=sys.argv[1:]; d=json.load(open(p)); d["permissions"].setdefault(k, []).append(v); json.dump(d,open(p,"w"))' "$@"; }
cp "$p6/.claude/settings.json" "$WORK/clean.json"
addrule "$p6/.claude/settings.json" ask "Bash(git push:*)"
expect "doctor flags duplicate rule" 1 python3 "$SOUS" doctor "$p6"
cp "$WORK/clean.json" "$p6/.claude/settings.json"
addrule "$p6/.claude/settings.json" allow "Bash(./scripts/gone.sh:*)"
expect "doctor flags rule for missing script" 1 python3 "$SOUS" doctor "$p6"
mkdir -p "$p6/scripts" && touch "$p6/scripts/gone.sh"
expect "rule for present script ok" 0 python3 "$SOUS" doctor "$p6"

# Rot: a stale copied guard fails doctor, and install refreshes it.
echo "# drift" >> "$p6/.claude/hooks/sous-guard.sh"
expect "doctor flags stale guard" 1 python3 "$SOUS" doctor "$p6"
expect "install refreshes guard" 0 python3 "$SOUS" install "$p6"
expect "doctor after refresh" 0 python3 "$SOUS" doctor "$p6"

# Feedback loop: report reads the block log back, counted by reason.
printf '%s\tBLOCKED (sous): force push. Ask the user.\n' "$(date +%s)" "$(date +%s)" > "$SOUS_LOG"
expect "report runs" 0 python3 "$SOUS" report
expect "report counts reasons" 0 sh -c 'python3 "$1" report | grep -q "2  force push"' _ "$SOUS"

# SessionStart fast path: speaks only when a layer is missing, never fails.
# HOME is faked so the author's real ~/.claude/settings.json is not under test.
mkdir -p "$WORK/home/.claude"
expect "check on a bare project speaks" 0 sh -c 'HOME="$1" python3 "$2" check "$3" | grep -q "Run `sous install`"' _ "$WORK/home" "$SOUS" "$WORK/bare"
expect "check flags bypass mode when installed" 0 sh -c 'HOME="$1" python3 "$2" check "$3" | grep -q "bypass mode still allowed"' _ "$WORK/home" "$SOUS" "$p1"
printf '{"permissions":{"disableBypassPermissionsMode":"disable"}}\n' > "$WORK/home/.claude/settings.json"
expect "check is silent when every layer is present" 0 sh -c '[ -z "$(HOME="$1" python3 "$2" check "$3")" ]' _ "$WORK/home" "$SOUS" "$p1"
expect "check within 300ms" 0 python3 -c '
import subprocess,sys,time
t=time.monotonic(); subprocess.run(["python3",sys.argv[1],"check",sys.argv[2]],capture_output=True)
sys.exit(0 if time.monotonic()-t<0.3 else 1)' "$SOUS" "$p1"
expect "plugin hooks.json carries SessionStart + PreToolUse" 0 python3 -c '
import json,sys; h=json.load(open(sys.argv[1]))["hooks"]
assert "SessionStart" in h and "PreToolUse" in h' "$HERE/../hooks/hooks.json"

# Dry run writes nothing.
p4="$WORK/dry"; mkdir -p "$p4"
expect "dry run" 0 python3 "$SOUS" install "$p4" --dry-run
expect "dry run wrote nothing" 1 test -e "$p4/.claude"

# Broken input never ends in a traceback, and never gets rewritten.
notrace() { "$@" >"$WORK/nt.txt" 2>&1; local rc=$?; ! grep -q Traceback "$WORK/nt.txt" && return $rc; return 99; }
p7="$WORK/broken"; mkdir -p "$p7/.claude"
printf '{"permissions": {"deny": [}\n' > "$p7/.claude/settings.json"
cp "$p7/.claude/settings.json" "$WORK/broken.json"
expect "doctor on invalid JSON fails cleanly" 1 notrace python3 "$SOUS" doctor "$p7"
expect "install on invalid JSON refuses cleanly" 1 notrace python3 "$SOUS" install "$p7"
expect "invalid JSON left untouched" 0 cmp "$WORK/broken.json" "$p7/.claude/settings.json"
printf '[1, 2]\n' > "$p7/.claude/settings.json"
expect "doctor on a non-object fails cleanly" 1 notrace python3 "$SOUS" doctor "$p7"
expect "check on invalid JSON never fails" 0 notrace python3 "$SOUS" check "$p7"
printf '{"permissions": "nope", "sandbox": [], "hooks": {"PreToolUse": ["x", {"hooks": "y"}]}}\n' > "$p7/.claude/settings.json"
expect "doctor on wrong-typed keys fails cleanly" 1 notrace python3 "$SOUS" doctor "$p7"

# JSON with comments: read for checks, but install won't drop the comments.
p8="$WORK/jsonc"; mkdir -p "$p8"
python3 "$SOUS" install "$p8" >/dev/null
python3 - "$p8/.claude/settings.json" <<'PY'
import sys; p = sys.argv[1]; t = open(p).read()
t = t.replace('{\n  "permissions"', '{\n  // team note: "keep // this"\n  "permissions"', 1)
assert '"\n    ]' in t
open(p, "w").write(t.replace('"\n    ]', '",\n    ]', 1))
PY
expect "doctor flags JSONC as unproven" 1 python3 "$SOUS" doctor "$p8"
expect "doctor still reads JSONC rules" 0 sh -c 'python3 "$1" doctor "$2" | grep -q "ok    deny rules"' _ "$SOUS" "$p8"
cp "$p8/.claude/settings.json" "$WORK/jsonc.json"
expect "install over JSONC with nothing to add" 0 python3 "$SOUS" install "$p8"
python3 - "$p8/.claude/settings.json" <<'PY'
import sys; p = sys.argv[1]; t = open(p).read()
open(p, "w").write(t.replace('"Read(.env)",', '', 1))
PY
cp "$p8/.claude/settings.json" "$WORK/jsonc.json"
expect "install refuses to rewrite JSONC" 1 python3 "$SOUS" install "$p8"
expect "JSONC left untouched" 0 cmp "$WORK/jsonc.json" "$p8/.claude/settings.json"
expect "dry run over JSONC still plans" 0 python3 "$SOUS" install "$p8" --dry-run

# A UTF-8 BOM (Windows editors) is not an error.
p9="$WORK/bom"; mkdir -p "$p9"
python3 "$SOUS" install "$p9" >/dev/null
python3 - "$p9/.claude/settings.json" <<'PY'
import sys; p = sys.argv[1]; d = open(p, "rb").read(); open(p, "wb").write(b"\xef\xbb\xbf" + d)
PY
expect "doctor reads a BOM file" 0 python3 "$SOUS" doctor "$p9"

# Paths: a project dir with spaces, a relative hook command, a symlinked settings file.
p10="$WORK/with space"; mkdir -p "$p10"
expect "install into a path with spaces" 0 python3 "$SOUS" install "$p10"
expect "doctor on a path with spaces" 0 python3 "$SOUS" doctor "$p10"
sethook() { python3 -c 'import json,sys
p,cmd,matcher=sys.argv[1:]; d=json.load(open(p)); g={"hooks":[{"type":"command","command":cmd}]}
if matcher != "-": g["matcher"]=matcher
d["hooks"]["PreToolUse"]=[g]; json.dump(d,open(p,"w"),indent=2)' "$@"; }
sethook "$p10/.claude/settings.json" ".claude/hooks/sous-guard.sh" Bash
expect "relative hook command resolves" 0 python3 "$SOUS" doctor "$p10"
sethook "$p10/.claude/settings.json" "bash \"\$CLAUDE_PROJECT_DIR/.claude/hooks/sous-guard.sh\"" "Bash|Edit"
expect "quoted hook path with spaces resolves" 0 python3 "$SOUS" doctor "$p10"
sethook "$p10/.claude/settings.json" '"$CLAUDE_PROJECT_DIR"/.claude/hooks/sous-guard.sh' Edit
expect "guard behind a non-Bash matcher does not count" 1 python3 "$SOUS" doctor "$p10"
sethook "$p10/.claude/settings.json" '"${CLAUDE_PROJECT_DIR}"/.claude/hooks/sous-guard.sh' -
expect "matcher absent means every tool" 0 python3 "$SOUS" doctor "$p10"
mv "$p10/.claude/settings.json" "$WORK/linked.json" && ln -s "$WORK/linked.json" "$p10/.claude/settings.json"
python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d["permissions"]["deny"].remove("Read(.env)"); json.dump(d,open(p,"w"))' "$WORK/linked.json"
expect "install through a symlinked settings file" 0 python3 "$SOUS" install "$p10"
expect "symlink kept, target updated" 0 sh -c 'test -L "$1" && grep -q "Read(.env)" "$2"' _ "$p10/.claude/settings.json" "$WORK/linked.json"

# Rot: a rule for a script run through an interpreter, not just a ./script.
cp "$WORK/clean.json" "$p6/.claude/settings.json"
addrule "$p6/.claude/settings.json" allow "Bash(python3 tools/gen.py:*)"
expect "doctor flags interpreter rule for missing script" 1 python3 "$SOUS" doctor "$p6"
mkdir -p "$p6/tools" && touch "$p6/tools/gen.py"
addrule "$p6/.claude/settings.json" allow "Bash(python3 -m http.server)"
addrule "$p6/.claude/settings.json" allow "Bash(npm run build:*)"
addrule "$p6/.claude/settings.json" allow 'Bash("$CLAUDE_PROJECT_DIR"/scripts/gone.sh)'
expect "module, package script and project-var rules pass" 0 python3 "$SOUS" doctor "$p6"

# Table cache: only a clean pass recorded by doctor reads as green.
mkdir -p "$WORK/home2/.claude"
nonci() { env -u CI -u GITHUB_ACTIONS HOME="$WORK/home2" "$@"; }
expect "doctor outside CI writes the cache" 0 nonci python3 "$SOUS" doctor "$p1"
expect "second run uses it" 0 sh -c 'env -u CI HOME="$1" python3 "$2" doctor "$3" | grep -q "(cached, unchanged)"' _ "$WORK/home2" "$SOUS" "$p1"
for f in "$XDG_CACHE_HOME"/sous/tables-*; do printf 'sous-guard: trust me\nadversarial: trust me\n' > "$f"; done
expect "forged cache is ignored" 0 sh -c '! env -u CI HOME="$1" python3 "$2" doctor "$3" | grep -q "trust me"' _ "$WORK/home2" "$SOUS" "$p1"
expect "CI never trusts the cache" 0 sh -c '! python3 "$1" doctor "$2" | grep -q "(cached"' _ "$SOUS" "$p1"
printf '{"permissions": \n' > "$WORK/home2/.claude/settings.json"
expect "broken user settings: clean FAIL" 1 notrace nonci python3 "$SOUS" doctor "$p1"
expect "broken user settings named" 0 grep -q "user settings unreadable" "$WORK/nt.txt"
rm "$WORK/home2/.claude/settings.json"

# Usage errors exit 64 instead of being ignored.
expect "unknown option" 64 python3 "$SOUS" doctor "$p1" --stirct
expect "option for another command" 64 python3 "$SOUS" check "$p1" --dry-run
expect "missing directory" 64 python3 "$SOUS" doctor "$WORK/nope"
expect "two directories" 64 python3 "$SOUS" doctor "$p1" "$p2"
expect "bad --days" 64 notrace python3 "$SOUS" report --days=abc
expect "unknown command" 64 python3 "$SOUS" frobnicate
expect "version matches plugin.json" 0 sh -c '[ "$(python3 "$1" --version)" = "sous $(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))[\"version\"])" "$2")" ]' _ "$SOUS" "$HERE/../.claude-plugin/plugin.json"
expect "version matches the guard stamp" 0 sh -c '[ "$(python3 "$1" --version)" = "sous $(bash "$2" --version | cut -d" " -f2)" ]' _ "$SOUS" "$HERE/../hooks/sous-guard.sh"

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
