"""Usage errors (exit 2), the .deuce.toml reader, and the bin/deuce launcher."""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest

import deuce
from conftest import ROOT, git, run
from deuce import cli, config

LAUNCHER = ROOT / "bin" / "deuce"


# ── Usage errors ────────────────────────────────────────────────────────────

@pytest.mark.parametrize("argv", [
    [],
    ["sweep", "--nope"],
    ["undo"],
    ["frobnicate"],
])
def test_bad_arguments_exit_2(capsys, argv):
    with pytest.raises(SystemExit) as exc:
        cli.main(argv)
    assert exc.value.code == cli.EXIT_USAGE


def test_not_a_git_repository_exits_2(capsys, tmp_path):
    code, _, err = run(capsys, "sweep", "--repo", str(tmp_path))
    assert code == cli.EXIT_USAGE
    assert "not a git repository" in err


def test_missing_base_exits_2(capsys, sandbox):
    code, _, err = run(capsys, "sweep", "--repo", str(sandbox.repo), "--base", "trunk")
    assert code == cli.EXIT_USAGE
    assert "base branch 'trunk'" in err


def test_invalid_deuce_toml_exits_2(capsys, sandbox):
    (sandbox.repo / ".deuce.toml").write_text("protect = 'not-a-list'\n")
    code, _, err = run(capsys, "status", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_USAGE
    assert ".deuce.toml" in err and "protect" in err


def test_unknown_deuce_toml_key_exits_2(capsys, sandbox):
    (sandbox.repo / ".deuce.toml").write_text('protekt = ["x"]\n')
    code, _, err = run(capsys, "status", "--repo", str(sandbox.repo))
    assert code == cli.EXIT_USAGE
    assert "protekt" in err


def test_version_flag(capsys):
    with pytest.raises(SystemExit) as exc:
        cli.main(["--version"])
    assert exc.value.code == 0
    assert deuce.__version__ in capsys.readouterr().out


# ── .deuce.toml ─────────────────────────────────────────────────────────────

TOML_CASES = [
    'protect = ["hotfix/*", "staging"]\n',
    "# comment\n\nprotect = [\n  'a',  # trailing\n  \"b/*\",\n]\n",
    "protect = []\n",
    "",
]


@pytest.mark.parametrize("text", TOML_CASES)
def test_fallback_toml_reader_agrees_with_tomllib(text):
    tomllib = pytest.importorskip("tomllib")
    assert config.parse_subset(text) == tomllib.loads(text)


@pytest.mark.parametrize("text", ["protect = [\"a\"", "protect = [1, 2]", "protect\n", "protect = \"x\" junk"])
def test_fallback_toml_reader_rejects_what_it_does_not_understand(text):
    with pytest.raises(config.ConfigError):
        config.parse_subset(text)


def test_defaults_cannot_be_unprotected(tmp_path):
    (tmp_path / ".deuce.toml").write_text("protect = []\n")
    patterns = config.load_protect(tmp_path, {})
    assert set(config.DEFAULT_PROTECT) <= set(patterns)


@pytest.mark.parametrize("name, pattern", [
    ("main", "main"), ("release/2.0", "release/*"), ("develop", "develop"), ("feat/x", None),
])
def test_protected_matching(name, pattern):
    assert config.protected_by(name, config.DEFAULT_PROTECT) == pattern


# ── bin/deuce ───────────────────────────────────────────────────────────────

def _launch(*args, cwd=None, env=None):
    return subprocess.run([str(LAUNCHER), *args], capture_output=True, text=True, cwd=cwd,
                          env=env or os.environ.copy())


def test_launcher_runs_the_package(sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    proc = _launch("sweep", "--json", cwd=sandbox.repo)
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["deuce_version"] == deuce.__version__
    assert {b["branch"] for b in report["branches"]} >= {"main", "feat/a"}


def test_launcher_apply_end_to_end(sandbox):
    sandbox.feature("feat/a")
    sandbox.merge("feat/a")
    sandbox.fetch()
    proc = _launch("sweep", "--apply", "--repo", str(sandbox.repo))
    assert proc.returncode == 0, proc.stderr
    assert "feat/a" not in sandbox.local_branches()


def test_launcher_ignores_modules_in_the_working_directory(sandbox):
    """An agent's checkout could hold a `deuce/` or `subprocess.py`; the
    launcher runs Python isolated so neither shadows the real code."""
    (sandbox.repo / "subprocess.py").write_text("raise SystemExit('shadowed')\n")
    (sandbox.repo / "deuce").mkdir()
    (sandbox.repo / "deuce" / "__init__.py").write_text("raise SystemExit('shadowed')\n")
    proc = _launch("status", cwd=sandbox.repo)
    assert proc.returncode == 0, proc.stderr
    assert "shadowed" not in proc.stderr


def test_launcher_follows_a_symlink(tmp_path):
    link = tmp_path / "deuce"
    link.symlink_to(LAUNCHER)
    proc = subprocess.run([str(link), "--version"], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr
    assert deuce.__version__ in proc.stdout


def test_launcher_honors_deuce_python(tmp_path):
    env = os.environ.copy()
    env["DEUCE_PYTHON"] = sys.executable
    env["PATH"] = str(tmp_path)  # no python3 on PATH at all
    for tool in ("dirname", "readlink"):
        (tmp_path / tool).symlink_to(next(p for p in os.environ["PATH"].split(os.pathsep)) + "/" + tool)
    proc = _launch("--version", env=env)
    assert proc.returncode == 0, proc.stderr


def test_launcher_without_python_exits_2(tmp_path):
    env = os.environ.copy()
    env["PATH"] = str(tmp_path)
    for tool in ("dirname", "readlink"):
        (tmp_path / tool).symlink_to(next(p for p in os.environ["PATH"].split(os.pathsep)) + "/" + tool)
    proc = _launch("--version", env=env)
    assert proc.returncode == 2
    assert "Python 3.10" in proc.stderr


def test_python_m_deuce(sandbox):
    proc = subprocess.run([sys.executable, "-m", "deuce", "status", "--repo", str(sandbox.repo)],
                          capture_output=True, text=True, cwd=ROOT)
    assert proc.returncode == 0, proc.stderr
    assert git(sandbox.repo, "branch", "--show-current") == "main"
