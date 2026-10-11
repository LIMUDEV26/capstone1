
# REAL TIME WORKFLOW, ACTIVITY LOG, IN PAYROLL MANAGEMENT SYSTEM WITH INTEGRATED ANALYTICS FOR ACCOUNTING FIRMS
## Cagayan de Oro College | College of Information Technology Education

**RESEARCHER**
Jana Vinzy E. Dacula
Jellianne Mariz L. Mulit
Mikie Angelyn A. Romero
Roberth B. Namoc
Shiela Mae B. Pacala

---

## LEVEL 1: Master Unit Testing Registry

### Series 100: Login and Authentication
Focuses on the login page behavior, credential checking, captcha, account lockout, and session creation from the moment the user opens the system.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 1.1 | Login page load | Open the system URL in a browser. | Login page displays with company name, email, password, and Log In button. | Login page loaded with all required fields visible. | |
| 1.2 | Email format check | Type a malformed email and click Log In. | Error shown; login blocked. | Inline error appeared; form blocked. | |
| 1.3 | Email domain restriction | Type an email outside gmail.com or phinmaed.com and click Log In. | Error shown; only allowed domains accepted. | Error shown; login blocked. | |
| 1.4 | Password masking | Type any text into the password field. | Characters hidden as bullet dots. | All characters masked throughout. | |
| 1.5 | Show and hide password | Click the eye icon beside the password field. | Password toggles visible and masked. | Toggle worked on each click. | |
| 1.6 | Remember Me checkbox | Check Remember Me, log in, close browser, reopen login page. | Email pre-filled on next visit. | Email was pre-filled on return. | |
| 1.7 | Wrong password attempt | Enter valid email and incorrect password, click Log In. | Error shown; attempts counter decreases. | Error toast shown; counter decremented. | |
| 1.8 | Account lockout | Enter wrong password four or more times. | Account locked; toast to contact admin. | Account locked on 4th failed attempt. | |
| 1.9 | Intruder browser block | Enter non-existent email ten times. | "INTRUDER BLOCKED" shown on 10th attempt. | Page displayed INTRUDER BLOCKED on attempt 10. | |
| 1.10 | Math captcha shown | Log in with valid credentials when captcha is enabled. | Math equation shown; answer required. | Captcha equation appeared after credentials. | |
| 1.11 | Math captcha wrong answer | Answer captcha with wrong number. | Error shown; captcha refreshes. | Error shown; new equation generated. | |
| 1.12 | Math captcha correct answer | Answer captcha with correct number. | Login proceeds; redirected to dashboard. | Login completed; redirected to dashboard. | |
| 1.13 | Robot check countdown | Wait for robot verification step after login. | "I am not a robot" checkbox appears after delay. | Checkbox appeared after delay; ticking allowed login. | |
| 1.14 | Successful login as Admin | Enter valid Admin credentials, complete captcha, click Log In. | Redirected to Admin Dashboard. | Redirected to Admin Dashboard. | |
| 1.15 | Successful login as Manager | Enter valid Manager credentials, complete captcha, click Log In. | Redirected to Manager Dashboard. | Redirected to Manager Dashboard. | |
| 1.16 | Successful login as Staff | Enter valid Staff credentials, complete captcha, click Log In. | Redirected to Staff Dashboard. | Redirected to Staff Dashboard. | |
| 1.17 | First-login forced password reset | Log in with a new account using a temporary password. | Redirected to Reset Password page; dashboard inaccessible. | Reset Password page loaded; dashboard blocked. | |
| 1.18 | Expired password redirect | Log in with an account whose password has expired. | Redirected to Change Password page with expiry notice. | Redirected to Change Password with expiry message. | |
| 1.19 | Forgot password link | Click Forgot Password on the login page. | Redirected to Forgot Password page. | Navigated to Forgot Password page. | |
| 1.20 | Role-based redirect blocked | Log in as Staff; type Admin URL directly. | Redirected to 403 Access Denied page. | 403 Access Denied page displayed. | |

