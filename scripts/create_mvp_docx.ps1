$ErrorActionPreference = "Stop"

$outputPath = Join-Path (Get-Location) "LB_Workflow_Payroll_MVP_Prompt.docx"
$tempDir = Join-Path $env:TEMP ("docx_" + [guid]::NewGuid().ToString("N"))
$null = New-Item -ItemType Directory -Path $tempDir
$null = New-Item -ItemType Directory -Path (Join-Path $tempDir "_rels"), (Join-Path $tempDir "word")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$contentTypes = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
'@
[System.IO.File]::WriteAllText((Join-Path $tempDir "[Content_Types].xml"), $contentTypes, $utf8NoBom)

$rels = @'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
'@
[System.IO.File]::WriteAllText((Join-Path $tempDir "_rels\.rels"), $rels, $utf8NoBom)

$docText = @'
LB Workflow & Payroll - MVP Description and Build Prompt

MVP System Description (based on your current app)
This is a role-based workflow + payroll management system for an accounting firm.

1) Admin
- Full access to users, roles, branches, employees, clients, services, projects, tasks, payroll, leave approvals, documents, settings, backups, lockouts, and activity logs.
- Can create/archive/restore records.
- Uses stronger security features (TOTP, hidden dashboard PIN, advanced reset flow).

2) Manager
- Manages daily operations: clients, services, projects, tasks, payroll, shift schedules, leave approvals, documents.
- Can submit leave for staff, assign/update tasks, and manage payroll records.
- Sees analytics and operational dashboard.

3) Staff
- Limited to personal workspace: my tasks, my attendance, my payslips, leave requests, notifications, profile.
- Can update only assigned task statuses and own attendance/leave interactions.
- Can interact in project messages only where assigned.

4) Core MVP modules
- Auth + session + forgot/reset password + account lockout + browser lockout.
- Master data: users, roles, branches, employees, clients, services, service checklists.
- Project operations: projects, auto-generated tasks from service checklists, project chat.
- Task lifecycle: pending/in_progress/completed/cancelled + completion report email to client.
- HR/payroll: leave requests/approvals, shift schedules, payroll CRUD, payroll analytics, attendance import.
- Documents tracking: received/processing/completed/archived, linked task auto-completion.
- Notifications + activity logs + admin settings + backup management.
- Smooth UI animations and responsive dashboards.

PROMPT TO COPY/PASTE

Build a production-ready MVP web app called "LB Workflow & Payroll" for an accounting firm.

Tech stack:
- Frontend: Next.js (TypeScript), Tailwind CSS, Framer Motion for super smooth animation, Chart.js/Recharts.
- Backend: Node.js + Express (TypeScript), REST API, RBAC middleware.
- Database: MongoDB + Mongoose.
- Auth: HTTP-only cookie sessions or JWT cookies, bcrypt password hashing.
- Validation: Zod or Joi.
- Real-time optional: Socket.io for project messages and notification refresh.

Required roles:
- admin, manager, staff.

Role permissions:
- admin: full system access + settings + backups + lockout controls + activity logs.
- manager: manage clients/services/projects/tasks/payroll/shifts/documents + approve/reject leave.
- staff: my tasks, my attendance, my payslips, my leave requests, notifications, profile.

Implement modules:
1) Authentication & Security: login/logout/session check, forgot/reset password, first-login forced password reset, TOTP for admin, account lockout thresholds, browser lockout table.
2) Master Data: users, roles, branches, employees, clients, services, service checklists, client-service assignments.
3) Projects & Tasks: project CRUD, auto-create tasks from selected checklists, task assignment, status updates, priority, due dates, archive/restore.
4) Project Communication: project messages (RBAC-aware).
5) Task Completion Reports: one report per completed task, email to client.
6) Leave Management: staff/manager submit leave, manager/admin approve/reject, update leave balances.
7) Shift Scheduling: create/update/cancel shifts, staff can mark completed/no-show only on own shifts.
8) Payroll: payroll CRUD with statuses (draft/pending/approved/paid), calculations (gross, deductions, net), analytics charts.
9) Attendance Import: upload XLSX, generate draft payroll entries.
10) Documents Tracking: received/submission tracking, statuses, linked tasks auto-complete on received/completed/submitted.
11) Notifications: task due, leave updates, payroll updates, shift reminders, approval reminders.
12) Activity Logs: auto-log all mutating API actions.
13) Settings & Backup: system settings (pagination, lockout, login titles), backup metadata and file management.

