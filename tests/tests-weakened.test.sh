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

# Exit codes for usage: a missing git repository must not read as clean.
d="$WORK/notrepo"; mkdir "$d"
(cd "$d" && GIT_CEILING_DIRECTORIES="$WORK" "$BASH" "$TOOL" >/dev/null 2>&1); rc=$?
if [ "$rc" = 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); printf 'FAIL outside a repo: want exit 2, got %s\n' "$rc" >&2; fi

echo "tests-weakened: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
