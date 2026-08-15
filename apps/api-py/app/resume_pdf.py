"""Render a composed resume (markdown) to a one-page-ish PDF with ReportLab.

Runs entirely on this machine — no network, no model — so the student-data
egress gate does not apply here: the student's PII is turned into bytes locally
and streamed straight back to the authenticated owner. Keep it that way; do not
add any remote call to this module.

The markdown we render is what `_compose_resume_markdown` / the AI-polish step
produces: `# Name`, `## Section`, `- bullet`, and plain paragraphs, with simple
`**bold**` inline emphasis. Anything richer degrades gracefully to plain text.
"""

import html
import io
import re

from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import HRFlowable, ListFlowable, ListItem, Paragraph, SimpleDocTemplate, Spacer


def _inline(md: str) -> str:
    """Minimal inline markdown -> ReportLab mini-HTML. Escape first so a stray
    '<' in the data can never inject markup, then re-introduce only <b>."""
    escaped = html.escape(md)
    # **bold** -> <b>bold</b>
    return re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", escaped)


def _styles() -> dict:
    base = getSampleStyleSheet()
    name = ParagraphStyle(
        "ResumeName", parent=base["Title"], fontSize=20, spaceAfter=2, leading=24, alignment=TA_LEFT
    )
    section = ParagraphStyle(
        "ResumeSection",
        parent=base["Heading2"],
        fontSize=12,
        textColor="#1a3c5e",
        spaceBefore=10,
        spaceAfter=2,
        leading=15,
    )
    body = ParagraphStyle("ResumeBody", parent=base["BodyText"], fontSize=10, leading=14, spaceAfter=3)
    bullet = ParagraphStyle("ResumeBullet", parent=body, spaceAfter=1)
    return {"name": name, "section": section, "body": body, "bullet": bullet}


def render_resume_pdf(markdown: str, *, fallback_title: str = "Resume") -> bytes:
    """Turn resume markdown into PDF bytes."""
    styles = _styles()
    story: list = []
    pending_bullets: list = []

    def flush_bullets() -> None:
        if pending_bullets:
            story.append(
                ListFlowable(
                    [ListItem(Paragraph(b, styles["bullet"]), leftIndent=10) for b in pending_bullets],
                    bulletType="bullet",
                    start="•",
                    leftIndent=12,
                )
            )
            pending_bullets.clear()

    saw_name = False
    for raw in (markdown or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            flush_bullets()
            continue
        if line.startswith("# "):
            flush_bullets()
            story.append(Paragraph(_inline(line[2:].strip()), styles["name"]))
            story.append(HRFlowable(width="100%", thickness=1, color="#1a3c5e", spaceAfter=4))
            saw_name = True
        elif line.startswith("## "):
            flush_bullets()
            story.append(Paragraph(_inline(line[3:].strip()), styles["section"]))
        elif line.lstrip().startswith(("- ", "* ")):
            pending_bullets.append(_inline(line.lstrip()[2:].strip()))
        else:
            flush_bullets()
            story.append(Paragraph(_inline(line.strip()), styles["body"]))
    flush_bullets()

    if not saw_name:
        story.insert(0, Paragraph(_inline(fallback_title), styles["name"]))
    if len(story) <= 1:
        story.append(Paragraph("No resume content.", styles["body"]))
        story.append(Spacer(1, 4 * mm))

    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=A4,
        title=fallback_title,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=16 * mm,
        bottomMargin=16 * mm,
    )
    doc.build(story)
    return buf.getvalue()
