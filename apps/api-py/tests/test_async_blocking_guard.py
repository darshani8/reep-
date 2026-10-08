"""tools/ci/check_async_blocking.py finds blocking work inside `async def`.

The 2026-09-29 /register 504s were an `async def` endpoint holding a sync
Session on the event loop. ruff's ASYNC rules cannot see that shape, so the
checker exists; these tests pin what it reports and -- just as much -- what it
must NOT report, because the interview relay is genuinely async and a guard
that flags it gets switched off. No database.
"""
from __future__ import annotations

import importlib.util
import sys
import textwrap
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parent.parent.parent.parent
_spec = importlib.util.spec_from_file_location(
    "check_async_blocking", REPO / "tools" / "ci" / "check_async_blocking.py"
)
guard = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
# Registered before exec: @dataclass looks its own module up in sys.modules.
sys.modules[_spec.name] = guard
_spec.loader.exec_module(guard)

_DOC_STORE = frozenset({"save_bytes", "unlink_stored"})


def _scan(source: str) -> list[str]:
    findings = guard.scan_source(
        textwrap.dedent(source),
        "routers/example.py",
        app_module_funcs={"document_store": _DOC_STORE, "mail_transport": frozenset({"send"})},
    )
    return [f.what for f in findings]


# --- what it must report ------------------------------------------------------


def test_the_registration_incident_shape_is_reported():
    """An async endpoint taking Depends(get_db) -- the exact 2026-09-29 defect."""
    found = _scan(
        """
        from fastapi import Depends
        from sqlalchemy.orm import Session
        from ..db import get_db

        async def submit(db: Session = Depends(get_db)):
            db.add(object())
            db.commit()
        """
    )
    assert any("Depends(get_db)" in w for w in found)
    assert "calls db.commit() on a sync Session" in found


def test_annotated_depends_is_reported_too():
    found = _scan(
        """
        from typing import Annotated
        from fastapi import Depends
        from ..db import get_db

        async def handler(db: Annotated[object, Depends(get_db)]):
            return None
        """
    )
    assert found and "Depends(get_db)" in found[0]


def test_a_second_session_dependency_is_found_by_reading_the_source():
    deps = guard.session_dependencies_of(
        """
from .db import SessionLocal

def get_reporting_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

def not_a_dependency():
    return SessionLocal()
"""
    )
    assert deps == {"get_reporting_db"}
    found = guard.scan_source(
        "async def h(db=Depends(get_reporting_db)):\n    return 1\n",
        "x.py",
        session_deps=frozenset({"get_db"}) | deps,
    )
    assert len(found) == 1


@pytest.mark.parametrize(
    ("body", "expected"),
    [
        ("db = SessionLocal()\ndb.execute(q)", "calls db.execute() on a sync Session"),
        ("with SessionLocal() as s:\n    s.commit()", "calls s.commit() on a sync Session"),
        ("open('x').read()", "calls open()"),
        ("Path('x').read_bytes()", "calls .read_bytes()"),
        ("time.sleep(1)", "calls time.sleep()"),
        ("requests.get('https://example.com')", "calls requests.get()"),
        ("subprocess.run(['ls'])", "calls subprocess.run()"),
        ("boto3.client('s3')", "calls boto3.client()"),
        ("document_store.save_bytes(b'')", "calls document_store.save_bytes()"),
        ("save_bytes(b'')", "calls document_store.save_bytes()"),
        ("mail_transport.send(m)", "calls mail_transport.send()"),
        # OBS-QG-U03: the descriptor-level calls and Path.open().
        ("os.open('x', 0)", "calls os.open()"),
        ("os.read(fd, 10)", "calls os.read()"),
        ("os.write(fd, b'')", "calls os.write()"),
        ("Path('x').open()", "calls Path(...).open()"),
        ("pathlib.Path('x').open('rb')", "calls Path(...).open()"),
    ],
)
def test_each_blocking_call_is_reported(body, expected):
    header = textwrap.dedent(
        """
        import os, pathlib, time, subprocess, requests, boto3
        from pathlib import Path
        from .. import document_store, mail_transport
        from ..document_store import save_bytes
        from ..db import SessionLocal

        async def handler(q, m):
        """
    )
    found = _scan(header + textwrap.indent(body, "    ") + "\n")
    assert expected in found


def test_a_method_inside_a_class_is_named_by_its_qualname():
    findings = guard.scan_source(
        "import time\nclass Relay:\n    async def run(self):\n        time.sleep(1)\n",
        "x.py",
    )
    assert [f.key for f in findings] == ["x.py::Relay.run"]


# --- what it must NOT report ----------------------------------------------------


def test_work_handed_to_a_thread_is_not_reported():
    """The interview relay's idiom: name the function, call nothing."""
    assert _scan(
        """
        import asyncio
        from starlette.concurrency import run_in_threadpool
        from ..document_store import save_bytes
        from ..db import SessionLocal

        def _persist(x):
            db = SessionLocal()
            db.commit()

        async def relay(x):
            await asyncio.to_thread(_persist, x)
            await asyncio.to_thread(save_bytes, b"")
            await run_in_threadpool(lambda: open("x").read())
        """
    ) == []


