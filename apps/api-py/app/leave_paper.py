"""Render a leave request as the printed BGSCET leave paper, with ReportLab.

Runs entirely on this machine - no network, no model - like app/english_report.py
and app/resume_pdf.py; keep it that way. The layout is the sheet the Leave
Approvals screen draws (features/director/leave-approvals): the invocation, the
college header, "Application for" with the printed options and the rest struck
off, the seven-row table, the two signature blocks, the rule, and the
Alternate Arrangements section with its own staff signature. Same words, same
order, so what the admin downloads is what they saw.

A SIGNATURE IS STILL A NAME AND A TIME. The image, where the signer has
uploaded one (app/models/staff_signature.py), is drawn ABOVE the name, never
instead of it: an image alone says nothing about when, and a paper with an
image and no timestamp is exactly the ambiguity the timestamp exists to
remove. No image on file prints the name and time alone, which is what the
screen shows; "Not signed" / "Awaiting" print where the screen prints them.
"""

from __future__ import annotations

import html
import io
from datetime import date, datetime, timezone
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.lib.utils import ImageReader
from reportlab.platypus import (
    HRFlowable,
    Image,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_INK = colors.HexColor("#1E1B29")
_MUTED = colors.HexColor("#585566")
_HAIRLINE = colors.HexColor("#B9AFC6")

#: The printed options, in the order the form lists them (leave.py's LeaveIn
#: pattern and the screen's KINDS agree on the ids).
KINDS: tuple[tuple[str, str], ...] = (
    ("CASUAL", "Casual Leave"),
    ("PERMISSION", "Permission"),
    ("OOD", "OOD"),
    ("RH", "RH"),
    ("LOP", "LOP"),
)

#: The "Sanctioned" cell, in the words the screen uses.
SANCTIONED: dict[str, str] = {
    "APPROVED": "Sanctioned",
    "REJECTED": "Not sanctioned",
    "FIRST_APPROVED": "Pending - first signature given",
    "SUBMITTED": "Pending",
    "CANCELLED": "Cancelled",
}

SIGNATURE_HEIGHT = 14 * mm
SIGNATURE_MAX_WIDTH = 55 * mm


def _esc(value: Any) -> str:
    return html.escape("" if value is None else str(value))


def _styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "invoke": ParagraphStyle("LvInvoke", parent=base["Normal"], fontSize=9, leading=11, alignment=TA_CENTER, textColor=_MUTED),
        "college": ParagraphStyle("LvCollege", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=12.5, leading=15, alignment=TA_CENTER, textColor=_INK),
        "addr": ParagraphStyle("LvAddr", parent=base["Normal"], fontSize=9.5, leading=12, alignment=TA_CENTER, textColor=_INK, spaceAfter=8),
        "apply": ParagraphStyle("LvApply", parent=base["Normal"], fontSize=10, leading=14, alignment=TA_LEFT, textColor=_INK),
        "body": ParagraphStyle("LvBody", parent=base["Normal"], fontSize=10, leading=13.5, textColor=_INK),
        "label": ParagraphStyle("LvLabel", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=9.5, leading=13, textColor=_INK),
        "cell": ParagraphStyle("LvCell", parent=base["Normal"], fontSize=9.5, leading=13, textColor=_INK),
        "h": ParagraphStyle("LvH", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=13, textColor=_INK, spaceBefore=6, spaceAfter=3),
        "sigline": ParagraphStyle("LvSigLine", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=8, leading=10, textColor=_MUTED),
        "signame": ParagraphStyle("LvSigName", parent=base["Normal"], fontName="Helvetica-Bold", fontSize=10, leading=12.5, textColor=_INK),
        "sigwhen": ParagraphStyle("LvSigWhen", parent=base["Normal"], fontSize=8.5, leading=11, textColor=_MUTED),
        "await": ParagraphStyle("LvAwait", parent=base["Normal"], fontName="Helvetica-Oblique", fontSize=9, leading=12, textColor=_MUTED),
        "foot": ParagraphStyle("LvFoot", parent=base["Normal"], fontSize=7.5, leading=10, textColor=_MUTED, spaceBefore=10),
    }


