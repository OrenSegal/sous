"""deuce command line: `sweep` (dry run unless --apply), `status`, `undo`.

Exit codes, option names and defaults are defined here once; README.md's
"Exit codes" and "Options" tables are checked against them by the tests."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

import deuce
from deuce import config, execute, plan, report
from deuce.audit import AuditLog
from deuce.evidence import GitHub
from deuce.gitrepo import NotARepo, Repo
from deuce.lock import Busy, repo_lock

EXIT_OK, EXIT_REFUSED, EXIT_USAGE = 0, 1, 2
EXIT_CODES = {
    EXIT_OK: "ok, or nothing to do",
    EXIT_REFUSED: "a branch was refused, an action failed, or another deuce holds the lock",
    EXIT_USAGE: "usage error: bad arguments, not a git repository, no such base branch, or a bad .deuce.toml",
}
DEFAULT_BASE = "main"
DEFAULT_REMOTE = "origin"
SCHEMA_VERSION = report.SCHEMA_VERSION


def build_parser() -> argparse.ArgumentParser:
    epilog = "exit codes:\n" + "\n".join(f"  {code} {meaning}" for code, meaning in EXIT_CODES.items())
    parser = argparse.ArgumentParser(
        prog="deuce", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=epilog,
        description="The cleanup after a branch merges: worktree, local branch, remote branch.")
    parser.add_argument("--version", action="version", version=f"deuce {deuce.__version__}")
    commands = parser.add_subparsers(dest="command", required=True, metavar="{sweep,status,undo}")

    sweep = commands.add_parser("sweep", help="clean up merged branches (a dry run unless --apply)")
    sweep.add_argument("--apply", action="store_true", help="do it; without this nothing changes")
    status = commands.add_parser("status", help="list every branch and whether it is stale (read-only)")
    for sub in (sweep, status):
        _repo_flag(sub)
        sub.add_argument("--base", default=DEFAULT_BASE, metavar="NAME", help="the branch merges land on")
        sub.add_argument("--remote", default=DEFAULT_REMOTE, metavar="NAME", help="the remote to compare with")
        sub.add_argument("--json", action="store_true", help="print the report as JSON")

    undo = commands.add_parser("undo", help="recreate the last branch deuce deleted")
    undo.add_argument("--last", action="store_true", required=True, help="the most recent deletion (required)")
    _repo_flag(undo)
    return parser


def _repo_flag(sub: argparse.ArgumentParser) -> None:
    sub.add_argument("--repo", metavar="DIR", default=None, help="the repository (default: the current directory)")


def subparsers(parser: argparse.ArgumentParser) -> dict[str, argparse.ArgumentParser]:
    action = next(a for a in parser._actions if isinstance(a, argparse._SubParsersAction))
    return dict(action.choices)


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        repo = Repo(args.repo or os.getcwd())
        if args.command == "undo":
            return undo(repo)
        protect = config.load_protect(repo.root)
        ctx = plan.context(repo, args.base, args.remote, protect, os.getcwd(), GitHub(repo.root))
        if args.command == "sweep" and args.apply:
            with repo_lock(repo.common_dir):
                return _sweep(ctx, args, apply=True)
        return _sweep(ctx, args, apply=False)
    except (NotARepo, config.ConfigError, plan.UsageError) as exc:
        print(f"deuce: {exc}", file=sys.stderr)
        return EXIT_USAGE
    except Busy as exc:
        print(f"deuce: {exc}", file=sys.stderr)
        return EXIT_REFUSED


def _sweep(ctx: plan.Context, args: argparse.Namespace, *, apply: bool) -> int:
    the_plan = plan.build(ctx)
    if apply:
        execute.apply(the_plan, AuditLog.default())
    counts = report.counts(the_plan)
    if args.command == "status":
        code = EXIT_OK
    else:
        code = EXIT_REFUSED if counts["refuse"] or counts["failed"] else EXIT_OK
    data = report.as_json(the_plan, args.command, apply, code)
    if args.json:
        print(json.dumps(data, indent=2))
    elif args.command == "status":
        print(report.status_text(data), end="")
    else:
        print(report.sweep_text(data), end="")
    return code


def undo(repo: Repo) -> int:
    """Recreate the most recent deleted branch (for this repository) that has
    not been undone yet, at the tip sha the audit log recorded."""
    log = AuditLog.default()
    with repo_lock(repo.common_dir):
        rows = [r for r in log.rows() if r.get("repo") == repo.common_dir]
        undone: Counter[tuple[str, str]] = Counter()
        index = None
        for i in range(len(rows) - 1, -1, -1):
            row, key = rows[i], (rows[i].get("branch", ""), rows[i].get("sha", ""))
            if row.get("status") != "done":
                continue
            if row.get("action") == "undo-delete-branch":
                undone[key] += 1
            elif row.get("action") == "delete-branch":
                if undone[key]:
                    undone[key] -= 1
                    continue
                index = i
                break
        if index is None:
            print(f"Nothing to undo: the audit log ({log.path}) has no deleted branch for this repository.")
            return EXIT_OK
        row = rows[index]
        branch, sha, remote = row["branch"], row["sha"], row.get("remote", "")
        if repo.rev(f"refs/heads/{branch}"):
            print(f"deuce: branch {branch} already exists; not overwriting it. The deleted tip was {sha}; "
                  f"to keep both: git branch {branch}-restored {sha}", file=sys.stderr)
            return EXIT_REFUSED
        if not repo.rev(sha):
            print(f"deuce: commit {sha} is no longer in this repository, so {branch} cannot be recreated",
                  file=sys.stderr)
            return EXIT_REFUSED
        result = repo.git("branch", branch, sha)
        if not result.ok:
            print(f"deuce: git branch {branch} {sha} failed: {result.err.strip()}", file=sys.stderr)
            return EXIT_REFUSED
        log.append(repo=repo.common_dir, action="undo-delete-branch", status="done", branch=branch, sha=sha,
                   remote=remote)

    print(f"Recreated branch {branch} at {sha} (deleted {row.get('time', '?')}).")
    # A sweep logs a branch's steps back to back: remove-worktree, delete-branch, delete-remote-branch.
    after = _neighbour(rows, index + 1, "delete-remote-branch", branch)
    if after:
        print(f"Its remote branch was deleted too; re-push it by hand if you need it: git push -u {remote} {branch}")
    before = _neighbour(rows, index - 1, "remove-worktree", branch)
    if before and before.get("path"):
        print(f"Its worktree was removed; to bring it back: git worktree add {before['path']} {branch}")
    return EXIT_OK


def _neighbour(rows: list[dict[str, str]], i: int, action: str, branch: str) -> dict[str, str] | None:
    if 0 <= i < len(rows):
        row = rows[i]
        if row.get("action") == action and row.get("branch") == branch and row.get("status") == "done":
            return row
    return None
