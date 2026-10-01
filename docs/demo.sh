#!/usr/bin/env bash
# Feed a few commands to the real guard and print what Claude Code would see.
# Regenerate the README capture with: bash docs/demo.sh > docs/demo.txt
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export SOUS_LOG=off
while IFS= read -r c; do
  printf '$ %s\n' "$c"
  out=$(python3 -c 'import json,sys; print(json.dumps({"tool_input": {"command": sys.argv[1]}}))' "$c" \
    | bash "$HERE/../hooks/sous-guard.sh" 2>&1)
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  printf '  exit %s\n\n' "$rc"
done <<'CASES'
/bin/rm -rf build
git -C . push -f origin main
sh -c 'cat .env'
git status && ls src
CASES
