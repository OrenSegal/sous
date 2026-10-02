"""Hidden-instruction scan: invisible characters and instruction-dropping lines in the
text an agent reads as instructions. Pure functions, no sous imports."""
import os
import re

# Text the agent will read as instructions can carry some it shouldn't: characters
# a reviewer can't see, or lines that tell it to drop its rules or hide things.
# ZWJ (U+200D) is left out because emoji sequences use it. For the same reason a
# lone U+FE0E/U+FE0F (text or emoji presentation, as in a warning sign) passes;
# a run of variation selectors is how bytes get smuggled, so VS_RUN catches that.
HIDDEN = re.compile("[­؜᠎​‌‎‏‪-‮⁠-⁤⁦-⁩"
                    "ㅤ︀-︍﻿\U000e0000-\U000e007f\U000e0100-\U000e01ef]")
VS_RUN = re.compile("[︀-️\U000e0100-\U000e01ef]{2,}")
_DROP = r"(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+"
# Said, not mentioned: these are not flagged inside a fenced block, inline code or
# a quoted span in prose, where docs quote them. A line that is only the quote still counts.
PHRASES = [
    (re.compile(r"\b(?:ignore|disregard|forget)\s+" + _DROP + r"(?:instructions|rules|directions|guidelines|prompt)",
                re.I),
     "tells the agent to drop its instructions"),
    (re.compile(r"\b(?:do\s+not|don't|never)\s+(?:tell|inform|reveal|mention)\b[^.\n]{0,40}\bthe\s+(?:user|human)\b",
                re.I),
     "asks the agent to hide something from the user"),
    (re.compile(r"<!--[^>]*\b(?:ignore|you\s+must|system\s+prompt|instructions?)\b[^>]*-->", re.I),
     "instruction hidden in an HTML comment"),
]
# Network sends count everywhere, fences included: a fence is where commands go.
# A $TOKEN in a header or user argument goes to the host it is for, so only a
# secret variable elsewhere on the line (URL, body) counts.
NET = "sends a secret over the network"
NET_FILE = re.compile(r"\b(?:curl|wget)\b[^\n]*(?:\.env\b|\.ssh|id_rsa|credentials)", re.I)
NET_VAR = re.compile(r"\b(?:curl|wget)\b[^\n]*\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET)", re.I)
AUTH_ARG = re.compile(r"(?:^|\s)(?:-H|--header|-u|--user|--oauth2-bearer)(?:\s+|=)(?:\"[^\"]*\"|'[^']*'|\S+)")
# Inline code, double or curly quotes, and single quotes that open after a non-word
# character (so the apostrophes in "don't ... it's" are not a span).
QUOTED = re.compile(r"(`+)[^`\n]*?\1|\"[^\"\n]*\"|“[^”\n]*”|‘[^’\n]*’|(?<!\w)'[^'\n]*'(?!\w)")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
SKIP_DIRS = {"node_modules"}


def injection_files(root):
    out = [n for n in ("CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/CLAUDE.md", ".mcp.json")
           if os.path.isfile(os.path.join(root, n))]
    for sub_dir in (".claude/skills", ".claude/commands", ".claude/agents", ".claude/rules"):
        for dirpath, _, names in os.walk(os.path.join(root, sub_dir)):
            out += sorted(os.path.relpath(os.path.join(dirpath, n), root) for n in names if n.endswith(".md"))
    # Claude Code also reads the CLAUDE.md of a subdirectory it works in. Dot
    # directories (.git, worktrees under .claude) and node_modules are skipped.
    for dirpath, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if not d.startswith(".") and d not in SKIP_DIRS)
        if dirpath != root:
            out += [os.path.relpath(os.path.join(dirpath, n), root)
                    for n in ("CLAUDE.md", "CLAUDE.local.md") if n in names]
    return out


def line_hits(line, in_fence):
    """The why of each pattern on one line of text; in_fence: inside a fenced block."""
    hits = []
    if not in_fence:
        bare = QUOTED.sub(" ", line)
        alone = not re.search(r"\w", bare)
        hits += [why for rx, why in PHRASES if rx.search(bare) or (alone and rx.search(line))]
    if NET_FILE.search(line) or NET_VAR.search(AUTH_ARG.sub(" ", line)):
        hits.append(NET)
    return hits


def scan_injection(root):
    """(file, line, why) for each hidden character or instruction-dropping line in
    memory files, rules, skills, commands, agents and .mcp.json. Hidden characters
    and network sends count inside fenced blocks, where hidden text and commands
    go; the drop, hide and HTML-comment phrases count only where they are said,
    not quoted (fence, inline code, a quoted span in prose)."""
    hits = []
    files = injection_files(root)
    for name in files:
        try:
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                lines = f.read().split("\n")
        except OSError:
            continue
        fence = None
        for n, line in enumerate(lines, 1):
            if n == 1:
                line = line.lstrip("﻿")
            m = HIDDEN.search(line) or VS_RUN.search(line)
            if m:
                hits.append((name, n, f"hidden character U+{ord(m.group()[0]):04X}"))
            f_m = None if name.endswith(".json") else FENCE.match(line)
            if f_m:
                mark = f_m.group(1)
                if fence is None:
                    fence = mark
                elif mark[0] == fence[0] and len(mark) >= len(fence) and not line.strip()[len(mark):]:
                    fence = None
                continue
            hits += [(name, n, why) for why in line_hits(line, fence is not None)]
    return hits, len(files)
