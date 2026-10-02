#!/usr/bin/env bash
# Table tests for bin/tests-ran: each case is a test log on stdin, the count
# tests-ran should read from it, and the exit code at the default floor of 1.
# The zero rows are the point: logs that say "succeeded" and ran nothing.
# Runs on bash 3.2 (no mapfile / declare -A).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SOUS_TESTS_RAN:-$HERE/../bin/tests-ran}"  # override to test another revision
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sous-test.XXXXXX") || exit 1  # macOS bare mktemp ignores TMPDIR
trap 'rm -r "$WORK"' EXIT
pass=0
fail=0

# $1 = expected count, $2 = expected exit (0 ran, 1 below floor), $3 = label; log on stdin
check() {
  local want_n="$1" want_rc="$2" label="$3" out got_n got_rc
  cat >"$WORK/log.txt"
  out=$("$BASH" "$TOOL" "$WORK/log.txt" 2>&1)
  got_rc=$?
  got_n=$(printf '%s\n' "$out" | sed -n 's/^tests-ran: [^0-9]*\([0-9][0-9]*\) .*/\1/p')
  if [ "$got_n" = "$want_n" ] && [ "$got_rc" = "$want_rc" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    printf 'FAIL %s: want count=%s exit=%s, got count=%s exit=%s\n' "$label" "$want_n" "$want_rc" "$got_n" "$got_rc" >&2
  fi
}

# $1 = expected exit, $2 = label, rest = arguments to tests-ran
expect() {
  local want="$1" label="$2" got
  shift 2
  "$BASH" "$TOOL" "$@" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); printf 'FAIL %s: want exit=%s got=%s\n' "$label" "$want" "$got" >&2
  fi
}

# --- XCTest -----------------------------------------------------------------
# A selector that matches nothing: xcodebuild still prints the success banner.
check 0 1 'xctest: zero executed, banner says succeeded' <<'LOG'
Test Suite 'Selected tests' started at 2026-09-01 10:00:00.000.
Test Suite 'Selected tests' passed at 2026-09-01 10:00:00.001.
	 Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds
** TEST SUCCEEDED **
LOG
# XCTest repeats the total once per nested suite: 12 ran, not 36.
check 12 0 'xctest: nested suites report the same total' <<'LOG'
Test Suite 'CartTests' passed at 2026-09-01 10:00:01.000.
	 Executed 12 tests, with 0 failures (0 unexpected) in 0.412 (0.415) seconds
Test Suite 'AppTests.xctest' passed at 2026-09-01 10:00:01.001.
	 Executed 12 tests, with 0 failures (0 unexpected) in 0.412 (0.416) seconds
Test Suite 'All tests' passed at 2026-09-01 10:00:01.002.
	 Executed 12 tests, with 0 failures (0 unexpected) in 0.412 (0.417) seconds
** TEST SUCCEEDED **
LOG
check 1 0 'xctest: singular "1 test"' <<'LOG'
	 Executed 1 test, with 0 failures (0 unexpected) in 0.003 (0.004) seconds
LOG
# Parallel shards each print their own total. The largest one is reported, so
# this is an undercount (7, not 12). Good enough to tell zero from non-zero.
check 7 0 'xctest: parallel shards undercount' <<'LOG'
	 Executed 5 tests, with 0 failures (0 unexpected) in 0.210 (0.211) seconds
	 Executed 7 tests, with 0 failures (0 unexpected) in 0.305 (0.306) seconds
** TEST SUCCEEDED **
LOG

# --- Swift Testing ----------------------------------------------------------
# An empty selector prints no count line at all. Silence is zero, not unknown.
check 0 1 'swift-testing: banner only, no count line' <<'LOG'
Testing started
** TEST SUCCEEDED **
LOG
check 3 0 'swift-testing: three tests' <<'LOG'
Suite "CookLoopGate" passed after 0.004 seconds.
Test run with 3 tests in 1 suite passed after 0.004 seconds.
LOG
check 0 1 'swift-testing: explicit zero' <<'LOG'
Test run with 0 tests passed after 0.001 seconds.
LOG
# Both harnesses in one log, one of them empty: the other still counts.
check 3 0 'mixed: xctest 0, swift-testing 3' <<'LOG'
	 Executed 0 tests, with 0 failures (0 unexpected) in 0.000 (0.001) seconds