### Series 200: Password Recovery and Change
Focuses on the Forgot Password flow, Reset Password page, and in-session Change Password.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 2.1 | Forgot password — registered email | Enter a registered email on Forgot Password page and submit. | Confirmation message: reset link sent. | Success message displayed. | |
| 2.2 | Forgot password — unknown email | Enter an unregistered email and submit. | Error: no account found. | Error message displayed. | |
| 2.3 | Reset password page loads | Open the password reset link. | New password and confirm fields shown. | Page loaded with both fields and strength indicator. | |
| 2.4 | Reset — mismatched passwords | Enter two different passwords and submit. | Error: passwords do not match. | Inline mismatch error shown. | |
| 2.5 | Reset — weak password | Enter a password missing required characters. | Error listing each missing requirement. | All policy errors listed individually. | |
| 2.6 | Successful password reset | Enter a valid strong password and submit. | Password updated; redirected to login. | Reset successful; redirected to login. | |
| 2.7 | Change password from user menu | Navigate to Change Password while logged in. | Form with current, new, and confirm fields shown. | Form displayed with all three fields. | |
| 2.8 | Wrong current password on change | Enter wrong current password and submit. | Error: current password incorrect. | Error shown; no change applied. | |
| 2.9 | Successful password change | Enter correct current password and new valid password. | Password updated; success message shown. | Password updated; success toast shown. | |

### Series 300: Dashboards and Navigation
Focuses on what each role sees after login and how the navigation and calendar behave.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 3.1 | Admin Dashboard content | Log in as Admin and view the dashboard. | Summary cards, payroll chart, task chart, activity log, mini calendar. | All components rendered on load. | |
| 3.2 | Manager Dashboard content | Log in as Manager and view the dashboard. | Task cards, approval counts, team task list, trend chart, mini calendar. | All manager widgets rendered. | |
| 3.3 | Staff Dashboard content | Log in as Staff and view the dashboard. | My Tasks cards, doughnut chart, trend line, mini calendar. | All staff widgets rendered. | |
| 3.4 | Dashboard mini calendar display | View the mini calendar on any dashboard. | Current month shown; project dates have colored dots. | Current month shown with project dots. | |
| 3.5 | Calendar day click | Click a date with a dot on the dashboard calendar. | Overlay opens listing projects or tasks for that date. | Overlay opened with project details. | |
| 3.6 | Calendar month navigation | Click left and right arrows on the mini calendar. | Calendar moves to previous or next month. | Navigation moved calendar correctly. | |
| 3.7 | Chart tooltips | Hover over any chart segment. | Tooltip shows exact value and label. | Tooltip shown with correct value. | |
| 3.8 | Activity log panel on dashboard | View the activity log panel on Admin or Manager dashboard. | Entries with actor, action, module, and timestamp. | Log entries shown with all fields. | |
| 3.9 | Sidebar navigation visibility | Check the left sidebar for each role. | Only role-permitted modules visible. | Sidebar filtered correctly per role. | |

### Series 400: Master Data — Branches, Employees, and Users
Focuses on creating and managing the core records that all other modules depend on.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 4.1 | Branches page loads | Navigate to Branches as Admin. | Table with name, location, and status. | Page loaded with correct columns. | |
| 4.2 | Add new branch | Fill in name and location, save. | New branch appears in the list. | Branch saved and listed. | |
| 4.3 | Duplicate branch blocked | Add a branch with an existing name. | Error: branch name already exists. | Error toast shown; not saved. | |
| 4.4 | Edit branch | Edit a field and save. | Change saved in the table. | Edit saved; table updated. | |
| 4.5 | Archive and restore branch | Archive a branch; restore from archived view. | Archived and returned on restore. | Archive and restore both worked. | |
| 4.6 | Employees page loads | Navigate to Employees. | List with name, position, branch, type, and status. | Page loaded with correct columns. | |
| 4.7 | Add new employee | Complete all required fields and save. | Employee in list linked to branch. | Employee saved with correct branch. | |
| 4.8 | Duplicate government number blocked | Enter an SSS or PhilHealth number already in use. | Error: government number already in use. | Error shown; not saved. | |
| 4.9 | View employee detail | Click View on an employee row. | Modal with all fields and document checklist. | Modal opened with all sections. | |
| 4.10 | Archive and restore employee | Archive; then restore from archived view. | Removed on archive; returns on restore. | Archive and restore both worked. | |
| 4.11 | Users page loads | Navigate to Users as Admin. | List with name, email, role, branch, status. | Page loaded with correct columns. | |
| 4.12 | Create new user | Fill all fields with valid email, role, branch, save. | User created; forced password reset on first login. | User created; reset forced on login. | |
| 4.13 | Duplicate email blocked | Create a user with an email already in the system. | Error: email already in use. | Error shown; not saved. | |
| 4.14 | Duplicate full name blocked | Create a user with a name already in use. | Error: name already exists. | Error shown; not saved. | |
| 4.15 | One manager per branch rule | Assign a second Manager to a branch that already has one. | Error: branch already has a manager. | Error shown; assignment blocked. | |
| 4.16 | Minimum age validation | Enter a birthdate making the user under 18. | Error: must be at least 18. | Error shown next to birthdate field. | |
| 4.17 | Archive and restore user | Archive; then restore from archived view. | Removed on archive; returns on restore. | Archive and restore both worked. | |
| 4.18 | Alphabet filter on users | Click a letter in the alphabet filter. | Only matching names shown. | List filtered to matching names. | |
| 4.19 | Pagination on lists | Navigate to page 2 on a list with more than 10 records. | Next set of records loads; no duplicates. | Page 2 loaded with correct records. | |

