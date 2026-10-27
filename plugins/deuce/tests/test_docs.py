"""The README, SKILL.md, the commands and the manifests restate facts the
code owns: exit codes, flags and defaults, the rules, the JSON shape, the audit
log columns and the version. These tests fail when the two drift apart."""

from __future__ import annotations

import json
import re

import pytest

import deuce
from conftest import ROOT, by_branch, run_json
from deuce import audit, cli, config, plan

README = (ROOT / "README.md").read_text(encoding="utf-8")
SKILL = (ROOT / "skills" / "deuce" / "SKILL.md").read_text(encoding="utf-8")
SWEEP_CMD = (ROOT / "commands" / "sweep.md").read_text(encoding="utf-8")
STATUS_CMD = (ROOT / "commands" / "status.md").read_text(encoding="utf-8")


def _section(text: str, heading: str) -> str:
    match = re.search(rf"^#+ {re.escape(heading)}\n(.*?)(?=^#+ |\Z)", text, re.S | re.M)
    assert match, f"no '{heading}' section"
    return match.group(1)


def _table(text: str, heading: str) -> list[dict[str, str]]:
    lines = [line for line in _section(text, heading).splitlines() if line.startswith("|")]
    header, _, *rows = ([cell.strip() for cell in line.strip("|").split("|")] for line in lines)
    return [dict(zip(header, row, strict=True)) for row in rows]


def _code(cell: str) -> str:
    return cell.strip().strip("`")


def _frontmatter(text: str) -> dict[str, str]:
    block = re.match(r"---\n(.*?)\n---\n", text, re.S)
    assert block, "no frontmatter"
    return dict(line.split(": ", 1) for line in block.group(1).splitlines() if ": " in line)


# ── Exit codes and options ─────────────────────────────────────────────────

def test_readme_exit_codes_match_the_code():
    rows = {int(row["Code"]): row["Meaning"].replace("`", "") for row in _table(README, "Exit codes")}
    assert rows == cli.EXIT_CODES


def test_help_lists_every_exit_code():
    text = " ".join(cli.build_parser().format_help().split())
    for code, meaning in cli.EXIT_CODES.items():
        assert f"{code} {meaning}" in text


def _parser_flags() -> dict[tuple[str, str], object]:
    flags = {}
    for command, sub in cli.subparsers(cli.build_parser()).items():
        for action in sub._actions:
            if action.option_strings and action.dest != "help":
                flags[(command, action.option_strings[-1])] = action
    return flags


def test_readme_options_table_matches_the_parser():
    documented = {}
    for row in _table(README, "Options"):
        flag = re.search(r"--[a-z-]+", row["Flag"]).group(0)
        for command in re.findall(r"`(\w+)`", row["Command"]):
            documented[(command, flag)] = row["Default"]
    flags = _parser_flags()
    assert set(documented) == set(flags)
    for key, action in flags.items():
        cell = documented[key]
        if action.const is True or action.default is None:
            assert cell in ("", "off"), key
        else:
            assert _code(cell) == action.default, key


def test_option_names_have_one_source():
    assert cli.DEFAULT_BASE == "main" and cli.DEFAULT_REMOTE == "origin"
    assert ("sweep", "--apply") in _parser_flags() and ("status", "--apply") not in _parser_flags()


# ── Rules ──────────────────────────────────────────────────────────────────

def test_readme_rules_table_matches_the_code():
    rows = {_code(row["Rule"]): row["Decision"] for row in _table(README, "Rules")}
    assert rows == {rule: decision for rule, (decision, _) in plan.RULES.items()}


def test_readme_lists_the_default_protected_names():
    section = _section(README, "Protected branches")
    for pattern in config.DEFAULT_PROTECT:
        assert f"`{pattern}`" in section


def test_skill_names_every_refusal():
    for rule, (decision, _) in plan.RULES.items():
        if decision == "refuse":
            assert f"`{rule}`" in SKILL, rule


# ── JSON report and audit log ──────────────────────────────────────────────

def _readme_json() -> dict:
    block = re.search(r"```json\n(.*?)```", _section(README, "JSON report"), re.S)
    return json.loads(block.group(1))


