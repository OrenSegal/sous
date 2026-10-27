#!/bin/bash
# tests/run.sh — exercises architecture-lint.sh against the fixtures in
# tests/fixtures/, asserting exit codes. Run from anywhere; paths resolve
# relative to this script.

set -uo pipefail

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${TEST_DIR}/../architecture-lint.sh"
FAILURES=0

check() {
  local name="$1" expect_exit="$2"
  shift 2
  local out
  out="$("$@" 2>&1)"
  local actual=$?
  if [ "$actual" -eq "$expect_exit" ]; then
    echo "PASS  ${name}"
  else
    echo "FAIL  ${name} (expected exit ${expect_exit}, got ${actual})"
    echo "      ${out//$'\n'/$'\n      '}"
    FAILURES=$((FAILURES + 1))
  fi
}

# --- Boundary check: clean fixture, no forbidden imports -------------------
BASELINE_A="$(mktemp -t arch-lint-baseline-clean).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/clean/src" ARCH_LINT_BASELINE_FILE="$BASELINE_A" \
  "$SCRIPT" --init-baseline >/dev/null
check "clean fixture passes" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/clean/src" ARCH_LINT_BASELINE_FILE="$BASELINE_A" "$SCRIPT"
rm -f "$BASELINE_A"

# --- Boundary check: Domain importing UI is a violation --------------------
# Baseline is written by hand at zero (not via --init-baseline against the
# dirty fixture itself) so this exercises a boundary violation with nothing
# in the ratchet to absorb it.
BASELINE_B="$(mktemp -t arch-lint-baseline-violation).json"
cat > "$BASELINE_B" <<'EOF'
{
  "no_singletons": 0,
  "boundaries": 0
}
EOF
check "Domain importing UI fails" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/violation/src" ARCH_LINT_BASELINE_FILE="$BASELINE_B" "$SCRIPT"
rm -f "$BASELINE_B"

# --- Ratchet: at-baseline singleton count passes ----------------------------
BASELINE_C="$(mktemp -t arch-lint-baseline-singleton-ok).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/singleton-ok/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_C" "$SCRIPT" --init-baseline >/dev/null
check "singleton at baseline passes" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/singleton-ok/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_C" "$SCRIPT"

# --- Ratchet: new singleton beyond baseline is a regression -----------------
check "new singleton beyond baseline fails" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/singleton-regression/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_C" "$SCRIPT"
rm -f "$BASELINE_C"

# --- Inline exemption: an exempted singleton doesn't count ------------------
BASELINE_D="$(mktemp -t arch-lint-baseline-exempt).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/singleton-exempt/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_D" "$SCRIPT" --init-baseline >/dev/null
check "arch-exempt comment excludes singleton from count" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/singleton-exempt/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_D" "$SCRIPT"
rm -f "$BASELINE_D"

# --- Ratchet: at-baseline boundary violation count passes -------------------
BASELINE_E="$(mktemp -t arch-lint-baseline-boundary-ok).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/boundary-ratchet-ok/src" \
  ARCH_LINT_BASELINE_FILE="$BASELINE_E" "$SCRIPT" --init-baseline >/dev/null
check "boundary violation at baseline passes" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/boundary-ratchet-ok/src" \
  ARCH_LINT_BASELINE_FILE="$BASELINE_E" "$SCRIPT"

# --- Ratchet: a new boundary violation beyond baseline is a regression -----
check "new boundary violation beyond baseline fails" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/boundary-ratchet-regression/src" \
  ARCH_LINT_BASELINE_FILE="$BASELINE_E" "$SCRIPT"
rm -f "$BASELINE_E"

# --- Ratchet: fewer current violations than baseline is "Improved", not a --
# --- failure ------------------------------------------------------------
BASELINE_F="$(mktemp -t arch-lint-baseline-improved).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/violation/src" ARCH_LINT_BASELINE_FILE="$BASELINE_F" \
  "$SCRIPT" --init-baseline >/dev/null
check "fewer violations than baseline is Improved, still passes" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/clean/src" ARCH_LINT_BASELINE_FILE="$BASELINE_F" "$SCRIPT"
rm -f "$BASELINE_F"

# --- Missing baseline file exits 1 with a message ---------------------------
BASELINE_G="$(mktemp -u -t arch-lint-baseline-missing).json"
check "missing baseline file exits 1" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/clean/src" ARCH_LINT_BASELINE_FILE="$BASELINE_G" "$SCRIPT"

# --- Import matching is anchored to whole module names, not substrings -----
# "import CoreData" must not be treated as importing the "Data" module.
BASELINE_H="$(mktemp -t arch-lint-baseline-anchor).json"
ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/import-anchor-ok/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_H" "$SCRIPT" --init-baseline >/dev/null
check "CoreData import does not false-positive on Data boundary" 0 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/import-anchor-ok/src" ARCH_LINT_FILE_GLOB='*.swift' \
  ARCH_LINT_BASELINE_FILE="$BASELINE_H" "$SCRIPT"
rm -f "$BASELINE_H"

# --- Older baseline file missing "boundaries" key defaults to 0, warns, ----
# --- doesn't crash -----------------------------------------------------
BASELINE_I="$(mktemp -t arch-lint-baseline-old-format).json"
cat > "$BASELINE_I" <<'EOF'
{
  "no_singletons": 0
}
EOF
out_i="$(env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/clean/src" ARCH_LINT_BASELINE_FILE="$BASELINE_I" "$SCRIPT" 2>&1)"
exit_i=$?
if [ "$exit_i" -eq 0 ] && echo "$out_i" | grep -q "No boundaries baseline found"; then
  echo "PASS  baseline missing boundaries key defaults to 0 and warns"
else
  echo "FAIL  baseline missing boundaries key defaults to 0 and warns (exit ${exit_i})"
  echo "      ${out_i//$'\n'/$'\n      '}"
  FAILURES=$((FAILURES + 1))
fi
rm -f "$BASELINE_I"

# --- A modules root that doesn't exist fails instead of passing silently --
# A typo'd or unset ARCH_LINT_MODULES_ROOT used to run zero checks and report
# "clean", which would let a misconfigured CI job pass forever.
BASELINE_J="$(mktemp -t arch-lint-baseline-no-root).json"
cat > "$BASELINE_J" <<'EOF'
{
  "no_singletons": 0,
  "boundaries": 0
}
EOF
check "missing modules root exits 1" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/does-not-exist/src" ARCH_LINT_BASELINE_FILE="$BASELINE_J" "$SCRIPT"
check "missing modules root exits 1 on --init-baseline" 1 \
  env ARCH_LINT_MODULES_ROOT="${TEST_DIR}/fixtures/does-not-exist/src" ARCH_LINT_BASELINE_FILE="$BASELINE_J" "$SCRIPT" --init-baseline
rm -f "$BASELINE_J"

echo ""
if [ "$FAILURES" -gt 0 ]; then
  echo "${FAILURES} test(s) failed"
  exit 1
fi
echo "All tests passed"
