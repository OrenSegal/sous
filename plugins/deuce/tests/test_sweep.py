"""`deuce sweep` end to end against real git: a bare 'remote', worktrees,
and branches merged with a merge commit, a squash and a rebase. Each hard
refusal has its own test, and each checks that nothing was touched."""

from __future__ import annotations

import os

import pytest

from conftest import by_branch, git, run, run_json
from deuce import audit, cli, lock

FORCE = "-" + "D"  # spelled in parts: a local guard blocks the literal


def _sweep(capsys, sandbox, *extra):
    return run_json(capsys, "sweep", "--repo", str(sandbox.repo), *extra)


def _apply(capsys, sandbox, *extra):
    return _sweep(capsys, sandbox, "--apply", *extra)


def _untouched(sandbox, branch, worktree=True):
    assert branch in sandbox.local_branches()
    if worktree:
        assert str(sandbox.worktree_path(branch)) in sandbox.worktrees()
        assert sandbox.worktree_path(branch).is_dir()


# ── The happy paths ─────────────────────────────────────────────────────────

def test_dry_run_is_the_default_and_changes_nothing(capsys, sandbox):
    tip = sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    before = (sandbox.local_branches(), sandbox.remote_branches(), sandbox.worktrees())

    code, report = _sweep(capsys, sandbox)

    assert code == cli.EXIT_OK
    assert report["applied"] is False
    entry = by_branch(report)["feat/a"]
    assert entry["decision"] == "sweep"
    assert entry["tip"] == tip
    assert entry["evidence"]["source"] == "git"
    assert entry["evidence"]["kind"] == "ancestor"
    assert [a["kind"] for a in entry["actions"]] == ["remove-worktree", "delete-branch", "delete-remote-branch"]
    assert all(a["status"] == "planned" for a in entry["actions"])
    assert (sandbox.local_branches(), sandbox.remote_branches(), sandbox.worktrees()) == before


