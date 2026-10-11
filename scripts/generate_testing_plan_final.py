"""
Generate a professional PDF from docs/TESTING_PLAN_FINAL.md using ReportLab.
Output: C:/Users/spencer/Downloads/TESTINGPLANLLB_FINAL.pdf
"""

import re
import sys
from pathlib import Path
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
    HRFlowable, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_RIGHT

# ─── Paths ───────────────────────────────────────────────────────────────────
MD_PATH  = Path(__file__).parent.parent / "docs" / "TESTING_PLAN_FINAL.md"
OUT_PATH = Path("C:/Users/spencer/Downloads/TESTINGPLANLLB_FINAL.pdf")

# ─── Colour palette ──────────────────────────────────────────────────────────
NAVY      = colors.HexColor("#1a3a6b")
BLUE      = colors.HexColor("#2563eb")
LIGHT_BG  = colors.HexColor("#f0f4ff")
RULE_BLUE = colors.HexColor("#3b82f6")
TH_BG     = colors.HexColor("#1e3a8a")
TH_TEXT   = colors.white
ROW_ALT   = colors.HexColor("#f8faff")
BORDER    = colors.HexColor("#cbd5e1")
TEXT      = colors.HexColor("#1e293b")
MUTED     = colors.HexColor("#64748b")

# ─── Page template ───────────────────────────────────────────────────────────
PAGE_W, PAGE_H = A4
MARGIN = 2 * cm

def on_page(canvas, doc):
    canvas.saveState()
    # Header bar
    canvas.setFillColor(NAVY)
    canvas.rect(0, PAGE_H - 28, PAGE_W, 28, fill=1, stroke=0)
    canvas.setFillColor(colors.white)
    canvas.setFont("Helvetica-Bold", 8)
    canvas.drawString(MARGIN, PAGE_H - 17, "Lope Laranjo Bato and Co., CPAs — Testing Plan")
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(PAGE_W - MARGIN, PAGE_H - 17, "Cagayan de Oro College | CITEd")
    # Footer
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 7)
    canvas.drawString(MARGIN, 14, "Confidential — For academic use only")
    canvas.drawCentredString(PAGE_W / 2, 14, f"Page {doc.page}")
    canvas.drawRightString(PAGE_W - MARGIN, 14, "AY 2025–2026")
    canvas.restoreState()

# ─── Styles ──────────────────────────────────────────────────────────────────
ss = getSampleStyleSheet()

def S(name, **kw):
    return ParagraphStyle(name, **kw)

sTitle    = S("sTitle",  fontName="Helvetica-Bold", fontSize=17, textColor=NAVY,  spaceAfter=4,  alignment=TA_CENTER)
sSubtitle = S("sSub",    fontName="Helvetica",      fontSize=11, textColor=NAVY,  spaceAfter=2,  alignment=TA_CENTER)
sMeta     = S("sMeta",   fontName="Helvetica",      fontSize=9,  textColor=MUTED, spaceAfter=2,  alignment=TA_CENTER)
sH1       = S("sH1",     fontName="Helvetica-Bold", fontSize=14, textColor=NAVY,  spaceBefore=14, spaceAfter=4)
sH2       = S("sH2",     fontName="Helvetica-Bold", fontSize=12, textColor=BLUE,  spaceBefore=10, spaceAfter=3)
sH3       = S("sH3",     fontName="Helvetica-Bold", fontSize=10, textColor=NAVY,  spaceBefore=7,  spaceAfter=2)
sBody     = S("sBody",   fontName="Helvetica",      fontSize=8.5, textColor=TEXT,  leading=13, spaceAfter=3)
sBold     = S("sBold",   fontName="Helvetica-Bold", fontSize=8.5, textColor=TEXT,  leading=13)
sTH       = S("sTH",     fontName="Helvetica-Bold", fontSize=8,  textColor=TH_TEXT,alignment=TA_CENTER, leading=10)
sTD       = S("sTD",     fontName="Helvetica",      fontSize=7.5, textColor=TEXT,  leading=10)
sTDC      = S("sTDC",    fontName="Helvetica",      fontSize=7.5, textColor=TEXT,  alignment=TA_CENTER, leading=10)
sBullet   = S("sBullet", fontName="Helvetica",      fontSize=8.5, textColor=TEXT,  leading=13, leftIndent=14, spaceAfter=2)
sSep      = S("sSep",    fontName="Helvetica-Oblique", fontSize=8, textColor=MUTED, spaceAfter=2, leading=11)
sNote     = S("sNote",   fontName="Helvetica-Oblique", fontSize=8, textColor=MUTED, spaceAfter=4, alignment=TA_CENTER)

