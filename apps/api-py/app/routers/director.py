"""Director dashboard — programme-wide aggregates. Director/admin only; reuses
the mentor router's require_director guard. Compute-only over existing data.
"""

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import get_current_session
from ..models.alert import Alert
from ..models.offer import OfferStatus, PlacementOffer
from ..models.user import Student
from .mentor import require_director

router = APIRouter(prefix="/director", tags=["director"])


class OverviewOut(BaseModel):
    total_students: int
    by_stage: dict[str, int]
    pending_offers: int
    approved_offers: int
    placed_students: int
    placement_percent: float
    open_alerts: int


@router.get("/overview", response_model=OverviewOut)
def overview(
    session: dict = Depends(get_current_session), db: Session = Depends(get_db)
) -> OverviewOut:
    require_director(session)

    total = db.scalar(select(func.count()).select_from(Student)) or 0
    by_stage = {
        stage.value: count
        for stage, count in db.execute(
            select(Student.current_stage, func.count()).group_by(Student.current_stage)
        ).all()
    }
    pending = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.PENDING_APPROVAL)
        )
        or 0
    )
    approved = (
        db.scalar(
            select(func.count())
            .select_from(PlacementOffer)
            .where(PlacementOffer.status == OfferStatus.APPROVED)
        )
        or 0
    )
    placed = (
        db.scalar(
            select(func.count(func.distinct(PlacementOffer.student_id))).where(
                PlacementOffer.status == OfferStatus.APPROVED
            )
        )
        or 0
    )
    open_alerts = (
        db.scalar(select(func.count()).select_from(Alert).where(Alert.resolved_at.is_(None))) or 0
    )

    return OverviewOut(
        total_students=total,
        by_stage=by_stage,
        pending_offers=pending,
        approved_offers=approved,
        placed_students=placed,
        placement_percent=round(100 * placed / total, 1) if total else 0.0,
        open_alerts=open_alerts,
    )
