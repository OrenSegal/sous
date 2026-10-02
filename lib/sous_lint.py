"""The pure half of `sous lint`: reading a prohibition and deciding whether a permission
rule covers what it names. No settings files, no guard; inputs are arguments."""
import fnmatch
import os
import re
import shutil

# A "never X" in CLAUDE.md is a request; a deny rule or the guard is a control.
# Only about 1 in 20 written security rules has a control behind it (arXiv 2608.23550),
# so lint reads the prohibitions and asks, for each one that names a command or a
# path in backticks, whether anything enforces it.
PROHIBIT = re.compile(r"\b(never|must not|mustn't|do not|don't|forbidden|prohibited|not allowed to)\b", re.I)
# A comma ends the clause unless a list goes on (`a`, `b` or `c`): in "don't use
# `pip`, use `uv`" the second span is the advice, not the prohibition.
CLAUSE_END = re.compile(r";|\.\s|\s(?:\u2014|--)\s|\b(?:instead|unless|except|but)\b|,(?!\s*(?:`|or\b|and\b|nor\b))",
                        re.I)
SPAN = re.compile(r"`([^`\n]+)`")
READS = re.compile(r"\b(read|reads|reading|open|view|cat|print|show|expose|leak)\b", re.I)
# "Never skip `make lint`", "never commit without `make test`": the command is the
# one that must run, so denying it would forbid the opposite of what was written.
MUST_RUN = re.compile(r"\b(skip|skipping|omit|bypass|forget|ignore|disable|without)\b", re.I)
LIST_GLUE = re.compile(r"[\s,]*(?:(?:or|and|nor)\s*)?", re.I)


def span_kind(span):
    """'path', 'command' or None for a backticked span in a prohibition."""
    span = span.strip()
    if not span or "://" in span or re.search(r"[<>$|&;(){}*?\\]", span):
        return None
    toks = span.split()
    first = os.path.basename(toks[0]) if toks[0] != "sudo" or len(toks) < 2 else os.path.basename(toks[1])
    if len(toks) == 1 and (span.startswith((".", "~", "/")) or "/" in span or re.search(r"\.\w{1,6}$", span)):
        return "path"
    if re.fullmatch(r"[a-z][\w.+-]*", first) and shutil.which(first):
        return "command"
    return None


def rule_covers(rule, kind, span, tool=None):
    """Whether one permission rule (allow/ask/deny syntax) covers span. For a
    path, tool ("Read" or "Edit") narrows it: a Read rule doesn't stop an edit."""
    if not isinstance(rule, str) or rule.startswith("!"):
        return False
    m = re.match(r"^(Bash|Read|Edit)\((.*)\)$", rule.strip())
    if not m or (kind == "command") != (m.group(1) == "Bash") or (tool and m.group(1) != tool):
        return False
    tool, inner = m.groups()
    if tool == "Bash":
        if inner.endswith(":*"):
            return span == inner[:-2] or span.startswith(inner[:-2] + " ")
        return fnmatch.fnmatchcase(span, inner) or span == inner
    path = re.sub(r"^\./", "", span).rstrip("/")
    pat = re.sub(r"^\.?/", "", inner).replace("**", "*").rstrip("/")
    return any(fnmatch.fnmatchcase(c, g) for c in (path, os.path.basename(path)) for g in (pat, pat + "/*"))