def _when(value: datetime | None, with_time: bool = True) -> str:
    """"9 Sep 2026, 14:05" - the screen's date pipe. Only portable strftime
    codes, then the leading zero is stripped: the day-without-padding code is
    glibc-only and raises on Windows."""
    if value is None:
        return "-"
    local = value.astimezone(timezone.utc) if value.tzinfo else value
    text = local.strftime("%d %b %Y, %H:%M" if with_time else "%d %b %Y")
    return text.lstrip("0")


def _date_span(a: date, b: date) -> str:
    return a.isoformat() if a == b else f"{a.isoformat()} - {b.isoformat()}"


def _signature_image(sig: tuple[bytes, str] | None) -> Image | None:
    """The uploaded image, scaled to the block: a fixed height, width to
    aspect, capped so a wide scan does not push the block off the column."""
    if sig is None:
        return None
    content, _mime = sig
    try:
        w, h = ImageReader(io.BytesIO(content)).getSize()
    except Exception:  # noqa: BLE001 - an unreadable image prints nothing, never breaks the paper
        return None
    if not w or not h:
        return None
    height = SIGNATURE_HEIGHT
    width = height * (w / h)
    if width > SIGNATURE_MAX_WIDTH:
        width = SIGNATURE_MAX_WIDTH
        height = width * (h / w)
    img = Image(io.BytesIO(content), width=width, height=height)
    img.hAlign = "LEFT"
    return img


def _signature_block(styles, *, image: Image | None, name: str | None, when: datetime | None,
                     awaiting: str, line: str) -> list:
    """Image (if any) over name over time, then the printed line under it.
    Name and time print together or not at all."""
    block: list = []
    if name and when is not None:
        if image is not None:
            block.append(image)
        block.append(Paragraph(_esc(name), styles["signame"]))
        block.append(Paragraph(_esc(_when(when)), styles["sigwhen"]))
    else:
        block.append(Spacer(1, SIGNATURE_HEIGHT))
        block.append(Paragraph(_esc(awaiting), styles["await"]))
    block.append(Spacer(1, 2))
    block.append(Paragraph(_esc(line), styles["sigline"]))
    return block


