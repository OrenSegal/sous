"""Is this branch merged into base, and how do we know?

With `gh` on PATH, GitHub's pull request record comes first: it is the only
way to see a squash merge, and its doubts (several PRs, a closed PR, a PR into
another branch) stop deuce. With no `gh`, no PR, or a failing `gh`, git is
asked instead: is the tip an ancestor of base, or does `git cherry` find an
equivalent of every commit? The answer always says which evidence was used."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass

from deuce.gitrepo import Repo

PR_FIELDS = "number,state,headRefOid,baseRefName,url"


@dataclass(frozen=True)
class Evidence:
    rule: str                 # a plan.RULES id: "merged" or why not
    reason: str = ""          # for a rule other than "merged"
    kind: str | None = None   # "pr", "ancestor" or "cherry" when merged
    source: str | None = None  # "gh" or "git"
    pr: int | None = None
    squash: bool = False
    pr_head: str | None = None
    detail: str = ""

    def as_json(self) -> dict:
        return {"kind": self.kind, "source": self.source, "pr": self.pr, "squash": self.squash, "detail": self.detail}


NONE = Evidence(rule="")


class GhError(Exception):
    pass


class GitHub:
    """`gh pr list`, from the repository root so gh picks the repo from its
    remotes. A failure is remembered, so a logged-out gh costs one call."""

    def __init__(self, cwd: str, path: str | None = None) -> None:
        self.cwd = cwd
        self.path = path if path is not None else shutil.which("gh")
        self._failure: GhError | None = None

    @property
    def available(self) -> bool:
        return bool(self.path)

    def prs(self, branch: str) -> list[dict]:
        if self._failure:
            raise self._failure
        argv = [self.path, "pr", "list", "--state", "all", "--head", branch, "--json", PR_FIELDS, "--limit", "10"]
        env = dict(os.environ, GH_PROMPT_DISABLED="1", NO_COLOR="1", GH_NO_UPDATE_NOTIFIER="1")
        try:
            proc = subprocess.run(argv, cwd=self.cwd, capture_output=True, text=True, timeout=60, env=env,
                                  stdin=subprocess.DEVNULL)
        except (OSError, subprocess.TimeoutExpired) as exc:
            self._failure = GhError(str(exc))
            raise self._failure from exc
        if proc.returncode != 0:
            message = " ".join((proc.stderr or proc.stdout).split())[:300] or f"exit {proc.returncode}"
            self._failure = GhError(message)
            raise self._failure
        try:
            prs = json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            raise GhError(f"unreadable output: {proc.stdout[:100]!r}") from exc
        if not isinstance(prs, list) or not all(isinstance(pr, dict) for pr in prs):
            raise GhError("unexpected output shape")
        return prs


def short_ref(ref: str) -> str:
    for prefix in ("refs/remotes/", "refs/heads/"):
        if ref.startswith(prefix):
            return ref[len(prefix):]
    return ref


def find(repo: Repo, gh: GitHub, branch: str, tip: str, base: str, base_ref: str) -> Evidence:
    if gh.available:
        try:
            prs = gh.prs(branch)
        except GhError as exc:
            note = f"gh failed ({exc}), so git was asked instead"
        else:
            if prs:
                return _from_prs(repo, prs, tip, base, base_ref)
            note = "gh found no pull request for this branch"
    else:
        note = "gh not found, so a squash merge cannot be seen"
    return _from_git(repo, tip, base_ref, note)


def _from_prs(repo: Repo, prs: list[dict], tip: str, base: str, base_ref: str) -> Evidence:
    if len(prs) > 1:
        numbers = ", ".join(f"#{pr.get('number')} {str(pr.get('state', '')).lower()}" for pr in prs)
        return Evidence("pr-ambiguous", f"gh lists {len(prs)} pull requests for this branch ({numbers}); "
                                        "deuce will not guess which one counts", source="gh")
    pr = prs[0]
    number, state, into = pr.get("number"), str(pr.get("state", "")).upper(), pr.get("baseRefName")
    if state == "OPEN":
        return Evidence("pr-open", f"PR #{number} is open", source="gh", pr=number)
    if state == "CLOSED":
        return Evidence("pr-closed", f"PR #{number} was closed without merging", source="gh", pr=number)
    if state != "MERGED":
        return Evidence("pr-ambiguous", f"PR #{number} is in state {state or 'unknown'}", source="gh", pr=number)
    if into != base:
        return Evidence("pr-other-base", f"PR #{number} was merged into {into}, not {base}", source="gh", pr=number)
    head = pr.get("headRefOid") or None
    squash = not repo.is_ancestor(tip, base_ref)
    how = "squash or rebase merged" if squash else "merged"
    return Evidence("merged", kind="pr", source="gh", pr=number, squash=squash, pr_head=head,
                    detail=f"PR #{number} {how} into {base} (gh)")


def _from_git(repo: Repo, tip: str, base_ref: str, note: str) -> Evidence:
    shown = short_ref(base_ref)
    if repo.is_ancestor(tip, base_ref):
        return Evidence("merged", kind="ancestor", source="git", detail=f"tip is an ancestor of {shown}; {note}")
    if repo.all_patches_upstream(base_ref, tip):
        return Evidence("merged", kind="cherry", source="git",
                        detail=f"git cherry finds every commit on {shown}; {note}")
    return Evidence("not-merged", f"not merged into {shown} ({note})", source="git")
