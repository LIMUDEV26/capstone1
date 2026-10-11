# REAL TIME WORKFLOW, ACTIVITY LOG, IN PAYROLL MANAGEMENT SYSTEM WITH INTEGRATED ANALYTICS FOR ACCOUNTING FIRMS
## Cagayan de Oro College | College of Information Technology Education
### REVISED TESTING PLAN: LOGIN-TO-END SYSTEM FLOW
**Researchers:** Jana Vinzy E. Dacula, Jellianne Mariz L. Mulit, Mikie Angelyn A. Romero, Roberth B. Namoc, Shiela Mae B. Pacala

> This revision reorders all tests to follow the actual user journey in the implemented system: Login → Dashboard → Master Data (Branches/Employees/Users/Clients/Projects) → Workflow & Tasks → Documents & Services → Payroll & HR → Analytics & Reports → Activity Log & Notifications → Settings & Security → Logout. Based on codebase `pages/index.tsx` (Login), `components/AuthProvider.tsx`, `api/auth.php`, `pages/{dashboard,admin/dashboard,manager/dashboard}` etc.

---

## LEVEL 1: Master Unit Testing Registry (Login-to-End Sequence)

### Series 100: Authentication & Login (pages/index.tsx ↔ api/auth.php)
*Entry point of every workflow. Covers credential validation, hashing, session, captcha, lockout.*

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result |
|---|---|---|---|
| 1.1 | `normalizeLoginIdentifier(email)` | Input `test@com`, `@@domain.com`, `  TEST@Gmail.com  ` | Return false/invalid for malformed; normalized lowercase trimmed for valid |
| 1.2 | `validateGmailComEmail(email)` | Input non-gmail/phinmaed domain | Return false (Rejected) |
| 1.3 | `ValidatePasswordStrength(pwd)` | Input <8 chars, missing upper/number/symbol (`pass123`) | Return false (Weak) with reason |
| 1.4 | `hashPassword()` / `verifyPassword()` | Correct vs modified plain text against stored hash | Return true if match; false if modified |
| 1.5 | `authenticateLoginCredentials()` | Valid username/email + correct password | Return user record + set session |
| 1.6 | `authenticateLoginCredentials()` | Valid user + wrong password (1st-3rd fail) | Return 401 + `attempts_remaining` decrement |
| 1.7 | `checkAndIncrementLoginFailureCounter()` | 4th+ consecutive wrong password | Account `status=locked`, 403 lockout |
| 1.8 | `getIntruderIPLockoutConfig()` + `recordIntruderIPAttempt()` | 10 unknown-email attempts from same IP/brower | IP blocked until `blocked_until`, 429 Intruder Blocked |
| 1.9 | `handleLoginPrecheck()` | Correct credentials, `isLoginMathCaptchaEnabled=true` | Return `captcha_required:true, mode:custom, expires_in:90` and create `$_SESSION[pending_login]` |
| 1.10 | `isMathCaptchaVerified()` | `login_complete` called before auto_check delay | Return `still running` error + `retry_after_ms` |
| 1.11 | `setActiveSessionUserFromRecord()` | Successful login_complete | Session regenerated, `$_SESSION[user_id,role,branch_id,must_reset_password]` set |
| 1.12 | `preparePasswordExpirationForUser()` | Login where `password_expires_at < NOW()` | `must_reset_password=1, reason=expired`, redirect to `/change-password` |
| 1.13 | `sanitizeInput()` / `sanitizeHtmlInput()` | Input `<script>malicious()</script>` | Return stripped/encoded clean string (XSS protection) |
| 1.14 | `checkRolePermission(role,action)` | Staff attempts `POST /api/auth.php?action=register` or `/admin/settings` | Return false 403 Forbidden (admin-only) |

### Series 200: Session, RBAC & Dashboards (AuthProvider, dashboard.tsx, admin/dashboard.tsx, manager/dashboard.tsx)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 2.1 | `handleCheckSession()` | Valid session cookie | Return 200 + user + `dashboard_path` (/admin/dashboard, /manager/dashboard, /dashboard) |
| 2.2 | `enforceManagedRoleSessionTimeout()` | Manager/Staff idle >30min | Session invalidated, 401, redirect to `/` |
| 2.3 | `getRoleFeatureAccessMap()` | Admin vs Manager vs Staff session | Correct feature map returned (payroll, user mgmt visibility) |
| 2.4 | `useProtectedPage({allowedRoles})` | Staff directly visits `/admin/dashboard` | Redirect to `/403` Access Denied |
| 2.5 | `getManagedRoleSessionTimeoutConfig()` | Fetch `analytics.php` / `payroll_analytics.php` counts | Correct counts/trend aggregated for role's branch scope |
| 2.6 | `buildProjectDateEvents()` | Projects with start/end dates | Calendar event map with green start / red end dots |

