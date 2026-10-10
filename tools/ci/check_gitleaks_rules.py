#!/usr/bin/env python3
"""Replay the leaks .gitleaks.toml must catch and the lines it must not.

WHY THIS EXISTS. A rules file is tested by nothing: an allowlist entry that is
too wide does not fail, it simply stops reporting, and "no leaks found" is
exactly what a working scanner and a blinded one both print. The first global
allowlist matched against the whole LINE, so `<...>`, `${` or `change-me`
anywhere on a line exempted that line from every rule -- about 4,400 tracked
lines -- and six realistic leaks walked through it. Each is a case below, and
the gate's own job runs this before it scans, so the rules are proven on the
run that relies on them.

THE VALUES ARE MADE UP AT RUN TIME, never committed. A file of realistic fake
tokens is a file the scanner reports, and an allowlist for it is an allowlist
for anything that looks like it.

    python3 tools/ci/check_gitleaks_rules.py          # gitleaks on PATH
    GITLEAKS=/path/to/gitleaks python3 tools/ci/check_gitleaks_rules.py
"""
from __future__ import annotations

import json
import os
import secrets
import shutil
import string
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / ".gitleaks.toml"


def _alnum(n: int, alphabet: str = string.ascii_letters + string.digits) -> str:
    return "".join(secrets.choice(alphabet) for _ in range(n))


# Spelled in two halves so THIS FILE is not a finding. The templates below sit in
# source as `<scheme>://reep:{pw}@` and `<NAME>=\n#...`, which the rules read as a
# URL with a password and a key with a value; the cases are built at run time,
# where the halves join, and the scanner reads the joined text in the temp dir.
PG = "postgres" + "ql"
PG_SHORT = "post" + "gres"
GROQ = "GROQ_" + "API_KEY"
OPENAI = "OPENAI_" + "API_KEY"
# gitleaks' inline allow marker, which every invocation in this repository
# refuses to honour (--ignore-gitleaks-allow). Split so no line of this file
# carries the marker itself.
ALLOW_MARK = "gitleaks" + ":allow"
DB_URL = "DATABASE" + "_URL"
AUTH = "AUTH_" + "SECRET"
VOICE = "VOICE_WORKER_" + "SECRET"
LIVEKIT = "LIVEKIT_API_" + "SECRET"
PEM_BEGIN = "-----" + "BEGIN RSA PRIVATE KEY-----"
PEM_END = "-----" + "END RSA PRIVATE KEY-----"
MASK = "<FAKE-VALUE-MASKED>"
GH = "GITHUB_" + "TOKEN"
# The published dev/CI values the global allowlist frees, spelled in halves.
DEV_SECRET = "reep-dev-secret-" + "change-me-in-production-0123456789abcdef"
CI_SECRET = "ci-secret-not-used-" + "outside-ci-0123456789abcdef"


def _pem(body_lines: list[str]) -> str:
    return "\n".join([PEM_BEGIN, *body_lines, PEM_END]) + "\n"


def _joined_bracket_cases() -> dict[str, str]:
    out: dict[str, str] = {}
    for position in ("start", "middle", "end"):
        real = _alnum(24)
        value = {"start": f"<abc>{real}", "middle": f"{real[:12]}<abc>{real[12:]}", "end": f"{real}<abc>"}[position]
        shapes = {
            "openai": f"{OPENAI}={value}\n",
            "groq": f"{GROQ}={value}\n",
            "livekit": f"{LIVEKIT}={value}\n",
            "voice": f"{VOICE}={value}\n",
            "dburl": f"psql {PG}://admin:{value}@db.example.com/reep_py\n",
            "auth": f'{AUTH}="{value}{_alnum(16)}"\n',
        }
        for rule, text in shapes.items():
            out[f"lj-{rule}-{position}/apps/api-py/.env"] = text
    return out


