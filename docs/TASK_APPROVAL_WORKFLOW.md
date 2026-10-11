# Task Approval Workflow System

## Overview

This document describes the comprehensive document-based task approval workflow system that enforces a structured review process for task completion.

## Workflow States

The task workflow uses a new `workflow_status` field with the following states:

1. **not_started** - Initial state, task created but not yet started
2. **in_progress** - Staff has clicked "Start Task"
3. **pending_manager** - Staff uploaded document and clicked "Done", awaiting manager review
4. **rejected_by_manager** - Manager rejected the submission
5. **pending_admin** - Manager approved, awaiting admin review
6. **rejected_by_admin** - Admin rejected the submission
7. **completed** - Admin approved, task complete

## Complete Workflow Flow

```
┌─────────────────┐
│  not_started    │ ← Task created, assigned to staff
└────────┬────────┘
         │ Staff clicks "Start Task"
         ▼
┌─────────────────┐
│  in_progress    │ ← Staff is working on the task
└────────┬────────┘
         │ Staff uploads document & clicks "Done"
         ▼
┌─────────────────┐
│ pending_manager │ ← Waiting for manager review
└────┬───────┬────┘
     │       │
     │       └─ Manager REJECTS ─┐
     │                           ▼
     │                    ┌──────────────────────┐
     │                    │ rejected_by_manager  │
     │                    └──────────┬───────────┘
     │                               │
     │                               │ Staff re-uploads document
     │                               └─────────────┐
     │                                             ▼
     │ Manager APPROVES              ┌──────────────────────┐
     └──────────────────────────────▶│   in_progress        │
                                     └──────────┬───────────┘
                                                │ Staff uploads new document
                                                ▼
                                     ┌──────────────────────┐
                                     │  pending_manager     │
                                     └──────────┬───────────┘
                                                │ Manager approves
                                                ▼
                                     ┌──────────────────────┐
                                     │  pending_admin       │ ← Waiting for admin review
                                     └────┬───────┬─────────┘
                                          │       │
                                          │       └─ Admin REJECTS ─┐
                                          │                          ▼
                                          │                   ┌─────────────────────┐
                                          │                   │ rejected_by_admin   │
                                          │                   └─────────┬───────────┘
                                          │                             │
                                          │                             │ Manager reviews & sends back to staff
                                          │                             └─────────────┐
                                          │                                           ▼
                                          │                             (back to in_progress)
                                          │
                                          │ Admin APPROVES
                                          ▼
                                     ┌──────────────────────┐
                                     │     completed        │ ✓ Task finished
                                     └──────────────────────┘
```

## User Roles and Permissions

### Staff
- **Can:**
  - View tasks assigned to them
  - Click "Start Task" to begin work (not_started → in_progress)
  - Upload documents when status is in_progress, rejected_by_manager, or rejected_by_admin
  - Click "Done" after uploading to submit for review (→ pending_manager)
  - View rejection reasons
  - Re-upload documents after rejection
- **Cannot:**
  - Manually change task status
  - Approve or reject tasks
  - Skip the workflow

### Manager
- **Can:**
  - View tasks in their projects
  - Review tasks with status "pending_manager"
  - Click "View" to see task details and uploaded document
  - Click "Accept" to approve (pending_manager → pending_admin)
  - Click "Reject" with reason (pending_manager → rejected_by_manager)
  - View document in maximized horizontal viewer modal
- **Cannot:**
  - Directly complete tasks (must go through admin)
  - Bypass admin review

### Admin
- **Can:**
  - View all tasks across all projects
  - Review tasks with status "pending_admin"
  - Click "View" to see task details and uploaded document
  - Click "Confirm" to complete task (pending_admin → completed)
  - Click "Reject" with reason (pending_admin → rejected_by_admin)
  - Override any workflow state if necessary
- **Cannot:**
  - Nothing - admin has full control

## Key Features

### 1. Status Protection
- Staff **cannot** manually edit task status
- Status only changes through specific workflow actions:
  - Start Task button
  - Submit Document (with file upload)
  - Manager/Admin review buttons