### Series 500: Clients, Projects, Services, and Contracts
Focuses on client and project setup and the related services and contracts modules.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 5.1 | Add new client | Fill required fields and save. | Client listed as active. | Client saved with Active status. | |
| 5.2 | Assign services to client | Select services in client form and save. | Services linked and shown in client detail. | Services saved and shown in detail. | |
| 5.3 | Add additional contact to client | Add a secondary contact and save. | Contact saved in client detail. | Contact saved under Contacts section. | |
| 5.4 | Create project from client | Click Start Project, assign manager, set dates, save. | Project linked to client; visible in list and calendar. | Project saved and visible in list and calendar. | |
| 5.5 | Project date validation | Set end date earlier than start date. | Error: end date must be after start date. | Error shown; not saved. | |
| 5.6 | Project calendar dots | View calendar after adding a project with dates. | Green dot on start date; red dot on end date. | Green and red dots shown on correct dates. | |
| 5.7 | Pin project | Click Pin on a project. | Pinned project moves to top of list. | Project moved to top with pin badge. | |
| 5.8 | Add new service | Fill name and description, save. | Service appears in the list. | Service saved and listed. | |
| 5.9 | Add checklist item to service | Open a service and add a checklist task. | Item saved under the service. | Item saved with completion toggle. | |
| 5.10 | Create contract | Fill all fields and save. | Contract in list with correct status. | Contract saved with Active status. | |
| 5.11 | Upload signed contract | Upload a signed PDF to a contract detail. | File uploaded; preview link available. | File uploaded; preview link appeared. | |
| 5.12 | Print contract | Click Print in a contract detail. | Print dialog opens. | Print dialog opened. | |
| 5.13 | Create project from contract | Click Create Project inside an active contract. | Project form pre-filled; linked to contract. | Pre-filled form saved and linked. | |

### Series 600: Tasks and Workflow
Focuses on the Tasks board, task creation, status changes, comments, checklists, and the My Tasks staff view.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 6.1 | Tasks board loads | Navigate to Tasks. | Kanban board with Backlog, In Progress, Review, Done. | Board loaded with all four columns. | |
| 6.2 | Create new task | Fill all required fields and save. | Task card in Backlog with correct details. | Task card appeared in Backlog. | |
| 6.3 | Required fields blocked | Leave title or due date blank and save. | Inline errors shown; task not saved. | Errors shown; task not saved. | |
| 6.4 | Drag task to new column | Drag a task card to another column. | Task moves; status updates. | Status updated on drop. | |
| 6.5 | Priority color on task card | View cards of different priority levels. | Low, Medium, High, Urgent show distinct colors. | All four priorities showed correct colors. | |
| 6.6 | Overdue date highlight | View a task past its due date. | Due date shown in red. | Overdue date shown in red. | |
| 6.7 | Open task detail | Click on a task card. | Detail panel with all fields and comments. | Detail panel opened with all sections. | |
| 6.8 | Add collaborator | Add a collaborator with a shift range. | Collaborator saved; name shown in detail. | Collaborator saved and displayed. | |
| 6.9 | Add checklist item to task | Add a service checklist item in task detail. | Item in checklist with completion toggle. | Item added with toggle. | |
| 6.10 | My Tasks page loads | Navigate to My Tasks as Staff. | All assigned or collaborated tasks listed. | Correct tasks listed for logged-in user. | |
| 6.11 | Update task status from My Tasks | Change status to In Progress or Completed. | Status updated; completion timestamp shown. | Status updated with timestamp. | |
| 6.12 | Add comment to task | Type and submit a comment. | Comment in thread with name and timestamp. | Comment appeared with name and timestamp. | |
| 6.13 | Upload file in task | Attach a file in a comment or workflow step. | File saved; download link shown. | File saved; download link appeared. | |
| 6.14 | Submit workflow step | Complete a workflow step with description and file. | Submission recorded with timestamp. | Submission recorded in task history. | |
| 6.15 | Filter tasks by status | Use status filter dropdown. | Only selected-status tasks shown. | List filtered to selected status. | |

