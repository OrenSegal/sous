"""The guard's block log and what `sous report` says about it. The bash guard writes
epoch<TAB>reason<TAB>project dir per block, and one byte per allowed command to
<log>.allowed.YYYYMMDD; these are the readers. The log path is passed in, never read
from the environment here, so tests don't need a HOME."""
import collections
import glob
import os
import time

# The same path the guard defaults to (hooks/sous-guard.sh); tests/ssot.test.sh holds them together.
DEFAULT_LOG = os.path.expanduser("~/.claude/sous/blocks.tsv")

REPORT_LOOP = """
How to act on this (the guard improves only through the corpus):
  false positive  add the benign command as `check 0` in tests/adversarial.test.sh,
                  watch it fail, then narrow the rule until it passes
  bypass seen     add it as `check 2` first (red), then widen the rule (green)
  rule never      a rule with zero hits for months is a candidate to delete;
  fires           fewer rules = faster guard, less to trust
Then upstream the change to sous and rerun `sous install` everywhere it's vendored.
"""


def rows(log):
    """(epoch, reason, project dir or None) per guard block. Rows from a guard
    before the third column have no directory."""
    if log == "off" or not os.path.isfile(log):
        return []
    out = []
    with open(log, errors="replace") as f:
        for line in f:
            cols = line.rstrip("\n").split("\t")
            if len(cols) >= 2 and cols[0].isdigit() and cols[1]:
                out.append((int(cols[0]), cols[1], cols[2] if len(cols) > 2 and cols[2] else None))
    return out


def short_reason(reason):
    return reason.replace("BLOCKED (sous): ", "").split(".")[0]


def reasons(log, days):
    """Short reason per block in the last `days` days."""
    cutoff = time.time() - days * 86400
    return [short_reason(reason) for ts, reason, _ in rows(log) if ts >= cutoff]


def count_allowed(log, days):
    """Allowed commands the guard saw: one byte per command in <log>.allowed.YYYYMMDD."""
    if log == "off":
        return 0
    cutoff = time.strftime("%Y%m%d", time.localtime(time.time() - days * 86400))
    total = 0
    for path in glob.glob(glob.escape(log) + ".allowed.*"):
        day = path.rsplit(".", 1)[-1]
        if day.isdigit() and day >= cutoff:
            total += os.path.getsize(path)
    return total


def percent_blocked(blocked, allowed):
    """Share of commands the guard stopped; a block rate, not a false-positive rate."""
    return 100 * blocked / (blocked + allowed)


def render_report(log, days):
    found = reasons(log, days)
    allowed = count_allowed(log, days)
    rate = f", {allowed} allowed ({percent_blocked(len(found), allowed):.1f}% blocked)" if allowed else ""
    lines = [f"sous report: {len(found)} blocks{rate} in the last {days} days ({log})\n"]
    lines += [f"  {n:5d}  {reason}" for reason, n in collections.Counter(found).most_common()]
    return "\n".join(lines) + "\n" + REPORT_LOOP