MongoDB collections:
users, roles, branches, employees, clients, services, serviceChecklists, clientServices, projects, tasks, projectMessages, taskCompletionReports, leaveRequests, leaveBalances, shiftSchedules, payrolls, attendanceRecords, documentsReceived, documentSubmissions, notifications, activityLogs, settings, intruderLockouts, backups, aiConversations, aiMessages.

UI/UX requirements:
- Fully responsive desktop/mobile.
- Use Framer Motion: page transitions, staggered table/card reveals, animated counters, modal transitions, smooth status pill transitions, optimistic UI updates.
- Keep animation duration fast and premium (150-280ms mostly), no laggy heavy effects.
- Include loading skeletons and empty/error states.

System layout and design spec:
- Layout style: app-shell architecture with a left sidebar, top header bar, and scrollable content area.
- Navigation: collapsible sidebar with section groups and role-aware menu items.
- Hamburger button: in header; toggles sidebar collapse/expand on desktop and opens drawer on mobile.
- Header: app title, page context, profile avatar, and account dropdown (profile/logout).
- Dashboard layout: summary cards, analytics charts, compact calendar panel, activity feed, and quick action buttons.
- Data pages: filter toolbar + table grid + pagination + row action menus (edit/archive/restore).
- Form pages: card-based forms with clear labels, inline validation, primary/secondary CTA buttons.
- Modal patterns: centered modal for create/edit flows, confirmation modal for destructive actions, side panel optional for details.
- Status UI: color-coded pills/badges for states (pending, in progress, completed, cancelled, approved, rejected, paid, archived).
- Empty/error/loading states: consistent placeholders, retry buttons, and concise error banners.

Color system (recommended):
- Primary: #1E3A8A (deep blue)
- Secondary: #3B82F6 (action blue)
- Success: #16A34A (green)
- Warning: #F59E0B (amber)
- Danger: #DC2626 (red)
- Info: #0EA5E9 (sky)
- Background: #F8FAFC / #FFFFFF
- Text primary: #0F172A, text secondary: #64748B, border: #E2E8F0

Layout variants to include:
- Auth split layout: left branding panel + right login/reset form.
- Admin analytics layout: multi-widget dashboard with charts and operational tables.
- Manager operations layout: task/calendar and team workload focus.
- Staff personal workspace layout: my tasks, my attendance, my payslips, notifications.
- Settings layout: grouped cards for security, lockouts, backup, pagination, and deductions.

Interaction and motion guidelines:
- Sidebar open/close: 180-220ms ease-in-out.
- Card/table reveal: stagger 40-70ms.
- Modal open/close: scale + fade 160-220ms.
- Button hover/press: subtle lift and shadow transitions.
- Keep motion meaningful; avoid heavy/parallax effects that reduce readability.

Deliverables:
- Full source code with clear folder structure.
- Seed script for default admin/manager/staff.
- .env.example.
- API route list and role matrix.
- README with setup/run instructions.
- Basic test coverage for auth, RBAC, and core task/leave/payroll flows.
'@

$lines = $docText -split "`r?`n"
$paragraphs = foreach ($line in $lines) {
    if ([string]::IsNullOrWhiteSpace($line)) {
        "<w:p/>"
    } else {
        $escaped = [System.Security.SecurityElement]::Escape($line)
        "<w:p><w:r><w:t xml:space=`"preserve`">$escaped</w:t></w:r></w:p>"
    }
}

$documentXml = @"
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    $($paragraphs -join "")
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>
"@
[System.IO.File]::WriteAllText((Join-Path $tempDir "word\document.xml"), $documentXml, $utf8NoBom)

if (Test-Path $outputPath) {
    Remove-Item $outputPath -Force
}

$zipPath = [System.IO.Path]::ChangeExtension($outputPath, "zip")
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Compress-Archive -Path (Join-Path $tempDir "*") -DestinationPath $zipPath -Force
Move-Item -Path $zipPath -Destination $outputPath -Force
Remove-Item $tempDir -Recurse -Force
Write-Output $outputPath