### 2. Document Upload Requirement
- Staff must upload a document before submitting
- Supported formats: PDF, DOC, DOCX, XLS, XLSX, JPG, PNG, TXT, ZIP
- Max file size: 10MB
- Files stored in `/uploads/task_submissions/`

### 3. Document Viewer Modal
- Opens in horizontal maximized view
- Shows document preview/download
- Includes Accept/Reject buttons
- Manager/Admin can review without leaving the page

### 4. Rejection Handling
- Rejected tasks return to staff
- Staff sees rejection reason prominently
- Staff can upload new document and resubmit
- Creates audit trail of all rejections

### 5. Two-Level Approval
- **Level 1:** Manager Review
  - Checks basic completion
  - Quality control
- **Level 2:** Admin Review
  - Final approval
  - Compliance check
  - Can reject back to manager/staff

## Database Schema Changes

### New Columns in `tasks` table:
```sql
workflow_status ENUM(...) DEFAULT 'not_started'
started_at TIMESTAMP NULL
submitted_at TIMESTAMP NULL
manager_reviewed_at TIMESTAMP NULL
manager_reviewed_by INT NULL
admin_reviewed_at TIMESTAMP NULL
admin_reviewed_by INT NULL
completed_at TIMESTAMP NULL
```

### New Tables:

#### `task_submissions`
Stores all document uploads
- submission_id, task_id, submitted_by, file_path, file_name
- submission_type (initial/resubmission)
- status (pending/approved/rejected)
- reviewed_by, reviewed_at, review_notes

#### `task_approval_history`
Complete audit trail
- history_id, task_id, submission_id, action
- performed_by, previous_status, new_status
- comments, metadata, ip_address, created_at

#### `task_rejection_reasons`
Detailed rejection tracking
- rejection_id, task_id, submission_id
- rejected_by, rejected_by_role (manager/admin)
- reason, expected_corrections, rejected_at

## API Endpoints

### `/api/task-workflow.php`

#### GET Actions:
- `my_tasks` - Get tasks for current user (role-based filtering)
- `pending_reviews` - Get tasks pending review (manager/admin)
- `task_details?task_id=X` - Get detailed task info with submissions
- `approval_history?task_id=X` - Get complete approval history
- `rejection_reasons?task_id=X` - Get rejection reasons for task

#### POST Actions:
- `start_task` - Staff starts a task (not_started → in_progress)
- `submit_document` - Staff uploads document and submits (→ pending_manager)
- `manager_review` - Manager approves/rejects (pending_manager → pending_admin or rejected_by_manager)
- `admin_review` - Admin approves/rejects (pending_admin → completed or rejected_by_admin)
- `download_submission` - Download uploaded document file

## Frontend Page

### `/pages/task-workflow.tsx`

Features:
- **Task List View:**
  - Filter by workflow status
  - Color-coded status badges
  - Priority indicators
  - Rejection reasons displayed prominently
  - Latest submission info

- **Action Buttons** (role-based):
  - "Start Task" (staff, not_started)
  - "Upload Document & Done" (staff, in_progress/rejected)
  - "Accept" / "Reject" (manager, pending_manager)
  - "Confirm" / "Reject" (admin, pending_admin)
  - "View Details" (all roles)

- **Upload Document Modal:**
  - File picker with validation
  - Notes field
  - Submit confirmation

- **Review Modal:**
  - Approval/rejection selection
  - Review notes (required for rejection)
  - Submit confirmation

- **Task Details Modal:**
  - Complete task information
  - Submission history with download links
  - Rejection history
  - Timeline of all actions

## Stored Procedures

### `sp_start_task(task_id, user_id)`
- Validates staff assignment
- Updates workflow_status to 'in_progress'
- Records started_at timestamp
- Logs action in history

### `sp_submit_task_document(...)`
- Validates file upload
- Creates submission record
- Updates workflow_status to 'pending_manager'
- Records submitted_at timestamp
- Logs action in history
- Sends notification to manager

