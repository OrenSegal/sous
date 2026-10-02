#!/usr/bin/env bash
# Unit tests for the pure modules in lib/: no settings files, no guard, no HOME.
# Each module takes its inputs as arguments, so these run in milliseconds.
# Runs on bash 3.2.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHONPATH="$HERE/../lib" exec python3 - <<'PY'
import os
import sys
import tempfile
import time

import sous_blocks
import sous_lint

passed = failed = 0


def expect(name, want, got):
    global passed, failed
    if want == got:
        passed += 1
    else:
        failed += 1
        print(f"FAIL: {name} (want {want!r}, got {got!r})")


tmp = tempfile.mkdtemp()
log = os.path.join(tmp, "blocks.tsv")
now = int(time.time())
with open(log, "w") as f:
    f.write(f"{now}\tBLOCKED (sous): force push. Ask.\t/p\n")      # three columns
    f.write(f"{now}\tBLOCKED (sous): force push. Ask.\n")          # before the directory column
    f.write(f"{now - 10 * 86400}\tBLOCKED (sous): old one. x\t/p\n")
    f.write("junk line\n")
    f.write("123\t\n")                                              # empty reason
rows = sous_blocks.rows(log)
expect("rows skips junk and empty reasons", 3, len(rows))
expect("rows: directory column", ["/p", None, "/p"], [r[2] for r in rows])
expect("rows: off and missing", ([], []), (sous_blocks.rows("off"), sous_blocks.rows(os.path.join(tmp, "none"))))
expect("short_reason", "force push", sous_blocks.short_reason("BLOCKED (sous): force push. Ask."))
expect("reasons: window", ["force push", "force push"], sous_blocks.reasons(log, 7))
expect("reasons: wider window", 3, len(sous_blocks.reasons(log, 30)))

today = time.strftime("%Y%m%d")
old = time.strftime("%Y%m%d", time.localtime(time.time() - 20 * 86400))
open(f"{log}.allowed.{today}", "w").write("...")
open(f"{log}.allowed.{old}", "w").write("....")
expect("count_allowed: window", 3, sous_blocks.count_allowed(log, 7))
expect("count_allowed: wider window", 7, sous_blocks.count_allowed(log, 30))
expect("count_allowed: off", 0, sous_blocks.count_allowed("off", 7))
text = sous_blocks.render_report(log, 7)
expect("render_report: rate", True, text.startswith("sous report: 2 blocks, 3 allowed (40.0% blocked) in the last 7 days"))
expect("render_report: counts reasons", True, "      2  force push" in text)
expect("render_report: no allowed, no rate", True, "allowed" not in sous_blocks.render_report(os.path.join(tmp, "none"), 7))

expect("PROHIBIT matches", True, bool(sous_lint.PROHIBIT.search("Never run `rm -rf`")))
expect("span_kind path", "path", sous_lint.span_kind(".env"))
expect("span_kind url is nothing", None, sous_lint.span_kind("https://x.y"))
expect("span_kind metachars are nothing", None, sous_lint.span_kind("a | b"))
expect("rule_covers command prefix", True, sous_lint.rule_covers("Bash(git push:*)", "command", "git push"))
expect("rule_covers command miss", False, sous_lint.rule_covers("Bash(git push:*)", "command", "git pull"))
expect("rule_covers read vs edit", False, sous_lint.rule_covers("Read(.env)", "path", ".env", tool="Edit"))
expect("rule_covers path glob", True, sous_lint.rule_covers("Read(**/.env)", "path", "app/.env", tool="Read"))
expect("rule_covers negation ignored", False, sous_lint.rule_covers("!Bash(rm:*)", "command", "rm"))

print(f"lib: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PY
