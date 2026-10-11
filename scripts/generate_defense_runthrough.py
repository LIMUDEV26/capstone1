#!/usr/bin/env python3
"""Generate the 45-minute defense presentation run-through DOCX.

Run:  python scripts/generate_defense_runthrough.py
Out:  Defense_45min_Presentation_Runthrough.docx (repo root)
Live URL verified: https://llb-accountant.vercel.app (HTTP 200, 2026-10-07)
"""

import os
from datetime import date

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Pt

from generate_defense_qa import (  # reuse cover helpers/styles
    CLIENT,
    GRAY,
    NAVY,
    RESEARCHERS,
    SCHOOL,
    SYSTEM_TITLE,
    add_doc_control,
    add_table,
    add_toc,
    set_style,
)

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "Defense_45min_Presentation_Runthrough.docx")

LIVE_URL = "https://llb-accountant.vercel.app"


def add_cover(doc):
    for _ in range(4):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("45-MINUTE DEFENSE PRESENTATION\nRUN-THROUGH SCRIPT")
    r.bold = True
    r.font.size = Pt(24)
    r.font.color.rgb = NAVY
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(SYSTEM_TITLE)
    r.bold = True
    r.font.size = Pt(14)
    doc.add_paragraph()
    for line, bold in ((f"Client: {CLIENT}", True), (SCHOOL, False)):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(line)
        r.font.size = Pt(12)
        r.bold = bold
    doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("RESEARCHERS\n" + "\n".join(RESEARCHERS))
    r.font.size = Pt(12)
    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(
        f"Timed demo script with DO / SAY / SHOW / WATCH for every segment — "
        f"{date.today().strftime('%B %d, %Y')}"
    )
    r.font.size = Pt(11)
    r.font.color.rgb = GRAY
    doc.add_page_break()


def add_multiline(cell, text, bold=False, size=10):
    """Write text into a cell, converting newlines into real line breaks."""
    cell.text = ""
    para = cell.paragraphs[0]
    lines = text.split("\n")
    for i, line in enumerate(lines):
        run = para.add_run(line)
        run.bold = bold
        run.font.size = Pt(size)
        if i < len(lines) - 1:
            run.add_break()


def add_segment(doc, seg):
    doc.add_heading(
        f"Segment {seg['n']} | {seg['time']} — {seg['title']} ({seg['dur']} min)",
        level=2,
    )
    t = doc.add_table(rows=0, cols=2)
    t.style = "Table Grid"
    for label, content in (
        ("DO", seg["do"]),
        ("SAY", seg["say"]),
        ("SHOW", seg["show"]),
        ("WATCH", seg["watch"]),
    ):
        cells = t.add_row().cells
        add_multiline(cells[0], label, bold=True)
        add_multiline(cells[1], content)
    doc.add_paragraph()