def test_readme_json_example_has_the_real_report_shape(capsys, sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    _, report = run_json(capsys, "sweep", "--repo", str(sandbox.repo))
    example = _readme_json()
    assert set(example) == set(report)
    assert example["schema_version"] == report["schema_version"] == cli.SCHEMA_VERSION
    assert set(example["summary"]) == set(report["summary"])
    real, shown = by_branch(report)["feat/a"], example["branches"][0]
    assert set(shown) == set(real)
    assert set(shown["evidence"]) == set(real["evidence"])
    assert set(shown["actions"][0]) == set(real["actions"][0])
    assert set(example["finish"][0]) == set(report["finish"][0])


def test_readme_documents_the_audit_log_columns():
    section = _section(README, "Audit log and undo")
    assert " ".join(f"`{f}`" for f in audit.FIELDS) in section


# ── Version: one source, the rest checked ──────────────────────────────────

def test_version_matches_the_manifests_and_changelog():
    plugin = json.loads((ROOT / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text(encoding="utf-8"))
    listed = {p["name"]: p["version"] for p in market["plugins"]}
    assert plugin["version"] == listed[plugin["name"]] == deuce.__version__
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    assert f"\n## {deuce.__version__}\n" in changelog


def test_release_workflow_checks_the_tag_against_the_package_version():
    release = (ROOT / ".github" / "workflows" / "release.yml").read_text(encoding="utf-8")
    assert "deuce.__version__" in release


def test_brand_line():
    assert "Part of [sous](https://github.com/OrenSegal/sous): tools for checking what coding agents actually do." in README


# ── The plugin surface keeps --apply behind the user ───────────────────────

@pytest.mark.parametrize("text", [SWEEP_CMD, STATUS_CMD], ids=["sweep", "status"])
def test_commands_never_pre_approve_apply(text):
    allowed = _frontmatter(text).get("allowed-tools", "")
    assert "--apply" not in allowed
    assert ":*" not in allowed and "Bash(deuce)" not in allowed and "Bash(*)" not in allowed


def test_sweep_command_runs_the_dry_run_first_and_waits_for_approval():
    body = SWEEP_CMD.lower()
    assert "dry run" in body
    assert "approv" in body
    assert "never pass `--apply`" in body


def test_skill_triggers_and_rules():
    description = _frontmatter(SKILL)["description"].lower()
    for phrase in ("clean up after", "merged branches", "prune worktrees"):
        assert phrase in description
    assert "never pass `--apply`" in SKILL.lower()


EVALS = sorted(path for path in (ROOT / "evals").iterdir() if (path / "prompt.md").is_file())


def test_evals_are_complete():
    assert len(EVALS) >= 2
    for case in EVALS:
        meta = _frontmatter((case / "prompt.md").read_text(encoding="utf-8"))
        assert meta["name"] == case.name and meta["plugins"] == '["../.."]', case.name
        graders = list((case / "graders").glob("*.md"))
        assert graders, case.name
        for grader in graders:
            assert _frontmatter(grader.read_text(encoding="utf-8"))["type"] in {"llm", "tool_used", "regex"}, grader
        scaffold = re.search(r"scaffold_script: (\S+)", (case / "case.yaml").read_text(encoding="utf-8"))
        assert scaffold and (case / scaffold.group(1)).is_file(), case.name


def test_an_eval_fails_the_agent_for_applying_without_approval():
    guards = [
        meta
        for case in EVALS
        for meta in (_frontmatter(g.read_text(encoding="utf-8")) for g in (case / "graders").glob("*.md"))
        if meta.get("type") == "tool_used" and meta.get("max") == "0" and "--apply" in meta.get("input_match", "")
    ]
    assert guards and all(meta.get("arm") == "both" for meta in guards)


def test_no_test_counts_in_docs():
    for name in ("README.md", "CONTRIBUTING.md", "CHANGELOG.md"):
        text = (ROOT / name).read_text(encoding="utf-8")
        assert not re.search(r"\b\d+\s+tests\b", text), name