# ─── Table helper ────────────────────────────────────────────────────────────
SHADE_COLS = [
    colors.HexColor("#e8effe"),  # shade 1
    colors.HexColor("#f0f4ff"),  # shade 2 (lighter)
]

def make_table(headers, rows, col_widths=None, center_cols=None):
    center_cols = center_cols or []
    usable = PAGE_W - 2 * MARGIN

    if col_widths is None:
        n = len(headers)
        col_widths = [usable / n] * n

    def cell(text, style):
        text = str(text) if text is not None else ""
        text = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return Paragraph(text, style)

    th_row = [cell(h, sTH) for h in headers]
    data   = [th_row]
    for i, row in enumerate(rows):
        bg = ROW_ALT if i % 2 else colors.white
        td_row = []
        for j, val in enumerate(row):
            st = sTDC if j in center_cols else sTD
            td_row.append(cell(val, st))
        data.append(td_row)

    t = Table(data, colWidths=col_widths, repeatRows=1)
    n_rows = len(data)
    style_cmds = [
        ("BACKGROUND", (0, 0), (-1, 0), TH_BG),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW_ALT]),
        ("GRID", (0, 0), (-1, -1), 0.4, BORDER),
        ("TOPPADDING",    (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING",   (0, 0), (-1, -1), 5),
        ("RIGHTPADDING",  (0, 0), (-1, -1), 5),
        ("VALIGN",        (0, 0), (-1, -1), "TOP"),
        ("FONTSIZE",      (0, 0), (-1, 0),  8),
    ]
    t.setStyle(TableStyle(style_cmds))
    return t

# ─── MD parser ───────────────────────────────────────────────────────────────
def parse_md(text):
    story = []
    lines = text.splitlines()
    i = 0

    def flush_table_block(tlines):
        # Parse markdown table
        rows = []
        for tl in tlines:
            if tl.startswith("|") and re.match(r"^\|[-| :]+\|$", tl.strip()):
                continue
            cells = [c.strip() for c in tl.strip().strip("|").split("|")]
            rows.append(cells)
        if not rows:
            return
        headers = rows[0]
        data    = rows[1:]
        n = len(headers)
        usable = PAGE_W - 2 * MARGIN
        # Distribute widths: ID col narrow, others even
        if n == 1:
            cw = [usable]
        else:
            id_w = 1.4 * cm if n >= 4 else 2 * cm
            rest = (usable - id_w) / (n - 1)
            cw   = [id_w] + [rest] * (n - 1)
        story.append(make_table(headers, data, col_widths=cw, center_cols=[0]))
        story.append(Spacer(1, 6))

    while i < len(lines):
        line = lines[i]

        # Heading 1
        if line.startswith("# ") and not line.startswith("## "):
            text_part = line[2:].strip()
            story.append(Spacer(1, 8))
            story.append(Paragraph(text_part, sTitle))
            story.append(HRFlowable(width="100%", thickness=2, color=RULE_BLUE, spaceAfter=4))
            i += 1; continue

        # Heading 2
        if line.startswith("## "):
            text_part = line[3:].strip()
            story.append(Spacer(1, 6))
            story.append(Paragraph(text_part, sSubtitle))
            i += 1; continue

        # Heading 3
        if line.startswith("### "):
            text_part = line[4:].strip()
            story.append(Spacer(1, 4))
            story.append(Paragraph(text_part, sH2))
            story.append(HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=3))
            i += 1; continue

        # Heading 4
        if line.startswith("#### "):
            text_part = line[5:].strip()
            story.append(Paragraph(text_part, sH3))
            i += 1; continue

        # Bold metadata lines (**key:** value)
        if line.startswith("**") and "**" in line[2:]:
            clean = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", line)
            story.append(Paragraph(clean, sBody))
            i += 1; continue

        # Horizontal rule
        if re.match(r"^-{3,}$", line.strip()):
            story.append(HRFlowable(width="100%", thickness=1, color=BORDER, spaceBefore=6, spaceAfter=6))
            i += 1; continue

        # Blockquote
        if line.startswith("> "):
            story.append(Paragraph(line[2:], sSep))
            i += 1; continue

        # Table block
        if line.startswith("|"):
            tblock = []
            while i < len(lines) and lines[i].startswith("|"):
                tblock.append(lines[i])
                i += 1
            flush_table_block(tblock)
            continue

        # Bullet list
        if re.match(r"^[*\-] ", line):
            story.append(Paragraph("• " + line[2:].strip(), sBullet))
            i += 1; continue

        # Numbered list
        if re.match(r"^\d+\. ", line):
            text_part = re.sub(r"^\d+\. ", "", line)
            story.append(Paragraph(text_part, sBullet))
            i += 1; continue

        # Empty line
        if not line.strip():
            story.append(Spacer(1, 4))
            i += 1; continue

        # Normal text — inline bold
        clean = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", line)
        clean = clean.replace("&", "&amp;").replace("<b>", "\x00b").replace("</b>", "\x00/b")
        clean = clean.replace("<", "&lt;").replace(">", "&gt;")
        clean = clean.replace("\x00b", "<b>").replace("\x00/b", "</b>")
        story.append(Paragraph(clean, sBody))
        i += 1

    return story