### Series 700: HR Requests — Leave, Overtime, Cash Advance, and Approval
Focuses on the submission and approval workflow for all staff HR requests.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 7.1 | Submit leave request | Fill all fields and submit. | Request appears as Pending. | Request saved with Pending status. | |
| 7.2 | Leave type dropdown | Open leave type dropdown. | Vacation, Sick, Emergency, and other types shown. | All leave types listed. | |
| 7.3 | Approve leave | Click Approve on a pending request. | Status Approved; notification sent. | Status Approved; notification delivered. | |
| 7.4 | Reject leave | Click Reject and enter a reason. | Status Rejected; reason stored. | Status Rejected; reason saved. | |
| 7.5 | Leave balance display | View leave balance for an employee. | Remaining days per type with balance bar. | Balance shown with progress bar. | |
| 7.6 | Leave planner view | Switch to Leave Planner tab. | Monthly calendar with team leave. | Calendar displayed with team leaves. | |
| 7.7 | Submit overtime request | Fill all fields and submit. | Request appears as Pending. | Request saved with Pending status. | |
| 7.8 | Approve overtime | Click Approve on pending overtime. | Status Approved; activity logged. | Status Approved; log entry created. | |
| 7.9 | Reject overtime | Click Reject and enter a reason. | Status Rejected. | Status Rejected; reason saved. | |
| 7.10 | Submit cash advance | Fill all fields and submit. | Request appears as Pending. | Request saved with Pending status. | |
| 7.11 | Invalid amount blocked | Enter zero or non-numeric amount. | Error: enter a valid amount. | Error shown; not submitted. | |
| 7.12 | Approve cash advance | Click Approve on pending cash advance. | Status Approved. | Status changed to Approved. | |
| 7.13 | Mark cash advance as deducted | Click Mark as Deducted on approved advance. | Deducted badge shown. | Deducted badge displayed on row. | |
| 7.14 | Manager Approval Inbox | Navigate to Approval Inbox as Manager. | All pending requests listed with count cards. | Inbox loaded with count cards and list. | |
| 7.15 | Approve from Approval Inbox | Click Approve in the inbox. | Status updated; notification sent. | Status updated; notification delivered. | |
| 7.16 | Filter Approval Inbox by type | Select a type filter. | Only selected type shown. | List filtered to selected type. | |

### Series 800: Attendance, Shifts, Payroll, and Payslips
Focuses on shift schedules, attendance viewing, payroll import and run, and payslip access.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 8.1 | Shift Schedules page loads | Navigate to Shift Schedules. | Table with employee, type, date, times, status. | Page loaded with correct columns. | |
| 8.2 | Add new shift | Fill all fields and save. | Shift appears in the table. | Shift saved and listed. | |
| 8.3 | Shift type options | Open shift type dropdown. | Morning, Afternoon, Night, Flexible shown. | All four types listed. | |
| 8.4 | Filter shifts by date range | Enter start and end date filter. | Only in-range shifts shown. | Filter applied; correct rows shown. | |
| 8.5 | My Attendance page loads | Navigate to My Attendance as Staff. | Personal records with date, time in/out, type, status. | Page loaded with correct columns. | |
| 8.6 | Attendance status badges | View attendance list rows. | Scheduled=blue, Completed=green, No Show=red, Cancelled=gray. | All badges showed correct colors. | |
| 8.7 | Upload attendance XLS | Upload a biometric export XLS file. | Preview with parsed entries matched to employees. | Preview table shown with matched entries. | |
| 8.8 | Invalid entry flagged on import | Upload file with invalid time pairs. | Problematic entry highlighted for review. | Invalid rows highlighted in preview. | |
| 8.9 | Confirm attendance import | Click Confirm on clean preview. | Attendance data saved for payroll run. | Data saved; available in payroll period. | |
| 8.10 | Run payroll | Select pay period, click Run Payroll, confirm. | Gross, deductions, net computed; summary generated. | Payroll computed with no errors. | |
| 8.11 | Payroll summary review | View payroll summary after running. | Per-employee gross, deductions, net and grand total. | Summary shown with all figures and total. | |
| 8.12 | My Payslips page loads | Navigate to My Payslips as Staff. | List with pay period, gross, net, status. | Page loaded with correct columns. | |
| 8.13 | View payslip detail | Click View on a payroll period row. | Full earnings and deductions breakdown. | Payslip opened with itemized breakdown. | |
| 8.14 | Print payslip | Click Print in payslip view. | Print dialog opens. | Print dialog opened. | |
| 8.15 | Download payslip | Click Download and select a format. | File downloads in CSV, TXT, or JSON. | File downloaded in selected format. | |

