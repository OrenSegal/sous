#!/bin/sh
# Builds ./app: a clone of a local bare "remote" (./remote.git) with two
# agent branches, each in its own worktree under ./app-worktrees/:
#   agent/docs  merged on the remote -> stale
#   agent/wip   not merged           -> keep
# Runs in the empty eval workspace. No network.
set -eu

export GIT_AUTHOR_NAME=Dev GIT_AUTHOR_EMAIL=dev@example.com
export GIT_COMMITTER_NAME=Dev GIT_COMMITTER_EMAIL=dev@example.com
export GIT_CONFIG_NOSYSTEM=1

ws=$(pwd -P)
git init -q --bare -b main "$ws/remote.git"
git clone -q "$ws/remote.git" "$ws/app" 2>/dev/null
cd "$ws/app"
echo "app" > README.md
git add README.md
git commit -q -m "initial"
git push -q -u origin main

for b in docs wip; do
  wt="$ws/app-worktrees/$b"
  git worktree add -q -b "agent/$b" "$wt" main
  echo "$b" > "$wt/$b.txt"
  git -C "$wt" add "$b.txt"
  git -C "$wt" commit -q -m "agent/$b work"
  git -C "$wt" push -q -u origin "agent/$b"
done

git clone -q "$ws/remote.git" "$ws/.merger" 2>/dev/null
git -C "$ws/.merger" merge -q --no-ff -m "Merge agent/docs" origin/agent/docs
git -C "$ws/.merger" push -q origin main
git fetch -q origin
