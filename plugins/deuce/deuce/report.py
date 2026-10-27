"""The plan and its outcome, as JSON (`--json`) or as text for a person."""

from __future__ import annotations

import deuce
from deuce.evidence import short_ref
from deuce.plan import FAILED, Plan

SCHEMA_VERSION = 1


def counts(the_plan: Plan) -> dict[str, int]:
    decisions = [bp.decision for bp in the_plan.branches]
    actions = [a for bp in the_plan.branches for a in bp.actions] + the_plan.finish
    return {"sweep": decisions.count("sweep"), "keep": decisions.count("keep"),
            "refuse": decisions.count("refuse"), "failed": sum(a.status == FAILED for a in actions)}


def as_json(the_plan: Plan, command: str, applied: bool, exit_code: int) -> dict:
    ctx = the_plan.ctx
    return {
        "schema_version": SCHEMA_VERSION,
        "deuce_version": deuce.__version__,
        "command": command,
        "applied": applied,
        "repo": ctx.repo.root,
        "base": ctx.base,
        "base_ref": short_ref(ctx.base_ref),
        "remote": ctx.remote if ctx.has_remote else None,
        "notes": the_plan.notes,
        "branches": [bp.as_json() for bp in the_plan.branches],
        "finish": [a.as_json() for a in the_plan.finish],
        "summary": {**counts(the_plan), "exit_code": exit_code},
    }


def sweep_text(report: dict) -> str:
    applied = report["applied"]
    head = "applied" if applied else "dry run, nothing changed"
    lines = [f"deuce sweep ({head})", f"repo {report['repo']}, base {report['base']} "
                                      f"(compared with {report['base_ref']})", ""]
    for b in report["branches"]:
        if b["decision"] == "sweep":
            lines.append(f"sweep   {b['branch']}: {b['reason']}")
            lines += [_action_line(a) for a in b["actions"]]
        else:
            label = "keep  " if b["decision"] == "keep" else "REFUSE"
            lines.append(f"{label}  {b['branch']}: {b['reason']}")
    lines += ["", "then:"] + [_action_line(a) for a in report["finish"]]
    lines += _notes(report)
    s = report["summary"]
    lines += ["", f"{s['sweep']} to sweep, {s['keep']} kept, {s['refuse']} refused"
                  + (f", {s['failed']} failed" if s["failed"] else "") + "."]
    if not applied:
        if s["sweep"]:
            lines.append("This was a dry run. Show it to the person who owns the repo; once they approve, "
                         "run the same command with --apply.")
        else:
            lines.append("Nothing to sweep.")
    return "\n".join(lines) + "\n"


def status_text(report: dict) -> str:
    states = {"sweep": "stale", "keep": "keep", "refuse": "held"}
    rows = [("BRANCH", "STATE", "WORKTREE", "WHY")]
    for b in report["branches"]:
        rows.append((b["branch"], states[b["decision"]], b["worktree"] or "-", b["reason"]))
    widths = [max(len(r[i]) for r in rows) for i in range(3)]
    lines = [f"deuce status: {report['repo']} (base {report['base']}, compared with {report['base_ref']})", ""]
    lines += ["  ".join(cell.ljust(widths[i]) if i < 3 else cell for i, cell in enumerate(row)).rstrip()
              for row in rows]
    lines += _notes(report)
    stale = report["summary"]["sweep"]
    held = report["summary"]["refuse"]
    lines += ["", f"{stale} stale, {held} held (a sweep would refuse them)."
                  " `deuce sweep` shows the dry run of the cleanup."]
    return "\n".join(lines) + "\n"


def _action_line(a: dict) -> str:
    what = a["command"] or a["kind"]
    return f"    [{a['status']}] {what}" + (f"  ({a['detail']})" if a["detail"] else "")


def _notes(report: dict) -> list[str]:
    return ["", "notes:", *(f"  - {n}" for n in report["notes"])] if report["notes"] else []