### Series 900: Documents, Calendar, Analytics, Reports, Notifications, and Logout
Focuses on the remaining modules and the end of the user journey.

| Unit ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 9.1 | Documents page loads | Navigate to Documents. | List with name, type, date, status. | Page loaded with correct columns. | |
| 9.2 | Add document record | Fill all fields and save. | Record appears in the list. | Record saved and listed. | |
| 9.3 | Calendar Management page loads | Navigate to Calendar Management as Admin. | Full month calendar with marked holidays. | Calendar loaded with holidays marked. | |
| 9.4 | Add holiday | Fill name, date, type, scope, save. | Holiday shown on calendar and list. | Holiday appeared on calendar and list. | |
| 9.5 | Edit and delete holiday | Edit a holiday; delete another. | Edit saves; delete removes from calendar. | Edit saved; delete removed holiday. | |
| 9.6 | Comment on holiday | Add a comment; reply to a comment. | Comment saved; reply threaded below. | Comment and reply saved correctly. | |
| 9.7 | Analytics page loads | Navigate to Analytics. | Summary cards, doughnut chart, trend chart. | All analytics components rendered. | |
| 9.8 | Analytics time period filter | Select Week, Month, or Year. | Charts update to selected period. | Charts updated without page reload. | |
| 9.9 | Reports page loads | Navigate to Reports. | Report type selector and filter panel shown. | Page loaded with selector and filters. | |
| 9.10 | Generate a report | Select type, apply filters, click Generate. | Report preview with charts and table. | Preview rendered with correct data. | |
| 9.11 | Export report to PDF | Click Export to PDF. | PDF downloads with report content. | PDF downloaded correctly. | |
| 9.12 | Export report to CSV or Excel | Click Export to Excel or CSV. | File downloads uncorrupted. | File downloaded without corruption. | |
| 9.13 | Notifications page loads | Navigate to Notifications. | List with title, type, severity, read/unread. | Page loaded with correct columns. | |
| 9.14 | Unread notification badge | Check bell icon after new notification. | Red dot on bell icon. | Red dot appeared on bell icon. | |
| 9.15 | Mark notifications as read | Click Mark All as Read. | All read; red dot removed. | All marked read; dot removed. | |
| 9.16 | Activity log real-time update | Open log panel; perform action in second session. | New entry appears without page refresh. | New entry appeared without refresh. | |
| 9.17 | Activity log filter | Filter by user and date range. | Only matching entries shown, newest first. | Filtered entries shown newest first. | |
| 9.18 | Activity log immutability | Look for edit or delete on any log entry. | No edit or delete button exists. | No edit or delete option found. | |
| 9.19 | Settings — Password Policy | Change minimum length and save. | New minimum enforced on next attempt. | New policy applied on next attempt. | |
| 9.20 | Settings — Session Timeout | Change timeout value and save. | Session expires at new duration. | Session expired at configured duration. | |
| 9.21 | Settings — Math Captcha toggle | Toggle captcha switch and save. | Captcha appears or disappears on login. | Toggle applied on login page. | |
| 9.22 | Settings — Account Lockout | Find a locked user and click Unlock. | User can log in again. | User unlocked and able to log in. | |
| 9.23 | Settings — Role Access Control | Toggle a feature off for Staff and save. | Feature removed from Staff navigation. | Feature hidden from Staff sidebar. | |
| 9.24 | Profile page | Navigate to Profile. | Personal info, photo, government numbers shown. | Profile page loaded with all fields. | |
| 9.25 | Submit profile edit request | Attempt to edit a locked field such as email. | Edit request submitted; field unchanged. | Edit request submitted; field unchanged. | |
| 9.26 | Logout | Click Logout in the sidebar. | Session destroyed; redirected to login. | Session ended; login page shown. | |
| 9.27 | Back button after logout | Click browser Back after logout. | Protected page does not load; login shown. | Redirected to login; page not restored. | |
| 9.28 | Session expiry auto-logout | Leave session idle past timeout. | Session expires; redirected to login. | Session expired; login page shown. | |

