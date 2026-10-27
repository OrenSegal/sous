#!/bin/bash
# architecture-lint.sh
#
# Config-driven package/module boundary enforcement with a ratchet baseline.
#
# Why this exists: architecture docs rot the moment nobody's forced to check
# them. This script makes the allowed dependency graph and a structural rule
# (no singletons) machine-checked instead of aspirational. It's designed to
# be dropped into a modular codebase where each module is a directory and an
# import fits on one grep-able line (tested with TypeScript and Swift; see
# README "Languages") with a few lines of config, not a rewrite.
#
# Two properties make this durable in a real codebase instead of getting
# disabled after the first false positive:
#
#   1. Ratchet baseline (.arch_lint_baseline.json) — existing violations
#      (boundary violations AND singletons) are grandfathered in, not
#      blocked. The gate only fails on NEW violations. The baseline numbers
#      may only shrink over time, never grow. This is what makes it possible
#      to introduce this into a codebase that already has debt, without a
#      giant one-time fix-everything PR.
#
#   2. Inline exemptions (`// arch-exempt: <rule>`) — for the rare case where
#      breaking a rule is the right call (e.g. a framework requires a
#      singleton), the exemption is visible right next to the code, not
#      hidden in a config file nobody reads. This currently applies to the
#      singleton rule only, not boundary violations.
#
# Usage:
#   ./architecture-lint.sh                # check + ratchet, exit 1 on regression
#   ./architecture-lint.sh --init-baseline # write current violation counts as baseline
#
# Config: edit BOUNDARIES below.

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
BASELINE_FILE="${ARCH_LINT_BASELINE_FILE:-${REPO_ROOT}/.arch_lint_baseline.json}"

# ---------------------------------------------------------------------------
# Config — edit for your codebase's module graph.
# Format: "module_dir|forbidden_import_module" (matched as a whole word, not
# a substring — "Data" won't match "CoreData").
# Example below models a common layered architecture:
#   Domain (innermost, zero deps) → Data/Services → UI → App (outermost)
# ---------------------------------------------------------------------------

BOUNDARIES=(
  "Domain|UI"
  "Domain|Services"
  "Domain|Data"
  "UI|Services"
  "UI|Data"
  "Services|UI"
  "Data|UI"
  "Data|Services"
)

# Directory holding your modules, and the source-file glob to lint.
# Overridable via env (ARCH_LINT_*) so the same script can be exercised
# against multiple fixture languages in tests/run.sh without editing this file.
MODULES_ROOT="${ARCH_LINT_MODULES_ROOT:-src}"
FILE_GLOB="${ARCH_LINT_FILE_GLOB:-*.ts}"          # e.g. "*.swift", "*.py", "*.go"
IMPORT_KEYWORD="${ARCH_LINT_IMPORT_KEYWORD:-import}"   # an ERE, e.g. "import", "(from|import)" for Python, 'require\('

# ---------------------------------------------------------------------------
# Boundary check — counts actual violating import lines (not just how many
# rules were broken), ratcheted against a baseline the same way as
# no_singletons below.
# ---------------------------------------------------------------------------

CHECKS=0
VIOLATIONS=0
current_boundaries=0

