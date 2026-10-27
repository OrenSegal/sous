"""Decide, for every local branch, whether to sweep, keep or refuse it, and
build the exact git commands a sweep would run. Nothing here changes the
repository; the dry run, `status` and `--apply` all start from this plan."""

from __future__ import annotations

import os
import shlex
from dataclasses import dataclass, field

from deuce import evidence
from deuce.config import protected_by
from deuce.evidence import Evidence, GitHub, short_ref
from deuce.gitrepo import Repo, Worktree

# Every reason a branch ends up where it does: id -> (decision, description).
# README's "Rules" table and SKILL.md are checked against this by the tests.
RULES: dict[str, tuple[str, str]] = {
    "merged": ("sweep", "merged into base by PR, ancestry or git cherry, and every check below passed"),
    "base": ("keep", "the base branch itself"),
    "protected": ("keep", "matches a protected name or pattern"),
    "no-commits": ("keep", "created and never moved, and not on the remote: a fresh agent branch"),
    "not-merged": ("keep", "no evidence that it is merged"),
    "pr-open": ("keep", "its pull request is still open"),
    "pr-ambiguous": ("refuse", "gh lists more than one pull request, or one in an unknown state"),
    "pr-closed": ("refuse", "its pull request was closed without merging"),
    "pr-other-base": ("refuse", "its pull request was merged into another branch"),
    "main-worktree": ("refuse", "checked out in the main worktree"),
    "running-from": ("refuse", "its worktree holds the directory deuce runs from"),
    "locked": ("refuse", "its worktree is locked (`git worktree lock`)"),
    "missing-worktree": ("refuse", "its worktree directory is gone; the metadata is pruned at the end of `--apply`"),
    "dirty": ("refuse", "its worktree has uncommitted or untracked changes"),
    "pr-unpushed": ("refuse", "it has commits that are not in the merged pull request"),
    "remote-ahead": ("refuse", "the remote branch has commits that are neither on it nor merged"),
    "safe-delete": ("refuse", "`git branch -d` would refuse it (and the force delete is not allowed)"),
}

PLANNED, DONE, FAILED, SKIPPED = "planned", "done", "failed", "skipped"


@dataclass
class Action:
    kind: str
    args: list[str]               # git arguments
    cwd: str
    status: str = PLANNED
    detail: str = ""
    path: str = ""                # the worktree, for remove-worktree
    sha: str = ""                 # what the action removes or moves to

    @property
    def command(self) -> str:
        return shlex.join(["git", *self.args]) if self.args else ""

    def as_json(self) -> dict:
        return {"kind": self.kind, "command": self.command, "status": self.status, "detail": self.detail}


@dataclass
class BranchPlan:
    branch: str
    tip: str
    worktree: str | None
    rule: str = ""
    reason: str = ""
    evidence: Evidence = evidence.NONE
    actions: list[Action] = field(default_factory=list)

    @property
    def decision(self) -> str:
        return RULES[self.rule][0]

    def decide(self, rule: str, reason: str = "") -> BranchPlan:
        assert rule in RULES, rule
        self.rule, self.reason = rule, reason
        if self.decision != "sweep":
            self.actions = []
        return self

    def as_json(self) -> dict:
        return {"branch": self.branch, "tip": self.tip, "worktree": self.worktree, "decision": self.decision,
                "rule": self.rule, "reason": self.reason, "evidence": self.evidence.as_json(),
                "actions": [a.as_json() for a in self.actions]}


@dataclass(frozen=True)
class Context:
    repo: Repo
    base: str
    base_ref: str                 # full ref: refs/remotes/<remote>/<base>, or refs/heads/<base>
    remote: str
    has_remote: bool
    protect: tuple[str, ...]
    cwd: str
    gh: GitHub


@dataclass
class Plan:
    ctx: Context
    branches: list[BranchPlan]
    finish: list[Action]
    notes: list[str]


class UsageError(Exception):
    pass


def context(repo: Repo, base: str, remote: str, protect: tuple[str, ...], cwd: str, gh: GitHub) -> Context:
    has_remote = repo.has_remote(remote)
    candidates = ([f"refs/remotes/{remote}/{base}"] if has_remote else []) + [f"refs/heads/{base}"]
    base_ref = next((ref for ref in candidates if repo.rev(ref)), None)
    if base_ref is None:
        raise UsageError(f"base branch '{base}' not found (looked for {' and '.join(candidates)})")
    return Context(repo, base, base_ref, remote, has_remote, protect, os.path.realpath(cwd), gh)


