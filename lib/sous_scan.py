"""Hidden-instruction scan: invisible characters and instruction-dropping lines in the
text an agent reads as instructions. Pure functions, no sous imports."""
import os
import re

# Text the agent will read as instructions can carry some it shouldn't: characters
# a reviewer can't see, or lines that tell it to drop its rules or hide things.
# ZWJ (U+200D) is left out because emoji sequences use it.
HIDDEN = re.compile("[​‌⁠﻿‪-‮⁦-⁩\U000e0000-\U000e007f]")
_DROP = r"(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system)\s+"
PHRASES = [
    (re.compile(r"\b(?:ignore|disregard|forget)\s+" + _DROP + r"(?:instructions|rules|directions|guidelines|prompt)",
                re.I),
     "tells the agent to drop its instructions"),
    (re.compile(r"\b(?:do\s+not|don't|never)\s+(?:tell|inform|reveal|mention)\b[^.\n]{0,40}\bthe\s+(?:user|human)\b",
                re.I),
     "asks the agent to hide something from the user"),
    (re.compile(r"\b(?:curl|wget)\b[^\n]*(?:\.env\b|\.ssh|id_rsa|credentials|\$\{?[A-Z_]*(?:KEY|TOKEN|SECRET))", re.I),
     "sends a secret over the network"),
    (re.compile(r"<!--[^>]*\b(?:ignore|you\s+must|system\s+prompt|instructions?)\b[^>]*-->", re.I),
     "instruction hidden in an HTML comment"),
]


def injection_files(root):
    out = [n for n in ("CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md", ".mcp.json")
           if os.path.isfile(os.path.join(root, n))]
    for sub_dir in (".claude/skills", ".claude/commands", ".claude/agents"):
        for dirpath, _, names in os.walk(os.path.join(root, sub_dir)):
            out += sorted(os.path.relpath(os.path.join(dirpath, n), root) for n in names if n.endswith(".md"))
    return out


def scan_injection(root):
    """(file, line, why) for each hidden character or instruction-dropping line in
    memory files, skills, commands, agents and .mcp.json. Fenced blocks count:
    that is where hidden text goes."""
    hits = []
    files = injection_files(root)
    for name in files:
        try:
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                lines = f.read().split("\n")
        except OSError:
            continue
        for n, line in enumerate(lines, 1):
            if n == 1:
                line = line.lstrip("﻿")
            m = HIDDEN.search(line)
            if m:
                hits.append((name, n, f"hidden character U+{ord(m.group()):04X}"))
            hits += [(name, n, why) for rx, why in PHRASES if rx.search(line)]
    return hits, len(files)
