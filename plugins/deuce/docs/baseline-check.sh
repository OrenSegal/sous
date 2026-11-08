#!/usr/bin/env bash
# Reproduces three rows of the README comparison table for the two built-in cleanups, in a
# throwaway repository with a bare remote. No gh involved. Prints what each method did.
set -euo pipefail
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git init -q --bare "$T/remote.git"
git clone -q "$T/remote.git" "$T/app" 2>/dev/null; cd "$T/app"
git config user.email t@t; git config user.name t; git checkout -qb main
echo base > f; git add f; git commit -qm base; git push -q origin main

mkbranch() { # name, with a worktree under $T/wt-name
  git checkout -q main; git checkout -qb "$1"; echo "$1" > "$1.txt"; git add .; git commit -qm "$1"
  git push -q -u origin "$1" 2>/dev/null; git checkout -q main; git worktree add -q "$T/wt-$1" "$1"
}
squash() { git merge --squash -q "$1" >/dev/null; git commit -qm "squash $1"; git push -q origin main; git push -q origin --delete "$1"; }

mkbranch squashed; squash squashed
mkbranch dirty; squash dirty; echo precious > "$T/wt-dirty/notes.md"
git fetch -q --prune

echo "--merged + -d:"
for b in $(git branch --merged main --format='%(refname:short)' | grep -v '^main$'); do
  git worktree remove "$T/wt-$b" 2>&1 | sed 's/^/  /' || true; git branch -d "$b" 2>&1 | sed 's/^/  /' || true
done
echo "  left: $(git branch --format='%(refname:short)' | grep -v '^main$' | tr "\n" " ")"

echo "[gone] + worktree remove --force + -D:"
for b in $(git for-each-ref refs/heads --format='%(refname:short) %(upstream:track)' | awk '$2=="[gone]"{print $1}'); do
  [ -f "$T/wt-$b/notes.md" ] && echo "  $b has uncommitted notes.md"
  git worktree remove --force "$T/wt-$b"; git branch -D "$b" >/dev/null; echo "  deleted $b"
done
echo "  left: $(git branch --format='%(refname:short)' | grep -v '^main$' | tr "\n" " ")"