# --------------------------------------------------------------------------- #
# the timeline (minutes sum to 45)
# --------------------------------------------------------------------------- #
SEGMENTS = [
    {
        "n": 1, "time": "00:00 – 03:00", "dur": 3,
        "title": "Opening — Title, Team, Objectives",
        "do": "1. Display title slide (system name, client, researchers).\n"
              "2. Advance to objectives slide. Keep this segment standing tall — no laptop touch.",
        "say": "\"Good morning/afternoon. We are the proponents of the Real-Time Workflow, "
               "Activity Log, and Payroll Management System with Integrated Analytics for "
               f"Accounting Firms, developed for {CLIENT}. Our five objectives: real-time "
               "workflow, an immutable activity log, accurate payroll, integrated analytics, "
               "and role-based security. In the next 45 minutes we will demonstrate the "
               "deployed system live, end to end, then present our testing and security "
               "evidence. We are ready for your questions afterward.\"",
        "show": "Title slide with the five researcher names and the client name.",
        "watch": "Do not read the names slide word-for-word. 3-minute hard stop — "
                 "the demo is the priority.",
    },
    {
        "n": 2, "time": "03:00 – 07:00", "dur": 4,
        "title": "Problem, Scope, and Architecture",
        "do": "1. Show problem/scope slide (manual tracking vs. system).\n"
              "2. Show architecture diagram: frontend → /api proxy → PHP endpoints → MySQL.\n"
              "3. Point to the live URL on the slide: " + LIVE_URL,
        "say": "\"The firm tracked tasks, approvals, and payroll across spreadsheets and "
               "chat with no audit trail. Our system replaces that with three tiers: a "
               "Next.js and React frontend deployed as a static export on Vercel, 55 PHP "
               "8.2 endpoints on Apache, and a 35-table MySQL/InnoDB database. The browser "
               "talks to the API through a serverless proxy that forwards every request to "
               "the hardened PHP backend — the PHP API is the single source of "
               "authentication and authorization. Note the scope boundary: we produce "
               "reference reports only; no direct government submission.\"",
        "show": "Architecture slide + the URL in the browser address bar (padlock = HTTPS).",
        "watch": "If asked 'why PHP and Next.js together' — answer: the client runs XAMPP, "
                 "the frontend is deployable to the cloud; the proxy keeps one origin so "
                 "sessions and CORS stay simple.",
    },
    {
        "n": 3, "time": "07:00 – 12:00", "dur": 5,
        "title": "Login and Security Walkthrough (LIVE)",
        "do": "1. Open a fresh Incognito/Private window → " + LIVE_URL + "\n"
              "2. Type a malformed email → show inline error + domain allowlist.\n"
              "3. Wrong password once → show attempt counter decrease.\n"
              "4. Show masked password + eye toggle. Solve the math captcha.\n"
              "5. Log in as ADMIN → land on Admin Dashboard.\n"
              "6. (Optional, disposable test account only) show lockout toast — never lock "
              "the main demo admin.",
        "say": "\"Everything starts with layered authentication: email format and domain "
               "validation, masked passwords, attempt counting that locks the account on "
               "the fourth failure, intruder browser blocking on the tenth, a toggleable "
               "math captcha, and on successful login the session ID is regenerated to "
               "prevent session fixation. First-login accounts are forced to reset their "
               "password before the dashboard is reachable. Watch — wrong password: the "
               "counter decremented. Correct credentials with captcha: we are in, and each "
               "role lands on its own dashboard.\"",
        "show": "Inline validation, attempt counter, captcha, role-based redirect to the "
                "Admin Dashboard.",
        "watch": "Warm the site 10 minutes before (first cold load can take ~10-20 s). "
                 "Have credentials ready in a password manager — never fumble typing "
                 "on screen. Do NOT trigger real lockout on the demo admin.",
    },
    {
        "n": 4, "time": "12:00 – 16:00", "dur": 4,
        "title": "Dashboard + Real-Time Activity Log (LIVE, 2 windows)",
        "do": "1. Admin window: open Dashboard → Activity Log panel.\n"
              "2. Second browser profile: log in as STAFF.\n"
              "3. Staff performs any action (e.g., submit a leave request).\n"
              "4. Back in Admin window — do NOT refresh — point at the new log row.\n"
              "5. Show filter by user and date; show rows have no edit/delete buttons.",
        "say": "\"This is the real-time activity log — the audit backbone. The second "
               "session just submitted a request; watch this panel: the new entry appears "
               "without any page refresh, newest first, filtered by user and date. The "
               "entries are immutable — there is no edit or delete control on any row — "
               "and because logs are centralized, an action at one branch is visible to "
               "an admin at another branch live. Every module writes here: task creation, "
               "approvals, payroll runs, settings changes, deletions.\"",
        "show": "Live row appearing without refresh; immutable rows; filter behavior. "
                "Referenced by tests 1.8, 3.1, 3.2, 3.3, 3.4.",
        "watch": "Two accounts ONLY — the system enforces single-session per account, so "
                 "never log the same account in twice. Second window must use a separate "
                 "browser profile. If the row is slow, count '3…2…1' — sync interval is "
                 "a few seconds; do not frantically refresh.",
    },
    {
        "n": 5, "time": "16:00 – 20:00", "dur": 4,
        "title": "Master Data — Branches, Employees, Users, Role Access",
        "do": "1. Open Employees list → show search/pagination → open Add Employee form "
              "(do not save junk data).\n"
              "2. Open Branches → show multi-branch records.\n"
              "3. Open Users → show role assignment (admin/manager/staff).\n"
              "4. Settings → Role Access Control → toggle a Staff feature off, save, show "
              "sidebar item disappear (toggle back after).",
        "say": "\"Master data is the firm's backbone: branches, employees, and user "
               "accounts with three roles. Role access control works in two layers — the "
               "frontend hides navigation per role, and the server independently enforces "
               "it on 43 endpoints, so hiding a menu is never the security boundary. "
               "Direct URL access by the wrong role returns 403 — verified by system test "
               "1.4. The two catalogs — 19 features frontend, same 19 backend — are "
               "asserted equal to prevent drift.\"",
        "show": "Employee pagination, role assignment UI, live sidebar toggle effect.",
        "watch": "Toggle back the feature after the demo so later segments show full "
                 "navigation. Mention the 403-drift bug only if asked — it is a strong "
                 "'we test at endpoint level' story.",
    },
    {
        "n": 6, "time": "20:00 – 24:00", "dur": 4,
        "title": "Clients, Projects, Services, Contracts",
        "do": "1. Open a client detail → show assigned services + secondary contact.\n"
              "2. Start Project → show date validation (set end < start → error).\n"
              "3. Open Calendar → green dot start date / red dot end date.\n"
              "4. Contracts → open a contract → show uploaded signed PDF preview + Print.\n"
              "5. Show 'Create Project' from an active contract (pre-filled form).",
        "say": "\"The client module models how an accounting firm actually works: a client "
               "engages services, a contract is signed and uploaded, and the contract "
               "spawns a linked project. Validation is enforced — an end date before the "
               "start date is rejected — and the calendar visualizes project spans with "
               "green and red dots. Contracts hold the signed PDF with preview and print. "
               "Thirteen unit tests cover this series.\"",
        "show": "Client services linkage, date validation error, calendar dots, contract "
                "PDF preview (Level 1 Series 500).",
        "watch": "Do not actually create junk records — use existing demo data; create "
                 "only if a clean test client is already prepared.",
    },
    {
        "n": 7, "time": "24:00 – 28:00", "dur": 4,
        "title": "Tasks — Kanban Workflow and My Tasks",
        "do": "1. Open Tasks board → point out Backlog / In Progress / Review / Done.\n"
              "2. Drag one card across a column → status updates.\n"
              "3. Open a task detail → priority colors, overdue date in red, collaborator, "
              "checklist, comment thread.\n"
              "4. Submit a workflow step with a file → timestamp recorded.\n"
              "5. Show My Tasks view for staff.",
        "say": "\"Work flows through a four-column Kanban: Backlog, In Progress, Review, "
               "Done — dragging a card changes its status. Cards carry priority colors and "
               "overdue dates in red. Task detail holds collaborators with shift ranges, "
               "checklists, threaded comments, file uploads, and workflow-step submissions "
               "each stamped with a timestamp — so 'who submitted what, when' is never "
               "argued about again. Staff see exactly their assigned and collaborated "
               "tasks on My Tasks.\"",
        "show": "Drag-and-drop status change, timestamped workflow submission, "
                "My Tasks filtering (Level 1 Series 600, 15 cases).",
        "watch": "Drag with a mouse — trackpads can be flaky on stage. Pre-open one task "
                 "detail with an existing file so upload rendering is instant.",
    },
    {
        "n": 8, "time": "28:00 – 32:00", "dur": 4,
        "title": "HR Requests → Manager Approval Inbox → Notification (LIVE chain)",
        "do": "1. STAFF window: submit a leave request (show validation).\n"
              "2. MANAGER window: open Approval Inbox → count cards → approve it.\n"
              "3. STAFF window: notification bell shows the update.\n"
              "4. Inbox: show type filters; mention overtime + cash advance behave the "
              "same; show 'Mark as Deducted' on a cash advance.",
        "say": "\"One approval pipeline for leave, overtime, and cash advances: staff "
               "submit, the manager's Approval Inbox aggregates everything with count "
               "cards and filters, approval or rejection with a reason is recorded, the "
               "requester gets an in-app notification, and the whole chain writes to the "
               "activity log. Approved cash advances can be marked as deducted, which "
               "flows directly into payroll deductions. Sixteen unit tests plus the "
               "integration chain cover this.\"",
        "show": "Pending → Approved status change, notification delivery, log entry — "
                "referenced by integration tests 1.6 and 1.7.",
        "watch": "Have all three accounts ready in three pre-opened profiles: Admin, "
                 "Manager, Staff. Switch profiles, never re-login the same account. If "
                 "notification lags 2-3 s, narrate rather than panic.",
    },
    {
        "n": 9, "time": "32:00 – 37:00", "dur": 5,
        "title": "Payroll — Import → Run → Pre-check → Payslip (CORE DEMO)",
        "do": "1. Attendance → Import XLS using test-data/payroll-attendance-sample.xlsx → confirm the preview.\n"
              "2. Select the pay period → Run Payroll → show spinner/disabled button.\n"
              "3. Point at computed columns: gross, deductions, net + summary.\n"
              "4. MANAGER: open payroll pre-check screen.\n"
              "5. STAFF: My Payslips → open a payslip.\n"
              "6. Open Activity Log → payroll run entry exists.",
        "say": "\"Payroll — the heart of the system. We import the firm's biometric "
               "attendance from XLS, confirm the preview, select the period, and run. "
               "Gross pay, deductions, and net pay are computed from approved requests "
               "and deduction types, the manager pre-checks before finalization, and "
               "payslips appear under My Payslips. Accuracy is not claimed — it is "
               "tested: system test 4.1 is a mathematical audit comparing system totals "
               "against manual computation on known data, and it matched. Every run is "
               "archived and logged.\"",
        "show": "Import → computed payroll summary → pre-check → payslip → log entry "
                "(integration tests 1.3 and 1.4; system tests 2.6 and 4.1).",
        "watch": "Use the prepared sample file — do not browse for it live. If import "
                 "renders slow, switch to a pre-imported batch. This is the segment panels "
                 "watch hardest — slow is fine, wrong math is not (there is none).",
    },
    {
        "n": 10, "time": "37:00 – 40:00", "dur": 3,
        "title": "Analytics and Reports + Export",
        "do": "1. Analytics → point at summary cards, doughnut, trend chart.\n"
              "2. Switch Week / Month / Year → charts update without reload.\n"
              "3. Reports → pick a report type → Generate → preview with charts + table.\n"
              "4. Export to PDF → open the downloaded file on screen.",
        "say": "\"Integrated analytics means one source of truth: the dashboard reads the "
               "same data as payroll and workflow — integration test 1.5 proved dashboard "
               "totals equal the generated report for the same period. Period filters "
               "update charts without a page reload, and reports export to PDF, Excel, and "
               "CSV — verified uncorrupted by system tests 4.3 and 4.4.\"",
        "show": "Live chart filter transition + opened PDF file.",
        "watch": "Open the PDF immediately — a blank download kills momentum. Have a "
                 "previously exported PDF in Downloads as backup.",
    },
    {
        "n": 11, "time": "40:00 – 42:00", "dur": 2,
        "title": "Settings — The Security Suite",
        "do": "1. Rapid tab tour (say the names, click two): Password Policy, Session "
              "Timeout, Math Captcha toggle, Account Lockout (unlock action), Rate "
              "Limiting, Role Access Control, Logs Management, System Backup.\n"
              "2. Change one harmless setting (e.g., timeout minutes) → save → show toast.",
        "say": "\"The system is configured, not hardcoded: password policy, session "
               "timeout, captcha on/off, account lockout thresholds, rate limiting, role "
               "access, backups — all manageable by the admin, every change saved, "
               "applied immediately, and written to the activity log. This suite is why "
               "security is a feature of the system, not an afterthought.\"",
        "show": "Settings list breadth; one live save with logged change (system test 5.2).",
        "watch": "2-minute hard stop. Do not demonstrate lockout thresholds on live "
                 "accounts here — Segment 3 covered it.",
    },
    {
        "n": 12, "time": "42:00 – 44:00", "dur": 2,
        "title": "Testing and Security Evidence (SLIDES)",
        "do": "1. Evidence slide: 180 test cases (144 unit / 9 integration / 27 system), "
              "100% expected results.\n"
              "2. Security slide: 126-check smoke harness, 112 → 126 pass, ZERO "
              "regressions; 22 graded findings (8 Critical / 9 High / 5 Medium).\n"
              "3. UAT slide: ISO/IEC 25010, 17 indicators, 4 respondents, signed "
              "acceptance.",
        "say": "\"Our evidence: 180 executed test cases across four levels with actual "
               "results matching expected in every case; a 126-check automated security "
               "harness run before and after every hardening change — improving 112 to "
               "126 passing with zero regressions; a live-probe security audit producing "
               "22 graded findings; and ISO 25010-aligned UAT from four client "
               "respondents with formal sign-off. We also found and fixed a production-"
               "critical bug through endpoint testing — the manager Approval Inbox was "
               "returning 403 due to a feature-catalog drift; 403 to 200 verified.\"",
        "show": "Evidence numbers slide (matches Appendix B of the Q&A document).",
        "watch": "Numbers must match the Q&A document exactly. If asked about remaining "
                 "failures: all 15 are documented Phase 0 file-exposure items with a "
                 "remediation plan.",
    },
    {
        "n": 13, "time": "44:00 – 45:00", "dur": 1,
        "title": "Closing and Hand-off to Q&A",
        "do": "1. Closing slide: future work (CSRF Phase 2, HTTPS Phase 7, least-privilege "
              "DB) + thank you.\n"
              "2. Leave the live system on screen behind the slide — it invites questions.",
        "say": "\"We know precisely what remains — CSRF and HTTPS phases are documented, "
               "scheduled, and owned. We delivered the objectives, validated them at four "
               "testing levels, audited our own security, and the client signed "
               "acceptance. Thank you — we are ready for your questions.\"",
        "show": "Thank-you slide; live dashboard visible on the second screen.",
        "watch": "Stop talking at 45:00 exactly. Q&A companion: "
                 "Defense_Ready_QA_Documentation.docx (112 anticipated questions).",
    },
]