---

## LEVEL 2: Master Integration Testing Registry

### Series 100: Presentation Layer to Application Logic Layer
Tests how the front-end screens connect to the back-end and how data flows correctly across modules from login to logout.

| Integration ID | Target Function | Testing Scenario Profile (step by step) | Expected Result | Actual Result | Remarks |
|---|---|---|---|---|---|
| 1.1 | Login screen to session and role menu | Log in as each role one at a time. | Each role redirected to correct dashboard; sidebar scoped by role. | All roles redirected correctly; sidebars scoped. | |
| 1.2 | Task creation form to task list | Create a task as Manager and save. | Task in Kanban and assignee's My Tasks; activity logged. | Task appeared in both views; log entry created. | |
| 1.3 | Attendance import to payroll run | Import XLS, confirm, then run payroll for same period. | Payable hours used in gross pay; no errors. | Payroll computed from import data correctly. | |
| 1.4 | Payroll run to activity log | Run payroll; open Activity Log. | Log entry with actor and timestamp. | Log entry appeared after payroll run. | |
| 1.5 | Analytics dashboard to reports | Note dashboard figures; generate report for same period. | Dashboard totals match report; charts update without reload. | Totals matched; charts updated without reload. | |
| 1.6 | Leave request to Approval Inbox | Submit leave as Staff; check as Manager. | Request in Approval Inbox as Pending. | Request appeared as Pending in inbox. | |
| 1.7 | Approval to notification | Manager approves request in inbox. | Staff receives in-app notification. | Notification delivered to staff. | |
| 1.8 | Live activity feed across sessions | Act in Tab 2; watch Tab 1 log panel. | New entry appears without manual refresh. | Log panel updated without refresh. | |
| 1.9 | Branch data entry to centralized view | Create record at Branch A; check at Branch B. | Record immediately visible at Branch B. | Record visible at Branch B in real time. | |

---

## LEVEL 3: Master System Testing Registry

### Series 100: User Authentication and Account Management
Validates complete end-to-end workflows through the actual user interface.

| System Test ID | Module | Step-by-Step Execution Procedure | Test Data / Inputs | Expected System Response | Actual Result | Remarks |
|---|---|---|---|---|---|---|
| 1.1 | Login — wrong password | 1. Open Login page. 2. Enter valid email, wrong password. 3. Click Log In. | WrongPass123 | Login fails; error shown; field cleared; attempts decremented. | Login failed; error shown; field cleared; counter decremented. | |
| 1.2 | Login — password masking | 1. Open Login page. 2. Type into password field. | Any string | Characters shown as bullet dots. | All characters masked as dots. | |
| 1.3 | Login — role redirect | 1. Log in as Admin. 2. Log out. 3. Log in as Manager. 4. Log out. 5. Log in as Staff. | Valid credentials per role | Each role goes to correct dashboard. | Each role redirected to correct dashboard. | |
| 1.4 | Login — role-based access block | 1. Log in as Staff. 2. Type Admin URL in browser. | /admin/settings | System blocks; displays Access Denied. | 403 Access Denied shown. | |
| 1.5 | Login — form validation | 1. Open Login page. 2. Leave fields blank. 3. Click Log In. | Blank fields | Submission blocked; inline errors shown. | Blocked; inline errors shown. | |
| 1.6 | Login — account lockout | 1. Enter wrong password four times. 2. Try a fifth time. | Wrong password repeated | Account locked on 4th; refused on 5th. | Account locked on 4th attempt. | |
| 1.7 | Session logout | 1. Log in. 2. Click Logout. 3. Click browser Back. | (none) | Session ended; Back does not restore page. | Session ended; Back redirected to login. | |
| 1.8 | First-login forced reset | 1. Log in with temporary password. | Temporary password | Redirected to Reset Password; dashboard blocked. | Reset page shown; dashboard blocked. | |

