#!/usr/bin/env bash
# Table tests for bin/tests-weakened: each case is a unified diff on stdin, whether
# the tool should flag it (exit 1) or not (exit 0), and a word its output must
# contain. The "clean" rows matter as much as the flagged ones: a rename, an
# extra assertion and an edit to non-test code are not weakening.
# Runs on bash 3.2 (no mapfile / declare -A).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOL="${SOUS_TESTS_WEAKENED:-$HERE/../bin/tests-weakened}"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/sous-test.XXXXXX") || exit 1
trap 'rm -r "$WORK"' EXIT
pass=0
fail=0

# $1 = expected exit, $2 = word expected in the output ("-" for none), $3 = label; diff on stdin
check() {
  local want_rc="$1" word="$2" label="$3" out got_rc
  cat >"$WORK/d.diff"
  out=$("$BASH" "$TOOL" - <"$WORK/d.diff" 2>&1)
  got_rc=$?
  if [ "$got_rc" = "$want_rc" ] && { [ "$word" = - ] || printf '%s' "$out" | grep -q -- "$word"; }; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1)); printf 'FAIL %s: want exit=%s word=%s, got exit=%s\n%s\n' "$label" "$want_rc" "$word" "$got_rc" "$out" >&2
  fi
}

check 1 deleted "python test removed" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,3 +1,1 @@
-def test_adds():
-    assert add(1, 2) == 3
+x = 1
D
check 0 - "python test renamed, assertions kept" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
-def test_adds():
+def test_adds_ints():
     assert add(1, 2) == 3
D
check 0 - "assertion added" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
 def test_adds():
     assert add(1, 2) == 3
+    assert add(2, 2) == 4
D
check 1 skipped "pytest skip added" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
+@pytest.mark.skip(reason="flaky")
 def test_adds():
     assert add(1, 2) == 3