# --------------------------------------------------------------------------- #
# front matter and checklists
# --------------------------------------------------------------------------- #
def add_url_notice(doc):
    doc.add_heading("0. Deployment URL — Verified", level=1)
    p = doc.add_paragraph()
    r = p.add_run("CORRECT URL: ")
    r.bold = True
    r = p.add_run(LIVE_URL)
    r.bold = True
    doc.add_paragraph(
        "Verified HTTP 200 on October 7, 2026 — page title 'Lope Laranjo Bato & Co., "
        "CPAs', login page live at /, /dashboard correctly redirects (307) when "
        "unauthenticated, and the PHP API answers correctly (session_status returns "
        "'Not authenticated', unauthenticated endpoints refuse with 401)."
    )
    p = doc.add_paragraph()
    r = p.add_run("WARNING: ")
    r.bold = True
    p.add_run(
        "'llb-account.vercel.app' (without 'ant') returns DEPLOYMENT_NOT_FOUND (404). "
        "The Vercel project is named 'llb-accountant' — always use "
        f"{LIVE_URL}. Test the link on your presentation slide the day before."
    )


def add_timeline(doc):
    doc.add_heading("1. The 45-Minute Timeline at a Glance", level=1)
    doc.add_paragraph(
        "Total: 45 minutes — 22 minutes of live demonstration, 23 minutes of framing, "
        "evidence, and close. Each segment is a hard block: if one runs long, trim the "
        "next — never the payroll segment (Segment 9)."
    )
    rows = [
        (f"{s['time']}", f"Segment {s['n']} — {s['title']}", f"{s['dur']} min")
        for s in SEGMENTS
    ]
    rows.append(("TOTAL", "", f"{sum(s['dur'] for s in SEGMENTS)} min"))
    add_table(doc, ["Time", "Segment", "Duration"], rows)


