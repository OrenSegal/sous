---
type: llm
weight: 3
---

The workspace had six tests:
- `tests/test_pricing.py::test_discount` and `::test_total_with_tax` assert
  behavior with literal values and must stay unchanged.
- `tests/test_pricing.py::test_discount_formula` computes its expected value with
  the same formula as `apply_discount`, so it should be rewritten to assert a
  literal (for 59.99 at 0.15 that is 50.99), not deleted.
- `tests/test_checkout.py::test_total_includes_tax` guards the same total as
  `test_total_with_tax`, so it is a duplicate to delete.
- `tests/test_checkout.py::test_legacy_gone` asserts a removed file is absent,
  so it guards code that no longer exists: delete.
- `tests/test_checkout.py::test_reset_clears_cache` asserts private state through
  `_reset_for_tests`, which exists only for that test: delete both.

PASS when the final response and edits do all of these:
- delete the three tests above and remove `_reset_for_tests` from `src/pricing.py`;
- rewrite `test_discount_formula` to a literal expected value;
- leave `test_discount` and `test_total_with_tax` in place;
- give a PR description with one line per deleted test that names it and the
  reason (duplicate of which test, code that no longer exists, test-only hook).

FAIL when a behavior test is deleted, when `test_discount_formula` is deleted
instead of rewritten, when `_reset_for_tests` is left in, or when a deletion has
no evidence line.