def _same_line_cases(hex64: str, ghp: str, pw: str) -> dict[str, str | tuple[str, str]]:
    leak = f"{GH}={ghp}"
    real_url = f"{PG}://admin:{pw}@prod-db.example.com/reep_py"
    return {
        # the global allowlist's published values
        "ls-dev-secret/apps/api-py/.env": f"{AUTH}={DEV_SECRET} {leak}\n",
        "ls-dev-password/docker-compose.yml": f"DATABASE_URL: {PG}://reep:reep_dev_password@postgres/reep_py {leak}\n",
        "ls-ci-secret/ci.yml": f"{AUTH}: {CI_SECRET} {leak}\n",
        "ls-not-repo/tests/x.py": f"URL = \"{PG}://reep:not-the-repo-password@db/x\" {leak}\n",
        "ls-nobody/tests/x.py": f"URL = \"{PG}://nobody:nobody@127.0.0.1:1/x\" {leak}\n",
        "ls-p40ss/docs/x.md": f"{PG}://reep:p%40ss@db/x and {leak}\n",
        "ls-user-pass/docs/x.md": f"--dbname={PG}://user:pass@... beside {leak}\n",
        "ls-dev-fstring/tests/x.py": f"url = f\"{PG}://reep:{{_DEV_DB_PASSWORD}}@db/x\" {leak}\n",
        # the anchored placeholder forms
        "ls-angle/apps/api-py/.env": f"{OPENAI}=<your-openai-key> {leak}\n",
        "ls-changeme/apps/api-py/.env": f"{VOICE}=change-me {leak}\n",
        "ls-dollar/docker-compose.yml": f"{AUTH}: ${{AUTH_SECRET}} {leak}\n",
        "ls-dburl-placeholder/docs/x.md": f"{PG}://reep:<password>@db/x then {real_url}\n",
        # the boot-guard exception, freed for reep-auth-secret alone
        # Named by RULE: under a widened exemption gitleaks' own generic-api-key
        # still catches the hex, and a file-level "caught" would hide that the
        # rule this exemption is scoped to went quiet.
        "ls-boot-guard/apps/api-py/.env": (f"{AUTH}=change-me-{_alnum(40)} {AUTH}={hex64}\n", "reep-auth-secret"),
        # the one path-scoped value exemption, at the exact path it is scoped to
        "apps/api-py/tests/test_backup_database.py": f"a = \"{PG}://u:s3cr3t@h:5432/\"; b = \"{real_url}\"\n",
    }


