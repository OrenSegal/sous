"""`deuce status` (read-only) and `deuce undo --last` (recreate the last
deleted branch from the audit log)."""

from __future__ import annotations

from conftest import by_branch, git, run, run_json
from deuce import cli


def _clean(capsys, sandbox, branch, **kw):
    tip = sandbox.feature(branch, **kw)
    sandbox.merge(branch)
    sandbox.fetch()
    code, _ = run_json(capsys, "sweep", "--apply", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert branch not in sandbox.local_branches()
    return tip


# ── status ──────────────────────────────────────────────────────────────────

def test_status_lists_stale_and_live_branches_and_changes_nothing(capsys, sandbox):
    sandbox.feature("feat/done")
    sandbox.merge("feat/done")
    sandbox.feature("feat/wip")
    sandbox.fetch()
    before = (sandbox.local_branches(), sandbox.remote_branches(), sandbox.worktrees())

    code, report = run_json(capsys, "status", "--repo", str(sandbox.repo))

    assert code == cli.EXIT_OK
    assert report["command"] == "status"
    entries = by_branch(report)
    assert entries["feat/done"]["decision"] == "sweep"
    assert entries["feat/wip"]["decision"] == "keep"
    assert entries["feat/done"]["worktree"] == str(sandbox.worktree_path("feat/done"))
    assert (sandbox.local_branches(), sandbox.remote_branches(), sandbox.worktrees()) == before


def test_status_text_is_a_table_of_every_branch(capsys, sandbox):
    sandbox.feature("feat/done")
    sandbox.merge("feat/done")
    sandbox.fetch()
    code, out, _ = run(capsys, "status", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert "feat/done" in out and "stale" in out
    assert "main" in out
    assert "deuce sweep" in out


def test_status_exits_0_even_when_a_sweep_would_refuse(capsys, sandbox):
    sandbox.feature("feat/dirty")
    sandbox.merge("feat/dirty")
    sandbox.fetch()
    (sandbox.worktree_path("feat/dirty") / "x.txt").write_text("x")
    code, report = run_json(capsys, "status", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert by_branch(report)["feat/dirty"]["decision"] == "refuse"


# ── undo ────────────────────────────────────────────────────────────────────

def test_undo_last_recreates_the_branch_at_its_logged_tip(capsys, sandbox):
    tip = _clean(capsys, sandbox, "feat/oops")
    code, out, _ = run(capsys, "undo", "--last", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert sandbox.tip("refs/heads/feat/oops") == tip
    assert "re-push" in out and "git push -u origin feat/oops" in out
    assert "git worktree add" in out and str(sandbox.worktree_path("feat/oops")) in out


def test_undo_walks_back_one_deletion_at_a_time(capsys, sandbox):
    first = _clean(capsys, sandbox, "feat/one", worktree=False)
    second = _clean(capsys, sandbox, "feat/two", worktree=False)
    assert run(capsys, "undo", "--last", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK
    assert sandbox.tip("refs/heads/feat/two") == second
    assert "feat/one" not in sandbox.local_branches()
    assert run(capsys, "undo", "--last", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK
    assert sandbox.tip("refs/heads/feat/one") == first


def test_a_restored_branch_is_kept_with_an_accurate_reason(capsys, sandbox):
    """`git branch <name> <sha>` leaves one 'Created from' reflog entry, so the
    restored branch is kept as `no-commits`; the reason must not call it empty."""
    tip = _clean(capsys, sandbox, "feat/back")
    assert run(capsys, "undo", "--last", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK

    code, report = run_json(capsys, "sweep", "--apply", "--repo", str(sandbox.repo))
    entry = by_branch(report)["feat/back"]
    assert code == cli.EXIT_OK
    assert (entry["decision"], entry["rule"]) == ("keep", "no-commits")
    assert "no commits on this branch yet" not in entry["reason"]
    assert "no commits beyond origin/main" in entry["reason"] and "deuce undo" in entry["reason"]
    assert sandbox.tip("refs/heads/feat/back") == tip


def test_a_restored_squash_merged_branch_is_kept_not_deleted_again(capsys, sandbox, fake_gh):
    tip = sandbox.feature("feat/sq", commits=2)
    sandbox.squash("feat/sq")
    sandbox.fetch()
    fake_gh.add("feat/sq", 7, "MERGED", tip)
    assert run_json(capsys, "sweep", "--apply", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK
    assert "feat/sq" not in sandbox.local_branches()
    assert run(capsys, "undo", "--last", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK

    code, report = run_json(capsys, "sweep", "--apply", "--repo", str(sandbox.repo))
    entry = by_branch(report)["feat/sq"]
    assert code == cli.EXIT_OK
    assert (entry["decision"], entry["rule"]) == ("keep", "no-commits")
    assert "no commits" not in entry["reason"]
    assert "not on origin/main" in entry["reason"] and "deuce undo" in entry["reason"]
    assert sandbox.tip("refs/heads/feat/sq") == tip


def test_undo_with_nothing_logged_is_a_no_op(capsys, sandbox):
    code, out, _ = run(capsys, "undo", "--last", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert "nothing to undo" in out.lower()


def test_undo_never_overwrites_an_existing_branch(capsys, sandbox):
    _clean(capsys, sandbox, "feat/again", worktree=False)
    git(sandbox.repo, "branch", "feat/again", "main")
    main_tip = sandbox.tip("main")
    code, _, err = run(capsys, "undo", "--last", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_REFUSED
    assert "already exists" in err
    assert sandbox.tip("refs/heads/feat/again") == main_tip


def test_undo_is_scoped_to_the_repository(capsys, sandbox, tmp_path):
    _clean(capsys, sandbox, "feat/elsewhere", worktree=False)
    other = tmp_path / "unrelated"
    git(tmp_path, "init", "-q", "-b", "main", str(other))
    (other / "f").write_text("x")
    git(other, "add", "f")
    git(other, "commit", "-q", "-m", "init")
    code, out, _ = run(capsys, "undo", "--last", "--repo", str(other))
    assert code == cli.EXIT_OK
    assert "nothing to undo" in out.lower()
    assert "feat/elsewhere" not in git(other, "branch", "--format=%(refname:short)")