check_no_import() {
  local module="$1" forbidden="$2"
  local dir="${MODULES_ROOT}/${module}"
  [[ -d "$dir" ]] || return 0

  CHECKS=$((CHECKS + 1))
  local hits
  hits=$(grep -rnE "${IMPORT_KEYWORD}.*\b${forbidden}\b" "$dir" --include="$FILE_GLOB" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    local count
    count=$(echo "$hits" | grep -c .)
    current_boundaries=$((current_boundaries + count))
    echo -e "${RED}x ${module} must not import ${forbidden}:${NC}"
    echo "   ${hits//$'\n'/$'\n   '}"
  fi
}

echo "Architecture Lint"
echo "=================="
echo ""

# A wrong MODULES_ROOT would otherwise run zero checks and report clean.
if [ ! -d "$MODULES_ROOT" ]; then
  echo -e "${RED}Modules root not found: ${MODULES_ROOT} (set MODULES_ROOT or ARCH_LINT_MODULES_ROOT).${NC}"
  exit 1
fi

for rule in "${BOUNDARIES[@]}"; do
  IFS='|' read -r module forbidden <<< "$rule"
  check_no_import "$module" "$forbidden"
done

echo ""
echo "Boundary checks run: $CHECKS"

# ---------------------------------------------------------------------------
# Ratchet baseline for pattern-based rules (e.g. no-singletons)
#
# This is the part worth stealing even if you don't use the boundary check
# above: any grep-able anti-pattern can be gated this way without requiring
# a big-bang cleanup before the gate can go live. The regex below is a Swift
# example (`static let shared`) — swap it for your language's singleton
# idiom (`_instance = None`, `getInstance()`, etc).
# ---------------------------------------------------------------------------

singleton_hits=$(
  grep -rlnE 'static (let|var) shared\b' "$MODULES_ROOT" --include="$FILE_GLOB" 2>/dev/null | \
  xargs -I{} grep -nE 'static (let|var) shared\b' {} /dev/null 2>/dev/null | \
  grep -v 'arch-exempt: singleton' || true
)
current_singletons=$(echo "$singleton_hits" | grep -c . || true)
[ -z "$singleton_hits" ] && current_singletons=0

if [ "${1:-}" == "--init-baseline" ]; then
  cat > "$BASELINE_FILE" <<EOF
{
  "no_singletons": ${current_singletons},
  "boundaries": ${current_boundaries}
}
EOF
  echo -e "${GREEN}Baseline written: no_singletons=${current_singletons}, boundaries=${current_boundaries}${NC}"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo -e "${YELLOW}No baseline file found. Run with --init-baseline first.${NC}"
  exit 1
fi

baseline_singletons=$(grep '"no_singletons"' "$BASELINE_FILE" | grep -oE '[0-9]+')

baseline_boundaries=$(grep '"boundaries"' "$BASELINE_FILE" 2>/dev/null | grep -oE '[0-9]+' || true)
if [ -z "$baseline_boundaries" ]; then
  baseline_boundaries=0
  echo -e "${YELLOW}No boundaries baseline found in ${BASELINE_FILE} (older baseline file) — defaulting to 0.${NC}"
fi

echo ""
echo "Ratchet: boundaries (baseline=${baseline_boundaries}, current=${current_boundaries})"

if [ "$current_boundaries" -gt "$baseline_boundaries" ]; then
  new_count=$((current_boundaries - baseline_boundaries))
  echo -e "${RED}  REGRESSION: ${new_count} new violation(s)${NC}"
  VIOLATIONS=$((VIOLATIONS + new_count))
elif [ "$current_boundaries" -lt "$baseline_boundaries" ]; then
  echo -e "${GREEN}  Improved: ${current_boundaries} violations (baseline was ${baseline_boundaries}) - shrink the baseline file${NC}"
else
  echo -e "${GREEN}  OK: at or within baseline${NC}"
fi

echo ""
echo "Ratchet: no_singletons (baseline=${baseline_singletons}, current=${current_singletons})"

if [ "$current_singletons" -gt "$baseline_singletons" ]; then
  new_count=$((current_singletons - baseline_singletons))
  echo -e "${RED}  REGRESSION: ${new_count} new violation(s)${NC}"
  echo "  ${singleton_hits//$'\n'/$'\n  '}"
  VIOLATIONS=$((VIOLATIONS + new_count))
elif [ "$current_singletons" -lt "$baseline_singletons" ]; then
  echo -e "${GREEN}  Improved: ${current_singletons} violations (baseline was ${baseline_singletons}) - shrink the baseline file${NC}"
else
  echo -e "${GREEN}  OK: at or within baseline${NC}"
fi

echo ""
if [ "$VIOLATIONS" -gt 0 ]; then
  echo -e "${RED}x Architecture lint failed: ${VIOLATIONS} violation(s)${NC}"
  echo "  Fix them, or add an inline exemption with justification."
  exit 1
else
  echo -e "${GREEN}Architecture lint clean.${NC}"
  exit 0
fi
