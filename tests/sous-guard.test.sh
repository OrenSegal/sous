#!/usr/bin/env bash
# Table tests for hooks/sous-guard.sh:
# recursive force delete, force push, and .env dumps, in the spellings the
# settings.json Bash deny rules can't see (absolute path, sh -c, git -C).
# Runs on bash 3.2 (no mapfile / declare -A).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SOUS_GUARD_HOOK:-$HERE/../hooks/sous-guard.sh}"  # override to test another revision
case "$HOOK" in /*) ;; *) HOOK="$PWD/$HOOK" ;; esac
# Run the hook outside any git tree, so a host that wraps it in a bigger
# PreToolUse script (other git guards) can't change the exit codes below.
SANDBOX_DIR=$(mktemp -d "${TMPDIR:-/tmp}/sous-test.XXXXXX") || exit 1  # macOS bare mktemp ignores TMPDIR
export SOUS_LOG="$SANDBOX_DIR/blocks.tsv"   # never write the real block log from tests
trap 'rm -f "$SOUS_LOG" "$SOUS_LOG".allowed.*; rmdir "$SANDBOX_DIR"' EXIT
pass=0
fail=0

# $1 = expected exit (0 allow, 2 block), $2 = command text
check() {
  local want="$1" cmd="$2" got payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  # 15s: 5s flaked (SIGALRM, exit 142) on loaded macOS CI runners
  (cd "$SANDBOX_DIR" && printf '%s' "$payload" | CLAUDE_TOOL_INPUT='' perl -e 'alarm 15; exec @ARGV' "$BASH" "$HOOK" >/dev/null 2>&1)
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL want=%s got=%s :: %s\n' "$want" "$got" "$cmd" >&2
  fi
}

# Recursive force delete, every spelling.
check 2 'rm -rf build'
check 2 'rm -fr build'
check 2 'rm -Rf build'
check 2 'rm -r -f build'
check 2 'rm -f -r build'
check 2 '/bin/rm -rf build'
check 2 "sh -c 'rm -rf build'"
check 2 'cd ios && rm -rf .build'
# Plain deletes stay allowed.
check 0 'rm -f /tmp/x.log'
check 0 'rm -r emptydir'
check 0 'rm file.txt'
check 0 './scripts/clean-build.sh --dry-run'

# Force push, every spelling.
check 2 'git push --force origin dev'
check 2 'git push -f origin dev'
check 2 'git push origin dev --force-with-lease'
check 2 'git push origin +dev'
check 2 'git -C . push -f origin dev'
# Normal pushes stay allowed.
check 0 'git push origin feature/login'
check 0 'git push -u origin feature/login'
check 0 'git push --follow-tags origin dev'

# Secrets dumps.
check 2 'cat .env'
check 2 'cat ./.env'
check 2 'head -5 .env.bootstrap'
check 2 'grep TOKEN web/.env.local'
check 2 "cat \".env\""
# Docs and non-reading commands stay allowed.
check 0 'cat .env.example'
check 0 'grep SUPABASE .env.example'
check 0 'ls -la .env*'
check 0 'git status --short .env.example'
# A name that only starts with the same letters is not a secrets file.
check 0 'rg -n ".environment(AppEnvironment.makePreview())" ios/App'
check 0 'grep -rn "\.environmentObject" ios'
check 0 'cat docs/.envelope-notes.md'
check 2 'cat .envrc'
check 2 'cat .env-prod'
check 2 'cat .env_old'
check 2 'cat .envr*'
# A quoted regex handed to a search tool is a pattern, not a glob.
check 0 'rg -n "Suite .*Tests" ios/Packages'
check 0 "grep -E '.*Service' Sources/A.swift"
check 0 'rg -n ".*" README.md'
check 0 "rg -c '.?' README.md"
# A quoted | ; & is part of the regex, not the end of the command.
check 0 'rg -n "struct Foo|Suite .*" ios/Packages'
check 0 'rg -n "func test.*|Test .*" ios'
check 0 "grep -En 'a;.*|b&.*' notes.md"
check 2 'rg -n "a|b" x | grep TOKEN .e*'
check 2 "rg -n 'a;b' x; cat .e*"
# An unquoted glob still expands, and so does a quoted one that a program globs itself.
check 2 'grep TOKEN .e*'
check 2 'rg KEY .*'
check 2 'grep TOKEN ".e"*'
check 2 "grep TOKEN '.e*' .e*"
check 2 'rg -g ".e*" KEY'
check 2 "grep -r --include '.e*' KEY ."
check 2 "find . -name '.e*' -exec cat {} +"
check 2 "cat '.e*' .e*"
check 2 "sh -c 'grep TOKEN .e*'"
check 2 "echo ok; sh -c 'true; grep TOKEN .e*'"
check 2 'echo "$(grep TOKEN .e*)"'
check 2 "echo hi # don't
grep TOKEN .e* # it's"

# Heredoc bodies are data (commit messages, docs), not commands...
check 0 "git commit -F - <<'MSG'
docs: explain why rm -rf and git push --force are denied
MSG"
check 0 "cat > notes.md <<EOF
never cat .env in a session
EOF"
# ...unless the heredoc feeds a shell, and text after the delimiter still counts.
check 2 "bash <<'EOF'
rm -rf build
EOF"
check 2 "cat <<'EOF' | bash
rm -rf build
EOF"
check 2 "cat <<EOF | sh
git push -f origin dev
EOF"
check 2 "cat > x.txt <<EOF
harmless
EOF
rm -rf build"

# The block log's third column names the project, so `sous gate` and `sous fleet`
# can tell worktrees apart: $CLAUDE_PROJECT_DIR, else the hook's working directory.
# A tab or newline in it would break the row, so they become spaces.
: >"$SOUS_LOG"
unset CLAUDE_PROJECT_DIR
CLAUDE_PROJECT_DIR=$'/w/one\ttwo\nthree' check 2 'rm -rf build'
check 2 'rm -rf build'
want=$(printf '/w/one two three\n%s' "$(cd "$SANDBOX_DIR" && pwd)")
if [ "$(cut -f3 "$SOUS_LOG")" = "$want" ] && [ "$(wc -l <"$SOUS_LOG")" -eq 2 ]; then pass=$((pass + 1)); else
  fail=$((fail + 1)); printf 'FAIL block log path column: want\n%s\ngot:\n' "$want" >&2; cat "$SOUS_LOG" >&2
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
