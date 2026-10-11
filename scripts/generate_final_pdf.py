"""
Generate TESTINGPLANLLB_FINAL.pdf from docs/TESTING_PLAN_FINAL.md
Uses ReportLab to produce a clean A4 PDF with tables.
"""
import re
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, PageBreak, KeepTogether
)
from reportlab.lib.enums import TA_LEFT, TA_CENTER, TA_JUSTIFY

# ── paths ──────────────────────────────────────────────────────────────────
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MD_PATH  = os.path.join(BASE_DIR, "docs", "TESTING_PLAN_FINAL.md")
OUT_PATH = os.path.join(os.path.expanduser("~"), "Downloads", "TESTINGPLANLLB_FINAL.pdf")

# ── colours ────────────────────────────────────────────────────────────────
NAVY   = colors.HexColor("#1e3a8a")
GOLD   = colors.HexColor("#c99a4d")
LIGHT  = colors.HexColor("#f1f5f9")
WHITE  = colors.white
BLACK  = colors.HexColor("#1f2328")
MUTED  = colors.HexColor("#475569")
PASS_GREEN = colors.HexColor("#d1fae5")
PASS_TXT   = colors.HexColor("#065f46")

# ── document ───────────────────────────────────────────────────────────────
doc = SimpleDocTemplate(
    OUT_PATH,
    pagesize=A4,
    leftMargin=14*mm, rightMargin=14*mm,
    topMargin=16*mm, bottomMargin=16*mm,
)
W = A4[0] - 28*mm   # usable width

styles = getSampleStyleSheet()

def S(name, **kw):
    return ParagraphStyle(name, parent=styles["Normal"], **kw)

sTitle  = S("title",  fontSize=14, textColor=NAVY, alignment=TA_CENTER, spaceAfter=2,  fontName="Helvetica-Bold")
sSub    = S("sub",    fontSize=10, textColor=MUTED, alignment=TA_CENTER, spaceAfter=2)
sH2     = S("h2",     fontSize=11, textColor=NAVY, fontName="Helvetica-Bold", spaceBefore=14, spaceAfter=4)
sH3     = S("h3",     fontSize=9.5, textColor=BLACK, fontName="Helvetica-Bold", spaceBefore=8, spaceAfter=3)
sBody   = S("body",   fontSize=8.5, textColor=BLACK, spaceAfter=2, leading=12)
sNote   = S("note",   fontSize=8, textColor=MUTED, spaceAfter=2, leading=11, leftIndent=6)
sCell   = S("cell",   fontSize=7.2, textColor=BLACK, leading=10, wordWrap="CJK")
sCellH  = S("cellH",  fontSize=7.2, textColor=WHITE, fontName="Helvetica-Bold", leading=10)
sCellP  = S("cellP",  fontSize=7.2, textColor=PASS_TXT, leading=10, wordWrap="CJK")