### `sp_manager_review_task(task_id, manager_id, approved, notes)`
- Validates manager permission
- If approved: → pending_admin
- If rejected: → rejected_by_manager, creates rejection record
- Updates submission status
- Logs action in history
- Sends appropriate notifications

### `sp_admin_review_task(task_id, admin_id, approved, notes)`
- Validates admin role
- If approved: → completed, sets completed_at
- If rejected: → rejected_by_admin, creates rejection record
- Logs action in history
- Sends appropriate notifications

## Views for Quick Queries

### `v_tasks_pending_manager_review`
Shows all tasks waiting for manager approval with staff/project info

### `v_tasks_pending_admin_review`
Shows all tasks waiting for admin approval with manager approval info

### `v_staff_rejected_tasks`
Shows all rejected tasks with rejection reasons and reviewer info

## Installation Instructions

### 1. Run Database Migration
```bash
# Navigate to your MySQL command line or phpMyAdmin
mysql -u your_username -p llb < database/task_approval_workflow_migration.sql
```

### 2. Verify Tables Created
```sql
SHOW TABLES LIKE 'task_%';
-- Should show: task_submissions, task_approval_history, task_rejection_reasons

DESCRIBE tasks;
-- Should show new workflow_status column and timestamp columns
```

### 3. Create Upload Directory
```bash
mkdir -p uploads/task_submissions
chmod 755 uploads/task_submissions
```

### 4. Test the Workflow
1. Login as staff
2. Navigate to `/task-workflow` page
3. Start a task
4. Upload a document
5. Login as manager
6. Review and approve
7. Login as admin
8. Final review and complete

## Usage Examples

### Example 1: Staff Completes Task Successfully
1. Staff logs in, sees task with status "Not Started"
2. Clicks "Start Task" → Status: "In Progress"
3. Works on task, uploads document (report.pdf), adds notes
4. Clicks "Upload Document & Done" → Status: "Pending Manager Review"
5. Manager reviews, sees document, clicks "Accept" → Status: "Pending Admin Review"
6. Admin reviews, sees document, clicks "Confirm" → Status: "Completed" ✓

### Example 2: Manager Rejects Task
1. Staff submits document
2. Manager reviews, finds issues
3. Manager clicks "Reject", adds reason: "Missing client signature on page 3"
4. Status → "Rejected by Manager"
5. Staff sees rejection reason in red banner
6. Staff uploads corrected document
7. Status → "Pending Manager Review" (retry)

### Example 3: Admin Rejects Task
1. Manager approves task
2. Admin reviews, finds compliance issue
3. Admin clicks "Reject", adds reason: "Does not meet regulatory requirements"
4. Status → "Rejected by Admin"
5. Manager notified, reviews rejection
6. Manager contacts staff with corrections needed
7. Staff uploads new document, workflow restarts

## Best Practices

1. **Clear Rejection Reasons:** Always provide specific, actionable feedback
2. **Document Review:** Actually view the document before approving
3. **Timely Reviews:** Review submissions within 24-48 hours
4. **Communication:** Use notes fields to communicate expectations
5. **Audit Trail:** Review history before final approval
6. **File Naming:** Use descriptive filenames for uploaded documents

## Troubleshooting

### Staff cannot upload document
- Check workflow_status is in_progress, rejected_by_manager, or rejected_by_admin
- Verify file size under 10MB
- Check file type is allowed

### Manager/Admin cannot review
- Verify workflow_status is pending_manager or pending_admin
- Check user role and project assignment
- Ensure submission exists for task

### File upload fails
- Check uploads/task_submissions directory exists
- Verify directory permissions (755)
- Check disk space

## Future Enhancements

- Email notifications at each workflow stage
- Slack/Teams integration for real-time alerts
- Document preview in modal (PDF viewer)
- Mobile app support
- Workflow analytics dashboard
- Approval timing reminders
- Bulk approval for admins
- Custom workflow templates per project type

## Conclusion

This workflow system ensures quality control, accountability, and compliance by requiring document-based proof of completion with two-level approval. All actions are logged for audit purposes, and the system prevents status manipulation by enforcing the defined workflow.