### Series 300: Master Data Setup (Branches → Employees → Users)
*Must be done in order before transactions.*

| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 3.1 | `createBranch(name,location)` | Admin creates branch via `api/branches.php` | Return 201, branch_id, activity_log entry |
| 3.2 | `assertBranchExistsForRegister()` | Create user with non-existent branch_id | 404 Branch not found |
| 3.3 | `createEmployee(data)` | Valid employee with branch_id | Return employee_id, linked to branch |
| 3.4 | `assertManagerBranchAvailability()` | Second manager assigned to same branch | 409 Only one manager per branch |
| 3.5 | `handleRegister()` | Admin creates user (email @gmail.com, pwd 8+ upper/num/symbol) | 201, `must_reset_password=1`, username auto-generated, hash stored |
| 3.6 | `ensureUniqueUserFullName()` | Duplicate first+last name | 409 User with same name exists |
| 3.7 | `handleRegister()` duplicate email | Email already exists lowercased | 409 Email already in use |
| 3.8 | `generateUniqueUsernameFromEmail()` | `john.doe@gmail.com` taken | Appends `_1`, `_2` unique |
| 3.9 | `updateUser(branch/role/status)` | `api/users.php` change | Persisted, activity logged |
| 3.10 | `validateTaskFields()` missing | Title/due_date missing | Return false + missing list |

### Series 400: Client & Project Setup (clients ↔ projects)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 4.1 | `createClient(data)` | `api/clients.php` with name/contact | Return client_id, status active |
| 4.2 | `createProject(client_id,manager_id)` | Link client to project | Project created with correct FKs |
| 4.3 | `linkTaskToProject()` | Task with project_id | Task scoped to project |
| 4.4 | `updateProject(status)` | Archive project | No longer shown in active calendar |

### Series 500: Workflow & Task Management (api/tasks.php, task-workflow.php, calendar)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 5.1 | `createTask(title,assigned_to,due_date,priority)` | Manager creates task with all fields | New task `status=pending`, activity_log trigger |
| 5.2 | `assignTask(taskId,staffId)` | Reassign | Updated assignee + collaborators entry |
| 5.3 | `updateTaskStatus(taskId,newStatus)` | Staff marks `completed` | Status + `completion_timestamp` set |
| 5.4 | `addChecklistItem(taskId)` | Add service checklist | Item stored, proof_file nullable |
| 5.5 | `addCollaborator(taskId,userId,shift_mode)` | Add with shift_mode current_time/range | collaborator row created |
| 5.6 | `filterTasksByUser/branch/date` | Query with assigned_to + date range | Matching entries newest first |
| 5.7 | `validateAttendanceLog(entry)` analog for task due validation | due_date < start_date | Flag for review |

### Series 600: Documents, Services & Contracts (api/documents.php, services.php, contracts.php)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 6.1 | `uploadDocument(taskId,file)` | PDF/XLS upload via `serve-file.php` | File path stored, accessible by authorized branch |
| 6.2 | `createServiceChecklist()` | Service template linked to task | Checklist generated per client engagement |

### Series 700: Payroll & HR Engine (api/payroll.php, attendance_import.php, deduction-types.php, shift-schedules.php, overtime-requests.php, cash-advance.php)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 7.1 | `importBiometricLog(deviceLog)` / `preview_xls_import.php` | XLS time-in/out uploaded | Parsed entries matched to employee_id |
| 7.2 | `validateAttendanceLog(entry)` | Timeout < timein or missing pair | Flag for manual review |
| 7.3 | `convertLogToPayableHours(entry)` | Valid pair → hours | Correct hours matching manual compute |
| 7.4 | `calculateGrossPay(rate,hours)` | rate × hours | Gross pay 2 decimals |
| 7.5 | `applyDeductionTypes(gross)` | SSS/PhilHealth/Pag-IBIG threshold rules | Correct net pay, threshold_mode above/below applied |
| 7.6 | `aggregateMonthlyPayrollTotal(records)` | Month branch sum | Matches manual sum |
| 7.7 | `generatePayslip(employee,period)` | View `/my-payslips` | Correct payslip rendered, PDF export clean |
| 7.8 | `requestOvertime/cashAdvance/leave` | `overtime-requests.php`, `cash-advance-requests.php`, `leave-requests.php` | Request `pending` → manager approval inbox |
| 7.9 | `approveInbox(action)` | Manager `approval-inbox.php` approve/reject | Status updated, notification sent, activity logged |

