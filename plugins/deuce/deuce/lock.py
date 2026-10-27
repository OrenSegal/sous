"""One deuce at a time per repository: `sweep --apply` and `undo` take an
exclusive, non-blocking flock on <git common dir>/deuce.lock. Dry runs and
`status` only read, so they take no lock."""

from __future__ import annotations

import fcntl
import os
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path


class Busy(Exception):
    pass


@contextmanager
def repo_lock(common_dir: str | Path) -> Iterator[Path]:
    path = Path(common_dir) / "deuce.lock"
    fd = os.open(path, os.O_RDWR | os.O_CREAT, 0o644)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Busy(f"another deuce is already changing this repository (lock held on {path})") from exc
        yield path
    finally:
        os.close(fd)  # closing the descriptor releases the lock
