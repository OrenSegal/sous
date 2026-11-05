#!/usr/bin/env python3
"""Render docs/demo.txt (the real output of docs/demo.sh) as a terminal-style SVG.

Regenerate with: python3 docs/demo_svg.py > docs/demo.svg
Lines appear one after another through CSS; a viewer without CSS animation shows the final frame.
"""
import os
import textwrap
from xml.sax.saxutils import escape

WRAP = 84  # columns: keeps 14px text legible when the README renders the image 800px wide
FONT, LINE_H, PAD, BAR = 14, 20, 20, 32
STEP = 0.35  # seconds between lines

src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "demo.txt")
rows = []  # (css class, text)
for line in open(src, encoding="utf-8").read().rstrip("\n").split("\n"):
    if line.startswith("$ "):
        kind = "cmd"
    elif line.startswith("BLOCKED"):
        kind = "block"
    elif line.strip() == "exit 0":
        kind = "ok"
    else:
        kind = "dim"
    parts = textwrap.wrap(line, WRAP, subsequent_indent="  ") or [""]
    rows += [(kind, p) for p in parts]

height = BAR + PAD * 2 + LINE_H * len(rows)
out = [
    f'<svg xmlns="http://www.w3.org/2000/svg" xml:space="preserve" '
    f'viewBox="0 0 800 {height}" width="800" height="{height}" '
    'role="img" aria-label="sous guard blocking rm -rf, a force push and a .env read, and allowing git status">',
    "<style>",
    "text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;"
    f"font-size:{FONT}px;white-space:pre;fill:#c9d1d9}}",
    ".cmd{fill:#e6edf3}.p{fill:#7ee787}.block{fill:#ff7b72}.ok{fill:#7ee787}.dim{fill:#8b949e}",
    ".l{animation:in .2s ease-out backwards}",
    "@keyframes in{from{opacity:0}to{opacity:1}}",
    "</style>",
    f'<rect width="800" height="{height}" rx="8" fill="#0d1117"/>',
    f'<rect width="800" height="{BAR}" rx="8" fill="#161b22"/>',
    f'<rect y="{BAR - 8}" width="800" height="8" fill="#161b22"/>',
    '<circle cx="20" cy="16" r="6" fill="#ff5f57"/><circle cx="40" cy="16" r="6" fill="#febc2e"/>'
    '<circle cx="60" cy="16" r="6" fill="#28c840"/>',
    '<text x="400" y="21" text-anchor="middle" class="dim">bash docs/demo.sh</text>',
]
for i, (kind, text) in enumerate(rows):
    y = BAR + PAD + LINE_H * i + FONT
    delay = f' style="animation-delay:{i * STEP:.2f}s"'
    if kind == "cmd":
        body = f'<tspan class="p">$</tspan><tspan class="cmd">{escape(text[1:])}</tspan>'
    else:
        body = escape(text)
    out.append(f'<text x="{PAD}" y="{y}" class="l {kind}"{delay}>{body}</text>')
out.append("</svg>")
print("\n".join(out))
