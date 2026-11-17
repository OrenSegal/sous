#!/bin/sh
# Builds a Python project whose tests hold one test of each kind prune-tests
# names, plus two anchored tests that must stay:
#   test_pricing.py::test_discount             keep (behavior)
#   test_pricing.py::test_discount_formula     rewrite (expected value repeats the code)
#   test_pricing.py::test_total_with_tax       keep (behavior)
#   test_checkout.py::test_total_includes_tax  delete (same behavior as test_total_with_tax)
#   test_checkout.py::test_legacy_gone         delete (guards code that no longer exists)
#   test_checkout.py::test_reset_clears_cache  delete, with src/pricing.py::_reset_for_tests
# Runs in the empty eval workspace. No network.
set -eu

mkdir -p src tests
: > src/__init__.py
cat > src/pricing.py <<'PY'
_cache = {}


def apply_discount(price, rate):
    return round(price * (1 - rate), 2)


def total(items, tax):
    key = (tuple(items), tax)
    if key not in _cache:
        _cache[key] = round(sum(items) * (1 + tax), 2)
    return _cache[key]


def _reset_for_tests():
    _cache.clear()
PY
cat > tests/test_pricing.py <<'PY'
from src.pricing import apply_discount, total


def test_discount():
    assert apply_discount(100, 0.2) == 80


def test_discount_formula():
    price, rate = 59.99, 0.15
    assert apply_discount(price, rate) == round(price * (1 - rate), 2)


def test_total_with_tax():
    assert total([10, 20], 0.1) == 33
PY
cat > tests/test_checkout.py <<'PY'
import os

from src import pricing


def test_total_includes_tax():
    assert pricing.total([10, 20], 0.1) == 33.0


def test_legacy_gone():
    assert not os.path.exists("src/legacy_pricing.py")


def test_reset_clears_cache():
    pricing.total([1], 0)
    pricing._reset_for_tests()
    assert pricing._cache == {}
PY