### Series 200: Workflow, Task, and Payroll Record Processing

| System Test ID | Module | Step-by-Step Execution Procedure | Test Data / Inputs | Expected System Response | Actual Result | Remarks |
|---|---|---|---|---|---|---|
| 2.1 | Duplicate user email | 1. Navigate to Users. 2. Fill in existing email. 3. Save. | Existing email | Blocked; warning: email already registered. | Blocked; warning shown. | |
| 2.2 | Task assignment and activity log | 1. Create task. 2. Assign staff with due date. 3. Save. | Valid task data | Task Active; in assignee list; log entry created. | Task created; log entry recorded. | |
| 2.3 | Numeric field input boundary | 1. Open rate form. 2. Type letters in rate field. 3. Save. | "Five Hundred" | Rejected; error: enter valid numeric value. | Rejected; numeric error shown. | |
| 2.4 | Payroll record edit | 1. Select payroll entry. 2. Edit value. 3. Update. | Updated value | Grid updates; log records change; persists on refresh. | Grid updated; log entry created; persisted. | |
| 2.5 | Record deletion with confirmation | 1. Select a record. 2. Click Delete. | (none) | Confirmation modal; removed after confirm; log entry. | Modal shown; removed after confirm; logged. | |
| 2.6 | Full payroll run | 1. Import XLS. 2. Select period. 3. Run Payroll. | Imported biometric data | Gross, deductions, net computed; summary generated. | Payroll computed; summary generated. | |
| 2.7 | Table pagination | 1. Navigate to a long list. 2. Click Next. | 11 or more records | Next page loads; no duplicates or skipped rows. | Next page loaded with correct records. | |

### Series 300: Real-Time Activity Log and Audit Trail

| System Test ID | Module | Step-by-Step Execution Procedure | Test Data / Inputs | Expected System Response | Actual Result | Remarks |
|---|---|---|---|---|---|---|
| 3.1 | Live log on dashboard | 1. Open Activity Log panel. 2. Act in second session. | Concurrent user action | New entry appears without refresh. | Entry appeared without refresh. | |
| 3.2 | Log filtering | 1. Open Activity Log. 2. Filter by user and date range. | User and date range | Only matching entries; newest first. | Filtered correctly; sorted newest first. | |
| 3.3 | Audit trail immutability | 1. Open Activity Log. 2. Look for edit or delete on a row. | Edit or delete attempt | No such option; logs read-only. | No edit or delete found. | |
| 3.4 | Cross-branch log visibility | 1. Act at Branch A. 2. Check log at Branch B as Admin. | Action at Branch A | Branch A entry visible at Branch B in real time. | Branch A entry visible at Branch B. | |

### Series 400: Integrated Analytics, Reporting, and Exports

| System Test ID | Module | Step-by-Step Execution Procedure | Test Data / Inputs | Expected System Response | Actual Result | Remarks |
|---|---|---|---|---|---|---|
| 4.1 | Mathematical audit | 1. Run payroll. 2. Check analytics totals. 3. Verify manually. | Known test data | System totals match manual calculations. | Totals matched manual calculations. | |
| 4.2 | Dashboard trend analysis | 1. Open analytics. 2. Select multi-period view. | Two or more periods | Chart shows correct variance per period. | Chart matched underlying data. | |
| 4.3 | PDF export | 1. Open a report. 2. Click Export to PDF. | (none) | Clean formatted PDF downloads. | PDF downloaded correctly. | |
| 4.4 | Spreadsheet export | 1. Open a report. 2. Click Export to Excel or CSV. | (none) | Uncorrupted Excel or CSV downloads. | File downloaded without corruption. | |

### Series 500: System Configuration and Notifications

| System Test ID | Module | Step-by-Step Execution Procedure | Test Data / Inputs | Expected System Response | Actual Result | Remarks |
|---|---|---|---|---|---|---|
| 5.1 | UI feedback during processing | 1. Trigger a payroll run via button. | Click action button | Loading indicator; button disabled. | Spinner shown; button disabled. | |
| 5.2 | Settings change applied | 1. Open Settings. 2. Change a value. 3. Save. | New config value | Setting saved; applied; logged. | Setting applied and logged. | |
| 5.3 | Notification delivery | 1. Run payroll or approve request. 2. Check notification bell. | Completed action | Affected user gets in-app notification. | Notification delivered promptly. | |
| 5.4 | Scope compliance | 1. Look for any direct government submission function. | Payroll screen | No such function; reference reports only. | No submission function found. | |