### Series 800: Analytics, Reports & Exports (api/analytics.php, payroll_analytics.php, reports.php)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 8.1 | `aggregateTaskCompletionRate(records,staffId)` | Completed/assigned per staff | Correct % |
| 8.2 | `computeTrendVariance(current,prior)` | Two periods variance | Correct +/- % |
| 8.3 | `generateChartDataset(metric,branch,range)` | Filter by branch/range | Bucketed labels/values scoped correctly |
| 8.4 | `export Report PDF/CSV` | Click Export on reports | `.pdf` via jsPDF / CSV downloads uncorrupted formatted |

### Series 900: Real-Time Activity Log, Notifications & Security (api/activity-logs.php, notifications.php, security-control.php)
| Unit ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 9.1 | `logUserAction(userId,action,module)` | Any CRUD or payroll run | Append-only entry actor/action/module/timestamp/IP to `activity_log` |
| 9.2 | `timestampActivityEntry()` | Moment action fires | Server timestamp accurate to second |
| 9.3 | `filterActivityLogByUser(userId,range)` | Query by user+date | Matching newest-first |
| 9.4 | `searchActivityLog(keyword)` | Search task/client | Content match |
| 9.5 | `preventLogTampering(logId)` | Attempt edit/delete log | Rejected, immutable |
| 9.6 | `getNotifications(userId)` | After task assignment/payroll approve | Real-time feed without manual refresh (poll/liveSync) |
| 9.7 | `enforceIntruderBrowserLockout()` | Blocked browser hits any auth endpoint | 429 globally |

---

## LEVEL 2: Master Integration Testing Registry (Login-to-End Flow)

| Integration ID | Target Function | Testing Scenario Profile | Expected Result |
|---|---|---|---|
| 2.1 | **Login Screen ↔ Session/RBAC** | User (Admin/Manager/Staff) logs in via `pages/index.tsx` → `auth.php?action=login_precheck → login_complete` | Token/session stored via HttpOnly cookie, `AuthProvider` sets `dashboard_path`, role menu visible |
| 2.2 | **Dashboard ↔ Analytics/Payroll APIs** | Open role dashboard | Frontend fetches `analytics.php` + `payroll_analytics.php` + `projects.php?compact=calendar`, renders stats/cards/calendar/charts without full reload |
| 2.3 | **Branch → Employee → User Chain** | Admin creates Branch → Employee → User in sequence | FK integrity holds, manager-per-branch rule enforced, new user appears in `users.php` list |
| 2.4 | **Client → Project creation** | Create client then project linked to client | Project `client_id` persisted, visible in Projects list and calendar |
| 2.5 | **Task Creation Form ↔ Workflow API** | Manager creates task `POST /api/tasks.php` | Validated, persisted to `tasks`, returns 201, UI redirects to task list, activity log written |
| 2.6 | **Task Workflow ↔ Activity Logger** | Update status/collaborator/checklist | Same transaction writes to `activity_log` with actor/action/timestamp |
| 2.7 | **Biometric/XLS Import ↔ Payroll API** | Upload via `attendance_import.php` / `preview_xls_import.php` | Validated logs → `payable_hours` → available to `payroll.php` run |
| 2.8 | **Payroll Run ↔ Deduction/Analytics** | Admin runs payroll for period | Gross→deductions→net computed via `deduction_type` thresholds, `payroll_analytics.php` KPI updated |
| 2.9 | **Live Activity Feed ↔ Log Query** | Open ActivityLogsPanel while multi-branch users act | Frontend polls/subscribes, feed appends in real-time |
| 2.10 | **Branch Data Entry ↔ Centralized DB Sync** | User at Branch A creates task/payroll | Written to centralized MySQL `llb`, visible to authorized Branch B instantly |
| 2.11 | **Approval Inbox ↔ Notifications** | Staff requests overtime → Manager approves | `approval-inbox.php` status change triggers `notifications.php` + email via `mailer.php` |
| 2.12 | **Document Upload ↔ Serve-File** | Upload PDF to task | `uploads/` path stored, `serve-file.php` streams with auth check |
| 2.13 | **Settings ↔ System Behavior** | Change OT multiplier, session timeout, password policy | Saved to `settings` table, applied to next payroll/session, audit logged |