# ─── Title page ──────────────────────────────────────────────────────────────
def title_page():
    elems = []
    elems.append(Spacer(1, 3 * cm))
    elems.append(Paragraph("Cagayan de Oro College", sMeta))
    elems.append(Paragraph("College of Information Technology Education", sMeta))
    elems.append(Spacer(1, 0.6 * cm))
    elems.append(HRFlowable(width="70%", thickness=2, color=RULE_BLUE, spaceAfter=10))
    elems.append(Paragraph(
        "REAL TIME WORKFLOW, ACTIVITY LOG, IN PAYROLL MANAGEMENT SYSTEM<br/>WITH INTEGRATED ANALYTICS FOR ACCOUNTING FIRMS",
        sTitle
    ))
    elems.append(HRFlowable(width="70%", thickness=2, color=RULE_BLUE, spaceBefore=10, spaceAfter=16))
    elems.append(Paragraph("<b>TESTING PLAN — LOGIN TO LOGOUT</b>", sSubtitle))
    elems.append(Spacer(1, 0.4 * cm))
    elems.append(Paragraph("Lope Laranjo Bato and Co., CPAs", sSubtitle))
    elems.append(Spacer(1, 1.5 * cm))
    elems.append(Paragraph("<b>Researchers:</b>", sMeta))
    for name in [
        "Jana Vinzy E. Dacula",
        "Jellianne Mariz L. Mulit",
        "Mikie Angelyn A. Romero",
        "Roberth B. Namoc",
        "Shiela Mae B. Pacala",
    ]:
        elems.append(Paragraph(name, sMeta))
    elems.append(Spacer(1, 1.5 * cm))
    elems.append(Paragraph("Document Version: Final", sMeta))
    elems.append(Paragraph("Testing Period: Academic Year 2025–2026", sMeta))
    elems.append(PageBreak())
    return elems

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    md_text = MD_PATH.read_text(encoding="utf-8")

    doc = SimpleDocTemplate(
        str(OUT_PATH),
        pagesize=A4,
        leftMargin=MARGIN,
        rightMargin=MARGIN,
        topMargin=MARGIN + 0.8 * cm,
        bottomMargin=MARGIN,
        title="Testing Plan — Lope Laranjo Bato and Co., CPAs",
        author="CITEd Research Team",
    )

    story = title_page()
    story += parse_md(md_text)

    doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print(f"PDF written to: {OUT_PATH}")

if __name__ == "__main__":
    main()