---

## LEVEL 4: Comprehensive User Acceptance Testing (UAT) Survey

### PART 1: PARTICIPANT PROFILE MATRIX

Per Chapter 3 (Respondents and Sampling Technique), the study uses purposive sampling with a total of four (4) respondents from Lope Laranjo Bato and Co., CPAs, selected for their direct involvement in accounting operations and familiarity with the firm's existing manual and semi-automated processes.

| Participant ID | Target User Role / Position | Organization / Branch | Testing Date | Signature Initials |
|---|---|---|---|---|
| 1 | Administrator | Lope Laranjo Bato and Co., CPAs — Main Branch | ___ / ____ / 2026 | |
| 2 | Manager | Lope Laranjo Bato and Co., CPAs — Main Branch | ___ / ____ / 2026 | |
| 3 | Accounting Staff | Lope Laranjo Bato and Co., CPAs — Main Branch | ___ / ____ / 2026 | |
| 4 | Accounting Staff | Lope Laranjo Bato and Co., CPAs — Main Branch | ___ / ____ / 2026 | |

### Part 2: Full ISO/IEC 25010-Aligned Survey Evaluation

This instrument evaluates the system using the industry-standard ISO/IEC 25010 Software Quality Model.
Likert Rating Scale: 5 = Strongly Agree (SA) | 4 = Agree (A) | 3 = Neutral (N) | 2 = Disagree (D) | 1 = Strongly Disagree (SD)

**1. Functional Suitability**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 1.1 | Functional Completeness: The system provides all required payroll, activity-log, and analytics features outlined in the project objectives. | | | | | |
| 1.2 | Functional Correctness: The system computes payroll and reports without mathematical errors. | | | | | |
| 1.3 | Functional Appropriateness: Workflows align with the firm's actual payroll processing policies. | | | | | |

**2. Usability and User Experience (UX)**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 2.1 | Appropriateness Recognizability: Users quickly understand what each module, button, and menu does. | | | | | |
| 2.2 | Learnability: New users can perform core operations without intensive training. | | | | | |
| 2.3 | Operability: Payroll forms, search inputs, and filters are easy to control. | | | | | |
| 2.4 | UI Aesthetics: Color scheme, typography, and layout are professional and clean. | | | | | |
| 2.5 | Accessibility: Text size, icons, and interactive elements are visible and accessible. | | | | | |

**3. Performance Efficiency**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 3.1 | Time Behavior: Payroll processing, page transitions, and report generation execute at acceptable speed. | | | | | |
| 3.2 | Resource Utilization: The system runs smoothly without browser lag or excessive memory use during a live payroll run. | | | | | |

**4. Security**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 4.1 | Confidentiality: Payroll data is visible only to authorized personnel by role. | | | | | |
| 4.2 | Integrity: The system prevents unauthorized modification of payroll and activity-log records. | | | | | |
| 4.3 | Accountability: Every action can be traced back to the specific logged-in user account via the activity log. | | | | | |

**5. Reliability**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 5.1 | Fault Tolerance: The application handles data-entry mistakes gracefully without crashing or exposing raw errors. | | | | | |
| 5.2 | Recoverability: In the event of a network interruption, in-progress payroll data or entries can be recovered safely. | | | | | |

**6. Maintainability and Portability**

| # | Evaluation Criteria Indicators | 5 | 4 | 3 | 2 | 1 |
|---|---|---|---|---|---|---|
| 6.1 | Co-existence / Compatibility: The system runs correctly across major browsers and screen sizes. | | | | | |
| 6.2 | Modularity / Reusability: Components are structured so future developers can add analytics or reporting features cleanly. | | | | | |

---

### PART 3: FORMAL CLIENT ACCEPTANCE AND SIGN-OFF

This signature sheet is the definitive evidence required by capstone panels. It proves the capstone project solved a real institutional need and has been officially handed over.

**Acceptance Statement:**

"By signing below, I acknowledge that I have actively participated in or reviewed the User Acceptance Testing (UAT) phase for the developed system. I confirm that the functional deliverables, user interfaces, security protocols, and operational workflows meet our agreed specifications and are accepted for live deployment."

**Approved By:**

___________________________________________
Client Printed Name and Designation

___________________________________________
Signature over Printed Name

Date Signed: _____ / _____ / 2026