---

## LEVEL 3: Master System Testing Registry (End-to-End via UI, starts at Login)

### Series 100: Login & Access
| System Test ID | Module | Step-by-Step Execution Procedure | Test Data/Inputs | Expected System Response |
|---|---|---|---|---|
| 3-1.1 | Login Success | 1. Go `/` 2. Enter valid gmail.com email + strong password 3. Click LOG IN 4. Pass robot check (if shown) | Valid creds | Success checkmark → redirect to role dashboard |
| 3-1.2 | Login Failure | 1. `/` 2. Valid user + wrong password 3. Click LOG IN | WrongPass123 | "Invalid credentials", password cleared, attempts_remaining shown (3→2→1) |
| 3-1.3 | Account Lockout | Repeat 3-1.2 until threshold | 4th fail | Account locked, toast + "contact admin", status=locked |
| 3-1.4 | Intruder IP Block | Use non-existent email 10x from same browser | fake@nowhere.com ×10 | 429 "INTRUDER BLOCKED" on 10th, blocks even valid login until admin unblocks |
| 3-1.5 | Password Masking | At `/`, type in password field | Any string | Masked bullets ••••••, eye toggle shows/hides |
| 3-1.6 | Forgot Password | Click Forgot password with email filled | existing email | Redirect to `/forgot-password?email=...` OTP/email code flow |
| 3-1.7 | First-Login Force Change | Login with admin-created temp password | new user temp pwd | Forced redirect to `/reset-password?mode=first_login`, cannot access dashboard until changed |
| 3-1.8 | Password Expiry | Login with expired `password_expires_at` | expired user | Redirect `/change-password?reason=expired` |
| 3-1.9 | Role-Based Redirect | Login as Staff, manually enter `/admin/dashboard` | `/admin/dashboard` URL | Blocked → `/403` Access Denied |
| 3-1.10 | Session Logout | Click Logout → hit Back button | - | Session terminated, Back does not restore protected page, redirects to `/` |

### Series 200: Dashboards Post-Login
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-2.1 | Staff Dashboard | Login Staff → land `/dashboard` | - | Shows My Tasks stats (Total/Open/Completed/Due Today/Overdue), Project Count, Task Distribution doughnut, Trends line, Calendar mini |
| 3-2.2 | Admin Dashboard | Login Admin → `/admin/dashboard` | - | Banner + counts (Users/Projects/Payroll pending), payroll KPI, monthly bar, activity feed |
| 3-2.3 | Manager Dashboard | Login Manager → `/manager/dashboard` | - | Precheck/payroll approvals, team tasks |
| 3-2.4 | Calendar Drill-down | Click calendar day with green/red dot | date with projects | Modal lists tasks for that date, filtered by project_ids |

### Series 300: Master Data (in order)
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-3.1 | Branches | Admin → Branches → Add → Save | New branch | Row appears, duplicate prevented |
| 3-3.2 | Employees | Employees → Add → Save | Valid employee + branch | Appears, salary numeric validation |
| 3-3.3 | Users | Users → Create → Fill email/gmail, first/last, role, branch → Save | john@gmail.com / Str0ng!Pass | 201, appears in list, must_reset_password=1 |
| 3-3.4 | Duplicate User | Same email | duplicate | 409 Email already in use |
| 3-3.5 | One Manager Per Branch | Create 2nd manager same branch | same branch_id | 409 Only one manager per branch |
| 3-3.6 | Form Validation | Leave required fields blank → Submit | blank | Inline "This field is required" |
| 3-3.7 | Numeric Boundaries | Rate field type "Five Hundred" | text | "Please enter valid numeric value" |

### Series 400: Client & Project Flow
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-4.1 | Create Client | Clients → Add → Save | Client data | Active client row, appears in dropdowns |
| 3-4.2 | Create Project | Projects → Add → link Client + Manager → Save | Valid project dates/budget | Project active, visible in calendar at start/end dates |

### Series 500: Task Workflow
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-5.1 | Create Task | Tasks → Create → assign Staff, due date, priority, project → Save | Valid task | Status Pending, appears in assignee My Tasks + activity log |
| 3-5.2 | My Tasks | Staff view `/my-tasks` | - | Assigned + collaborated tasks listed, pagination correct |
| 3-5.3 | Task Detail & Status | Open task → change to In Progress → Completed | status change | Timestamp updated, log entry, doughnut counts update |
| 3-5.4 | Collaborators & Shifts | Add collaborator with shift range | user + dates | Collaborator row shows, shift validated |
| 3-5.5 | Checklist | Add checklist item + proof file | description | Item appears, completion toggles with proof |
| 3-5.6 | Search/Filter Tasks | Filter by status/branch/date | filters | Only matching tasks, newest first |
| 3-5.7 | Pagination | Next/Page 2 on tasks/payroll list | click | No duplicate/skip rows |