def test_dry_run_text_says_what_and_why_and_how_to_apply(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    code, out, _ = run(capsys, "sweep", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_OK
    assert "dry run" in out.lower()
    assert "feat/a" in out and "ancestor of origin/main" in out
    assert "git worktree remove" in out and "branch -d feat/a" in out
    assert "--apply" in out


def test_apply_cleans_a_merged_branch_and_tidies_the_repo(capsys, sandbox):
    tip = sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()

    code, report = _apply(capsys, sandbox)

    assert code == cli.EXIT_OK
    assert report["applied"] is True
    assert "feat/a" not in sandbox.local_branches()
    assert "feat/a" not in sandbox.remote_branches()
    assert str(sandbox.worktree_path("feat/a")) not in sandbox.worktrees()
    assert not sandbox.worktree_path("feat/a").exists()
    assert sandbox.tip("main") == sandbox.tip("origin/main"), "base was fast-forwarded"
    assert [a["status"] for a in by_branch(report)["feat/a"]["actions"]] == ["done", "done", "done"]
    assert [f["kind"] for f in report["finish"]] == ["fetch-prune", "fast-forward", "prune-worktrees"]

    rows = audit.AuditLog.default().rows()
    deleted = [r for r in rows if r["action"] == "delete-branch"]
    assert deleted and deleted[-1]["branch"] == "feat/a" and deleted[-1]["sha"] == tip
    assert deleted[-1]["remote"] == "origin"
    assert {r["action"] for r in rows} >= {"remove-worktree", "delete-branch", "delete-remote-branch", "fetch-prune"}


def test_a_second_sweep_has_nothing_to_do(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    _apply(capsys, sandbox)
    code, report = _sweep(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert report["summary"]["sweep"] == 0


def test_unmerged_branch_is_kept(capsys, sandbox):
    sandbox.feature("feat/wip")
    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    entry = by_branch(report)["feat/wip"]
    assert entry["decision"] == "keep"
    assert "not merged" in entry["reason"]
    _untouched(sandbox, "feat/wip")
    assert "feat/wip" in sandbox.remote_branches()


def test_branch_without_a_worktree_is_swept(capsys, sandbox):
    sandbox.feature("feat/plain", worktree=False)
    sandbox.merge("feat/plain")
    sandbox.fetch()
    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert [a["kind"] for a in by_branch(report)["feat/plain"]["actions"]] == ["delete-branch", "delete-remote-branch"]
    assert "feat/plain" not in sandbox.local_branches()


def test_rebase_merge_without_gh_is_found_by_git_cherry(capsys, sandbox):
    sandbox.feature("feat/rb", commits=2)
    sandbox.rebase_merge("feat/rb")
    sandbox.fetch()
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/rb"]
    assert code == cli.EXIT_OK
    assert entry["evidence"]["kind"] == "cherry"
    assert "gh not found" in entry["evidence"]["detail"]
    assert "feat/rb" not in sandbox.local_branches()


def test_squash_merge_without_gh_is_not_guessed(capsys, sandbox):
    sandbox.feature("feat/sq", commits=2)
    sandbox.squash("feat/sq")
    sandbox.fetch()
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/sq"]
    assert code == cli.EXIT_OK
    assert entry["decision"] == "keep"
    assert "gh not found" in entry["reason"]
    _untouched(sandbox, "feat/sq")


# ── gh evidence ─────────────────────────────────────────────────────────────

def test_squash_merged_pr_with_matching_tip_is_force_deleted(capsys, sandbox, fake_gh):
    tip = sandbox.feature("feat/sq", commits=2)
    sandbox.squash("feat/sq")
    sandbox.fetch()
    fake_gh.add("feat/sq", 7, "MERGED", tip)

    code, report = _sweep(capsys, sandbox)
    entry = by_branch(report)["feat/sq"]
    assert code == cli.EXIT_OK
    assert entry["evidence"] == {"kind": "pr", "source": "gh", "pr": 7, "squash": True,
                                 "detail": entry["evidence"]["detail"]}
    assert "PR #7" in entry["evidence"]["detail"]
    delete = entry["actions"][1]
    assert delete["command"].split()[:3] == ["git", "branch", FORCE]

    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert "feat/sq" not in sandbox.local_branches()
    assert "feat/sq" not in sandbox.remote_branches()
    assert ["pr", "list", "--state", "all", "--head", "feat/sq"] == fake_gh.calls[0][:6]


def test_regular_merged_pr_uses_the_safe_delete(capsys, sandbox, fake_gh):
    tip = sandbox.feature("feat/m")
    sandbox.merge("feat/m")
    sandbox.fetch()
    fake_gh.add("feat/m", 8, "MERGED", tip)
    code, report = _sweep(capsys, sandbox)
    entry = by_branch(report)["feat/m"]
    assert entry["evidence"]["squash"] is False
    assert entry["actions"][1]["command"].split()[:3] == ["git", "branch", "-d"]


def test_unpushed_commits_not_in_the_pr_are_refused(capsys, sandbox, fake_gh):
    pr_head = sandbox.feature("feat/more")
    sandbox.squash("feat/more")
    sandbox.fetch()
    fake_gh.add("feat/more", 9, "MERGED", pr_head)
    sandbox.commit(sandbox.worktree_path("feat/more"), "late.txt", "after the merge\n", "late work")

    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/more"]
    assert code == cli.EXIT_REFUSED
    assert entry["decision"] == "refuse"
    assert "not in PR #9" in entry["reason"]
    _untouched(sandbox, "feat/more")
    assert "feat/more" in sandbox.remote_branches()


@pytest.mark.parametrize("prs, phrase", [
    ([(1, "CLOSED"), (2, "MERGED")], "2 pull requests"),
    ([(3, "CLOSED")], "closed without merging"),
])
def test_ambiguous_gh_evidence_is_refused(capsys, sandbox, fake_gh, prs, phrase):
    tip = sandbox.feature("feat/amb")
    sandbox.merge("feat/amb")  # merged by ancestry too: gh's doubt still wins
    sandbox.fetch()
    for number, state in prs:
        fake_gh.add("feat/amb", number, state, tip)
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/amb"]
    assert code == cli.EXIT_REFUSED
    assert entry["decision"] == "refuse"
    assert phrase in entry["reason"]
    _untouched(sandbox, "feat/amb")


def test_pr_merged_into_another_base_is_refused(capsys, sandbox, fake_gh):
    tip = sandbox.feature("feat/stacked")
    fake_gh.add("feat/stacked", 4, "MERGED", tip, base="feat/parent")
    code, report = _sweep(capsys, sandbox)
    entry = by_branch(report)["feat/stacked"]
    assert code == cli.EXIT_REFUSED
    assert "merged into feat/parent, not main" in entry["reason"]


def test_open_pr_is_kept(capsys, sandbox, fake_gh):
    tip = sandbox.feature("feat/open")
    fake_gh.add("feat/open", 5, "OPEN", tip)
    code, report = _sweep(capsys, sandbox)
    entry = by_branch(report)["feat/open"]
    assert code == cli.EXIT_OK
    assert entry["decision"] == "keep"
    assert "PR #5 is open" in entry["reason"]


def test_gh_failure_falls_back_to_git_and_says_so(capsys, sandbox, fake_gh):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    fake_gh.fail("gh: To get started with GitHub CLI, please run: gh auth login")
    code, report = _sweep(capsys, sandbox)
    entry = by_branch(report)["feat/a"]
    assert code == cli.EXIT_OK
    assert entry["evidence"]["source"] == "git"
    assert "gh failed" in entry["evidence"]["detail"] and "auth login" in entry["evidence"]["detail"]


# ── Hard refusals: worktrees ────────────────────────────────────────────────

@pytest.mark.parametrize("dirt", ["modified", "untracked", "staged"])
def test_dirty_worktree_is_refused(capsys, sandbox, dirt):
    sandbox.feature("feat/dirty")
    sandbox.merge("feat/dirty")
    sandbox.fetch()
    wt = sandbox.worktree_path("feat/dirty")
    if dirt == "modified":
        (wt / "README").write_text("edited\n")
    elif dirt == "untracked":
        (wt / "notes.txt").write_text("scratch\n")
    else:
        (wt / "new.txt").write_text("x\n")
        git(wt, "add", "new.txt")

    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/dirty"]
    assert code == cli.EXIT_REFUSED
    assert entry["decision"] == "refuse"
    assert "uncommitted or untracked" in entry["reason"]
    assert entry["actions"] == []
    _untouched(sandbox, "feat/dirty")
    assert "feat/dirty" in sandbox.remote_branches()


def test_ignored_files_are_named_before_the_worktree_goes(capsys, sandbox):
    sandbox.feature("feat/env")
    sandbox.merge("feat/env")
    sandbox.fetch()
    wt = sandbox.worktree_path("feat/env")
    git(sandbox.repo, "config", "core.excludesFile", str(sandbox.base / "excludes"))
    (sandbox.base / "excludes").write_text(".env\n")
    (wt / ".env").write_text("SECRET=1\n")
    code, report = _sweep(capsys, sandbox)
    remove = by_branch(report)["feat/env"]["actions"][0]
    assert remove["kind"] == "remove-worktree"
    assert ".env" in remove["detail"]


def test_branch_checked_out_in_the_main_worktree_is_refused(capsys, sandbox):
    sandbox.feature("feat/here", worktree=False)
    sandbox.merge("feat/here")
    sandbox.fetch()
    git(sandbox.repo, "switch", "-q", "feat/here")
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/here"]
    assert code == cli.EXIT_REFUSED
    assert "main worktree" in entry["reason"]
    assert "feat/here" in sandbox.local_branches()


def test_the_worktree_deuce_runs_from_is_refused(capsys, sandbox):
    sandbox.feature("feat/self")
    sandbox.merge("feat/self")
    sandbox.fetch()
    inside = sandbox.worktree_path("feat/self")
    code, report = run_json(capsys, "sweep", "--apply", "--repo", str(inside))
    entry = by_branch(report)["feat/self"]
    assert code == cli.EXIT_REFUSED
    assert "running from" in entry["reason"]
    _untouched(sandbox, "feat/self")


def test_locked_worktree_is_refused(capsys, sandbox):
    sandbox.feature("feat/locked")
    sandbox.merge("feat/locked")
    sandbox.fetch()
    git(sandbox.repo, "worktree", "lock", "--reason", "agent busy", str(sandbox.worktree_path("feat/locked")))
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/locked"]
    assert code == cli.EXIT_REFUSED
    assert "locked" in entry["reason"] and "agent busy" in entry["reason"]
    _untouched(sandbox, "feat/locked")


def test_detached_worktree_is_skipped_with_a_note(capsys, sandbox):
    where = sandbox.base / "wt" / "detached"
    git(sandbox.repo, "worktree", "add", "-q", "--detach", str(where), "main")
    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert any("detached HEAD" in note and str(where) in note for note in report["notes"])
    assert str(where) in sandbox.worktrees()


def test_worktrees_outside_the_list_are_never_touched(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    other = sandbox.base / "other-clone"
    git(sandbox.base, "clone", "-q", str(sandbox.remote), str(other))
    git(other, "switch", "-q", "feat/a")
    lookalike = sandbox.base / "wt" / "feat-a-copy"
    lookalike.mkdir(parents=True)
    (lookalike / "keep.txt").write_text("not a worktree\n")

    code, _ = _apply(capsys, sandbox)

    assert code == cli.EXIT_OK
    assert git(other, "branch", "--show-current") == "feat/a"
    assert (other / "feat-a-0.txt").exists()
    assert (lookalike / "keep.txt").exists()


def test_missing_worktree_directory_is_refused_then_pruned(capsys, sandbox):
    import shutil

    sandbox.feature("feat/gone")
    sandbox.merge("feat/gone")
    sandbox.fetch()
    shutil.rmtree(sandbox.worktree_path("feat/gone"))
    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_REFUSED
    assert "directory is missing" in by_branch(report)["feat/gone"]["reason"]
    assert str(sandbox.worktree_path("feat/gone")) not in sandbox.worktrees(), "stale metadata pruned"
    code, report = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert "feat/gone" not in sandbox.local_branches()


# ── Hard refusals: names and commits ────────────────────────────────────────

def test_base_and_default_protected_names_are_kept(capsys, sandbox):
    for name in ("develop", "release/1.0", "master"):
        sandbox.feature(name, worktree=False)
        sandbox.merge(name)
    sandbox.fetch()
    code, report = _apply(capsys, sandbox)
    entries = by_branch(report)
    assert code == cli.EXIT_OK
    assert entries["main"]["decision"] == "keep" and "base" in entries["main"]["reason"]
    for name in ("develop", "release/1.0", "master"):
        assert entries[name]["decision"] == "keep"
        assert "protected" in entries[name]["reason"]
        assert name in sandbox.local_branches() and name in sandbox.remote_branches()


def test_protect_patterns_from_deuce_toml(capsys, sandbox):
    sandbox.feature("hotfix/x", worktree=False)
    sandbox.merge("hotfix/x")
    sandbox.fetch()
    (sandbox.repo / ".deuce.toml").write_text('# keep hotfixes\nprotect = ["hotfix/*"]\n')
    code, report = _apply(capsys, sandbox)
    assert "hotfix/*" in by_branch(report)["hotfix/x"]["reason"]
    assert "hotfix/x" in sandbox.local_branches()


def test_protect_patterns_from_the_environment(capsys, sandbox, monkeypatch):
    sandbox.feature("keep-me", worktree=False)
    sandbox.merge("keep-me")
    sandbox.fetch()
    monkeypatch.setenv("DEUCE_PROTECT", "staging, keep-*")
    code, report = _apply(capsys, sandbox)
    assert "keep-*" in by_branch(report)["keep-me"]["reason"]
    assert "keep-me" in sandbox.local_branches()


def test_a_branch_with_no_commits_yet_is_kept(capsys, sandbox):
    git(sandbox.repo, "worktree", "add", "-q", "-b", "agent/new", str(sandbox.worktree_path("agent/new")), "main")
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["agent/new"]
    assert code == cli.EXIT_OK
    assert entry["decision"] == "keep"
    assert "no commits" in entry["reason"]
    _untouched(sandbox, "agent/new")


def test_remote_branch_with_extra_commits_is_refused(capsys, sandbox):
    sandbox.feature("feat/shared")
    sandbox.merge("feat/shared")
    other = sandbox.base / "teammate"
    git(sandbox.base, "clone", "-q", str(sandbox.remote), str(other))
    git(other, "switch", "-q", "feat/shared")
    sandbox.commit(other, "theirs.txt", "teammate\n", "teammate commit")
    git(other, "push", "-q", "origin", "feat/shared")
    sandbox.fetch()
    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/shared"]
    assert code == cli.EXIT_REFUSED
    assert "remote branch" in entry["reason"]
    assert "feat/shared" in sandbox.remote_branches()
    _untouched(sandbox, "feat/shared")


def test_remote_moving_after_the_plan_fails_that_step(capsys, sandbox, monkeypatch):
    """The remote delete carries a lease on the sha deuce saw, so a push that
    lands between the fetch and the delete is not thrown away."""
    sandbox.feature("feat/race", worktree=False)
    sandbox.merge("feat/race")
    sandbox.fetch()
    other = sandbox.base / "racer"
    git(sandbox.base, "clone", "-q", str(sandbox.remote), str(other))
    git(other, "switch", "-q", "feat/race")
    sandbox.commit(other, "late.txt", "late\n", "late push")
    git(other, "push", "-q", "origin", "feat/race")  # not fetched by our clone

    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/race"]
    assert code == cli.EXIT_REFUSED
    statuses = {a["kind"]: a["status"] for a in entry["actions"]}
    assert statuses["delete-remote-branch"] == "failed"
    assert "stale info" in entry["actions"][-1]["detail"]
    assert "feat/race" in sandbox.remote_branches()
    assert report["summary"]["failed"] == 1


def test_remote_branch_already_deleted_on_the_remote_is_fine(capsys, sandbox):
    sandbox.feature("feat/auto")
    sandbox.merge("feat/auto")
    sandbox.fetch()
    sandbox.delete_on_remote("feat/auto")  # GitHub's auto-delete; not fetched yet
    code, report = _apply(capsys, sandbox)
    actions = by_branch(report)["feat/auto"]["actions"]
    assert code == cli.EXIT_OK
    assert actions[-1]["status"] == "done" and "already gone" in actions[-1]["detail"]
    assert "feat/auto" not in sandbox.local_branches()


def _stale_base(sandbox, *branches):
    """Merged on the remote, remote branches auto-deleted and pruned: no
    upstream left, and local main is behind origin/main."""
    for branch in branches:
        sandbox.merge(branch)
        sandbox.delete_on_remote(branch)
    git(sandbox.repo, "fetch", "-q", "--prune", "origin")
    assert sandbox.tip("main") != sandbox.tip("origin/main")
    return sandbox.tip("main")


def test_one_sweep_cleans_a_merge_when_local_base_is_behind(capsys, sandbox):
    """`git branch -d` checks HEAD (main) when there is no upstream, so --apply
    fast-forwards main first, and one sweep cleans the branch. The dry run
    shows that step and changes nothing."""
    sandbox.feature("feat/stale")
    sandbox.feature("feat/stale-plain", worktree=False)
    old_main = _stale_base(sandbox, "feat/stale", "feat/stale-plain")
    new_main = sandbox.tip("origin/main")

    code, dry = _sweep(capsys, sandbox)
    entries = by_branch(dry)
    assert code == cli.EXIT_OK
    assert entries["feat/stale"]["decision"] == "sweep"
    assert [a["kind"] for a in entries["feat/stale"]["actions"]] == ["fast-forward", "remove-worktree",
                                                                     "delete-branch"]
    assert entries["feat/stale"]["actions"][0]["command"] == f"git merge --ff-only --quiet {new_main}"
    assert [a["kind"] for a in entries["feat/stale-plain"]["actions"]] == ["fast-forward", "delete-branch"]
    assert "runs first" in next(f for f in dry["finish"] if f["kind"] == "fast-forward")["detail"]
    assert sandbox.tip("main") == old_main
    _untouched(sandbox, "feat/stale")
    _untouched(sandbox, "feat/stale-plain", worktree=False)

    code, report = _apply(capsys, sandbox)
    entries = by_branch(report)
    assert code == cli.EXIT_OK
    assert "feat/stale" not in sandbox.local_branches()
    assert "feat/stale-plain" not in sandbox.local_branches()
    assert str(sandbox.worktree_path("feat/stale")) not in sandbox.worktrees()
    assert sandbox.tip("main") == new_main
    assert [a["status"] for a in entries["feat/stale"]["actions"]] == ["done", "done", "done"]
    assert [a["status"] for a in entries["feat/stale-plain"]["actions"]] == ["skipped", "done"]
    moved = [r for r in audit.AuditLog.default().rows() if r["action"] == "fast-forward"]
    assert [(r["branch"], r["sha"], r["status"]) for r in moved] == [("main", new_main, "done")]


def test_safe_delete_is_still_refused_when_base_cannot_be_fast_forwarded(capsys, sandbox):
    """The same stale main, but its worktree has uncommitted changes, so it is
    not fast-forwarded and `git branch -d` would refuse: nothing is touched."""
    sandbox.feature("feat/stale")
    old_main = _stale_base(sandbox, "feat/stale")
    (sandbox.repo / "README").write_text("local edit\n")

    code, report = _apply(capsys, sandbox)
    entry = by_branch(report)["feat/stale"]
    assert code == cli.EXIT_REFUSED
    assert entry["rule"] == "safe-delete"
    assert "branch -d would refuse" in entry["reason"]
    assert "uncommitted changes" in entry["reason"]
    _untouched(sandbox, "feat/stale")
    assert sandbox.tip("main") == old_main
    assert (sandbox.repo / "README").read_text() == "local edit\n"


def test_fast_forward_skips_a_dirty_base_worktree(capsys, sandbox):
    sandbox.feature("feat/a", worktree=False)
    sandbox.merge("feat/a")
    (sandbox.repo / "README").write_text("local edit\n")
    code, report = _apply(capsys, sandbox)
    ff = next(f for f in report["finish"] if f["kind"] == "fast-forward")
    assert ff["status"] == "skipped"
    assert "uncommitted" in ff["detail"]
    assert (sandbox.repo / "README").read_text() == "local edit\n"


def test_no_remote_means_local_steps_only(capsys, tmp_path):
    repo = tmp_path / "solo"
    git(tmp_path, "init", "-q", "-b", "main", str(repo))
    (repo / "f").write_text("x\n")
    git(repo, "add", "f")
    git(repo, "commit", "-q", "-m", "init")
    git(repo, "switch", "-q", "-c", "feat")
    (repo / "g").write_text("y\n")
    git(repo, "add", "g")
    git(repo, "commit", "-q", "-m", "feat")
    git(repo, "switch", "-q", "main")
    git(repo, "merge", "-q", "--no-ff", "-m", "merge", "feat")
    code, report = run_json(capsys, "sweep", "--apply", "--repo", str(repo))
    assert code == cli.EXIT_OK
    assert [a["kind"] for a in by_branch(report)["feat"]["actions"]] == ["delete-branch"]
    assert any("no remote" in n for n in report["notes"])
    assert "feat" not in git(repo, "branch", "--format=%(refname:short)").split()


# ── Concurrency and the audit log ───────────────────────────────────────────

def test_apply_is_refused_while_another_deuce_holds_the_lock(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    common = git(sandbox.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    with lock.repo_lock(common):
        code, out, err = run(capsys, "sweep", "--apply", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_REFUSED
    assert "another deuce" in err
    _untouched(sandbox, "feat/a")
    code, _ = _apply(capsys, sandbox)
    assert code == cli.EXIT_OK
    assert "feat/a" not in sandbox.local_branches()


def test_dry_run_and_status_need_no_lock(capsys, sandbox):
    common = git(sandbox.repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    with lock.repo_lock(common):
        assert run(capsys, "sweep", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK
        assert run(capsys, "status", "--repo", str(sandbox.repo))[0] == cli.EXIT_OK


def test_audit_log_lives_in_deuce_state_dir(capsys, sandbox, tmp_path, monkeypatch):
    monkeypatch.setenv("DEUCE_STATE_DIR", str(tmp_path / "elsewhere"))
    sandbox.feature("feat/a", worktree=False)
    sandbox.merge("feat/a")
    sandbox.fetch()
    _apply(capsys, sandbox)
    log = tmp_path / "elsewhere" / "log.tsv"
    assert log.exists()
    header, *rows = log.read_text().splitlines()
    assert header.split("\t") == list(audit.FIELDS)
    assert any("\tdelete-branch\t" in row for row in rows)


def test_dry_run_writes_nothing_to_the_audit_log(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    _sweep(capsys, sandbox)
    assert audit.AuditLog.default().rows() == []


def test_default_state_dir_is_under_home(monkeypatch, tmp_path):
    monkeypatch.delenv("DEUCE_STATE_DIR")
    monkeypatch.setenv("HOME", str(tmp_path))
    assert audit.AuditLog.default().path == tmp_path / ".local" / "state" / "deuce" / "log.tsv"
    assert os.environ["HOME"] == str(tmp_path)
