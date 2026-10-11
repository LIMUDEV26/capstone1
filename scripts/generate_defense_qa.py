#!/usr/bin/env python3
"""Generate the Defense-Ready Q&A DOCX for the capstone1 system.

Run:  python scripts/generate_defense_qa.py
Out:  Defense_Ready_QA_Documentation.docx (repo root)
All facts are grounded in docs/TESTING_PLAN_FINAL.md, docs/SECURITY_HARDENING.md,
database/Capstone1.sql and the api/ endpoint inventory.
"""

import os
from datetime import date

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, "Defense_Ready_QA_Documentation.docx")

NAVY = RGBColor(0x1F, 0x3A, 0x5F)
GRAY = RGBColor(0x59, 0x59, 0x59)

SYSTEM_TITLE = (
    "Real-Time Workflow, Activity Log, and Payroll Management System "
    "with Integrated Analytics for Accounting Firms"
)
CLIENT = "Lope Laranjo Bato and Co., CPAs"
SCHOOL = "Cagayan de Oro College | College of Information Technology Education"
RESEARCHERS = [
    "Jana Vinzy E. Dacula",
    "Jellianne Mariz L. Mulit",
    "Mikie Angelyn A. Romero",
    "Roberth B. Namoc",
    "Shiela Mae B. Pacala",
]


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def set_style(doc):
    normal = doc.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(11)
    for name, size in (("Heading 1", 16), ("Heading 2", 13), ("Heading 3", 11.5)):
        st = doc.styles[name]
        st.font.name = "Calibri"
        st.font.size = Pt(size)
        st.font.color.rgb = NAVY
        st.font.bold = True
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)  # A4
    sec.left_margin = sec.right_margin = Cm(2.2)
    sec.top_margin = sec.bottom_margin = Cm(2.0)


def add_toc(doc):
    doc.add_heading("Table of Contents", level=1)
    p = doc.add_paragraph()
    r = p.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = 'TOC \\o "1-2" \\h \\z \\u'
    sep = OxmlElement("w:fldChar")
    sep.set(qn("w:fldCharType"), "separate")
    txt = OxmlElement("w:t")
    txt.text = "Right-click and choose “Update Field” to build the table of contents."
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    for el in (begin, instr, sep, txt, end):
        r._r.append(el)
    settings = doc.settings.element
    upd = OxmlElement("w:updateFields")
    upd.set(qn("w:val"), "true")
    settings.append(upd)