def cases() -> tuple[dict[str, str | tuple[str, str]], dict[str, str]]:
    """({path: text that MUST be reported}, {path: text that must NOT be})."""
    hex64 = secrets.token_hex(32)
    ghp = "ghp_" + _alnum(36)
    akia = "AKIA" + _alnum(16, string.ascii_uppercase + "234567")  # AWS key IDs are base32
    pw = _alnum(20)
    leaks = {
        # The six that passed the line-targeted allowlist.
        "l01/apps/api-py/.env.example": f"AUTH_SECRET={hex64}  # change-me before deploying\n",
        "l02/docker-compose.yml": f"    environment:\n      AUTH_SECRET: ${{AUTH_SECRET:-{hex64}}}\n",
        "l03/apps/web/src/app/x.component.html": f"<span class=\"token\">{ghp}</span>\n",
        "l04/apps/web/src/app/x.ts": f"const keys: Array<string> = ['{akia}'];\n",
        "l05/infra/task.json": f'{{"valueFrom": "arn:aws:ssm:x", "note": "{ghp}"}}\n',
        "l06/apps/api-py/.env.example": f"DATABASE_PASSWORD=reep_dev_password GITHUB_TOKEN={ghp}\n",
        # The shapes the per-variable rules could not see.
        "l07/k8s/secret.yaml": f"stringData:\n  AUTH_SECRET:\n    \"{hex64}\"\n",
        "l08/infra/taskdef.yaml": f"environment:\n  - name: AUTH_SECRET\n    value: \"{hex64}\"\n",
        "l09/infra/taskdef.json": f'[{{"name": "STRIPE_API_KEY", "value": "{pw}"}}]\n',
        "l10/docs/runbook.md": f"psql {PG}://reep:{pw}@reep-db.example.rds.amazonaws.com/reep_py\n",
        "l11/docs/runbook2.md": f"pg_dump --dbname={PG_SHORT}://admin:{pw}@10.0.0.5:5432/reep_py\n",
        # And the originals, so a rule edit cannot quietly lose one.
        "l12/apps/api-py/.env": f"AUTH_SECRET={hex64}\nOPENAI_API_KEY=proxy-{pw}\n",
        "l13/apps/api-py/.env2": f"{GROQ}=gsk_{_alnum(48)}\n",
        # DEF-QG-U04: an inline allow marker is not an allowlist here.
        "l14/apps/api-py/.env": f"AUTH_SECRET={hex64}  # {ALLOW_MARK}\n",
        "l15/docs/notes.md": f"token {ghp} <!-- {ALLOW_MARK} -->\n",
        # OBS-QG-U01: a real-shaped value that merely CONTAINS a placeholder.
        # (AUTH_SECRET=change-me-<40> is the one exception, and it is a quiet
        # case below: the ENV=prod boot guard refuses it.)
        "l16/apps/api-py/.env": f'AUTH_SECRET="${{X}}{_alnum(40)}"\n',
        "l17/apps/api-py/.env": f"{OPENAI}=changeme{secrets.token_hex(20)}\n",
        "l18/docs/runbook.md": f"psql {PG}://admin:changeme{secrets.token_hex(12)}@db.example.com/reep_py\n",
        "l19/docs/runbook.md": f"psql {PG}://reep:reep_dev_password{_alnum(6)}@db.example.com/reep_py\n",
        # FV-QG-01: a PEM block with ONE real body line is a key, however many
        # of its other lines are masked.
        "l20/docs/report.txt": _pem([MASK, _alnum(64, string.ascii_letters + string.digits + "+/"), MASK]),
        # OBS-QG-U07 / UT-G2-022: `<...>` JOINED to real characters is a real
        # value, at the start, in the middle and at the end, for every rule
        # whose value class admits `<`. Only a value that is wholly one `<...>`
        # is a placeholder.
        **_joined_bracket_cases(),
        # Withdrawn allowances: documentation must be respelled as a whole <...>.
        "l21/docs/evidence.txt": f"{OPENAI}=proxy-{MASK}\n",
        "l22/docs/evidence.txt": f"psql {PG}://admin:changeme<hex>@db.example.com/reep_py\n",
        # DEF-QG-U10: a REAL secret on the SAME LINE as every value an allowlist
        # frees. Against the match (or the secret) the freed value is freed and
        # the real one is found; widen any allowlist to the LINE and the real
        # one goes quiet with it -- the round-1 bug -- and these go MISSED.
        **_same_line_cases(hex64, ghp, pw),
    }
    quiet = {
        "q01/apps/api-py/.env.example": (
            f'{GROQ}=\n#MISTRAL_API_KEY=\nSAKANA_API_KEY=""\nOPENAI_API_KEY=""\n'
            "AUTH_SECRET=${AUTH_SECRET}\n"
            "AUTH_SECRET=reep-dev-secret-change-me-in-production-0123456789abcdef\n"
        ),
        "q02/docker-compose.yml": (
            "      DATABASE_URL: postgresql+psycopg://reep:reep_dev_password@postgres:5432/reep_py\n"
            "      VOICE_WORKER_SECRET: ${VOICE_WORKER_SECRET:?set VOICE_WORKER_SECRET}\n"
        ),
        "q03/infra/taskdef.yaml": (
            "secrets:\n  - name: AUTH_SECRET\n    valueFrom: arn:aws:secretsmanager:ap-south-1:1:secret:x\n"
            "environment:\n  - name: SES_FROM_ADDRESS\n    value: no-reply@example.com\n"
        ),
        "q04/k8s/secret.yaml": "data:\n  AUTH_SECRET:\n    valueFrom: x\nnext_key:\n  other: 1\n",
        "q05/docs/x.md": "a `--dbname=postgres://user:pass@...` is what not to do\n",
        "q06/apps/web/src/app/x.ts": "const rows: Array<string> = ['a', 'b'];\n",
        # The boot guard's exception: production refuses to boot on this value.
        "q07/apps/api-py/.env": f"AUTH_SECRET=change-me-{_alnum(40)}\n",
        # WHOLE-secret placeholders stay quiet.
        "q08/apps/api-py/.env.example": 'AUTH_SECRET="<paste-the-64-hex-secret-from-token-hex>"\n',
        "q09/docs/deploy.md": (
            f"DATABASE_URL={PG}://reep:<password>@db.example.com/reep_py\n"
            f"DATABASE_URL={PG}://reep:${{DB_PASSWORD}}@db.example.com/reep_py\n"
            f"DATABASE_URL={PG}://reep:change-me@db.example.com/reep_py\n"
        ),
        # FV-QG-01: the unit tester's masked spellings, every rule. A `<...>`
        # is documentation whatever surrounds it; no key is written with `<`.
        "q10/docs/evidence.txt": (
            f"{OPENAI}={MASK}\n{GROQ}={MASK}\n{AUTH}={MASK}\n"
            f"{DB_URL}={PG}://reep:{MASK}@host/db\n{OPENAI}=<your OpenAI key>\n"
            f"{VOICE}={MASK}\n{LIVEKIT}={MASK}\n"
            f"{VOICE}=change-me\n"
        ),
        "q11/docs/evidence-key.txt": _pem([MASK] * 6),
    }
    return leaks, quiet