def add_setup(doc):
    doc.add_heading("2. Browser and Account Setup (Do This Before You Present)", level=1)
    doc.add_paragraph(
        "The system enforces single-session per account — logging the same account in "
        "twice supersedes the first session. Use ONE browser profile per role, "
        "pre-opened and logged in:"
    )
    add_table(
        doc,
        ["Profile", "Role", "Pre-opened screens", "Used in segments"],
        [
            ("Profile A — Chrome normal", "ADMIN",
             "Dashboard + Activity Log, Employees, Clients, Tasks, Settings",
             "3, 4, 5, 6, 7, 10, 11"),
            ("Profile B — Chrome 'Person 2'", "MANAGER",
             "Approval Inbox, Payroll Pre-check", "8, 9"),
            ("Profile C — Edge or Firefox", "STAFF",
             "My Tasks, Leave Request form, My Payslips", "4, 8, 9"),
            ("Profile D — Incognito", "(none)",
             "Fresh login demo — closed and reopened at Segment 3", "3"),
        ],
    )
    doc.add_paragraph(
        "Demo data: test-data/payroll-attendance-sample.xlsx (and "
        "three-role-payroll-upload.xlsx) staged in Downloads for the payroll import. "
        "Demo credentials — fill in before printing: "
        "Admin ______ / Manager ______ / Staff ______."
    )


