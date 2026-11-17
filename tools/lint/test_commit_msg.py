import pytest
from commit_msg import validate

SCOPES = frozenset({"repo", "lint", "cs2"})


@pytest.mark.parametrize(
    "message",
    [
        "repo: add wishlist\n\nSo the backlog outlives the thread.\n",
        "cs2/features/aim: drop the arbiter\n\nIt merged plans it never understood.",
        "lint: reject bare suppressions\n\nWhy goes here.\n# Please enter the commit message\n",
        "Merge branch 'worktree-aim'",
        "fixup! repo: add wishlist",
    ],
)
def test_accepts_scoped_subjects_with_a_body(message: str) -> None:
    assert validate(message, SCOPES) == []


def test_rejects_conventional_commit_types() -> None:
    errors = validate("feat(cs2): add aim\n\nwhy", SCOPES)
    assert len(errors) == 1
    assert errors[0].startswith("subject must be")


def test_rejects_scopes_that_are_not_moon_projects() -> None:
    errors = validate("native: add kit\n\nwhy", SCOPES)
    assert errors == ["`native` is not a moon project; known: cs2, lint, repo"]


@pytest.mark.parametrize(
    "message",
    [
        "repo: add wishlist",
        "repo: add wishlist\nno blank line",
        "repo: add wishlist\n\n\n",
    ],
)
def test_requires_a_body_after_a_blank_line(message: str) -> None:
    assert validate(message, SCOPES) == ["body must follow a blank line and say why"]


def test_ignores_the_diff_below_the_scissors_line() -> None:
    message = (
        "repo: x\n\nwhy\n# ------------------------ >8 ------------------------\n+ignored diff line"
    )
    assert validate(message, SCOPES) == []


def test_rejects_an_empty_message() -> None:
    assert validate("# only comments\n", SCOPES) == ["message is empty"]
