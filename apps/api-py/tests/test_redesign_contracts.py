from app.architecture_events import request_hash
from app.policies import STAFF_ROLES, student_identity


def test_request_hash_is_order_independent():
    assert request_hash({"b": 2, "a": 1}) == request_hash({"a": 1, "b": 2})


def test_student_identity_requires_session_owned_student():
    assert student_identity({"role": "STUDENT", "userId": "u", "studentId": "s"}) == "s"


def test_role_sets_are_explicit():
    assert STAFF_ROLES == {"MENTOR", "DIRECTOR", "ADMIN"}
    assert "STUDENT" not in STAFF_ROLES
