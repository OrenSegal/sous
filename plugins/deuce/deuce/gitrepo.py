"""Everything deuce asks git. Reads only; the commands that change things are
built by plan.py and run by execute.py through `Repo.git`."""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass


class NotARepo(Exception):
    pass


@dataclass(frozen=True)
class Result:
    code: int
    out: str
    err: str

    @property
    def ok(self) -> bool:
        return self.code == 0


@dataclass(frozen=True)
class Worktree:
    path: str               # resolved with os.path.realpath
    head: str | None
    branch: str | None      # short name, None when detached
    is_main: bool
    locked: str | None      # the lock reason ("" when locked without one)
    prunable: bool
    bare: bool = False

    def contains(self, path: str) -> bool:
        return path == self.path or path.startswith(self.path.rstrip(os.sep) + os.sep)


def real(path: str) -> str:
    return os.path.realpath(path)


class Repo:
    def __init__(self, start: str) -> None:
        start = real(start)
        if not os.path.isdir(start):
            raise NotARepo(f"{start}: not a git repository (no such directory)")
        probe = _run(["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], start)
        if not probe.ok:
            raise NotARepo(f"{start}: not a git repository (or a bare one)")
        top, common = probe.out.splitlines()[:2]
        self.root = real(top)
        self.common_dir = real(common)

    # -- plumbing ---------------------------------------------------------
    def git(self, *args: str, cwd: str | None = None) -> Result:
        return _run(list(args), cwd or self.root)

    def rev(self, ref: str) -> str | None:
        result = self.git("rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}")
        return result.out.strip() if result.ok else None

    def is_ancestor(self, older: str, newer: str) -> bool:
        return self.git("merge-base", "--is-ancestor", older, newer).ok

    def has_remote(self, remote: str) -> bool:
        return self.git("remote", "get-url", "--", remote).ok

    # -- branches ---------------------------------------------------------
    def branches(self) -> list[tuple[str, str]]:
        out = self.git("for-each-ref", "--format=%(refname)%00%(objectname)", "refs/heads").out
        pairs = []
        for line in out.splitlines():
            ref, sha = line.split("\0")
            pairs.append((ref.removeprefix("refs/heads/"), sha))
        return pairs

    def upstream(self, branch: str) -> str | None:
        """The configured upstream ref, only if it still resolves."""
        out = self.git("for-each-ref", "--format=%(upstream)", f"refs/heads/{branch}").out.strip()
        return out if out and self.rev(out) else None

    def head(self) -> str | None:
        return self.rev("HEAD")

    def created_only(self, branch: str) -> bool:
        """True when the branch's reflog has nothing but its creation: no
        commit, merge, reset or pull has moved it since."""
        result = self.git("reflog", "show", "--format=%gs", f"refs/heads/{branch}", "--")
        entries = result.out.splitlines() if result.ok else []
        return bool(entries) and all(e.startswith("branch: Created from") for e in entries)

    def all_patches_upstream(self, upstream: str, branch: str) -> bool:
        """`git cherry`: every commit on the branch has an equivalent patch
        on upstream (a rebase merge, or a squash of a single commit)."""
        result = self.git("cherry", upstream, branch)
        lines = result.out.split("\n") if result.ok and result.out.strip() else []
        return bool(lines) and all(line.startswith("-") for line in lines if line)

    # -- worktrees ------------------------------------------------------------
    def worktrees(self) -> list[Worktree]:
        out = self.git("worktree", "list", "--porcelain").out
        found, block = [], {}
        for line in out.splitlines() + [""]:
            if not line:
                if block:
                    found.append(_worktree(block, is_main=not found))
                block = {}
                continue
            key, _, value = line.partition(" ")
            block[key] = value
        return found

    def changes(self, path: str, *, untracked: bool = True) -> list[str]:
        """Uncommitted (and, by default, untracked) paths; ignored files excluded."""
        mode = "--untracked-files=all" if untracked else "--untracked-files=no"
        result = self.git("status", "--porcelain", mode, cwd=path)
        return result.out.splitlines() if result.ok else ["(git status failed: " + result.err.strip() + ")"]

    def ignored(self, path: str) -> list[str]:
        result = self.git("status", "--porcelain", "--ignored", cwd=path)
        return [line[3:] for line in result.out.splitlines() if line.startswith("!! ")]


def _worktree(block: dict[str, str], *, is_main: bool) -> Worktree:
    branch = block.get("branch")
    return Worktree(
        path=real(block["worktree"]),
        head=block.get("HEAD"),
        branch=branch.removeprefix("refs/heads/") if branch else None,
        is_main=is_main,
        locked=block.get("locked") if "locked" in block else None,
        prunable="prunable" in block,
        bare="bare" in block,
    )


def _run(args: list[str], cwd: str) -> Result:
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", LC_ALL="C")
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=env,
                          stdin=subprocess.DEVNULL)
    return Result(proc.returncode, proc.stdout, proc.stderr)
