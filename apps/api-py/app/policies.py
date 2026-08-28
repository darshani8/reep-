"""Fail-closed capability and student-scope policy for the v1 API."""

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from .models.user import Student

STAFF_ROLES = frozenset({"MENTOR", "DIRECTOR", "ADMIN"})
PROGRAMME_ROLES = frozenset({"DIRECTOR", "ADMIN"})


def require_role(session: dict, *roles: str) -> dict:
      """Require an explicit role; missing or malformed identity is denied."""
      role = session.get("role")
      if not isinstance(role, str) or role not in roles:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient role.")
            if not session.get("userId"):
                      raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Sign in required.")
                  return session


def require_staff(session: dict) -> dict:
      return require_role(session, *sorted(STAFF_ROLES))


def require_programme_admin(session: dict) -> dict:
      return require_role(session, *sorted(PROGRAMME_ROLES))


def assert_student_scope(session: dict, student_id: str, db: Session) -> Student:
      """Return a student only when the current role is allowed to access it."""
    require_staff(session)
    student = db.get(Student, student_id)
    if student is None:
              raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not found.")
          if session["role"] == "MENTOR" and (
                    not session.get("mentorId") or student.mentor_id != session["mentorId"]
          ):
                    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Student not in your mentor scope.")
                return student


def student_identity(session: dict) -> str:
      """Derive the student id from the verified session, never from request JSON."""
    require_role(session, "STUDENT")
    student_id = session.get("studentId")
    if not student_id:
              raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Student profile is not provisioned.")
          return str(student_id)