def main() -> int:
    gitleaks = os.environ.get("GITLEAKS") or shutil.which("gitleaks")
    if not gitleaks:
        print("FAILED: gitleaks is not on PATH (or set GITLEAKS); the rules were not checked", file=sys.stderr)
        return 1
    leaks, quiet = cases()
    with tempfile.TemporaryDirectory(prefix="gitleaks-cases-") as tmp:
        root = Path(tmp)
        for rel, case in {**leaks, **quiet}.items():
            text = case[0] if isinstance(case, tuple) else case
            path = root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
        report = root.parent / f"{root.name}.json"
        try:
            run = subprocess.run(
                [gitleaks, "dir", ".", "--config", str(CONFIG), "--ignore-gitleaks-allow",
                 "--redact", "--no-banner",
                 "--exit-code", "0", "--report-format", "json", "--report-path", str(report)],
                capture_output=True, text=True, cwd=root,  # `dir .` from the root, as CI runs it
            )
            if run.returncode != 0 or not report.exists():
                print(run.stderr, file=sys.stderr)
                print("FAILED: gitleaks did not complete; the rules were not checked", file=sys.stderr)
                return 1
            findings = json.loads(report.read_text(encoding="utf-8")) or []
        finally:
            report.unlink(missing_ok=True)

    hits: dict[str, list[str]] = {}
    for finding in findings:
        reported = Path(finding["File"])
        rel = (reported.relative_to(root) if reported.is_absolute() else reported).as_posix()
        hits.setdefault(rel, []).append(finding["RuleID"])

    problems = []
    for rel, case in leaks.items():
        # A case may name the rule that must catch it; a different rule catching
        # the same bytes is then a MISS for the one this case exists to test.
        rule = case[1] if isinstance(case, tuple) else None
        caught = rel in hits and (rule is None or rule in hits[rel])
        status = f"caught by {sorted(set(hits[rel]))}" if caught else (
            f"MISSED by {rule} (caught only by {sorted(set(hits[rel]))})" if rel in hits else "MISSED")
        print(f"leak   {rel:42} {status}")
        if not caught:
            problems.append(f"{rel} is a leak the rules no longer catch" + (f" with {rule}" if rule else ""))
    for rel in quiet:
        status = f"REPORTED by {sorted(set(hits[rel]))}" if rel in hits else "quiet"
        print(f"quiet  {rel:42} {status}")
        if rel in hits:
            problems.append(f"{rel} is a published value or placeholder the rules now report")
    if problems:
        print("\nFAILED:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    print(f"\nOK: {len(leaks)} leaks caught, {len(quiet)} placeholder files quiet.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
