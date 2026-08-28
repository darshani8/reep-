"""Companion registry and permission-controlled memory APIs.

The registry is admin-managed. A signed-in user can use active companions and
write only their own private memory. Centralized memory is a curated, shared
pool: only an admin can create or approve it, and only APPROVED entries enter a
companion's context response.
"""

import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..identity import get_current_session
from ..models.companion import (
    Companion,
    CompanionMemory,
    CompanionStatus,
    MemoryScope,
    MemoryStatus,
)

router = APIRouter(prefix="/companions", tags=["companions"])
_SLUG_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_VALID_ROLES = {"STUDENT", "MENTOR", "DIRECTOR", "ADMIN", "ALUMNI"}
_DEFAULT_ROLES = ["STUDENT", "MENTOR", "DIRECTOR", "ADMIN"]


def _require_admin(session: dict) -> str:
    if session.get("role") != "ADMIN":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required.")
    return str(session["userId"])


def _user_id(session: dict) -> str:
    return str(session["userId"])


def _active_companion(db: Session, companion_id: str, session: dict | None = None) -> Companion:
    companion = db.get(Companion, companion_id)
    if companion is None or companion.status != CompanionStatus.ACTIVE:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Active companion not found.")
    if session is not None and session.get("role") not in (companion.allowed_roles or []):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This companion is not assigned to your role.")
    return companion