def test_a_nested_def_runs_elsewhere_and_is_not_reported():
    """media_bridge's heartbeat: a sync callback defined inside the socket
    handler and invoked from a worker thread."""
    assert _scan(
        """
        from ..db import SessionLocal

        async def media_bridge(websocket):
            def on_heartbeat():
                db = SessionLocal()
                db.commit()
            await websocket.accept()
            return on_heartbeat
        """
    ) == []


def test_a_plain_def_endpoint_is_the_fix_and_is_not_reported():
    assert _scan(
        """
        from ..db import get_db

        def submit(db=Depends(get_db)):
            db.commit()
        """
    ) == []


def test_async_io_and_unrelated_names_are_not_reported():
    assert _scan(
        """
        import asyncio

        async def handler(websocket, file, cache):
            await asyncio.sleep(0.1)
            data = await file.read(1024)
            await websocket.send_bytes(data)
            cache.get("key")
            cache.commit()
        """
    ) == []


# --- the real tree --------------------------------------------------------------


def test_the_real_tree_matches_known_exactly():
    """Both directions of the ratchet, on app/ as it is."""
    findings = guard.scan_tree()
    offending = {f.key for f in findings}
    assert offending == set(guard.KNOWN), (
        f"new: {sorted(offending - set(guard.KNOWN))}; "
        f"fixed but still listed: {sorted(set(guard.KNOWN) - offending)}"
    )
    assert guard.main() == 0


def test_every_known_entry_carries_a_reason_and_its_findings():
    for key, known in guard.KNOWN.items():
        assert "::" in key, key
        assert len(known.reason.split()) >= 8, f"{key}: write the reason, not a placeholder"
        assert known.findings, f"{key}: pin what it was caught doing"


def test_the_registration_endpoints_are_not_async_again():
    """The two functions the incident was about stay off the list entirely."""
    keys = {f.key for f in guard.scan_tree()}
    assert "routers/registration.py::submit" not in keys
    assert "routers/registration.py::attach_document" not in keys


def test_the_interview_relay_is_not_flagged():
    """~75 async defs live in the interview engines and the socket; every one
    of them hands its database and file work to a thread."""
    keys = {f.key for f in guard.scan_tree()}
    relay_files = ("interview_nova.py", "interview_local.py", "interview_core.py",
                   "interview_audio.py", "routers/interview.py")
    assert not [k for k in keys if k.split("::")[0] in relay_files]


def test_a_new_offender_fails_main(tmp_path, monkeypatch, capsys):
    app = tmp_path / "app"
    app.mkdir()
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    (app / "new.py").write_text(
        "from .db import get_db\n\nasync def h(db=Depends(get_db)):\n    db.commit()\n"
    )
    monkeypatch.setattr(guard, "APP", app)
    monkeypatch.setattr(guard, "KNOWN", {})
    real_scan = guard.scan_tree
    monkeypatch.setattr(guard, "scan_tree", lambda: real_scan(app))
    assert guard.main() == 1
    assert "new.py:3: h" in capsys.readouterr().err


def test_a_stale_known_entry_fails_main(tmp_path, monkeypatch, capsys):
    app = tmp_path / "app"
    app.mkdir()
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    real_scan = guard.scan_tree
    monkeypatch.setattr(guard, "scan_tree", lambda: real_scan(app))
    monkeypatch.setattr(
        guard, "KNOWN", {"gone.py::fixed": guard.Known("it was fixed and nobody struck it off", ("x",))}
    )
    assert guard.main() == 1
    assert "gone.py::fixed" in capsys.readouterr().err


def test_a_file_that_does_not_parse_fails_rather_than_passing(tmp_path):
    app = tmp_path / "app"
    app.mkdir()
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    (app / "broken.py").write_text("async def (:\n")
    with pytest.raises(SyntaxError):
        guard.scan_tree(app)


# --- review follow-ups: the shapes the first version missed ----------------------


def _scan_with(source: str, **kwargs) -> list[str]:
    return [f.what for f in guard.scan_source(textwrap.dedent(source), "x.py", **kwargs)]


@pytest.mark.parametrize(
    "declaration",
    [
        "DbDep = Annotated[Session, Depends(get_db)]",
        "DbDep: TypeAlias = Annotated[Session, Depends(get_db)]",
        "type DbDep = Annotated[Session, Depends(get_db)]",
    ],
)
def test_fastapis_session_alias_idiom_is_reported(declaration):
    """FastAPI's documented `SessionDep`: the Depends() is in the alias, not at
    the parameter, and the body's calls must still count as Session calls."""
    found = _scan_with(
        f"""
        from typing import Annotated, TypeAlias
        from fastapi import Depends
        from ..db import get_db

        {declaration}

        async def handler(db: DbDep):
            db.execute(q)
        """
    )
    assert "parameter `db` is Depends(get_db), a sync Session" in found
    assert "calls db.execute() on a sync Session" in found


