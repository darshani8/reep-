"""The round trip's refusals: who it will and will not run against.

tools/ci/check_migration_roundtrip.py creates and drops `<db>_roundtrip` beside
DATABASE_URL's database, so it must never run against production. These pin its
three fences without a database: the ENV allowlist and the client-side host
checks (refusal()), and the server's own answer to "are you a managed cloud
Postgres?" (managed_server()), asked through a stubbed engine.

The case that matters most is the one CI hit: a Postgres behind a port mapping
reports a non-loopback LISTENING address (the GitHub Actions service container
said 172.18.0.2, and so does `docker compose up -d`). That must pass. An
earlier version demanded a loopback server address and turned CI red; widening
it to private ranges would have accepted RDS, which sits on a private VPC
address too.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine

REPO = Path(__file__).resolve().parents[3]


def _load():
    spec = importlib.util.spec_from_file_location(
        "reep_check_migration_roundtrip", REPO / "tools" / "ci" / "check_migration_roundtrip.py"
    )
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load tools/ci/check_migration_roundtrip.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rt = _load()

DEV = SimpleNamespace(env="dev", env_is_dev=True)


def _engine(rest: str):
    # create_engine does not connect, so these never reach a server.
    return create_engine(f"postgresql+psycopg://reep:pw@{rest}")


class _StubServer:
    """An engine whose one connection answers the three questions asked of it."""

    def __init__(self, *, setting=None, rds_role=None, listening="172.18.0.2"):
        self.answers = {"pg_settings": setting, "rds.superuser_variables": rds_role,
                        "inet_server_addr": listening}

    def connect(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, statement, params=None):
        sql = str(statement)
        for marker, answer in self.answers.items():
            if marker in sql:
                return SimpleNamespace(scalar=lambda answer=answer: answer)
        raise AssertionError(f"unexpected query: {sql}")


@pytest.mark.parametrize(
    "rest",
    [
        "localhost:5433/reep_py",
        "127.0.0.1:5433/reep_py",
        "[::1]:5433/reep_py",
        "localhost:5433/reep_py?host=/var/run/postgresql",
    ],
)
def test_a_local_client_connection_is_accepted(rest) -> None:
    assert rt.refusal(DEV, _engine(rest)) is None, f"{rest} is local and must be accepted"


@pytest.mark.parametrize(
    ("rest", "why"),
    [
        ("db.internal:5432/reep_py", "a remote host"),
        ("localhost:5433/reep_py?host=db.example.com", "?host= overrides the URL's host"),
        ("localhost:5433/reep_py?hostaddr=192.0.2.1", "?hostaddr= is where libpq really connects"),
        ("localhost:5433/reep_py?host=localhost,db.example.com", "a multi-host list with a remote member"),
        ("localhost:5433/reep_prod", "a database named like production"),
    ],
)
def test_a_connection_that_could_reach_production_is_refused(rest, why) -> None:
    assert rt.refusal(DEV, _engine(rest)) is not None, f"{rest} must be refused: {why}"


@pytest.mark.parametrize("env", ["prod", "production", "staging", "uat", ""])
def test_only_a_development_env_is_accepted(env) -> None:
    settings = SimpleNamespace(env=env, env_is_dev=False)
    assert rt.refusal(settings, _engine("localhost:5433/reep_py")) is not None, (
        f"ENV={env!r} is not a development name and must be refused"
    )


def test_a_port_mapped_server_reporting_a_bridge_address_passes() -> None:
    """The CI service container and docker compose: client on localhost, server
    listening on a Docker bridge address, no managed-cloud settings."""
    assert rt.refusal(DEV, _engine("localhost:5433/reep_py")) is None, "the client side is local"
    assert rt.managed_server(_StubServer(listening="172.18.0.2")) is None, (
        "a server on a Docker bridge address with no rds.* settings is a development server"
    )


@pytest.mark.parametrize("setting", ["rds.force_ssl", "rds.extensions", "aurora_compute_plan_id", "cloudsql.iam_authentication", "azure.extensions"])
def test_a_managed_cloud_server_is_refused_even_through_a_local_tunnel(setting) -> None:
    """A tunnel makes the client host loopback; it cannot make RDS stop being RDS."""
    assert rt.refusal(DEV, _engine("localhost:5433/reep_py")) is None, "the tunnel looks local"
    reason = rt.managed_server(_StubServer(setting=setting))
    assert reason is not None and setting in reason, f"a server carrying {setting} must be refused"


def test_rds_superuser_variables_alone_is_refused() -> None:
    reason = rt.managed_server(_StubServer(rds_role="session_replication_role"))
    assert reason is not None and "RDS" in reason, "rds.superuser_variables is RDS's own setting"