class CompanionCreate(BaseModel):
    slug: str = Field(min_length=2, max_length=80)
    name: str = Field(min_length=1, max_length=120)
    role_key: str = Field(min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    capabilities: list[str] = Field(default_factory=list, max_length=30)
    allowed_roles: list[str] = Field(default_factory=lambda: list(_DEFAULT_ROLES), max_length=5)

    @field_validator("allowed_roles")
    @classmethod
    def valid_roles(cls, value: list[str]) -> list[str]:
        normalized = [role.strip().upper() for role in value]
        invalid = sorted(set(normalized) - _VALID_ROLES)
        if invalid:
            raise ValueError(f"unsupported allowed role(s): {', '.join(invalid)}")
        return list(dict.fromkeys(normalized))

    @field_validator("slug")
    @classmethod
    def valid_slug(cls, value: str) -> str:
        value = value.strip().lower()
        if not _SLUG_RE.fullmatch(value):
            raise ValueError("slug must contain lowercase letters, numbers, and hyphens only")
        return value

    @field_validator("name", "role_key")
    @classmethod
    def non_blank(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


class CompanionUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    role_key: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    system_prompt: str | None = Field(default=None, max_length=20_000)
    capabilities: list[str] | None = Field(default=None, max_length=30)
    allowed_roles: list[str] | None = Field(default=None, max_length=5)
    status: CompanionStatus | None = None

    @field_validator("allowed_roles")
    @classmethod
    def valid_roles(cls, value: list[str] | None) -> list[str] | None:
        if value is None:
            return value
        normalized = [role.strip().upper() for role in value]
        invalid = sorted(set(normalized) - _VALID_ROLES)
        if invalid:
            raise ValueError(f"unsupported allowed role(s): {', '.join(invalid)}")
        return list(dict.fromkeys(normalized))

    @field_validator("name", "role_key")
    @classmethod
    def non_blank(cls, value: str | None) -> str | None:
        if value is None:
            return value
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


class MemoryCreate(BaseModel):
    title: str = Field(min_length=1, max_length=160)
    content: str = Field(min_length=1, max_length=50_000)
    metadata_json: dict = Field(default_factory=dict)
    embedding: list[float] | None = None

    @field_validator("title", "content")
    @classmethod
    def trim_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value must not be blank")
        return value


class CompanionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    slug: str
    name: str
    role_key: str
    description: str | None
    system_prompt: str | None
    capabilities: list
    allowed_roles: list
    status: CompanionStatus
    created_at: datetime
    updated_at: datetime
    memory_count: int = 0


class MemoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    companion_id: str | None
    scope: MemoryScope
    status: MemoryStatus
    title: str
    content: str
    owner_user_id: str | None
    created_by_user_id: str | None
    approved_by_user_id: str | None
    metadata_json: dict
    created_at: datetime
    updated_at: datetime
    approved_at: datetime | None


class ContextOut(BaseModel):
    companion_id: str
    memories: list[MemoryOut]


def _companion_out(db: Session, companion: Companion) -> CompanionOut:
    count = db.scalar(
        select(func.count()).select_from(CompanionMemory).where(
            or_(CompanionMemory.companion_id == companion.id, CompanionMemory.companion_id.is_(None))
        )
    ) or 0
    return CompanionOut.model_validate(companion).model_copy(update={"memory_count": count})


def _memory_query(companion_id: str, user_id: str, *, admin: bool = False):
    query = select(CompanionMemory).where(
        ((CompanionMemory.companion_id == companion_id) | (CompanionMemory.companion_id.is_(None))),
        (
            (CompanionMemory.scope == MemoryScope.SHARED)
            | ((CompanionMemory.scope == MemoryScope.PRIVATE) & (CompanionMemory.owner_user_id == user_id))
        ),
    )
    if not admin:
        query = query.where(
            (CompanionMemory.status == MemoryStatus.APPROVED)
            | ((CompanionMemory.scope == MemoryScope.PRIVATE) & (CompanionMemory.status != MemoryStatus.ARCHIVED))
        )
    return query.order_by(CompanionMemory.created_at.desc())


@router.get("", response_model=list[CompanionOut])
def list_companions(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CompanionOut]:
    """List the registry. Management metadata is intentionally admin-only."""
    _require_admin(session)
    return [_companion_out(db, companion) for companion in db.scalars(select(Companion).order_by(Companion.name)).all()]


@router.get("/active", response_model=list[CompanionOut])
def list_active_companions(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> list[CompanionOut]:
    """The safe runtime catalogue for any authenticated role."""
    _user_id(session)
    role = session.get("role")
    companions = db.scalars(
        select(Companion)
        .where(Companion.status == CompanionStatus.ACTIVE)
        .where(Companion.allowed_roles.contains([role]))
        .order_by(Companion.name)
    ).all()
    return [_companion_out(db, companion) for companion in companions]


@router.post("", response_model=CompanionOut, status_code=status.HTTP_201_CREATED)
def create_companion(
    body: CompanionCreate,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CompanionOut:
    admin_id = _require_admin(session)
    if db.scalar(select(Companion).where(Companion.slug == body.slug)) is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Companion slug already exists.")
    companion = Companion(**body.model_dump(), created_by_user_id=admin_id)
    db.add(companion)
    db.commit()
    db.refresh(companion)
    return _companion_out(db, companion)


@router.patch("/{companion_id}", response_model=CompanionOut)
def update_companion(
    companion_id: str,
    body: CompanionUpdate,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> CompanionOut:
    _require_admin(session)
    companion = db.get(Companion, companion_id)
    if companion is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Companion not found.")
    for key, value in body.model_dump(exclude_unset=True).items():
        setattr(companion, key, value)
    db.commit()
    db.refresh(companion)
    return _companion_out(db, companion)


@router.get("/{companion_id}/memory", response_model=list[MemoryOut])
def list_memory(
    companion_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> list[MemoryOut]:
    admin = session.get("role") == "ADMIN"
    if not admin:
        _active_companion(db, companion_id, session)
    else:
        if db.get(Companion, companion_id) is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Companion not found.")
    rows = db.scalars(_memory_query(companion_id, _user_id(session), admin=admin).limit(limit)).all()
    return [MemoryOut.model_validate(row) for row in rows]


@router.post("/{companion_id}/memory", response_model=MemoryOut, status_code=status.HTTP_201_CREATED)
def create_private_memory(
    companion_id: str,
    body: MemoryCreate,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MemoryOut:
    _active_companion(db, companion_id, session)
    owner_id = _user_id(session)
    row = CompanionMemory(
        companion_id=companion_id,
        scope=MemoryScope.PRIVATE,
        status=MemoryStatus.APPROVED,
        owner_user_id=owner_id,
        created_by_user_id=owner_id,
        **body.model_dump(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return MemoryOut.model_validate(row)


@router.post("/shared-memory", response_model=MemoryOut, status_code=status.HTTP_201_CREATED)
def create_shared_memory(
    body: MemoryCreate,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MemoryOut:
    admin_id = _require_admin(session)
    row = CompanionMemory(
        companion_id=None,
        scope=MemoryScope.SHARED,
        status=MemoryStatus.DRAFT,
        created_by_user_id=admin_id,
        **body.model_dump(),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return MemoryOut.model_validate(row)


@router.post("/{companion_id}/memory/{memory_id}/approve", response_model=MemoryOut)
def approve_shared_memory(
    companion_id: str,
    memory_id: str,
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> MemoryOut:
    admin_id = _require_admin(session)
    _active_companion(db, companion_id)
    row = db.get(CompanionMemory, memory_id)
    if row is None or row.scope != MemoryScope.SHARED or row.companion_id is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Shared memory not found.")
    row.status = MemoryStatus.APPROVED
    row.approved_by_user_id = admin_id
    row.approved_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(row)
    return MemoryOut.model_validate(row)


@router.get("/{companion_id}/context", response_model=ContextOut)
def companion_context(
    companion_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    session: dict = Depends(get_current_session),
    db: Session = Depends(get_db),
) -> ContextOut:
    """Return exactly the memory this caller may pass to the companion."""
    _active_companion(db, companion_id, session)
    rows = db.scalars(_memory_query(companion_id, _user_id(session)).limit(limit)).all()
    return ContextOut(companion_id=companion_id, memories=[MemoryOut.model_validate(row) for row in rows])