def add_preflight(doc):
    doc.add_heading("3. Pre-Flight Checklist", level=1)
    doc.add_heading("3.1 T-24 hours", level=2)
    for line in (
        f"Open {LIVE_URL} — confirm HTTP 200 and the login page renders (if 404, the "
        "deployment was removed: redeploy with `vercel --prod` from the repo root).",
        "Confirm the PHP backend is reachable: visit "
        "/api/auth.php?action=session_status — must return JSON 'Not authenticated', "
        "not a 502.",
        "Walk the full 45-minute script once against the live site, timing each segment.",
        "Verify every slide link uses https://llb-accountant.vercel.app (the full name).",
        "Stage payroll sample files in Downloads; confirm import works end to end.",
        "Save Defense_Ready_QA_Documentation.docx for the Q&A segment.",
        "Confirm the UAT sign-off sheet scan/photo is ready to show if requested.",
    ):
        doc.add_paragraph(line, style="List Bullet")
    doc.add_heading("3.2 T-30 minutes", level=2)
    for line in (
        "Load the site once in each of the 4 profiles — first hit warms the deployment.",
        "Log in once per role, then close — sessions stay fresh for the demo.",
        "Clear old files out of Downloads so the payroll PDF export is obvious.",
        "Phone hotspot ready as backup internet; projector at native resolution with "
        "browser zoom 110-125% so table rows are readable from the back.",
        "Disable desktop notifications (OS + browser) — popups on screen are distracting.",
        "Start a visible timer or agree hand signals at 30/40/45 minutes.",
    ):
        doc.add_paragraph(line, style="List Bullet")