### Series 600: Documents & Services
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-6.1 | Upload Document | Task → Documents → Upload PDF | file | Stored, preview via serve-file, branch auth enforced |

### Series 700: Payroll & HR End-to-End
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-7.1 | XLS Attendance Import | Payroll Import Review → Upload XLS | biometric export | Preview parsed, matched to employee_id, errors flagged |
| 3-7.2 | Validate & Convert to Hours | Confirm import | valid pairs | Payable hours calculated matching manual |
| 3-7.3 | Run Payroll | Payroll Management → Select period → Run Payroll → Confirm | period | Gross→deductions→net computed 2 decimals, summary generated, no errors |
| 3-7.4 | Payslip View | My Payslips → View period | - | Correct breakdown, PDF export downloads clean |
| 3-7.5 | Deduction Types CRUD | Settings → Deduction Types → Add/Edit | threshold rules | Saved, applied next run, logged |
| 3-7.6 | Leave/Overtime/Cash Advance | Staff request → Manager Approval Inbox → Approve/Reject | request | Pending→Approved, notification delivered, payroll adjusted |
| 3-7.7 | Shift Schedules | Create shift | dates | Created, visible in calendar |

### Series 800: Analytics, Reports, Notifications
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-8.1 | Analytics | Open Analytics | branch+range filter | Charts bucketed correctly scoped to branch/range |
| 3-8.2 | Trend Variance | Select multi-period | 2 periods | Period-over-period variance correct |
| 3-8.3 | Math Audit | Run test batch → open analytics | simulated data | System totals = manual totals |
| 3-8.4 | PDF Export | Reports → Export PDF | click | Clean formatted PDF via jsPDF downloads |
| 3-8.5 | Excel/CSV Export | Reports → Export Excel/CSV | click | Uncorrupted file |
| 3-8.6 | Notifications | Perform payroll/task action → check bell | action | Real-time notification without manual refresh |

### Series 900: Activity Log & Security (Final before Logout)
| ID | Module | Procedure | Inputs | Expected |
|---|---|---|---|---|
| 3-9.1 | Live Log | Open Activity Log panel → second session edits task | concurrent action | New entry appears realtime |
| 3-9.2 | Filtering | Filter log by user + date range | user+range | Only matches, sorted recent first |
| 3-9.3 | Immutability | Attempt edit/delete log row directly | edit attempt | Blocked, append-only |
| 3-9.4 | Cross-Branch Visibility | Action at Branch A → view at Branch B manager | branch A action | Visible centralized in real time |
| 3-9.5 | Settings Profiling | Change OT multiplier/session timeout → Save | new value | Saved, applied next run, logged |
| 3-9.6 | Scope Compliance | Look for BIR/SSS/PhilHealth submission button | payroll screen | No such function; only manual-reference reports (limitation compliance) |
| 3-9.7 | Logout Termination | Click Logout | - | Session destroyed, protected pages inaccessible, login required again |

---

## LEVEL 4: User Acceptance Testing (UAT) - ISO/IEC 25010 (unchanged structure, now traces login-to-end journey)

**Participant Matrix (4 purposive respondents, Lope Laranjo Bato & Co., CPAs – Main Branch)**

| ID | Role | Org/Branch | Date | Sig |
|---|---|---|---|---|
| 1 | Administrator | Main | __ / __ /2026 | |
| 2 | Manager | Main | __ / __ /2026 | |
| 3 | Accounting Staff | Main | __ / __ /2026 | |
| 4 | Accounting Staff | Main | __ / __ /2026 | |

**Likert 5=SA ... 1=SD – evaluate after executing full login-to-logout script above.**

Functional Suitability, Usability, Performance, Security, Reliability, Maintainability/Portability sections as originally designed (retain).

**Formal Sign-Off:** *"By signing below, I confirm participation in UAT covering the full login-to-logout workflow and accept for live deployment."*

---

*Generated 2026-08-22 from actual codebase | Source of truth: `pages/index.tsx`, `api/auth.php`, `Capstone1.sql`, dashboards & modules list.*