def test_an_alias_declared_in_another_module_is_resolved_across_the_tree(tmp_path):
    app = tmp_path / "app"
    (app / "routers").mkdir(parents=True)
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    (app / "deps.py").write_text(
        "from typing import Annotated\nfrom fastapi import Depends\nfrom .db import get_db\n"
        "DbDep = Annotated[object, Depends(get_db)]\n"
    )
    (app / "routers" / "a.py").write_text(
        "from ..deps import DbDep as D\nasync def h(db: D):\n    db.commit()\n"
    )
    (app / "routers" / "b.py").write_text(
        "from .. import deps\nasync def h(db: deps.DbDep):\n    return 1\n"
    )
    (app / "routers" / "c.py").write_text(
        "from ..deps import DbDep\nasync def h(db: 'DbDep'):\n    return 1\n"
    )
    keys = {f.key for f in guard.scan_tree(app)}
    assert keys == {"routers/a.py::h", "routers/b.py::h", "routers/c.py::h"}


def test_depends_by_keyword_is_reported():
    found = _scan_with("async def h(db=Depends(dependency=get_db)):\n    db.commit()\n")
    assert "calls db.commit() on a sync Session" in found


def test_get_db_under_an_import_alias_is_reported():
    found = _scan_with(
        "from ..db import get_db as database\n"
        "async def h(db=Depends(database)):\n    db.commit()\n"
    )
    assert any("Depends(get_db)" in w for w in found)


@pytest.mark.parametrize(
    "prelude, call",
    [
        ("from .. import db", "db.SessionLocal()"),
        ("from ..db import SessionLocal as SL", "SL()"),
    ],
)
def test_session_local_under_other_spellings_is_reported(prelude, call):
    found = _scan_with(f"{prelude}\nasync def h():\n    s = {call}\n    s.commit()\n")
    assert "calls SessionLocal()" in found
    assert "calls s.commit() on a sync Session" in found


def test_a_generator_yielding_session_local_under_an_alias_is_a_session_dependency():
    deps = guard.session_dependencies_of(
        "from .db import SessionLocal as SL\ndef get_other():\n    s = SL()\n    yield s\n"
    )
    assert deps == {"get_other"}


def test_a_local_variable_named_like_a_module_is_not_that_module():
    assert _scan_with("async def h():\n    requests = []\n    requests.append(1)\n") == []


def test_an_awaited_path_call_is_the_async_twin_and_is_not_reported():
    assert _scan_with(
        "import anyio\nasync def h(p):\n    return await anyio.Path(p).read_text()\n"
    ) == []


def test_a_session_parameter_is_reported_even_when_every_call_is_handed_off():
    """A decision, documented in the guard: holding a sync Session in an
    `async def` is the defect, whatever the body does with it."""
    found = _scan_with(
        "async def h(db=Depends(get_db)):\n"
        "    return await run_in_threadpool(lambda: db.execute(q))\n"
    )
    assert found == ["parameter `db` is Depends(get_db), a sync Session"]


def test_a_known_offender_that_grows_a_blocking_call_fails_main(tmp_path, monkeypatch, capsys):
    app = tmp_path / "app"
    app.mkdir()
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    (app / "known.py").write_text(
        "import requests\nasync def h(db=Depends(get_db)):\n    db.commit()\n    requests.get('x')\n"
    )
    real_scan = guard.scan_tree
    monkeypatch.setattr(guard, "scan_tree", lambda: real_scan(app))
    pinned = (guard._DB_PARAM, "calls db.commit() on a sync Session")
    monkeypatch.setattr(guard, "KNOWN", {"known.py::h": guard.Known("on the list on purpose here", pinned)})
    assert guard.main() == 1
    assert "known.py::h: NEW      calls requests.get()" in capsys.readouterr().err


def test_a_known_offender_that_shrank_must_update_its_pin(tmp_path, monkeypatch, capsys):
    app = tmp_path / "app"
    app.mkdir()
    for module in guard.BLOCKING_APP_MODULES:
        (app / f"{module}.py").write_text("def helper():\n    pass\n")
    (app / "known.py").write_text("async def h(db=Depends(get_db)):\n    return 1\n")
    real_scan = guard.scan_tree
    monkeypatch.setattr(guard, "scan_tree", lambda: real_scan(app))
    pinned = (guard._DB_PARAM, "calls db.commit() on a sync Session")
    monkeypatch.setattr(guard, "KNOWN", {"known.py::h": guard.Known("on the list on purpose here", pinned)})
    assert guard.main() == 1
    assert "GONE     calls db.commit() on a sync Session" in capsys.readouterr().err


def test_an_immediately_invoked_lambda_is_the_documented_blind_spot():
    """OBS-QG-U03. Pinned so that closing the gap is a deliberate change:
    a lambda body is excluded because `to_thread(lambda: ...)` is the idiom."""
    assert _scan_with("import time\nasync def h():\n    (lambda: time.sleep(5))()\n") == []
    assert "immediately-invoked lambda" in guard.__doc__


def test_an_awaited_async_file_open_is_not_reported():
    assert _scan_with("import anyio\nasync def h(p):\n    return await anyio.Path(p).open()\n") == []