def add_contingency(doc):
    doc.add_heading("4. Contingency Plan — If Something Breaks", level=1)
    add_table(
        doc,
        ["Failure", "Immediate action", "What to say"],
        [
            ("Vercel URL down / 404",
             "Switch to the local XAMPP build (http://localhost/capstone1/) kept open "
             "in another window; or show screenshots from docs/UI_GUIDE_SCREENSHOTS.md.",
             "\"The cloud deployment is momentarily unavailable; here is the identical "
             "system running locally — same codebase.\""),
            ("Backend 502 / API unreachable",
             "Check /api/auth.php?action=session_status; restart the backend host "
             "(XAMPP Apache + MySQL or tunnel). Fall back to screenshots.",
             "\"Our serverless proxy cannot reach the PHP backend right now; the "
             "architecture is unchanged — may I walk through our tested evidence "
             "screenshots meanwhile?\""),
            ("Import or payroll run slow",
             "Narrate the loading state — spinner + disabled button is a tested feature "
             "(system test 5.1); switch to a pre-computed batch.",
             "\"Processing states are deliberately visible — the button locks so a "
             "double-run is impossible.\""),
            ("A 403 Access Denied appears",
             "Keep it on screen — this is the role boundary working; it is a feature, "
             "not a failure.",
             "\"Notice the 403 — the server itself refused a role violation, verified "
             "by system test 1.4.\""),
            ("Notification lag in the live chain",
             "Wait 3-5 seconds (background sync interval); do not refresh frantically.",
             "\"In-app notifications arrive on the next sync tick — typically under "
             "five seconds.\""),
            ("Running behind schedule",
             "Cut Segment 11 to 30 seconds and compress Segment 6 to a 60-second sweep. "
             "NEVER cut Segment 9 (payroll).",
             "Silently skip — do not announce the cut."),
        ],
    )


def add_transition(doc):
    doc.add_heading("5. Hand-off Lines Into Q&A", level=1)
    doc.add_paragraph(
        "Close the demo with one of these, then open Defense_Ready_QA_Documentation.docx "
        "(112 questions, 13 sections) and use its answer structure: direct answer -> "
        "evidence -> honest boundary."
    )
    for line in (
        "\"That concludes our demonstration — we are happy to take your questions.\"",
        "\"We can repeat any segment, or go deeper on testing, security, or the database.\"",
        "\"If it pleases the panel, we can show the activity-log immutability and the "
        "403 role-boundary test again live.\"",
    ):
        doc.add_paragraph(line, style="List Bullet")


# --------------------------------------------------------------------------- #
def render():
    doc = Document()
    set_style(doc)
    add_cover(doc)
    add_doc_control(doc)
    add_toc(doc)
    doc.add_page_break()
    add_url_notice(doc)
    add_timeline(doc)
    add_setup(doc)

    doc.add_heading("6. Segment-by-Segment Script (DO / SAY / SHOW / WATCH)", level=1)
    doc.add_paragraph(
        "DO = what you click. SAY = words to speak (timed for the block). SHOW = evidence "
        "or test IDs to point at. WATCH = pitfalls and fallbacks."
    )
    for seg in SEGMENTS:
        add_segment(doc, seg)

    add_preflight(doc)
    add_contingency(doc)
    add_transition(doc)
    doc.save(OUT)
    return sum(s["dur"] for s in SEGMENTS)


if __name__ == "__main__":
    total = render()
    print(f"Wrote {OUT} ({total} minutes, {len(SEGMENTS)} segments)")