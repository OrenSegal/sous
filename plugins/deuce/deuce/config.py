"""Protected branch names: built-in defaults, plus `protect` in the repo's
.deuce.toml, plus DEUCE_PROTECT. Configuration only ever adds names; the
defaults and the base branch cannot be unprotected."""

from __future__ import annotations

import ast
import fnmatch
import os
import re
from collections.abc import Mapping
from pathlib import Path

DEFAULT_PROTECT = ("main", "master", "develop", "release/*")
CONFIG_FILE = ".deuce.toml"
ENV_PROTECT = "DEUCE_PROTECT"
KNOWN_KEYS = {"protect"}


class ConfigError(Exception):
    pass


def protected_by(branch: str, patterns: tuple[str, ...]) -> str | None:
    """The first pattern that protects this branch name, or None."""
    return next((p for p in patterns if fnmatch.fnmatchcase(branch, p)), None)


def load_protect(root: str | Path, env: Mapping[str, str] = os.environ) -> tuple[str, ...]:
    patterns = list(DEFAULT_PROTECT)
    path = Path(root) / CONFIG_FILE
    if path.is_file():
        try:
            data = parse(path.read_text(encoding="utf-8"))
        except (ConfigError, UnicodeDecodeError) as exc:
            raise ConfigError(f"{path}: {exc}") from exc
        unknown = set(data) - KNOWN_KEYS
        if unknown:
            raise ConfigError(f"{path}: unknown key(s) {', '.join(sorted(unknown))}; only 'protect' is read")
        value = data.get("protect", [])
        if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
            raise ConfigError(f"{path}: 'protect' must be a list of branch-name patterns")
        patterns += value
    patterns += [p for p in re.split(r"[,\s]+", env.get(ENV_PROTECT, "")) if p]
    return tuple(dict.fromkeys(patterns))


def parse(text: str) -> dict:
    try:
        import tomllib
    except ModuleNotFoundError:  # Python 3.10
        return parse_subset(text)
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        raise ConfigError(str(exc)) from exc


_KEY = re.compile(r"^([A-Za-z0-9_-]+)\s*=\s*(.*)$", re.S)


def parse_subset(text: str) -> dict:
    """The part of TOML that .deuce.toml uses, for Python 3.10 (no tomllib):
    comments, and `key = "string"` or `key = [strings]`, arrays may span
    lines. Anything else is an error rather than a guess."""
    data: dict = {}
    pending = ""
    for raw in text.splitlines():
        line = _strip_comment(raw).strip()
        if not line and not pending:
            continue
        pending = f"{pending} {line}".strip() if pending else line
        match = _KEY.match(pending)
        if not match:
            raise ConfigError(f"cannot read line: {raw.strip()!r}")
        key, value = match.groups()
        if value.startswith("[") and not value.rstrip().endswith("]"):
            continue  # an array that continues on the next line
        if key in data:
            raise ConfigError(f"duplicate key {key!r}")
        data[key] = _value(value.strip())
        pending = ""
    if pending:
        raise ConfigError("unterminated array")
    return data


def _value(text: str):
    if text.startswith("["):
        inner = text[1:-1].strip().rstrip(",")
        items = [part.strip() for part in _split_items(inner)] if inner else []
        return [_string(item) for item in items]
    return _string(text)


def _string(text: str) -> str:
    if len(text) < 2 or text[0] not in "\"'" or text[-1] != text[0]:
        raise ConfigError(f"expected a quoted string, got {text!r}")
    if text[0] == "'":
        return text[1:-1]
    try:
        value = ast.literal_eval(text)
    except (SyntaxError, ValueError) as exc:
        raise ConfigError(f"bad string {text!r}") from exc
    if not isinstance(value, str):
        raise ConfigError(f"expected a string, got {text!r}")
    return value


def _split_items(text: str) -> list[str]:
    items, current, quote = [], "", None
    for ch in text:
        if quote:
            current += ch
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
            current += ch
        elif ch == ",":
            items.append(current)
            current = ""
        else:
            current += ch
    if quote:
        raise ConfigError("unterminated string")
    items.append(current)
    return items


def _strip_comment(line: str) -> str:
    quote = None
    for i, ch in enumerate(line):
        if quote:
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "#":
            return line[:i]
    return line