def build(ctx: Context) -> Plan:
    worktrees = ctx.repo.worktrees()
    by_branch: dict[str, Worktree] = {}
    notes = []
    for wt in worktrees:
        if wt.branch:
            by_branch.setdefault(wt.branch, wt)
        elif not wt.bare:
            notes.append(f"worktree {wt.path} has a detached HEAD; skipped (deuce cleans up branches only)")
    if not ctx.has_remote:
        notes.append(f"no remote '{ctx.remote}': local steps only (no remote branch delete, fetch or fast-forward)")
    head_ff = _head_fast_forward(ctx)
    branches = [decide(ctx, name, tip, by_branch.get(name), head_ff) for name, tip in ctx.repo.branches()]
    steps = finish(ctx)
    if any(a.kind == "fast-forward" for bp in branches for a in bp.actions):
        steps[1].detail = (f"runs first, before the branches above that need it; here it runs again only if the "
                           f"fetch moves {short_ref(ctx.base_ref)}")
    return Plan(ctx, branches, steps, notes)


def _head_fast_forward(ctx: Context) -> Action | None:
    """The base fast-forward, when base is what HEAD is at the repository root.
    That HEAD is what `git branch -d` checks a branch with no upstream against,
    so a planned fast-forward run first lets it see a merge it would miss."""
    head = ctx.repo.git("symbolic-ref", "-q", "HEAD").out.strip()
    return fast_forward(ctx) if head == f"refs/heads/{ctx.base}" else None


def decide(ctx: Context, name: str, tip: str, wt: Worktree | None, head_ff: Action | None = None) -> BranchPlan:
    repo = ctx.repo
    bp = BranchPlan(name, tip, wt.path if wt else None)
    if name == ctx.base:
        return bp.decide("base", "the base branch")
    pattern = protected_by(name, ctx.protect)
    if pattern:
        return bp.decide("protected", f"protected by '{pattern}'")
    remote_sha = repo.rev(f"refs/remotes/{ctx.remote}/{name}") if ctx.has_remote else None
    if remote_sha is None and repo.created_only(name):
        shown = short_ref(ctx.base_ref)
        if repo.is_ancestor(tip, ctx.base_ref):
            return bp.decide("no-commits", f"no commits beyond {shown}; created and never moved since, and not on "
                                           "the remote (a fresh branch, or one `deuce undo` restored)")
        return bp.decide("no-commits", f"created at this tip and never moved since, and not on the remote, with "
                                       f"commits not on {shown} by ancestry (as when `deuce undo` restores a branch)")

    ev = bp.evidence = evidence.find(repo, ctx.gh, name, tip, ctx.base, ctx.base_ref)
    if ev.rule != "merged":
        return bp.decide(ev.rule, ev.reason)

    if wt:
        refusal = _worktree_refusal(ctx, wt)
        if refusal:
            return bp.decide(*refusal)
    if ev.kind == "pr" and tip != ev.pr_head and not (ev.pr_head and repo.is_ancestor(tip, ev.pr_head)):
        return bp.decide("pr-unpushed", f"has commits not in PR #{ev.pr} (tip {tip[:10]}, "
                                        f"PR head {str(ev.pr_head)[:10]}); push them or open a new PR first")
    if remote_sha and not _remote_is_covered(repo, remote_sha, tip, ev.pr_head, ctx.base_ref):
        return bp.decide("remote-ahead", f"remote branch {ctx.remote}/{name} is at {remote_sha[:10]}, which has "
                                         "commits that are neither on this branch nor merged; fetch and look first")

    force = ev.kind == "pr" and ev.squash and tip == ev.pr_head
    if not force:
        target = repo.upstream(name) or "HEAD"
        if not repo.is_ancestor(tip, target):
            if target == "HEAD" and head_ff and head_ff.status == PLANNED and repo.is_ancestor(tip, head_ff.sha):
                bp.actions.append(Action("fast-forward", list(head_ff.args), head_ff.cwd, sha=head_ff.sha,
                                         detail=f"first: git branch -d checks HEAD, which is {ctx.base}"))
            else:
                shown = short_ref(target) if target != "HEAD" else f"HEAD of {repo.root}"
                why = f"; {ctx.base} is not fast-forwarded first: {head_ff.detail}" \
                    if target == "HEAD" and head_ff and head_ff.status == SKIPPED else ""
                return bp.decide("safe-delete", f"git branch -d would refuse: the tip is not merged into {shown}, "
                                                f"which is what git checks{why}")

    if wt:
        ignored = repo.ignored(wt.path)
        detail = f"ignored files go with it: {', '.join(ignored[:10])}" + (" ..." if len(ignored) > 10 else "") \
            if ignored else ""
        bp.actions.append(Action("remove-worktree", ["worktree", "remove", wt.path], repo.root, detail=detail,
                                 path=wt.path))
    flag = "-" + ("D" if force else "d")  # the force delete only for a squash-merged PR whose head is the tip
    bp.actions.append(Action("delete-branch", ["branch", flag, name], repo.root, sha=tip,
                             detail=f"force delete: PR #{ev.pr} was squash merged and its head is this tip"
                             if force else ""))
    if remote_sha:
        bp.actions.append(Action("delete-remote-branch",
                                 ["push", "--porcelain", f"--force-with-lease={name}:{remote_sha}", ctx.remote,
                                  "--" + "delete", name], repo.root, sha=remote_sha))
    return bp.decide("merged", ev.detail)


