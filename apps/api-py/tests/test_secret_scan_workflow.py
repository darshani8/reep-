"""The secret-scan step runs both scans and decides once, under GitHub's shell.

GitHub runs a `run:` block with no `shell:` as `bash --noprofile --norc -eo
pipefail`, so `-e` is already on when the script starts. The "Scan the commits
and the tree" step captures each scan's status itself (`history=$?`,
`tree=$?`) and gives one verdict at the end. With -e still on, the first scan
that finds something kills the script before its status is read: no tree scan,
no `::error::` annotation, no tree report (DEF-QG-I01). It still failed closed,
which is why nothing noticed.

The guard is `set +e` as the step's first command rather than `shell: bash
{0}`: the fix then sits on the line a reader looks at, with its reason, and it
survives somebody adding `shell: bash` for an unrelated reason (which brings
-e back). A behavioural replay needs gitleaks and git history, so it is done by
hand and recorded in the commit; this pins the shape.
"""
from __future__ import annotations

import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WORKFLOW = REPO / ".github" / "workflows" / "secret-scan.yml"


def _scan_step_script() -> str:
    text = WORKFLOW.read_text(encoding="utf-8")
    step = re.search(r"- name: Scan the commits and the tree\n(.*?)(?=\n      - name: |\Z)", text, re.S)
    assert step, "secret-scan.yml has no 'Scan the commits and the tree' step for this guard to read"
    run = re.search(r"\n        run: \|\n(.*)", step.group(1), re.S)
    assert run, "the scan step has no `run: |` block"
    lines = []
    for line in run.group(1).splitlines():
        if line.strip() and not line.startswith(" " * 10):
            break  # the block ends at the first line indented less than its script
        lines.append(line[10:])
    return "\n".join(lines)


def _commands(script: str) -> list[str]:
    return [line.strip() for line in script.splitlines() if line.strip() and not line.strip().startswith("#")]


def test_the_scan_step_turns_errexit_off_before_anything_runs() -> None:
    first = _commands(_scan_step_script())[0]
    assert re.match(r"set \+e\b", first), (
        f"the scan step's first command is {first!r}. It must be `set +e ...`: GitHub's "
        "default shell has -e on, and with it the first scan that finds a secret ends the "
        "script before the second scan runs or any annotation is written"
    )


def test_nothing_turns_errexit_back_on_in_the_scan_step() -> None:
    later = [c for c in _commands(_scan_step_script())[1:] if re.search(r"\bset -[a-z]*e|\bset -o errexit", c)]
    assert not later, f"the scan step turns -e back on after disabling it: {later}"


def test_both_scans_are_captured_and_one_verdict_ends_the_step() -> None:
    script = _scan_step_script()
    assert "history=$?" in script and "tree=$?" in script, "each scan's status must be captured, not acted on"
    last = _commands(script)[-1]
    assert last == '[ "$history" -eq 0 ] && [ "$tree" -eq 0 ]', (
        f"the step must end on its single verdict, not {last!r}"
    )


def test_the_checkout_feeding_the_scan_fetches_the_whole_history() -> None:
    """`fetch-depth: 0`, or the push-mode scan of main/stage/dev reads one commit.

    actions/checkout defaults to depth 1. Deleting this one line would leave the
    check green while it scanned only the tip (DEF-QG-I06: depth 1 scanned 1
    commit, depth 50 scanned 89, both exiting 0). The step's shallow refusal is
    the backstop; this keeps the line it backs up."""
    text = WORKFLOW.read_text(encoding="utf-8")
    jobs = text.split("\njobs:\n", 1)[1]
    scan_at = jobs.index("- name: Scan the commits and the tree")
    checkouts = [m for m in re.finditer(r"- uses: actions/checkout@[^\n]+\n((?:        .*\n)*)", jobs) if m.start() < scan_at]
    assert checkouts, "no actions/checkout step precedes the scan step"
    block = checkouts[-1].group(1)
    assert re.search(r"^\s+fetch-depth:\s*0\s*$", block, re.M), (
        "the checkout step that feeds the secret scan must set `fetch-depth: 0`; without it "
        "the history scan reads only the commits a shallow clone happened to fetch"
    )


def test_the_scan_step_refuses_a_shallow_clone_in_both_modes() -> None:
    """The refusal comes before the mode branch, so a PR scan is not right by luck of depth."""
    commands = _commands(_scan_step_script())
    shallow = [i for i, c in enumerate(commands) if "--is-shallow-repository" in c]
    mode = [i for i, c in enumerate(commands) if c.startswith('if [ "$EVENT" = "pull_request" ]')]
    assert shallow, "the scan step no longer asks `git rev-parse --is-shallow-repository`"
    assert mode and shallow[0] < mode[0], "the shallow refusal must come before the push/PR branch"
    follow = commands[shallow[0] : shallow[0] + 3]
    assert any("::error::" in c and "shallow" in c for c in follow) and "exit 1" in follow, (
        f"the shallow check must emit an ::error:: naming the cause and exit 1, got {follow}"
    )
