"""deuce: the cleanup after a branch merges. Finds local branches that are
merged into the base branch, and removes their worktrees, the local branch and
the remote branch, after a dry run and only when every safety rule passes."""

# The one place the version lives. plugin.json, marketplace.json, CHANGELOG.md
# and the release workflow are checked against it by tests/test_docs.py.
__version__ = "0.1.1"