Test run with 3 tests in 1 suite passed after 0.004 seconds.
** TEST SUCCEEDED **
LOG
check 12 0 'mixed: largest harness, not the sum' <<'LOG'
	 Executed 12 tests, with 0 failures (0 unexpected) in 0.412 (0.417) seconds
Test run with 3 tests in 1 suite passed after 0.004 seconds.
LOG

# --- pytest -----------------------------------------------------------------
check 0 1 'pytest: no tests ran' <<'LOG'
collected 0 items

============================ no tests ran in 0.01s =============================
LOG
# Every test skipped: pytest exits 0.
check 0 1 'pytest: all skipped' <<'LOG'
tests/test_api.py sss                                                    [100%]

============================== 3 skipped in 0.02s ==============================
LOG
check 0 1 'pytest: all deselected by -k' <<'LOG'
collected 4 items / 4 deselected / 0 selected

============================ 4 deselected in 0.02s =============================
LOG
check 6 0 'pytest: passed + failed, skipped left out' <<'LOG'
=================== 1 failed, 5 passed, 2 skipped in 0.31s ====================
LOG
check 5 0 'pytest -q: no banner characters' <<'LOG'
.....                                                                    [100%]
5 passed in 0.12s
LOG

# --- Vitest -----------------------------------------------------------------
check 3 0 'vitest: three passed' <<'LOG'
 Test Files  1 passed (1)
      Tests  3 passed (3)
   Start at  10:00:00
   Duration  312ms
LOG
check 0 1 'vitest: --passWithNoTests' <<'LOG'
No test files found, exiting with code 0
LOG
check 0 1 'vitest: all skipped' <<'LOG'
 Test Files  1 skipped (1)
      Tests  3 skipped (3)
LOG
check 3 0 'vitest: failed | passed' <<'LOG'
 Test Files  1 failed (1)
      Tests  1 failed | 2 passed (3)
LOG
# Colored summary line, as CI prints it. Fed from a file, not a pipe: a pipe
# would run check in a subshell and its pass/fail would never be counted.
printf '\033[2m      Tests \033[22m \033[1m\033[32m4 passed\033[39m\033[22m\033[90m (4)\033[39m\n' >"$WORK/ansi.txt"
check 4 0 'vitest: ANSI colors' <"$WORK/ansi.txt"
# A file or suite count on its own (a truncated log) is not a test count.
check 0 1 'vitest: file count alone' <<'LOG'
 Test Files  2 passed (2)
LOG

# --- Jest -------------------------------------------------------------------
# "Test Suites: 1 passed" is a file count and must not be read as a test count.
check 2 0 'jest: suites line ignored, skipped left out' <<'LOG'
Test Suites: 1 passed, 1 total
Tests:       2 skipped, 2 passed, 4 total
Snapshots:   0 total
Time:        0.512 s
LOG
check 0 1 'jest: suite count alone' <<'LOG'
Test Suites: 2 passed, 2 total
LOG
check 0 1 'jest: --passWithNoTests' <<'LOG'
No tests found, exiting with code 0
LOG
check 0 1 'jest: suites passed, every test skipped' <<'LOG'
Test Suites: 1 skipped, 0 of 1 total
Tests:       3 skipped, 3 total
LOG

# --- Not a test log ---------------------------------------------------------
check 0 1 'empty log' </dev/null
check 0 1 'build output that mentions tests in prose' <<'LOG'
Compiling 14 files in 2 targets
note: 3 tests were skipped by the scheme
Build complete in 4.2s
LOG

# --- Floor and usage --------------------------------------------------------
printf '5 passed in 0.12s\n' >"$WORK/five.txt"
expect 0 'floor met'            --min 5 "$WORK/five.txt"
expect 1 'below floor'          --min 6 "$WORK/five.txt"
expect 1 'below floor, = form'  --min=6 "$WORK/five.txt"
expect 0 'floor of 0 never fails' --min 0 /dev/null
expect 2 'missing log does not pass' "$WORK/nope.txt"
expect 2 'no arguments'
expect 2 '--min without a number' --min abc "$WORK/five.txt"
if printf '5 passed in 0.12s\n' | "$BASH" "$TOOL" - >/dev/null 2>&1; then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo 'FAIL stdin via -' >&2
fi

# Sourced: only the function, no exit.
# shellcheck source=/dev/null
if n=$(. "$TOOL" && tests_ran_count "$WORK/five.txt") && [ "$n" = 5 ]; then pass=$((pass + 1)); else
  fail=$((fail + 1)); echo "FAIL sourced tests_ran_count: got '${n:-}'" >&2
fi

printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
