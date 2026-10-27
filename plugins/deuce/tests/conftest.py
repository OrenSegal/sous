"""Shared test setup. Every test runs against throwaway git repositories in a
temp dir, with a local bare repository standing in for the remote, an empty
global git config, a temp DEUCE_STATE_DIR and a PATH that holds only the tools
the suite needs. `gh` is never the real one: the `fake_gh` fixture puts a shim
from tests/fakes/ on PATH, and without it there is no `gh` at all (CI runners
ship a real one in /usr/bin, so PATH is built from symlinks, not trimmed)."""

from __future__ import annotations

import json
import os
import pathlib
import shutil
import subprocess
import sys
from dataclasses import dataclass, field

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
FAKES = ROOT / "tests" / "fakes"
sys.path.insert(0, str(ROOT))

from deuce import cli  # noqa: E402

TOOLS = ("git", "dirname", "readlink")


@pytest.fixture(autouse=True)
def isolated_env(tmp_path_factory, monkeypatch):
    tools = tmp_path_factory.mktemp("tools")
    for name in TOOLS:
        real = shutil.which(name)
        assert real, f"{name} is needed to run the tests"
        (tools / name).symlink_to(real)
    (tools / "python3").symlink_to(sys.executable)
    home = tmp_path_factory.mktemp("home")
    gitconfig = home / "gitconfig"
    gitconfig.write_text("")
    for key in list(os.environ):
        if key.startswith(("GIT_", "DEUCE_", "FAKE_GH_")):
            monkeypatch.delenv(key)
    monkeypatch.setenv("PATH", str(tools))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(gitconfig))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    for role in ("AUTHOR", "COMMITTER"):
        monkeypatch.setenv(f"GIT_{role}_NAME", "Test")
        monkeypatch.setenv(f"GIT_{role}_EMAIL", "test@example.com")
    monkeypatch.setenv("DEUCE_STATE_DIR", str(home / "state"))
    return home


def git(cwd, *args, check=True) -> str:
    proc = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise AssertionError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr}")
    return proc.stdout.strip()


@dataclass
class FakeGh:
    """Canned `gh pr list` answers per head branch, and a log of every call."""
    dir: pathlib.Path
    monkeypatch: pytest.MonkeyPatch
    prs: dict[str, list[dict]] = field(default_factory=dict)

    def add(self, branch: str, number: int, state: str, head: str, base: str = "main") -> None:
        self.prs.setdefault(branch, []).append({
            "number": number, "state": state, "headRefOid": head, "baseRefName": base,
            "url": f"https://github.test/o/r/pull/{number}"})
        (self.dir / "prs.json").write_text(json.dumps(self.prs))

    def fail(self, message: str) -> None:
        self.monkeypatch.setenv("FAKE_GH_FAIL", message)

    @property
    def calls(self) -> list[list[str]]:
        log = self.dir / "calls.jsonl"
        if not log.exists():
            return []
        return [json.loads(line) for line in log.read_text().splitlines()]


@pytest.fixture
def fake_gh(tmp_path_factory, monkeypatch):
    shim = tmp_path_factory.mktemp("ghbin")
    (shim / "gh").symlink_to(FAKES / "gh")
    data = tmp_path_factory.mktemp("ghdata")
    (data / "prs.json").write_text("{}")
    monkeypatch.setenv("PATH", f"{shim}{os.pathsep}{os.environ['PATH']}")
    monkeypatch.setenv("FAKE_GH_PRS", str(data / "prs.json"))
    monkeypatch.setenv("FAKE_GH_LOG", str(data / "calls.jsonl"))
    return FakeGh(data, monkeypatch)


