"""The audit log: one TSV row per action deuce applied, with enough to put a
deleted branch back (its name, tip sha, remote and worktree path).

Lives at $DEUCE_STATE_DIR/log.tsv, or ~/.local/state/deuce/log.tsv. Rows are
only ever appended; `deuce undo` appends its own rows rather than editing."""

from __future__ import annotations

import os
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path

FIELDS = ("time", "repo", "action", "status", "branch", "sha", "remote", "path", "detail")
ENV_STATE_DIR = "DEUCE_STATE_DIR"


def _clean(value: object) -> str:
    return " ".join(str(value or "").split())  # no tabs or newlines inside a cell


class AuditLog:
    def __init__(self, path: Path) -> None:
        self.path = path

    @classmethod
    def default(cls, env: Mapping[str, str] = os.environ) -> AuditLog:
        state = env.get(ENV_STATE_DIR)
        base = Path(state) if state else Path(env.get("HOME") or Path.home()) / ".local" / "state" / "deuce"
        return cls(base / "log.tsv")

    def append(self, **row: object) -> None:
        unknown = set(row) - set(FIELDS)
        if unknown:
            raise ValueError(f"unknown audit fields: {sorted(unknown)}")
        row.setdefault("time", datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))
        self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        new = not self.path.exists() or self.path.stat().st_size == 0
        with self.path.open("a", encoding="utf-8") as handle:
            if new:
                handle.write("\t".join(FIELDS) + "\n")
            handle.write("\t".join(_clean(row.get(f, "")) for f in FIELDS) + "\n")

    def rows(self) -> list[dict[str, str]]:
        if not self.path.exists():
            return []
        lines = self.path.read_text(encoding="utf-8").splitlines()
        if not lines:
            return []
        header = lines[0].split("\t")
        return [dict(zip(header, line.split("\t"), strict=False)) for line in lines[1:] if line]