def para(txt, style=sCell):
    return Paragraph(str(txt).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"), style)

# ── table builder ──────────────────────────────────────────────────────────
def build_table(headers, rows, col_widths):
    """Build a styled ReportLab Table from headers + rows."""
    header_row = [para(h, sCellH) for h in headers]
    data = [header_row]
    for row in rows:
        formatted = []
        for i, cell in enumerate(row):
            cell_str = str(cell)
            if i == len(row)-1 and cell_str.lower().startswith("passed"):
                formatted.append(para(cell_str, sCellP))
            else:
                formatted.append(para(cell_str, sCell))
        data.append(formatted)

    tbl = Table(data, colWidths=col_widths, repeatRows=1)

    ts = TableStyle([
        # header
        ("BACKGROUND",  (0,0), (-1,0),  NAVY),
        ("TEXTCOLOR",   (0,0), (-1,0),  WHITE),
        ("FONTNAME",    (0,0), (-1,0),  "Helvetica-Bold"),
        ("FONTSIZE",    (0,0), (-1,0),  7.2),
        ("BOTTOMPADDING",(0,0),(-1,0),  4),
        ("TOPPADDING",  (0,0), (-1,0),  4),
        # body
        ("FONTSIZE",    (0,1), (-1,-1), 7.2),
        ("TOPPADDING",  (0,1), (-1,-1), 3),
        ("BOTTOMPADDING",(0,1),(-1,-1), 3),
        ("LEFTPADDING", (0,0), (-1,-1), 4),
        ("RIGHTPADDING",(0,0), (-1,-1), 4),
        ("VALIGN",      (0,0), (-1,-1), "TOP"),
        ("GRID",        (0,0), (-1,-1), 0.4, colors.HexColor("#cbd5e1")),
        ("ROWBACKGROUNDS",(0,1),(-1,-1),[WHITE, LIGHT]),
    ])
    # highlight "Passed" cells in last column
    for r_idx, row in enumerate(rows, start=1):
        last = str(row[-1])
        if last.lower().startswith("passed"):
            tbl_row = r_idx
            tbl.setStyle(TableStyle([("BACKGROUND", (-1, tbl_row), (-1, tbl_row), PASS_GREEN)]))
    tbl.setStyle(ts)
    return tbl

# ── parse markdown ─────────────────────────────────────────────────────────
def parse_md_table(lines):
    """Return (headers, rows) from markdown table lines."""
    headers, rows = [], []
    for line in lines:
        line = line.strip()
        if not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if all(re.match(r"^-+$", c) for c in cells):
            continue
        if not headers:
            headers = cells
        else:
            rows.append(cells)
    return headers, rows

# ── column-width presets ───────────────────────────────────────────────────
def col_widths_for(n_cols, hint="unit"):
    w = W
    if hint == "unit" and n_cols == 6:
        # Unit ID | Target | Scenario | Expected | Actual | Remarks
        return [12*mm, 28*mm, 52*mm, 42*mm, 48*mm, 36*mm]
    if hint == "system" and n_cols == 7:
        # SysID | Module | Steps | Inputs | Expected | Actual | Remarks
        return [12*mm, 22*mm, 42*mm, 22*mm, 38*mm, 42*mm, 30*mm]
    if hint == "integ" and n_cols == 6:
        return [12*mm, 28*mm, 50*mm, 44*mm, 48*mm, 36*mm]
    if hint == "uat_part1" and n_cols == 5:
        return [18*mm, 36*mm, 60*mm, 36*mm, 28*mm]
    if hint == "uat_survey" and n_cols == 7:
        return [10*mm, W - 10*mm - 5*18*mm] + [18*mm]*5
    # fallback: equal
    return [w / n_cols] * n_cols

# ── main parse + build ─────────────────────────────────────────────────────
with open(MD_PATH, "r", encoding="utf-8") as f:
    md_lines = f.readlines()

story = []

# Title block
story.append(Paragraph("REAL TIME WORKFLOW, ACTIVITY LOG, IN PAYROLL MANAGEMENT SYSTEM<br/>WITH INTEGRATED ANALYTICS FOR ACCOUNTING FIRMS", sTitle))
story.append(Paragraph("Cagayan de Oro College | College of Information Technology Education", sSub))
story.append(Spacer(1, 3*mm))
story.append(Paragraph("Researchers: Jana Vinzy E. Dacula · Jellianne Mariz L. Mulit · Mikie Angelyn A. Romero · Roberth B. Namoc · Shiela Mae B. Pacala", sSub))
story.append(Spacer(1, 4*mm))

# State machine
i = 0
in_table = False
table_lines = []
current_level = ""
current_series = ""
current_hint = "unit"

level1_started = False

def flush_table(story, table_lines, hint):
    if not table_lines:
        return
    headers, rows = parse_md_table(table_lines)
    if not headers or not rows:
        return
    cw = col_widths_for(len(headers), hint)
    # pad rows to header length
    for r in rows:
        while len(r) < len(headers):
            r.append("")
        while len(r) > len(headers):
            r.pop()
    tbl = build_table(headers, rows, cw)
    story.append(tbl)
    story.append(Spacer(1, 3*mm))

while i < len(md_lines):
    raw = md_lines[i].rstrip("\n")
    stripped = raw.strip()

    # detect table start / continuation
    if stripped.startswith("|"):
        table_lines.append(stripped)
        i += 1
        continue
    else:
        if table_lines:
            flush_table(story, table_lines, current_hint)
            table_lines = []

    # headings
    if stripped.startswith("## LEVEL"):
        m = re.match(r"## (LEVEL \d+.*)", stripped)
        if m:
            current_level = m.group(1)
            story.append(PageBreak())
            story.append(Paragraph(current_level, sH2))
            # underline effect via gold rule
        i += 1
        continue

    if stripped.startswith("### Series") or stripped.startswith("### PART") or stripped.startswith("### Part"):
        story.append(Paragraph(stripped.lstrip("#").strip(), sH3))
        # detect hint for upcoming table
        sl = stripped.lower()
        if "series 1" in sl or "series 2" in sl or "series 3" in sl or "series 4" in sl or "series 5" in sl or "series 6" in sl or "series 7" in sl or "series 8" in sl or "series 9" in sl:
            if "level 3" in current_level.lower() or "system" in current_level.lower():
                current_hint = "system"
            elif "level 2" in current_level.lower() or "integration" in current_level.lower():
                current_hint = "integ"
            else:
                current_hint = "unit"
        elif "part 1" in sl or "participant" in sl:
            current_hint = "uat_part1"
        elif "part 2" in sl or "survey" in sl or "iso" in sl:
            current_hint = "uat_survey"
        i += 1
        continue

    # bold lines (section labels like **1. Functional...**)
    if stripped.startswith("**") and stripped.endswith("**"):
        label = stripped.strip("*")
        sBoldLabel = ParagraphStyle("bold_label2", parent=styles["Normal"],
                                    fontSize=9.5, fontName="Helvetica-Bold",
                                    textColor=NAVY, spaceBefore=6, spaceAfter=2)
        story.append(Paragraph(label, sBoldLabel))
        i += 1
        continue

    # horizontal rule
    if stripped == "---":
        i += 1
        continue

    # blank line
    if stripped == "":
        i += 1
        continue

    # description paragraph (italic-ish lines under series headings)
    if not stripped.startswith("#") and not stripped.startswith("|"):
        story.append(Paragraph(stripped, sNote))
        i += 1
        continue

    i += 1

# flush any trailing table
if table_lines:
    flush_table(story, table_lines, current_hint)

# ── page numbering ─────────────────────────────────────────────────────────
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 7)
    canvas.setFillColor(MUTED)
    canvas.drawCentredString(A4[0]/2, 10*mm, f"Page {doc.page}")
    canvas.setStrokeColor(GOLD)
    canvas.setLineWidth(0.5)
    canvas.line(14*mm, 13*mm, A4[0]-14*mm, 13*mm)
    canvas.restoreState()

doc.build(story, onFirstPage=on_page, onLaterPages=on_page)
print(f"PDF written to: {OUT_PATH}")