class Sandbox:
    """A bare 'remote', a clone of it with `main` checked out, and helpers
    to make branches, worktrees and the three kinds of merge."""

    def __init__(self, base: pathlib.Path) -> None:
        self.base = base.resolve()
        self.remote = self.base / "remote.git"
        self.repo = self.base / "repo"
        git(self.base, "init", "--bare", "-b", "main", str(self.remote))
        git(self.base, "clone", str(self.remote), str(self.repo))
        self.commit(self.repo, "README", "hello\n", "initial")
        git(self.repo, "push", "-u", "origin", "main")

    # -- building blocks --------------------------------------------------
    def commit(self, cwd, name: str, content: str, message: str) -> str:
        path = pathlib.Path(cwd) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        git(cwd, "add", name)
        git(cwd, "commit", "-q", "-m", message)
        return git(cwd, "rev-parse", "HEAD")

    def worktree_path(self, branch: str) -> pathlib.Path:
        return self.base / "wt" / branch.replace("/", "-")

    def feature(self, branch: str, *, worktree: bool = True, push: bool = True, commits: int = 1) -> str:
        """A branch off main with its own commits, optionally in a linked
        worktree and pushed with upstream tracking. Returns the tip sha."""
        if worktree:
            where = self.worktree_path(branch)
            git(self.repo, "worktree", "add", "-q", "-b", branch, str(where), "main")
        else:
            git(self.repo, "branch", branch, "main")
            where = self.base / "scratch"
            if not where.exists():
                git(self.repo, "worktree", "add", "-q", "--detach", str(where), "main")
            git(where, "switch", "-q", branch)
        for i in range(commits):
            self.commit(where, f"{branch.replace('/', '-')}-{i}.txt", f"{branch} {i}\n", f"{branch} commit {i}")
        if push:
            git(where, "push", "-q", "-u", "origin", branch)
        tip = git(where, "rev-parse", "HEAD")
        if not worktree:
            git(where, "switch", "-q", "--detach", "main")
        return tip

    def merge(self, branch: str) -> None:
        """A merge commit on the remote's main (the GitHub 'merge' button)."""
        self._on_remote_main(lambda w: git(w, "merge", "-q", "--no-ff", "-m", f"Merge {branch}", f"origin/{branch}"))

    def squash(self, branch: str) -> None:
        """A squash merge on the remote's main (the GitHub 'squash' button)."""
        def do(w):
            git(w, "merge", "-q", "--squash", f"origin/{branch}")
            git(w, "commit", "-q", "-m", f"{branch} (squashed)")
        self._on_remote_main(do)

    def rebase_merge(self, branch: str) -> None:
        """Every commit replayed onto main (the GitHub 'rebase' button)."""
        def do(w):
            commits = git(w, "rev-list", "--reverse", f"origin/main..origin/{branch}").split()
            self.commit(w, f"main-before-{branch.replace('/', '-')}.txt", "main moved\n", "main moved on")
            for sha in commits:
                git(w, "cherry-pick", sha)
        self._on_remote_main(do)

    def _on_remote_main(self, change) -> None:
        other = self.base / "upstream-clone"
        if not other.exists():
            git(self.base, "clone", "-q", str(self.remote), str(other))
        git(other, "fetch", "-q", "origin")
        git(other, "checkout", "-q", "-B", "main", "origin/main")
        change(other)
        git(other, "push", "-q", "origin", "main")

    def fetch(self) -> None:
        git(self.repo, "fetch", "-q", "origin")

    def delete_on_remote(self, branch: str) -> None:
        """What GitHub's 'delete branch after merge' does."""
        git(self.base, "--git-dir", str(self.remote), "update-ref", "-d", f"refs/heads/{branch}")

    # -- queries -----------------------------------------------------------
    def local_branches(self) -> set[str]:
        return set(git(self.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads").split())

    def remote_branches(self) -> set[str]:
        out = git(self.base, "--git-dir", str(self.remote), "for-each-ref", "--format=%(refname:short)", "refs/heads")
        return set(out.split())

    def worktrees(self) -> set[str]:
        out = git(self.repo, "worktree", "list", "--porcelain")
        return {line.split(" ", 1)[1] for line in out.splitlines() if line.startswith("worktree ")}

    def tip(self, ref: str) -> str:
        return git(self.repo, "rev-parse", ref)


@pytest.fixture
def sandbox(tmp_path) -> Sandbox:
    return Sandbox(tmp_path)


def run(capsys, *argv: str) -> tuple[int, str, str]:
    code = cli.main(list(argv))
    captured = capsys.readouterr()
    return code, captured.out, captured.err


def run_json(capsys, *argv: str) -> tuple[int, dict]:
    code, out, err = run(capsys, *argv, "--json")
    try:
        return code, json.loads(out)
    except json.JSONDecodeError as exc:  # pragma: no cover - debugging aid
        raise AssertionError(f"not JSON: {out!r} {err!r}") from exc


def by_branch(report: dict) -> dict[str, dict]:
    return {b["branch"]: b for b in report["branches"]}