def _worktree_refusal(ctx: Context, wt: Worktree) -> tuple[str, str] | None:
    if wt.is_main:
        return "main-worktree", f"checked out in the main worktree {wt.path}"
    if wt.contains(ctx.cwd) or wt.contains(ctx.repo.root):
        return "running-from", f"deuce is running from its worktree {wt.path}"
    if wt.locked is not None:
        return "locked", f"worktree {wt.path} is locked" + (f": {wt.locked}" if wt.locked else "")
    if wt.prunable or not os.path.isdir(wt.path):
        return "missing-worktree", (f"worktree directory is missing ({wt.path}); --apply prunes the stale "
                                    "metadata, then the next sweep can clean the branch")
    changes = ctx.repo.changes(wt.path)
    if changes:
        return "dirty", (f"uncommitted or untracked changes in {wt.path} ({len(changes)}, "
                         f"first: {changes[0].strip()})")
    return None


def _remote_is_covered(repo: Repo, remote_sha: str, tip: str, pr_head: str | None, base_ref: str) -> bool:
    if remote_sha == tip or remote_sha == pr_head:
        return True
    return (repo.is_ancestor(remote_sha, tip) or bool(pr_head and repo.is_ancestor(remote_sha, pr_head))
            or repo.is_ancestor(remote_sha, base_ref))


# ── After the branches: fetch, fast-forward base, prune worktree metadata ──

def finish(ctx: Context) -> list[Action]:
    root = ctx.repo.root
    if ctx.has_remote:
        fetch = Action("fetch-prune", ["fetch", "--prune", ctx.remote], root)
    else:
        fetch = Action("fetch-prune", [], root, status=SKIPPED, detail=f"no remote '{ctx.remote}'")
    return [fetch, fast_forward(ctx), Action("prune-worktrees", ["worktree", "prune"], root)]


def fast_forward(ctx: Context) -> Action:
    """Move base up to <remote>/<base>, only ever as a fast-forward, and only
    through a worktree with no uncommitted changes to tracked files."""
    repo, base, root = ctx.repo, ctx.base, ctx.repo.root
    if not ctx.has_remote:
        return Action("fast-forward", [], root, status=SKIPPED, detail=f"no remote '{ctx.remote}'")
    old, new = repo.rev(f"refs/heads/{base}"), repo.rev(ctx.base_ref)
    if old is None or new is None:
        return Action("fast-forward", [], root, status=SKIPPED, detail=f"no local {base}")
    if old == new:
        return Action("fast-forward", [], root, status=SKIPPED, detail=f"{base} is up to date")
    if not repo.is_ancestor(old, new):
        return Action("fast-forward", [], root, status=SKIPPED,
                      detail=f"{base} has commits that are not on {short_ref(ctx.base_ref)}; not a fast-forward")
    wt = next((w for w in repo.worktrees() if w.branch == base), None)
    if wt is None:
        return Action("fast-forward", ["update-ref", f"refs/heads/{base}", new, old], root, sha=new)
    if wt.prunable or not os.path.isdir(wt.path):
        return Action("fast-forward", [], root, status=SKIPPED, detail=f"{base}'s worktree {wt.path} is missing")
    if repo.changes(wt.path, untracked=False):
        return Action("fast-forward", [], root, status=SKIPPED,
                      detail=f"uncommitted changes in {wt.path}, where {base} is checked out")
    return Action("fast-forward", ["merge", "--ff-only", "--quiet", new], wt.path, sha=new)
