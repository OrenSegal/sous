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
trap 'rm -f "$SOUS_LOG"; rmdir "$SANDBOX_DIR"' EXIT
pass=0
fail=0

# $1 = expected exit (0 allow, 2 block), $2 = command text
check() {
  local want="$1" cmd="$2" got payload
  payload=$(jq -cn --arg c "$cmd" '{tool_input:{command:$c}}')
  (cd "$SANDBOX_DIR" && printf '%s' "$payload" | CLAUDE_TOOL_INPUT='' perl -e 'alarm 5; exec @ARGV' bash "$HOOK" >/dev/null 2>&1)
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
check 0 './scripts/dev/prune-worktrees.sh --dry-run'

# Force push, every spelling.
check 2 'git push --force origin dev'
check 2 'git push -f origin dev'
check 2 'git push origin dev --force-with-lease'
check 2 'git push origin +dev'
check 2 'git -C . push -f origin dev'
# Normal pushes stay allowed.
check 0 'git push origin chore/sous-harness'
check 0 'git push -u origin chore/sous-harness'
check 0 'git push --follow-tags origin dev'

# Secrets dumps.
check 2 'cat .env'
check 2 'cat ./.env'
check 2 'head -5 .env.bootstrap'
check 2 'grep TOKEN website/.env.local'
check 2 "cat \".env\""
# Docs and non-reading commands stay allowed.
check 0 'cat .env.example'
check 0 'grep SUPABASE .env.example'
check 0 'ls -la .env*'
check 0 'git status --short .env.example'

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

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