D
check 1 skipped "jest it.skip added" <<'D'
diff --git a/web/cart.test.ts b/web/cart.test.ts
--- a/web/cart.test.ts
+++ b/web/cart.test.ts
@@ -1,2 +1,2 @@
-it('totals', () => {
+it.skip('totals', () => {
   expect(total()).toBe(3)
D
check 1 skipped "only added leaves the rest unrun" <<'D'
diff --git a/web/cart.spec.js b/web/cart.spec.js
--- a/web/cart.spec.js
+++ b/web/cart.spec.js
@@ -1,2 +1,2 @@
-test('totals', () => {
+test.only('totals', () => {
   expect(total()).toBe(3)
D
check 1 skipped "XCTSkip added" <<'D'
diff --git a/App/CartTests.swift b/App/CartTests.swift
--- a/App/CartTests.swift
+++ b/App/CartTests.swift
@@ -1,2 +1,3 @@
 func testTotals() throws {
+    throw XCTSkip("later")
     XCTAssertEqual(total(), 3)
D
check 1 skipped "go t.Skip added" <<'D'
diff --git a/cart/cart_test.go b/cart/cart_test.go
--- a/cart/cart_test.go
+++ b/cart/cart_test.go
@@ -1,2 +1,3 @@
 func TestTotals(t *testing.T) {
+	t.Skip("later")
 	if total() != 3 { t.Fatal("bad") }
D
check 1 skipped "rust ignore added" <<'D'
diff --git a/tests/cart.rs b/tests/cart.rs
--- a/tests/cart.rs
+++ b/tests/cart.rs
@@ -1,2 +1,3 @@
+#[ignore]
 #[test]
 fn totals() { assert_eq!(total(), 3); }
D
check 1 fewer "assertions loosened away" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,4 +1,2 @@
 def test_adds():
-    assert add(1, 2) == 3
-    assert add(0, 0) == 0
+    pass
D
check 1 trivial "assert True added" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_adds():
-    assert add(1, 2) == 3
+    assert True
D
check 1 trivial "expect(true).toBe(true) added" <<'D'
diff --git a/web/cart.test.ts b/web/cart.test.ts
--- a/web/cart.test.ts
+++ b/web/cart.test.ts
@@ -1,2 +1,2 @@
 it('totals', () => {
-  expect(total()).toBe(3)
+  expect(true).toBe(true)
D
check 1 "test file removed" "test file deleted" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
deleted file mode 100644
--- a/tests/test_a.py
+++ /dev/null
@@ -1,2 +0,0 @@
-def test_adds():
-    assert add(1, 2) == 3
D
check 0 - "edit to non-test code with skip in it" <<'D'
diff --git a/src/cart.py b/src/cart.py
--- a/src/cart.py
+++ b/src/cart.py
@@ -1,2 +1,3 @@
+def skip(items): return items[1:]
 def total(): return 3
D
check 0 - "assertion removed in non-test file" <<'D'
diff --git a/src/cart.py b/src/cart.py
--- a/src/cart.py
+++ b/src/cart.py
@@ -1,2 +1,1 @@
-    assert items
 def total(): return 3
D
check 0 - "empty diff" </dev/null
check 0 - "require() import swapped for import is not an assertion" <<'D'
diff --git a/web/cart.test.js b/web/cart.test.js
--- a/web/cart.test.js
+++ b/web/cart.test.js
@@ -1,2 +1,2 @@
-const { total } = require('./cart')
+import { total } from './cart'
 test('totals', () => { expect(total()).toBe(3) })
D
check 1 fewer "go require.Equal removed is an assertion" <<'D'
diff --git a/cart/cart_test.go b/cart/cart_test.go
--- a/cart/cart_test.go
+++ b/cart/cart_test.go
@@ -1,3 +1,2 @@
 func TestTotals(t *testing.T) {
-	require.Equal(t, 3, total())
 }
D

# Loosening: an exact assertion swapped for one that accepts more.
check 1 loosened "== 42 changed to is not None" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_answer():
-    assert answer() == 42
+    assert answer() is not None
D
check 1 loosened "toBe changed to toBeDefined" <<'D'
diff --git a/web/cart.test.ts b/web/cart.test.ts
--- a/web/cart.test.ts
+++ b/web/cart.test.ts
@@ -1,2 +1,2 @@
 it('totals', () => {
-  expect(total()).toBe(3)
+  expect(total()).toBeDefined()
D
check 1 loosened "assertEqual changed to assertIsNotNone" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_answer(self):
-    self.assertEqual(answer(), 42)
+    self.assertIsNotNone(answer())
D
check 1 loosened "== 42 changed to >= 0" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_answer():
-    assert answer() == 42
+    assert answer() >= 0
D
check 0 - "exact value changed to another exact value" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_answer():
-    assert answer() == 42
+    assert answer() == 43
D
check 0 - "a weak assertion added next to the exact one" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
 def test_answer():
+    assert answer() is not None
     assert answer() == 42
D
check 0 - "exact assertion moved, a weak one added in a new test" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,5 @@
 def test_answer():
-    assert answer() == 42
+    assert answer(1) == 42
+
+def test_exists():
+    assert answer() is not None
D

# Commented out: the code is still in the file, so the name and the count looked kept.
check 1 commented "python test commented out" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
-def test_adds():
-    assert add(1, 2) == 3
+# def test_adds():
+#     assert add(1, 2) == 3
D
check 1 commented "js test commented out" <<'D'
diff --git a/web/cart.test.ts b/web/cart.test.ts
--- a/web/cart.test.ts
+++ b/web/cart.test.ts
@@ -1,3 +1,3 @@
-it('totals', () => {
-  expect(total()).toBe(3)
-})
+// it('totals', () => {
+//   expect(total()).toBe(3)
+// })
D
check 0 - "a new comment that mentions assert" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
 def test_adds():
+    # assert on the sum, not the type
     assert add(1, 2) == 3
D
check 0 - "swift #expect is not a comment" <<'D'
diff --git a/App/CartTests.swift b/App/CartTests.swift
--- a/App/CartTests.swift
+++ b/App/CartTests.swift
@@ -1,2 +1,2 @@
 @Test func totals() {
-    #expect(total() == 3)
+    #expect(total(1) == 3)
D

# An early return leaves everything under it unreached.
check 1 unreachable "bare return above an assertion" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
 def test_adds():
+    return
     assert add(1, 2) == 3
D
check 1 unreachable "go return above a check" <<'D'
diff --git a/cart/cart_test.go b/cart/cart_test.go
--- a/cart/cart_test.go
+++ b/cart/cart_test.go
@@ -1,2 +1,3 @@
 func TestTotals(t *testing.T) {
+	return
 	require.Equal(t, 3, total())
D
check 0 - "guarded return: the assertion is at a shallower indent" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,4 @@
 def test_adds():
+    if no_db():
+        return
     assert add(1, 2) == 3
D
check 0 - "return in a helper with no assertion after it" <<'D'
diff --git a/tests/helpers.py b/tests/helpers.py
--- a/tests/helpers.py
+++ b/tests/helpers.py
@@ -1,2 +1,3 @@
 def make():
     x = 1
+    return
D

# A dummy: the name stays or changes, the body proves nothing.
check 1 dummy "test body replaced by pass, helper call removed" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_adds():
-    check_total(add(1, 2), 3)
+    pass
D
check 1 dummy "new one-line empty test" <<'D'
diff --git a/web/cart.test.ts b/web/cart.test.ts
--- a/web/cart.test.ts
+++ b/web/cart.test.ts
@@ -1,1 +1,1 @@
-it('totals', () => { checkTotal(total(), 3) })
+it('totals', () => {})
D
check 1 trivial "replaced by an assertion on constants" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
-def test_adds():
-    assert add(1, 2) == 3
+def test_dummy():
+    assert 2 + 2 == 4
D
check 1 trivial "assertEqual of two constants" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,2 @@
 def test_adds(self):
-    self.assertEqual(add(1, 2), 3)
+    self.assertEqual(3, 3)
D
check 0 - "pass in an except block is not a dummy test" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,4 +1,4 @@
 def test_adds():
     try:
-        cleanup()
+        pass
     except OSError:
D
check 0 - "assertion comparing a call to a constant is not trivial" <<'D'
diff --git a/tests/test_a.py b/tests/test_a.py
--- a/tests/test_a.py
+++ b/tests/test_a.py
@@ -1,2 +1,3 @@
 def test_adds():
     assert add(1, 2) == 3
+    assert add(2, 2) == 4
D

# Moved out of where the runner looks.
check 1 moved "git mv out of tests/" <<'D'
diff --git a/tests/test_a.py b/attic/test_a.py
similarity index 100%
rename from tests/test_a.py
rename to attic/test_a.py
D
check 1 moved "moved with an edit, out of tests/" <<'D'
diff --git a/tests/test_a.py b/old/a.py
similarity index 90%
rename from tests/test_a.py
rename to old/a.py
--- a/tests/test_a.py
+++ b/old/a.py
@@ -1,1 +1,1 @@
-x = 1
+x = 2
D
check 0 - "moved within tests/" <<'D'
diff --git a/tests/test_a.py b/tests/unit/test_a.py
similarity index 100%
rename from tests/test_a.py
rename to tests/unit/test_a.py
D
check 0 - "colocated: the new name still says it is a test" <<'D'
diff --git a/tests/a.test.ts b/src/a.test.ts
similarity index 100%
rename from tests/a.test.ts
rename to src/a.test.ts
D
check 0 - "renamed source file" <<'D'
diff --git a/src/a.py b/lib/a.py
similarity index 100%
rename from src/a.py
rename to lib/a.py
D

# Told the runner not to look.
check 1 ignored "pytest.ini ignore added" <<'D'
diff --git a/pytest.ini b/pytest.ini
--- a/pytest.ini
+++ b/pytest.ini
@@ -1,2 +1,2 @@
 [pytest]
-addopts = -q
+addopts = -q --ignore=tests/test_a.py
D
check 1 ignored "pyproject deselect" <<'D'
diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,1 +1,2 @@
 [tool.pytest.ini_options]
+addopts = "--deselect tests/test_a.py::test_adds"
D
check 1 ignored "conftest collect_ignore" <<'D'
diff --git a/conftest.py b/conftest.py
--- a/conftest.py
+++ b/conftest.py
@@ -1,1 +1,2 @@
 import pytest
+collect_ignore = ["tests/test_a.py"]
D
check 1 ignored "jest testPathIgnorePatterns" <<'D'
diff --git a/jest.config.js b/jest.config.js
--- a/jest.config.js
+++ b/jest.config.js
@@ -1,1 +1,2 @@
 module.exports = {
+  testPathIgnorePatterns: ['cart'],
D
check 0 - "pytest.ini option that ignores nothing" <<'D'
diff --git a/pytest.ini b/pytest.ini
--- a/pytest.ini
+++ b/pytest.ini
@@ -1,2 +1,2 @@
 [pytest]
-addopts = -q
+addopts = -q --tb=short
D
check 0 - "ignore in an unrelated config file" <<'D'
diff --git a/.eslintrc.json b/.eslintrc.json
--- a/.eslintrc.json
+++ b/.eslintrc.json
@@ -1,1 +1,2 @@
 {
+  "ignorePatterns": ["--ignore"],
D
check 0 - "pyproject ruff exclude is not a test setting" <<'D'
diff --git a/pyproject.toml b/pyproject.toml
--- a/pyproject.toml
+++ b/pyproject.toml
@@ -1,1 +1,2 @@
 [tool.ruff]
+exclude = ["tests/fixtures"]
D

# Against a ref: the diff is taken from the merge base, so tests the base
# branch added after this branch forked are not read as deleted here.
repo="$WORK/repo"; mkdir -p "$repo/tests"
g() { git -C "$repo" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
printf 'def test_a():\n    assert 1 + 1 == 2\n' >"$repo/tests/test_a.py"
g init -q -b main; g add -A; g commit -qm base
g checkout -q -b feature
printf 'x = 1\n' >"$repo/app.py"; g add -A; g commit -qm feature
g checkout -q main
printf 'def test_b():\n    assert 2 + 2 == 4\n' >"$repo/tests/test_b.py"; g add -A; g commit -qm "main adds a test"
g checkout -q feature
out=$(cd "$repo" && "$BASH" "$TOOL" main 2>&1); rc=$?
if [ "$rc" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL base moved on: want exit 0, got %s\n%s\n' "$rc" "$out" >&2; fi
# A ref that doesn't resolve must not read as clean.
out=$(cd "$repo" && "$BASH" "$TOOL" no-such-ref 2>&1); rc=$?
if [ "$rc" = 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL unknown ref: want exit 2, got %s\n%s\n' "$rc" "$out" >&2; fi
# The branch's own weakening still shows against the ref.
g rm -q tests/test_a.py; g commit -qm "drop test"
out=$(cd "$repo" && "$BASH" "$TOOL" main 2>&1); rc=$?
if [ "$rc" = 1 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL branch deletion: want exit 1, got %s\n%s\n' "$rc" "$out" >&2; fi

# A real git mv, staged: the tool's own diff has to show the rename.
repo2="$WORK/repo2"; mkdir -p "$repo2/tests" "$repo2/attic"
g2() { git -C "$repo2" -c user.name=t -c user.email=t@t -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
printf 'def test_a():\n    assert add(1, 1) == 2\n' >"$repo2/tests/test_a.py"
g2 init -q -b main; g2 add -A; g2 commit -qm base; g2 mv tests/test_a.py attic/test_a.py
out=$(cd "$repo2" && "$BASH" "$TOOL" 2>&1); rc=$?
case "$rc:$out" in 1:*moved*) pass=$((pass + 1)) ;; *) fail=$((fail + 1)); printf 'FAIL git mv out of tests/: exit %s\n%s\n' "$rc" "$out" >&2 ;; esac

# Exit codes for usage: a missing git repository must not read as clean.
d="$WORK/notrepo"; mkdir "$d"
(cd "$d" && GIT_CEILING_DIRECTORIES="$WORK" "$BASH" "$TOOL" >/dev/null 2>&1); rc=$?
if [ "$rc" = 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL outside a repo: want exit 2, got %s\n' "$rc" >&2; fi

echo "tests-weakened: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
