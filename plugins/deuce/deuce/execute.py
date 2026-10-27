"""Run a plan's actions (only under `sweep --apply`, holding the repo lock),
and append every one that ran to the audit log."""

from __future__ import annotations

from deuce import plan as planning
from deuce.audit import AuditLog
from deuce.plan import DONE, FAILED, PLANNED, SKIPPED, Action, Plan


def apply(the_plan: Plan, log: AuditLog) -> None:
    ctx = the_plan.ctx
    for bp in the_plan.branches:
        if bp.decision != "sweep":
            continue
        failed = False
        for action in bp.actions:
            if failed:
                action.status, action.detail = SKIPPED, "an earlier step for this branch failed"
                continue
            if action.kind == "fast-forward":  # base, before a delete whose `git branch -d` checks HEAD
                if ctx.repo.is_ancestor(bp.tip, "HEAD"):
                    action.status, action.detail = SKIPPED, f"{ctx.base} already holds the tip"
                    continue
                _run(ctx, action)
                if action.status == DONE and not ctx.repo.is_ancestor(bp.tip, "HEAD"):
                    action.status, action.detail = FAILED, "HEAD still does not hold the tip after the fast-forward"
            elif action.kind == "delete-branch" and ctx.repo.rev(f"refs/heads/{bp.branch}") != bp.tip:
                action.status, action.detail = FAILED, "the branch moved since the plan; sweep again"
            else:
                _run(ctx, action)
            _log(log, ctx, action, ctx.base if action.kind == "fast-forward" else bp.branch)
            failed = action.status == FAILED

    fetch, _, prune = the_plan.finish
    if fetch.status == PLANNED:
        _run(ctx, fetch)
        _log(log, ctx, fetch, "")
    ff = planning.fast_forward(ctx)  # again, now that the fetch has run
    if ff.status == PLANNED:
        _run(ctx, ff)
        _log(log, ctx, ff, ctx.base)
    _run(ctx, prune)
    _log(log, ctx, prune, "")
    the_plan.finish = [fetch, ff, prune]


def _run(ctx: planning.Context, action: Action) -> None:
    result = ctx.repo.git(*action.args, cwd=action.cwd)
    output = " ".join((result.out + " " + result.err).split())
    if result.ok:
        action.status, output = DONE, ""
    elif action.kind == "delete-remote-branch" and "remote ref does not exist" in result.err:
        action.status, output = DONE, f"already gone on {ctx.remote}"
    else:
        action.status = FAILED
    if output:
        action.detail = f"{action.detail}; {output}" if action.detail else output


def _log(log: AuditLog, ctx: planning.Context, action: Action, branch: str) -> None:
    log.append(repo=ctx.repo.common_dir, action=action.kind, status=action.status, branch=branch,
               sha=action.sha, remote=ctx.remote if ctx.has_remote else "", path=action.path, detail=action.detail)