def add_table(doc, headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ""
        run = hdr[i].paragraphs[0].add_run(h)
        run.bold = True
        run.font.size = Pt(10)
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ""
            run = cells[i].paragraphs[0].add_run(str(val))
            run.font.size = Pt(10)
    doc.add_paragraph()
    return t


def add_cover(doc):
    for _ in range(4):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("CAPSTONE PROJECT — DEFENSE-READY Q&A")
    r.bold = True
    r.font.size = Pt(26)
    r.font.color.rgb = NAVY
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(SYSTEM_TITLE)
    r.bold = True
    r.font.size = Pt(15)
    doc.add_paragraph()
    for line, size, bold in (
        (f"Client: {CLIENT}", 12, True),
        (SCHOOL, 12, False),
        ("", 12, False),
    ):
        p = doc.add_paragraph()
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        r = p.add_run(line)
        r.font.size = Pt(size)
        r.bold = bold
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run("RESEARCHERS\n" + "\n".join(RESEARCHERS))
    r.font.size = Pt(12)
    for _ in range(3):
        doc.add_paragraph()
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(f"Prepared for panel defense — {date.today().strftime('%B %d, %Y')}")
    r.font.size = Pt(11)
    r.font.color.rgb = GRAY
    doc.add_page_break()


def add_doc_control(doc):
    doc.add_heading("Document Control", level=1)
    add_table(
        doc,
        ["Field", "Value"],
        [
            ("Document", "Defense-Ready Question & Answer Documentation"),
            ("Version", "1.0"),
            ("Date generated", date.today().isoformat()),
            ("Target audience", "Capstone panel / thesis defense Q&A"),
            ("Source artifacts",
             "docs/TESTING_PLAN_FINAL.md; docs/SECURITY_HARDENING.md; "
             "database/Capstone1.sql; api/ (55 endpoints); pages/ (40+ screens)"),
            ("Verification basis",
             "Expected-vs-actual results recorded in the Level 1-3 registries, "
             "security smoke harness (126 pass / 0 regressions), UAT sign-off sheet"),
        ],
    )


def add_how_to_use(doc):
    doc.add_heading("1. How to Use This Document", level=1)
    doc.add_paragraph(
        "This document is a curated bank of anticipated panel questions with "
        "model answers grounded in the project's own documentation and code. "
        "Answers are written to be spoken aloud in 20-60 seconds. Long answers "
        "can be expanded with the evidence cited in each response."
    )
    doc.add_heading("1.1 Answer structure (use for every question)", level=2)
    for line in (
        "1. Direct answer — one sentence, no preamble.",
        "2. Evidence — cite the test ID, doc file, or code location that proves it.",
        "3. Boundary — state the limitation honestly if the question exceeds scope.",
    ):
        doc.add_paragraph(line, style="List Bullet")
    doc.add_heading("1.2 Defense-day quick protocol", level=2)
    for line in (
        "Memorize the number block in Appendix B (tables, endpoints, test counts, smoke scores).",
        "Never guess: if a number is not in Appendix B, say 'I will verify after the defense' rather than inventing one.",
        "Security questions: lead with 'defense in depth', then name the control, then the evidence (smoke harness before/after).",
        "Admit known gaps by naming the remediation phase — panels reward honest, planned weakness over hidden weakness.",
        "Demo failures: the system runs on local XAMPP; re-run scripts/security-smoke.sh to prove health before continuing.",
    ):
        doc.add_paragraph(line, style="List Bullet")
    doc.add_page_break()


# --------------------------------------------------------------------------- #
# content
# --------------------------------------------------------------------------- #
SECTIONS = []

SECTIONS.append({
    "title": "2. Project Overview and Objectives",
    "qa": [
        ("What is this system?",
         f"A role-based web system that digitizes {CLIENT}'s task workflow, HR "
         "approvals, payroll processing, and management analytics in one platform, "
         "with a real-time activity log that records every action for audit."),
        ("Who is the client and who are the users?",
         f"The client is {CLIENT}. End users are three roles: Administrator "
         "(master data, settings, logs, backups), Manager (approvals, payroll "
         "pre-check, project and task oversight), and Staff (assigned tasks, HR "
         "requests, attendance, payslips)."),
        ("What problem does it solve?",
         "Accounting firms track tasks, leave, overtime, cash advances, and "
         "payroll manually across spreadsheets and chat. Records are hard to "
         "trace, approvals leave no evidence, and payroll figures must be "
         "recomputed by hand. The system centralizes these processes and gives "
         "every mutation an actor, a timestamp, and an immutable log entry."),
        ("What are the core objectives?",
         "(1) Real-time workflow for tasks and HR approvals; (2) an immutable "
         "activity log / audit trail; (3) accurate payroll generated from "
         "attendance imports; (4) integrated analytics and reports on the same "
         "data; (5) role-based security over all of the above."),
        ("Why is it called 'real-time'?",
         "The activity log and live sync utility (utils/liveSync.ts) refresh "
         "automatically, so a new entry appears in another session or branch "
         "without any manual page refresh. This was verified end-to-end by "
         "Level 2 test 1.8 (live activity feed across sessions) and Level 3 "
         "tests 3.1 and 3.4 (cross-branch visibility)."),
        ("What does 'integrated analytics' mean here?",
         "The analytics dashboard (Chart.js doughnut and trend charts with "
         "week/month/year filters) reads the same database as payroll and "
         "workflow. Level 2 test 1.5 proved dashboard totals match the "
         "generated report for the same period, and Level 3 test 4.1 proved "
         "system totals match manual calculations on known test data."),
        ("What is the main innovation or contribution?",
         "End-to-end traceability: every write operation — task creation, "
         "approval, payroll run, settings change, deletion — produces an "
         "activity-log entry with actor and timestamp, visible live across "
         "branches, with no edit or delete option on log rows (Level 3 test 3.3)."),
        ("Give a one-sentence elevator pitch.",
         "A secure, role-based payroll and workflow system for accounting firms "
         "that turns attendance imports into accurate payroll, routes every "
         "approval through a tracked workflow, and shows who did what, when, "
         "in real time."),
        ("What is explicitly NOT part of the project?",
         "Direct submission to government agencies (e.g., BIR/SSS filings). "
         "The system produces reference reports only — confirmed by Level 3 "
         "test 5.4, which expects and observes no government-submission "
         "function on the payroll screens."),
    ],
})

SECTIONS.append({
    "title": "3. Scope, Stakeholders, and Limitations",
    "qa": [
        ("What modules are in scope?",
         "Authentication and password recovery; dashboards; branches, employees "
         "and users; clients, projects, services and contracts; tasks (Kanban "
         "board, My Tasks, workflow steps, comments, checklists, files); HR "
         "requests (leave, overtime, cash advance) with manager Approval Inbox; "
         "shift schedules, attendance import, payroll run, payslips; documents; "
         "calendar and holidays; analytics; reports and exports (PDF, Excel, "
         "CSV); notifications; real-time activity log; and a full settings suite "
         "(password policy, session timeout, captcha, account/browser lockout, "
         "role access control, rate limiting, logs, backup, data deletion)."),
        ("How was the respondent group selected?",
         "Purposive sampling of four (4) respondents from the client firm — one "
         "Administrator, one Manager, and two Accounting Staff — chosen for "
         "direct involvement in accounting operations and familiarity with the "
         "firm's existing manual and semi-automated processes (per Chapter 3, "
         "Respondents and Sampling Technique, in TESTING_PLAN_FINAL.md)."),
        ("Does the system support multiple branches?",
         "Yes. The branches table is first-class, and cross-branch behavior is "
         "tested: Level 2 test 1.9 shows a record created at Branch A is "
         "immediately visible at Branch B, and Level 3 test 3.4 shows Branch A "
         "activity-log entries visible to an admin at Branch B in real time."),
        ("What are the stated limitations?",
         "(1) Deployment runs on plain HTTP on the local network, so the secure "
         "cookie flag is deliberately off (HTTPS is Phase 7 of the security "
         "roadmap); (2) security roadmap Phases 2-7 (CSRF, default-deny "
         "authorization, injection hardening, error hygiene, dependency gates, "
         "HTTPS) are pending; (3) ESLint currently crashes due to a pre-existing "
         "toolchain incompatibility, so TypeScript compilation (tsc --noEmit) "
         "serves as the static-check gate; (4) performance results come from "
         "respondent evaluation and functional tests, not instrumented load tests."),
        ("What is assumed about attendance data?",
         "That the firm exports attendance/biometric data to XLS, which is "
         "imported through the attendance import module and confirmed before "
         "the payroll run (Level 2 test 1.3). There is no live biometric device "
         "integration — that is outside scope."),
        ("How is data privacy handled?",
         "Payroll and personal data are visible only to roles granted the "
         "feature (per-role feature access enforced server-side on 43 "
         "endpoints); sensitive profile fields are locked and require an edit "
         "request; settings include data deletion and log management pages; "
         "and ISO 25010 security indicators 4.1-4.3 (confidentiality, "
         "integrity, accountability) are surveyed in UAT."),
    ],
})

SECTIONS.append({
    "title": "4. Development and QA Methodology",
    "qa": [
        ("What SDLC model did you follow?",
         "An iterative build-and-verify cycle: implement a module, execute the "
         "matching test series from TESTING_PLAN_FINAL.md, fix defects, and "
         "re-verify — evidenced by the four-level test registries with "
         "expected-vs-actual columns and by the phased security programme that "
         "runs the same smoke harness before and after every change. "
         "(Recommended framing if a named model is demanded: iterative / "
         "agile-like with prototyping for UI validation.)"),
        ("Describe your testing approach.",
         "Four levels: Level 1 unit testing — 144 cases in nine series (100-900) "
         "covering each screen behavior; Level 2 integration testing — 9 cases "
         "proving cross-layer data flow (UI to logic to log to notification); "
         "Level 3 system testing — 27 end-to-end workflows executed through the "
         "real UI; Level 4 UAT — an ISO/IEC 25010-aligned survey with 17 "
         "indicators administered to 4 client respondents plus a formal "
         "sign-off sheet. Total executed Level 1-3 cases: 180."),
        ("How is test coverage organized and traceable?",
         "Every case has a stable ID (for example 1.8 unit, 2.3 integration, "
         "3.4 system) grouped into series that map directly to modules: 100 "
         "login/auth, 200 password recovery, 300 dashboards, 400 master data, "
         "500 clients/projects/services/contracts, 600 tasks/workflow, 700 HR "
         "requests, 800 attendance/shifts/payroll, 900 documents/calendar/"
         "analytics/reports/exports. Expected Result, Actual Result, and "
         "Remarks columns give full traceability from requirement to evidence."),
        ("Who performed the testing?",
         "The researchers executed Levels 1-3 against the live system, and the "
         "four purposive-sampled client respondents performed Level 4 UAT, "
         "rating quality indicators on a 5-point Likert scale and signing the "
         "acceptance statement."),
        ("What tools were used?",
         "Manual browser-based execution for Levels 1-3; scripts/security-smoke."
         "sh for automated security regression (headers, CORS, session flags, "
         "13 unauthenticated-refusal checks, role boundaries, login for all "
         "three roles); tsc --noEmit for static type checking; npm audit for "
         "dependency scanning; and the Capstone System Testing & UAT workbook "
         "for result aggregation."),
        ("What were the acceptance criteria?",
         "(1) Every Level 1-3 case's actual result equals its expected result; "
         "(2) the security smoke harness shows zero regressions (a check that "
         "passed before a change must not fail after); (3) all three roles log "
         "in and out successfully with captcha and SMTP intact; (4) UAT "
         "respondents rate the system acceptable and sign the acceptance "
         "statement."),
        ("How do you manage defects?",
         "Defects are recorded with severity and evidence in the project's "
         "documentation — the security audit uses Critical/High/Medium tables "
         "with live-probe evidence (SECURITY_HARDENING.md Findings), each fix "
         "is verified by re-running the relevant check, and regressions are "
         "prevented by the before/after smoke-script diff."),
        ("How do you prove a fix did not break existing features?",
         "The 'prime directive' of the hardening programme is that nothing "
         "breaks login (all three roles), captcha, SMTP, settings, or any "
         "existing feature. Every phase is verified by diffing "
         "scripts/security-smoke.sh output before and after: the score moved "
         "from 112 pass / 24 fail to 126 pass / 15 fail with ZERO regressions — "
         "no previously passing check failed."),
        ("What are your entry and exit criteria for testing?",
         "Entry: a stable local environment (XAMPP Apache + MariaDB, seeded "
         "from database/Capstone1.sql) with demo accounts for all three roles. "
         "Exit: Level 1-3 registries fully executed with actual = expected, "
         "smoke harness zero regressions, tsc clean, and UAT sign-off obtained."),
    ],
})

SECTIONS.append({
    "title": "5. System Architecture and Technology Stack",
    "qa": [
        ("Describe the architecture.",
         "A three-tier web architecture: presentation — Next.js 16 / React 19 "
         "pages and components; application logic — 55 PHP 8.2 endpoints under "
         "api/ running on Apache 2.4.58 with mod_php; data — MariaDB/MySQL on "
         "127.0.0.1:3306, InnoDB with utf8mb4 collation. The browser talks to "
         "the PHP endpoints over JSON with session cookies (fetch with "
         "credentials: 'include')."),
        ("Why this technology stack?",
         "The client environment is XAMPP (Apache, PHP, MySQL) — the backend "
         "meets the firm where it already operates, with zero additional "
         "infrastructure. Next.js/React with TypeScript and Tailwind CSS 4 "
         "gives a fast, componentized, type-safe UI; Chart.js renders the "
         "analytics; jspdf + html2canvas handle PDF export. Choices favor "
         "maintainability and deployment simplicity over novelty."),
        ("How do the frontend and backend communicate?",
         "Every screen issues fetch() calls to /api/*.php endpoints with "
         "credentials included. Two deployment modes: development runs Next.js "
         "on port 3000 and proxies /api/* to Apache; production serves a "
         "static export (out/) directly from Apache on the same origin, so no "
         "CORS is needed for the normal deployment."),
        ("Walk through the login flow.",
         "Login is a two-step process: login_precheck validates the account, "
         "email domain, attempt counter, and captcha requirement, then "
         "login_complete verifies credentials (bcrypt), regenerates the session "
         "ID (session_regenerate_id on login, preventing fixation), applies "
         "first-login forced password reset or expired-password redirect, and "
         "redirects by role to the Admin, Manager, or Staff dashboard. Wrong "
         "passwords decrement an attempts counter until account lockout."),
        ("How does authentication and session management work?",
         "Server-side PHP sessions hardened with session.use_strict_mode=1, "
         "use_only_cookies=1, use_trans_sid=0, HttpOnly cookies, SameSite=Lax, "
         "regeneration at login, and per-role idle timeouts — including an "
         "admin idle timeout with a configurable budget "
         "(session_timeout_admin_minutes). The frontend also enforces single-"
         "session awareness and shows an inactivity countdown warning before "
         "logout."),
        ("What email functionality exists and how does it work?",
         "Password reset and contract invitation emails are sent through SMTP "
         "(smtp.gmail.com:587) using PHPMailer 7 (composer vendor/), with "
         "credentials supplied via environment variables — never hardcoded. "
         "Verification: a real forgot_password reset email was sent "
         "successfully during security Phase 1 testing."),
        ("How are charts and exports implemented?",
         "Chart.js via react-chartjs-2 (with the datalabels plugin) powers the "
         "analytics doughnut and trend charts and in-report visuals. Reports "
         "preview in the browser, then export to PDF (jspdf + html2canvas) or "
         "to Excel/CSV; Level 3 tests 4.3 and 4.4 confirm uncorrupted downloads."),
        ("Is there a desktop version?",
         "Yes, optionally: an Electron wrapper (electron/main.cjs) packaged "
         "with electron-builder as a Windows NSIS installer can present the "
         "same web application as a desktop window. The web deployment remains "
         "the primary target."),
        ("Is there a PostgreSQL version?",
         "The codebase includes a compatibility layer (api/pg_compat.php) and "
         "pg driver support so the API can run against PostgreSQL as an "
         "alternative deployment; the capstone's verified environment is "
         "XAMPP's MySQL/MariaDB."),
        ("How is performance addressed?",
         "Server-side pagination prevents large-list overload (Level 3 test "
         "2.7 verifies no duplicated or skipped rows), payroll actions show a "
         "loading indicator with the button disabled while processing (test "
         "5.1), prepared statements are used at scale (644 prepare() calls), "
         "and InnoDB indexing backs the hot queries. Formal load testing was "
         "not part of scope — performance is otherwise evaluated through UAT "
         "indicators 3.1 (time behavior) and 3.2 (resource utilization)."),
    ],
})

SECTIONS.append({
    "title": "6. Database Design",
    "qa": [
        ("How many tables does the database have and what are the key ones?",
         "35 tables (database/Capstone1.sql). Key tables: branches, roles, "
         "employees, employee_role, users (authentication), client, projects, "
         "tasks, task_collaborators, checklist_items, work, services, "
         "service_checklists, client_services, deduction_type, deduction, "
         "payroll, payroll_user_archive, leave_request, leave_balance, "
         "shift_schedule, attendance_records, holidays, activity_log, "
         "document_received, document_submission, settings, chart_of_accounts, "
         "project_messages, task_completion_reports, request_rate_limits, and "
         "cash_advance_request."),
        ("Explain the main relationships.",
         "branches 1:N employees; employees link to users and roles through "
         "employee_role; client 1:N projects; projects 1:N tasks; tasks M:N "
         "users via task_collaborators; attendance_records and deduction types "
         "feed payroll; leave_request updates leave_balance; cash_advance_request "
         "produces payroll deductions once marked as deducted; activity_log "
         "cross-cuts every module as the audit trail; settings holds system-wide "
         "configuration as key-value rows."),
        ("Why InnoDB with utf8mb4?",
         "InnoDB supports foreign keys and transactions — essential for payroll "
         "where gross, deductions, and net must be consistent — and utf8mb4 "
         "covers the full Unicode range (including names and emoji). Every "
         "table in the dump uses ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 "
         "COLLATE=utf8mb4_unicode_ci."),
        ("How is data integrity enforced?",
         "At the database layer: InnoDB foreign keys and constraints. At the "
         "application layer: required-field validation (Level 1 test 6.3), "
         "business-rule validation such as end-date-after-start-date (test 5.5) "
         "and numeric-only amounts (test 7.11 / Level 3 test 2.3), plus "
         "parameterized queries in 644 prepared statements."),
        ("How is the schema created and migrated?",
         "database/Capstone1.sql (about 1,060 lines) creates the full schema "
         "with CREATE TABLE IF NOT EXISTS, and incremental scripts such as "
         "migrate_18_standard_report_users.sql handle upgrades. Runtime "
         "ensure*Table()/ALTER helpers provide additive DDL safety; a "
         "dedicated migration runner is scheduled as Phase 3 of the security "
         "roadmap to remove runtime DDL from request paths."),
        ("How are passwords and sensitive values stored?",
         "Passwords are hashed with bcrypt via PHP password_hash, with password "
         "history and expiry enforced by policy — never in plaintext. Known "
         "finding C8: the development SQL dump contains published default "
         "passwords for demo accounts; rotation before production is recorded "
         "as a remediation item. This is an honest, documented gap — say so "
         "if asked."),
        ("How is payroll history preserved?",
         "payroll stores the current run results while payroll_user_archive "
         "keeps per-employee payroll history, so past payslips remain "
         "retrievable (My Payslips) even after subsequent runs; every run also "
         "writes an activity-log entry with actor and timestamp (Level 2 test 1.4)."),
    ],
})

SECTIONS.append({
    "title": "7. Functional Modules — How They Work",
    "qa": [
        ("Walk through the authentication safeguards.",
         "Email format and domain allowlist (gmail.com / phinmaed.com), masked "
         "passwords with show/hide toggle, Remember Me, wrong-password counter, "
         "account lockout on the 4th failed attempt with an unlock path in "
         "Settings, intruder browser blocking on the 10th failed attempt with "
         "an 'INTRUDER BLOCKED' page, math captcha (toggleable) plus robot-check "
         "countdown, first-login forced password reset, expired-password "
         "redirect, and role-based dashboard redirection. Covered by Level 1 "
         "Series 100 (20 cases)."),
        ("How does the task workflow work?",
         "A Kanban board with Backlog, In Progress, Review, and Done columns; "
         "drag-and-drop updates status; priority levels render distinct colors; "
         "overdue due dates show red; task detail includes collaborators (with "
         "shift ranges), checklists, threaded comments, file uploads, and "
         "workflow-step submissions with timestamps. Staff see their assigned "
         "and collaborated tasks on My Tasks. 15 unit cases in Series 600."),
        ("How do HR request approvals work?",
         "Staff submit leave, overtime, or cash advance requests as Pending; "
         "the manager's Approval Inbox lists them with count cards and type "
         "filters; approve or reject (with reason) updates the status, sends an "
         "in-app notification to the requester, and writes an activity-log "
         "entry. Leave balances display per type with progress bars, and a "
         "Leave Planner calendar shows team absences. Approved cash advances "
         "can be marked as deducted, which flows into payroll deductions. "
         "16 unit cases in Series 700."),
        ("Describe the payroll process end-to-end.",
         "Import attendance XLS -> confirm import -> select the pay period -> "
         "run payroll -> gross pay, deductions, and net pay are computed with a "
         "summary -> manager pre-check screen validates before finalization -> "
         "payslips become visible to employees under My Payslips. The run "
         "writes an activity-log entry, and payroll analytics reflect the "
         "results. Verified by Level 2 test 1.3 (import feeds payable hours) "
         "and Level 3 test 2.6 (full run computes correctly)."),
        ("How do you prove payroll math is correct?",
         "Level 3 test 4.1 — Mathematical Audit: run payroll on known test "
         "data, compare system totals against manual calculations. Actual "
         "result: totals matched manual calculations. Corroborated by Level 2 "
         "test 1.5 (dashboard totals = report totals) and UAT indicator 1.2 "
         "(Functional Correctness: computes without mathematical errors)."),
        ("What can the activity log do?",
         "Live feed: new entries appear in another session without manual "
         "refresh (tests 1.8 / 3.1). Filtering by user and date range, sorted "
         "newest first (test 3.2). Immutability: no edit or delete controls "
         "exist on any entry (test 3.3 / 1.18). Cross-branch visibility for "
         "admins in real time (test 3.4). Every module writes to it: task "
         "creation, payroll runs, settings changes, record deletions."),
        ("What do analytics and reports provide?",
         "Analytics: summary cards, doughnut and trend charts with Week/Month/"
         "Year filters that update without a page reload. Reports: type "
         "selector with filter panel, chart-plus-table preview, and export to "
         "PDF, Excel, or CSV. Series 400 (Level 1, 9 cases) and Series 400 "
         "(Level 3, 4 cases) cover these, including the mathematical audit."),
        ("How do contracts and documents work?",
         "Contracts are created with status tracking, signed PDFs are uploaded "
         "with preview links (MIME validated with finfo), contracts print, and "
         "an active contract can spawn a pre-filled linked project. The "
         "Documents page maintains document records with type, date, and "
         "status. File serving goes through serve-file.php with realpath "
         "containment and role checks."),
        ("What is in Settings?",
         "Password policy (minimum length, history, expiry), session timeout "
         "(admin-configurable), math captcha toggle, account lockout (find and "
         "unlock locked users), browser lockout, role access control, rate "
         "limiting, logs management, system backup (automatic and manual), "
         "data deletion, leave management, and deduction types. Every change "
         "is saved, applied immediately, and logged (Level 3 test 5.2)."),
        ("How does role access control work?",
         "The frontend defines 19 feature toggles (utils/roleFeatureAccess.ts) "
         "that show or hide sidebar items per role; the backend enforces the "
         "same catalog server-side via requireFeatureAccess on 43 endpoints, so "
         "hiding a menu is never the security boundary — the API refuses "
         "direct calls. Level 3 test 1.4 verifies a Staff login typing an admin "
         "URL receives 403 Access Denied."),
        ("How do profile and edit requests handle locked fields?",
         "Sensitive fields such as email are locked: attempting to edit them "
         "creates an edit request that leaves the stored value unchanged until "
         "approved (Level 1 test 9.25), preserving data integrity while giving "
         "users a legitimate change path."),
        ("What notification mechanisms exist?",
         "In-app notifications with bell-icon unread badge, severity and "
         "read/unread states, mark-all-as-read, and delivery triggered by "
         "workflow events (payroll runs, approvals). The sidebar badge refreshes "
         "on a background interval so counts stay current without navigation."),
    ],
})

SECTIONS.append({
    "title": "8. Security",
    "qa": [
        ("What is your overall security model?",
         "Defense in depth across five layers: perimeter (allowlist-only CORS, "
         "Content-Security-Policy on API and frontend, hardened headers, "
         "version-banner suppression), session (strict mode, HttpOnly, "
         "SameSite=Lax, regeneration, idle timeouts), authentication (bcrypt, "
         "TOTP and email OTP, math/hCaptcha and ALTCHA, lockouts, DB-backed "
         "rate limiting, lockdown mode), authorization (role-based feature "
         "access on 43 endpoints plus per-endpoint role gates), and audit "
         "(broad immutable activity logging)."),
        ("How are passwords protected?",
         "Hashed with bcrypt (password_hash) with password history and expiry "
         "rules, a configurable minimum length policy, and a change flow that "
         "requires an emailed OTP. Plaintext passwords are never stored; reset "
         "links are delivered over SMTP via PHPMailer."),
        ("Are you vulnerable to SQL injection?",
         "The codebase uses 644 parameterized prepare() calls against 218 raw "
         "query() calls; tracing showed the raw calls interpolate internal "
         "identifiers and intval'd IDs — not currently exploitable — but the "
         "audit logged this as Medium finding M1 because one careless edit "
         "away is all it takes. Identifier quoting and retiring input-side "
         "escaping are scheduled as Phase 4. Answer with the numbers and the "
         "planned phase — never with 'it's impossible'."),
        ("How do you prevent XSS?",
         "API responses carry a Content-Security-Policy of default-src 'none' "
         "(JSON is inert), the Apache-served frontend has a CSP, and output "
         "encoding is applied. The audit honestly flags finding M2: "
         "htmlspecialchars was applied on input in some files, which is the "
         "wrong layer; correcting it is part of Phase 4."),
        ("How is CORS configured?",
         "Allowlist only — no wildcard. The previous behavior of reflecting "
         "any origin with credentials (finding C4) and the X-Forwarded-Host "
         "bypass (C5) were verified live, then closed: hostile origins are no "
         "longer reflected, preflights refuse them, and forwarded-host trust "
         "is gated behind an explicit environment flag."),
        ("Do you have CSRF protection?",
         "Honest answer: the audit found zero CSRF tokens (finding C6). The "
         "remediation is designed and scheduled as Phase 2 — implemented at "
         "the two choke points (setCORSHeaders() and the frontend notify.ts "
         "fetch wrapper) and shipped log-first, enforce-later. Say: 'Known "
         "gap, phase 2, choke-point design already decided.'"),
        ("How are file uploads and downloads secured?",
         "Uploads: finfo MIME-type validation on contract and workflow files "
         "(extension-only validators flagged as M3 for consolidation), "
         "uploads/.htaccess denies direct access (verified 403). Downloads: "
         "serve-file.php uses realpath containment against path traversal, "
         "checks the requesting role, and sends nosniff and no-store headers "
         "— all covered by smoke checks."),
        ("How is brute force prevented?",
         "Four independent controls: per-account lockout after 4 failed "
         "attempts (unlockable by admin), per-browser intruder blocking at 10 "
         "failed attempts, database-backed rate limiting on request endpoints "
         "(request_rate_limits table), and a systemwide lockdown mode. "
         "All were enabled (they had been built but switched off) in Phase 0 "
         "containment."),
        ("How are secrets and sensitive files protected?",
         "Phase 0 containment: .env-style secrets moved out of tracked files, "
         "the SMTP password removed from api/.htaccess, previously committed "
         "secrets untracked, Options -Indexes disabled so directories are no "
         "longer listable, backups moved out of the webroot, and a deny-list "
         "added to the root .htaccess for .git, .env, SQL dumps, and cookie "
         "jars. Credential rotation for anything historically committed is "
         "tracked as a follow-up."),
        ("What evidence proves the security work?",
         "scripts/security-smoke.sh run on the same machine before and after "
         "each phase: PASS 112 -> 126, FAIL 24 -> 15, with zero regressions. "
         "Closed checks include hostile-origin reflection blocked, "
         "X-Forwarded-Host bypass blocked, CSP present on frontend and API, "
         "X-Powered-By removed, session strict mode confirmed at runtime, "
         "role boundaries (approx. 30 admin, 13 manager, 13 staff endpoints) "
         "enforced, and logout invalidation for all three roles."),
        ("What security issues remain open?",
         "The 15 remaining smoke failures are Phase 0 items (file exposure of "
         ".env.local, .git/config, the SQL dump, backups, cookie jars over "
         "HTTP). Roadmap Phases 2-7 remain: CSRF, default-deny authorization "
         "and the analytics IDOR (H3), injection and unified upload "
         "validation, error hygiene with correlation IDs, dependency and CI "
         "gates, and HTTPS with secure cookies. npm audit still reports 3 "
         "vulnerabilities (2 high) tracked in H8."),
        ("What is the IDOR finding?",
         "api/analytics.php honored a ?user_id= parameter behind a bare "
         "requireAuth() — an authenticated user could read another user's "
         "analytics (finding H3). It is documented with evidence and "
         "scheduled for Phase 3's default-deny authorization sweep. Panels "
         "respect a team that found its own holes; deliver it as audit "
         "evidence, not as an excuse."),
    ],
})

SECTIONS.append({
    "title": "9. Testing Results and Evidence",
    "qa": [
        ("How many test cases were executed?",
         "180 across Levels 1-3: Level 1 unit = 144 (nine series), Level 2 "
         "integration = 9, Level 3 system = 27. Level 4 UAT adds 17 ISO/IEC "
         "25010 survey indicators administered to 4 respondents, plus the "
         "participant profile matrix and sign-off sheet."),
        ("What was the pass rate?",
         "All executed Level 1-3 cases recorded actual results equal to their "
         "expected results — no failed cases in the registries (Remarks "
         "columns are empty because there was nothing to retest). The security "
         "harness independently scores 126 pass / 15 fail, where all 15 "
         "failures are known, documented Phase 0 exposure items."),
        ("Break down Level 1 unit coverage.",
         "Series 100 Login & Authentication 20; 200 Password Recovery & Change "
         "9; 300 Dashboards & Navigation 9; 400 Master Data (branches, "
         "employees, users) 19; 500 Clients/Projects/Services/Contracts 13; "
         "600 Tasks & Workflow 15; 700 HR Requests 16; 800 Attendance/Shifts/"
         "Payroll/Payslips 15; 900 Documents/Calendar/Analytics/Reports/"
         "Notifications/Logout 28 — total 144."),
        ("What do the integration tests prove?",
         "Nine cross-layer flows: role-scoped login and menus; task creation "
         "appearing in Kanban, My Tasks, and the activity log simultaneously; "
         "attendance import feeding payroll hours; payroll run writing a log "
         "entry; dashboard totals matching generated reports; leave appearing "
         "in the Approval Inbox; approval triggering staff notification; the "
         "live feed updating across two browser sessions; and cross-branch "
         "records appearing in the centralized view instantly."),
        ("Give examples of system-level tests.",
         "Security behavior: Staff typing an admin URL gets 403 Access Denied; "
         "5 wrong passwords — lockout on the 4th, refusal on the 5th; after "
         "logout the browser Back button cannot restore the session. Boundary "
         "input: letters in a numeric rate field are rejected. End-to-end: full "
         "XLS import to computed payroll summary. Real-time: log entries appear "
         "across sessions and branches; the log has no edit or delete option."),
        ("How do you defend against 'your testing was superficial'?",
         "Point to breadth and depth: 180 executed cases covering every module "
         "login-to-logout in nine series; mathematical audit of payroll against "
         "manual computation; a 126-check automated security harness run before "
         "and after every change with a zero-regression rule; live-probe "
         "security auditing that produced 22 graded findings with HTTP status "
         "evidence; and external validation through 4 client respondents on an "
         "ISO 25010 instrument with formal sign-off."),
        ("Was performance testing done?",
         "Not instrumented load testing — that is a scope limitation. "
         "Performance is covered three ways: functional behavior under data "
         "volume (pagination test 2.7, disabled-button/spinner test 5.1), "
         "respondent evaluation on UAT indicators 3.1 time behavior and 3.2 "
         "resource utilization, and design choices (server-side pagination, "
         "prepared statements, background badge refresh on a 60-second interval "
         "rather than per-render fetches)."),
        ("Was accessibility or cross-browser testing done?",
         "Through the UAT instrument: indicator 2.5 (accessibility of text, "
         "icons, interactive elements) and 6.1 (co-existence across major "
         "browsers and screen sizes) are rated by respondents. State honestly "
         "that this is user-validated rather than tool-audited — no WCAG "
         "automated scan was run."),
        ("What is the Level 4 UAT instrument?",
         "An ISO/IEC 25010-aligned survey with 17 indicators in six groups — "
         "Functional Suitability, Usability/UX, Performance Efficiency, "
         "Security, Reliability, and Maintainability/Portability — on a 5-point "
         "Likert scale (5 = Strongly Agree to 1 = Strongly Disagree), a "
         "participant profile matrix for the 4 respondents with testing dates "
         "and signature initials, and a Part 3 formal acceptance statement for "
         "sign-off."),
        ("Why is ISO/IEC 25010 the right standard?",
         "It is the international standard for software product quality "
         "requirements and evaluation, giving the panel an objective, "
         "externally recognized rubric instead of ad-hoc opinion. Mapping our "
         "evaluation to it shows methodological rigor: each quality "
         "characteristic is represented by concrete, rateable indicators tied "
         "to features we actually built and tested."),
    ],
})

SECTIONS.append({
    "title": "10. Defects, Challenges, and Risk Management",
    "qa": [
        ("Tell us about a real bug you found and fixed.",
         "The role-feature-access catalogs had drifted between frontend and "
         "backend: utils/roleFeatureAccess.ts defined 19 features but "
         "getRoleFeatureAccessCatalog() in api/utils.php only 17 — tasks_board "
         "and approval_inbox were missing server-side. Because "
         "hasRoleFeatureAccess() returns false for unknown keys, "
         "api/approval-inbox.php returned 403 to EVERY manager — the Approval "
         "Inbox was dead, and the Settings role toggles could never persist. "
         "Both keys were added, the two lists are now asserted equal, and "
         "verification showed manager access go 403 -> 200. It was pre-existing, "
         "invisible to code review, and only endpoint-level verification "
         "caught it."),
        ("What were the most serious security findings?",
         "Eight Critical: secrets committed and downloadable over HTTP, "
         "listable backups/ next to full DB dumps, an SMTP password hardcoded "
         "in .htaccess, wildcard CORS reflecting any origin with credentials, "
         "an X-Forwarded-Host allowlist bypass, zero CSRF protection, the app "
         "running as MySQL root with an empty password, and default passwords "
         "published in the SQL dump. Nine High (including an analytics IDOR, "
         "session fixation via strict_mode off, admin sessions never "
         "idle-expiring, and unauthenticated dev scripts in the webroot) and "
         "five Medium complete the 22-finding audit."),
        ("What was the hardest challenge and how did you solve it?",
         "Balancing aggressive security hardening against the prime directive "
         "that nothing may break login (all three roles), captcha, SMTP, "
         "settings, or any existing feature. The solution was process: choke-"
         "point edits instead of shotgun changes (one edit in setCORSHeaders() "
         "covers 43 of 55 endpoints), log-before-enforce rollout for any "
         "control that can reject a request, additive-before-subtractive "
         "changes, one concern per commit for one-line reverts, and mandatory "
         "smoke-script diffs as the definition of done."),
        ("What tooling problems did you hit?",
         "ESLint 10.8.0 crashes with 'TypeError: Error while loading rule "
         "react/display-name' from the bundled plugin in eslint-config-next. "
         "It fails identically on files the project never touched, so it is a "
         "pre-existing toolchain incompatibility, not a regression. Mitigation: "
         "tsc --noEmit is clean and serves as the static gate; the ESLint fix "
         "is scheduled in Phase 6."),
        ("What are the top risks and their mitigations?",
         "1) Plain-HTTP deployment -> session.cookie_secure stays off by design "
         "until HTTPS lands in Phase 7. 2) MySQL root with empty password -> "
         "least-privilege DB user in Phase 3. 3) Missing CSRF -> Phase 2 "
         "choke-point implementation. 4) Dependency advisories (3 npm "
         "vulnerabilities) -> Phase 6 upgrade + CI lint gates. 5) Runtime DDL "
         "on request paths -> migration runner in Phase 3. Each risk has a "
         "named phase, so none is unowned."),
        ("What would you do if the system failed during the demo?",
         "The stack is local XAMPP, so recovery is fast: restart Apache and "
         "MySQL services, verify with scripts/security-smoke.sh (expected 126 "
         "pass), and fall back to seeded demo data if a dataset is corrupt. "
         "Every hardening phase also ships documented one-line rollback "
         "commands (git checkout of the changed files), so no change is ever "
         "destructive."),
        ("Is the system scalable for larger organizations?",
         "It is scoped for a single accounting firm's LAN — which it handles "
         "with pagination, prepared statements, and background-refresh design "
         "— not for thousands of concurrent users. Scaling levers are already "
         "identified: HTTPS/CDN-ready static frontend, least-privilege DB, "
         "and the PostgreSQL compatibility layer for managed cloud databases. "
         "Present scale as a deliberate scope boundary with a clear upgrade "
         "path."),
        ("The activity log is polling, not push — is that really 'real-time'?",
         "Precisely: it is automatic refresh without user intervention. "
         "utils/liveSync.ts re-queries the endpoint on a fixed interval so "
         "entries appear in every open session within seconds — verified "
         "cross-session and cross-branch by tests 1.8, 3.1, and 3.4. For a "
         "firm's audit needs this meets the requirement; WebSockets/SSE would "
         "be the upgrade if millisecond delivery were required. Frame it as "
         "'near-real-time by design — no refresh, no polling by the user'."),
    ],
})

SECTIONS.append({
    "title": "11. Results, Evaluation, and Acceptance",
    "qa": [
        ("What were the final evaluation results?",
         "180 of 180 Level 1-3 cases passed with actual results equal to "
         "expected; the security harness improved from 112 to 126 passing "
         "checks with zero regressions; tsc --noEmit is clean; and 4 of 4 "
         "purposive-sampled client respondents evaluate the system through the "
         "ISO 25010 instrument with a formal acceptance sign-off sheet as the "
         "capstone's definitive evidence of institutional acceptance."),
        ("What does the sign-off statement commit the client to?",
         "'By signing below, I acknowledge that I have actively participated "
         "in or reviewed the User Acceptance Testing (UAT) phase for the "
         "developed system. I confirm that the functional deliverables, user "
         "interfaces, security protocols, and operational workflows meet our "
         "agreed specifications and are accepted for live deployment.' It is "
         "signed by the client representative with printed name, designation, "
         "signature, and date."),
        ("What value does the client actually receive?",
         "Approval times collapse from chat/email chasing to a single inbox "
         "with notifications; payroll moves from manual recomputation to an "
         "auditable import-run-preslip pipeline with proven arithmetic; every "
         "action is attributable through the immutable activity log, which "
         "matters for an accounting firm's accountability; and managers get "
         "analytics and reports on live data instead of stale spreadsheets."),
        ("How would you summarize results for the panel in 30 seconds?",
         "'We built a three-tier, role-based system for Lope Laranjo Bato and "
         "Co. covering workflow, HR approvals, payroll, and analytics. We "
         "executed 180 test cases across four levels with 100% expected results "
         "achieved, ran a 126-check security harness showing zero regressions, "
         "and four client respondents validated it against ISO 25010 and signed "
         "formal acceptance. Known gaps — CSRF and HTTPS — are documented with "
         "scheduled remediation phases.'"),
    ],
})

SECTIONS.append({
    "title": "12. Future Work and Closing",
    "qa": [
        ("What are the planned future enhancements?",
         "Security roadmap: Phase 2 CSRF; Phase 3 default-deny authorization, "
         "IDOR fixes, migration runner, least-privilege DB user; Phase 4 "
         "injection and unified upload validation; Phase 5 error hygiene and "
         "security event feed; Phase 6 dependency and CI lint gates; Phase 7 "
         "HTTPS with secure cookies and production allowlists. Feature-wise: "
         "live biometric device integration, a mobile companion, richer BI "
         "dashboards, and email digests are natural extensions."),
        ("What would you change if you started over?",
         "Ship CSRF and least-privilege DB access from day one instead of "
         "retrofitting them — the audit proved choke-point controls are cheap "
         "when written first. Also start the automated smoke harness before "
         "feature work, because its before/after diff discipline caught the "
         "403 Approval Inbox bug that no code review saw."),
        ("How maintainable is the codebase?",
         "TypeScript end-to-end on the frontend, a single choke-point pattern "
         "for cross-cutting concerns (setCORSHeaders, notify.ts, "
         "getDBConnection, sendError), componentized React with clean seams "
         "for new analytics features (UAT indicator 6.2), consistent endpoint "
         "structure across 55 PHP files, and documentation living beside the "
         "code in docs/. New features slot in without touching cross-cutting "
         "plumbing."),
        ("What did the team learn from this project?",
         "Verification beats assumption: endpoint-level testing surfaced a "
         "production-dead Approval Inbox hidden behind passing code; live "
         "security probing turned 'probably fine' into 22 evidenced findings; "
         "and a smoke harness with a zero-regression rule made aggressive "
         "hardening safe. Also: honest documentation of known gaps earns more "
         "credibility than pretending they do not exist."),
        ("Final closing statement for the defense?",
         "'We delivered what the objectives specified — real-time workflow, an "
         "immutable activity log, accurate payroll, integrated analytics, and "
         "role-based security — validated at four levels of testing, audited "
         "against 22 security findings with a measurable 126-check harness, and "
         "accepted in writing by the client. We know precisely what remains, "
         "and it is scheduled, phased, and owned. Thank you.'"),
    ],
})

SECTIONS.append({
    "title": "13. Rapid-Fire Round (Memorize These)",
    "qa": [
        ("Stack in one line?", "Next.js 16 / React 19 / TypeScript / Tailwind 4 front end, 55 PHP 8.2 endpoints on Apache 2.4.58 (XAMPP), MariaDB/MySQL InnoDB."),
        ("How many database tables?", "35 tables, InnoDB, utf8mb4."),
        ("How many PHP endpoints?", "55 under api/."),
        ("How many screens/pages?", "40+ routes under pages/ (dashboards, master data, payroll, settings suite, per-role views)."),
        ("User roles?", "Three: Administrator, Manager, Staff."),
        ("Test cases executed?", "180 total — Level 1: 144, Level 2: 9, Level 3: 27; plus UAT 17 indicators x 4 respondents."),
        ("Security smoke score?", "112 pass / 24 fail before -> 126 pass / 15 fail after, zero regressions."),
        ("Security findings count?", "22 total — 8 Critical, 9 High, 5 Medium."),
        ("Password hashing?", "bcrypt via PHP password_hash, with history and expiry."),
        ("Session hardening?", "strict mode, HttpOnly, SameSite=Lax, regenerate on login, per-role idle timeout."),
        ("CORS policy?", "Allowlist only — no wildcard, forwarded-host trust gated."),
        ("Kanban columns?", "Backlog, In Progress, Review, Done."),
        ("Payroll inputs?", "XLS attendance import -> period selection -> run -> pre-check -> payslips."),
        ("Quality standard for UAT?", "ISO/IEC 25010, 17 indicators, 5-point Likert, 4 respondents, formal sign-off."),
        ("Sampling method?", "Purposive — 1 admin, 1 manager, 2 accounting staff."),
        ("Real-time mechanism?", "Automatic background sync (utils/liveSync.ts polling) — no manual refresh; cross-session verified."),
        ("Charts / exports?", "Chart.js; PDF via jspdf + html2canvas; Excel/CSV exports."),
        ("Email library?", "PHPMailer 7 over SMTP (smtp.gmail.com:587), credentials via environment variables."),
        ("Biggest known gaps?", "CSRF (Phase 2), HTTPS (Phase 7), least-privilege DB user (Phase 3), dependency advisories (Phase 6)."),
        ("Client?", f"{CLIENT}."),
    ],
})


# --------------------------------------------------------------------------- #
# appendices
# --------------------------------------------------------------------------- #
def add_appendices(doc):
    doc.add_page_break()
    doc.add_heading("Appendix A — Test Case Inventory", level=1)
    doc.add_paragraph(
        "Counts extracted directly from docs/TESTING_PLAN_FINAL.md. Level 1-3 "
        "cases were executed against the live system with recorded actual "
        "results."
    )
    add_table(
        doc,
        ["Level", "Series / Group", "Cases"],
        [
            ("L1 Unit", "100 — Login and Authentication", 20),
            ("L1 Unit", "200 — Password Recovery and Change", 9),
            ("L1 Unit", "300 — Dashboards and Navigation", 9),
            ("L1 Unit", "400 — Master Data (branches, employees, users)", 19),
            ("L1 Unit", "500 — Clients, Projects, Services, Contracts", 13),
            ("L1 Unit", "600 — Tasks and Workflow", 15),
            ("L1 Unit", "700 — HR Requests (leave, overtime, cash advance)", 16),
            ("L1 Unit", "800 — Attendance, Shifts, Payroll, Payslips", 15),
            ("L1 Unit", "900 — Documents, Calendar, Analytics, Reports, Logout", 28),
            ("L1 Unit", "Subtotal", 144),
            ("L2 Integration", "100 — Presentation to Application Logic", 9),
            ("L3 System", "100 — User Authentication and Account Management", 8),
            ("L3 System", "200 — Workflow, Task, Payroll Record Processing", 7),
            ("L3 System", "300 — Real-Time Activity Log and Audit Trail", 4),
            ("L3 System", "400 — Analytics, Reporting, and Exports", 4),
            ("L3 System", "500 — System Configuration and Notifications", 4),
            ("L3 System", "Subtotal", 27),
            ("TOTAL L1-L3", "", 180),
            ("L4 UAT", "ISO 25010 indicators (x 4 respondents)", 17),
        ],
    )

    doc.add_heading("Appendix B — Numbers to Memorize", level=1)
    add_table(
        doc,
        ["Metric", "Value"],
        [
            ("Database tables", "35 (InnoDB, utf8mb4)"),
            ("PHP endpoints", "55 (api/)"),
            ("Frontend routes", "40+ (pages/)"),
            ("User roles", "3 (admin, manager, staff)"),
            ("Test cases L1-L3", "180 (144 + 9 + 27)"),
            ("UAT", "17 ISO 25010 indicators, 4 respondents, 5-point Likert"),
            ("Security findings", "22 (8 Critical, 9 High, 5 Medium)"),
            ("Security smoke before", "112 pass / 24 fail / 3 note"),
            ("Security smoke after", "126 pass / 15 fail / 2 note, 0 regressions"),
            ("Query safety", "644 prepared vs 218 raw query() calls"),
            ("Feature-gated endpoints", "43 (requireFeatureAccess)"),
            ("Role feature toggles", "19 (frontend catalog; backend asserted equal)"),
            ("Docs schema size", "1,060 lines, 35 CREATE TABLE statements"),
            ("Hardening phases done", "Phase 0 containment + Phase 1 perimeter"),
            ("Hardening phases pending", "Phases 2-7 (CSRF, authz, injection, hygiene, CI, HTTPS)"),
        ],
    )

    doc.add_heading("Appendix C — Source Artifacts (Cite These)", level=1)
    add_table(
        doc,
        ["Artifact", "What it proves"],
        [
            ("docs/TESTING_PLAN_FINAL.md",
             "Level 1-4 registries: 180 executed cases, UAT instrument, sign-off"),
            ("docs/SECURITY_HARDENING.md",
             "22-finding audit with live evidence, phase roadmap, smoke results, rollback"),
            ("scripts/security-smoke.sh",
             "Automated 126-check security regression harness"),
            ("database/Capstone1.sql",
             "35-table InnoDB schema, 1,060 lines"),
            ("api/ (55 PHP files)",
             "Application logic, prepared statements, role gates, hardening headers"),
            ("utils/liveSync.ts / components/ActivityLogsPanel.tsx",
             "Automatic live activity-log refresh mechanism"),
            ("utils/roleFeatureAccess.ts + api/utils.php",
             "Dual-layer role feature access (UI + server) with asserted parity"),
            ("docs/UI_GUIDE_SCREENSHOTS.md",
             "UI walkthrough screenshots for demo fallback"),
        ],
    )


# --------------------------------------------------------------------------- #
# render
# --------------------------------------------------------------------------- #
def render():
    doc = Document()
    set_style(doc)
    add_cover(doc)
    add_doc_control(doc)
    add_toc(doc)
    doc.add_page_break()
    add_how_to_use(doc)

    counter = {"n": 0}
    for section in SECTIONS:
        doc.add_heading(section["title"], level=1)
        for q, a in section["qa"]:
            counter["n"] += 1
            pq = doc.add_paragraph()
            pq.paragraph_format.space_before = Pt(8)
            pq.paragraph_format.space_after = Pt(2)
            rq = pq.add_run(f"Q{counter['n']}. {q}")
            rq.bold = True
            rq.font.color.rgb = NAVY
            pa = doc.add_paragraph()
            pa.paragraph_format.space_after = Pt(6)
            pa.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
            ra = pa.add_run("A. ")
            ra.bold = True
            pa.add_run(a)

    add_appendices(doc)
    doc.save(OUT)
    return counter["n"]


if __name__ == "__main__":
    total = render()
    print(f"Wrote {OUT} ({total} Q&A pairs)")