def render_leave_paper_pdf(
    leave: Any,
    *,
    staff_signature: tuple[bytes, str] | None = None,
    director_signature: tuple[bytes, str] | None = None,
) -> bytes:
    """`leave` is routers/leave.py's LeaveOut (or anything with its fields)."""
    styles = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
        title=f"Leave application - {leave.requester_name}", author="REEP",
    )
    width = A4[0] - 36 * mm

    # -- header, as printed ----------------------------------------------------
    flow: list = [
        Paragraph("|| Jai Sri Gurudev ||", styles["invoke"]),
        Paragraph("BGS COLLEGE OF ENGINEERING AND TECHNOLOGY, MBA", styles["college"]),
        Paragraph("Mahalakshmipuram, Bengaluru-86.", styles["addr"]),
    ]
    options = []
    for key, label in KINDS:
        if leave.leave_kind is None:
            options.append(_esc(label))
        elif key == leave.leave_kind:
            options.append(f"<b><u>{_esc(label)}</u></b>")
        else:
            options.append(f"<strike>{_esc(label)}</strike>")
    flow.append(Paragraph(
        "Application for &nbsp;" + " / ".join(options) + " &nbsp;<font size='8' color='#585566'>(Strike-off, if not applicable)</font>",
        styles["apply"],
    ))
    flow.append(Paragraph(
        f"Date: <b>{_esc(_when(leave.signed_at, with_time=False)) if leave.signed_at else '-'}</b>", styles["apply"],
    ))
    flow.append(Spacer(1, 6))

    # -- the seven rows ----------------------------------------------------------
    rows = [
        ("Name", leave.requester_name),
        ("Designation", leave.requester_designation or "Not on record"),
        ("Department", leave.requester_department or "Not on record"),
        ("Date", _date_span(leave.from_date, leave.to_date)),
        ("Purpose", leave.reason),
        ("Credit", leave.credit or "-"),
        ("Sanctioned", SANCTIONED.get(leave.status, leave.status)),
    ]
    table = Table(
        [[Paragraph(_esc(k), styles["label"]), Paragraph(_esc(v), styles["cell"])] for k, v in rows],
        colWidths=[34 * mm, width - 34 * mm], hAlign="LEFT",
    )
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.6, _HAIRLINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#F4EFF8")),
    ]))
    flow.append(table)
    flow.append(Spacer(1, 10))

    # -- the two signature blocks ------------------------------------------------
    staff_block = _signature_block(
        styles, image=_signature_image(staff_signature), name=leave.requester_name,
        when=leave.signed_at, awaiting="Not signed", line="SIGNATURE OF STAFF",
    )
    director_block = _signature_block(
        styles, image=_signature_image(director_signature), name=leave.director_name,
        when=leave.director_decided_at, awaiting="Awaiting", line="PROGRAM DIRECTOR",
    )
    sig = Table([[staff_block, director_block]], colWidths=[width / 2, width / 2], hAlign="LEFT")
    sig.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "BOTTOM"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
        ("RIGHTPADDING", (0, 0), (-1, -1), 8),
    ]))
    flow.append(sig)
    if leave.director_note:
        label = "Rejected - remarks" if leave.status == "REJECTED" else "Sanctioned - remarks"
        flow.append(Spacer(1, 4))
        flow.append(Paragraph(f"<b>{_esc(label)}:</b> {_esc(leave.director_note)}", styles["body"]))
    flow.append(Spacer(1, 8))
    flow.append(HRFlowable(width="100%", thickness=0.8, color=_HAIRLINE))

    # -- alternate arrangements ---------------------------------------------------
    flow.append(Paragraph("Alternate Arrangements: (For Department purpose)", styles["h"]))
    flow.append(Paragraph(f"Name: <b>{_esc(leave.alt_name or '-')}</b>", styles["body"]))
    flow.append(Spacer(1, 4))
    head = [Paragraph(f"<b>{h}</b>", styles["cell"]) for h in ("Date", "Staff Name (Alternative)", "Class", "Time", "Remarks")]
    alt_rows = list(getattr(leave, "alt_rows", []) or [])
    if alt_rows:
        body_rows = [
            [Paragraph(_esc(getattr(a, "date", "")), styles["cell"]),
             Paragraph(_esc(getattr(a, "staff_name", "")), styles["cell"]),
             Paragraph(_esc(getattr(a, "cls", "")), styles["cell"]),
             Paragraph(_esc(getattr(a, "time", "")), styles["cell"]),
             Paragraph(_esc(getattr(a, "remarks", "")), styles["cell"])]
            for a in alt_rows
        ]
    else:
        body_rows = [[Paragraph("No alternate arrangements recorded.", styles["await"]), "", "", "", ""]]
    alt = Table([head] + body_rows, colWidths=[26 * mm, 52 * mm, 24 * mm, 24 * mm, width - 126 * mm], hAlign="LEFT")
    alt_style = [
        ("GRID", (0, 0), (-1, -1), 0.6, _HAIRLINE),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F4EFF8")),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]
    if not alt_rows:
        alt_style.append(("SPAN", (0, 1), (-1, 1)))
    alt.setStyle(TableStyle(alt_style))
    flow.append(alt)
    flow.append(Spacer(1, 10))
    foot = _signature_block(
        styles, image=_signature_image(staff_signature), name=leave.requester_name,
        when=leave.signed_at, awaiting="Not signed", line="Signature of staff.",
    )
    flow.append(Table([[foot]], colWidths=[width / 2], hAlign="LEFT",
                      style=TableStyle([("LEFTPADDING", (0, 0), (-1, -1), 0)])))

    generated = datetime.now(timezone.utc)
    flow.append(Paragraph(
        f"Generated by REEP on {_esc(_when(generated))} UTC. A signature on this form is a name and a "
        "timestamp recorded against the signer's REEP account; an image, where present, is that "
        "person's uploaded signature.",
        styles["foot"],
    ))

    doc.build(flow)
    return buf.getvalue()
