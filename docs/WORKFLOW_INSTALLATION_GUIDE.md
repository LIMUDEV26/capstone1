# Task Approval Workflow - Installation Guide

## Quick Start Installation

Follow these steps to install the document-based task approval workflow system.

## Prerequisites

- ✅ Existing project and task management system
- ✅ PHP 7.4 or higher
- ✅ MySQL 5.7 or higher
- ✅ Next.js/React frontend
- ✅ User authentication system with roles (admin, manager, staff)

## Step 1: Database Migration

### Option A: Using Command Line

```bash
# Navigate to your project directory
cd c:\xampp\htdocs\capstone1

# Run the migration script
mysql -u root -p llb < database\task_approval_workflow_migration.sql
```

### Option B: Using phpMyAdmin

1. Open phpMyAdmin in your browser: `http://localhost/phpmyadmin`
2. Select the `llb` database
3. Click on "Import" tab
4. Click "Choose File" and select: `database/task_approval_workflow_migration.sql`
5. Click "Go" to execute

### Verify Installation

```sql
-- Check new tables were created
USE llb;
SHOW TABLES LIKE 'task_%';

-- Should show:
-- - task_submissions
-- - task_approval_history
-- - task_rejection_reasons

-- Check new columns in tasks table
DESCRIBE tasks;

-- Should show new columns:
-- - workflow_status
-- - started_at
-- - submitted_at
-- - manager_reviewed_at
-- - manager_reviewed_by
-- - admin_reviewed_at
-- - admin_reviewed_by
-- - completed_at

-- Check views were created
SHOW FULL TABLES WHERE table_type = 'VIEW';

-- Should show:
-- - v_tasks_pending_manager_review
-- - v_tasks_pending_admin_review
-- - v_staff_rejected_tasks

-- Check stored procedures
SHOW PROCEDURE STATUS WHERE db = 'llb';

-- Should show:
-- - sp_start_task
-- - sp_submit_task_document
-- - sp_manager_review_task
-- - sp_admin_review_task
```

## Step 2: Create Upload Directory

### On Windows (XAMPP)

```batch
cd c:\xampp\htdocs\capstone1
mkdir uploads\task_submissions
```

### On Linux/Mac

```bash
cd /path/to/capstone1
mkdir -p uploads/task_submissions
chmod 755 uploads/task_submissions
```

### Verify Directory

- Check that `c:\xampp\htdocs\capstone1\uploads\task_submissions\` exists
- Ensure web server can write to this directory

## Step 3: Backend API Setup

The following files have been created:

### 1. `/api/task-workflow.php`

This file is already created. Verify it exists:

```bash
# Check if file exists
dir c:\xampp\htdocs\capstone1\api\task-workflow.php
```

### 2. Test API Endpoint

Visit in browser (must be logged in):
```
http://localhost/capstone1/api/task-workflow.php?action=my_tasks
```

Expected response:
```json
{
  "success": true,
  "data": {
    "tasks": []
  }
}
```

## Step 4: Frontend Setup

The following file has been created:

### 1. `/pages/task-workflow.tsx`

Verify it exists:

```bash
# Check if file exists
dir c:\xampp\htdocs\capstone1\pages\task-workflow.tsx
```

### 2. Add to Navigation Menu

Edit your menu configuration file: `config/menu.ts`

Add this entry:

```typescript
{
  name: 'Task Workflow',
  href: '/task-workflow',
  icon: CheckCircleIcon, // or any icon you prefer
  roles: ['admin', 'manager', 'staff']
}
```

Or edit your sidebar component to include:

```typescript
<Link href="/task-workflow">
  <a className="nav-link">
    Task Workflow
  </a>
</Link>
```

## Step 5: Test the System

### Test as Staff

1. **Login as staff user**
   - Username: (any staff account)
   - Password: (your password)

2. **Navigate to Task Workflow page**
   - Go to: `http://localhost:3000/task-workflow`

3. **Start a task**
   - Find a task with status "Not Started"
   - Click "Start Task"
   - Verify status changes to "In Progress"

4. **Upload a document**
   - Click "Upload Document & Done"
   - Select a test file (PDF, DOCX, etc.)
   - Add optional notes
   - Click "Submit Document"
   - Verify status changes to "Pending Manager Review"

### Test as Manager

1. **Login as manager user**

2. **Navigate to Task Workflow page**

3. **Review a task**
   - Find a task with status "Pending Manager Review"
   - Click "View Details" to see the submission
   - Click "Accept" or "Reject"
   - If rejecting, add a reason
   - Verify status changes appropriately

### Test as Admin

1. **Login as admin user**

2. **Navigate to Task Workflow page**

3. **Final review**
   - Find a task with status "Pending Admin Review"
   - Click "View Details"
   - Click "Confirm" or "Reject"
   - If rejecting, add a reason
   - Verify status changes to "Completed" if approved

## Step 6: Update Existing Tasks

If you have existing tasks in the system, update them:

```sql
-- Set all existing tasks to appropriate workflow status
UPDATE tasks 
SET workflow_status = CASE
    WHEN status = 'pending' THEN 'not_started'
    WHEN status = 'in_progress' THEN 'in_progress'
    WHEN status = 'completed' THEN 'completed'
    ELSE 'not_started'
END
WHERE workflow_status = 'not_started';
```

## Step 7: Configure File Upload Limits (Optional)

### PHP Configuration

Edit `php.ini` (usually at `c:\xampp\php\php.ini`):

```ini
; Maximum file upload size
upload_max_filesize = 10M

; Maximum POST data size
post_max_size = 12M

; Maximum execution time
max_execution_time = 300
```

Restart Apache after changes:

```batch
# In XAMPP Control Panel
Stop Apache → Start Apache
```

## Common Issues and Solutions

### Issue 1: Cannot upload files

**Problem:** File upload fails with error

**Solution:**
- Check `uploads/task_submissions` directory exists
- Verify directory permissions
- Check PHP `upload_max_filesize` setting
- Ensure file type is allowed

### Issue 2: Database error "Table doesn't exist"

**Problem:** SQL error when accessing workflow features

**Solution:**
- Re-run the migration script
- Check database connection in `api/config.php`
- Verify you're using the correct database name (`llb`)

### Issue 3: "Access denied" errors

**Problem:** Users cannot access certain features

**Solution:**
- Verify user role in database: `SELECT role FROM users WHERE id = X`
- Check session is active: Ensure user is logged in
- Verify project assignment for managers

### Issue 4: Status not changing

**Problem:** Task status doesn't update after actions

**Solution:**
- Check stored procedures were created: `SHOW PROCEDURE STATUS WHERE db = 'llb'`
- Verify workflow_status column exists: `DESCRIBE tasks`
- Check JavaScript console for errors

### Issue 5: Page not loading

**Problem:** `/task-workflow` page shows 404

**Solution:**
- Verify `pages/task-workflow.tsx` file exists
- Restart Next.js development server
- Clear browser cache
- Check Next.js build: `npm run dev`

## File Permissions (Linux/Mac)

```bash
# Set proper permissions for upload directory
chmod 755 uploads/task_submissions

# Set permissions for API files
chmod 644 api/task-workflow.php

# Set permissions for frontend
chmod 644 pages/task-workflow.tsx
```

## Verification Checklist

After installation, verify:

- ✅ Database migration completed successfully
- ✅ New tables exist: `task_submissions`, `task_approval_history`, `task_rejection_reasons`
- ✅ New columns added to `tasks` table
- ✅ Views created: `v_tasks_pending_manager_review`, etc.
- ✅ Stored procedures created: `sp_start_task`, etc.
- ✅ Upload directory exists and is writable
- ✅ API endpoint responds: `/api/task-workflow.php`
- ✅ Frontend page loads: `/task-workflow`
- ✅ Staff can start tasks
- ✅ Staff can upload documents
- ✅ Manager can review tasks
- ✅ Admin can approve/complete tasks
- ✅ Files are saved correctly
- ✅ Status transitions work properly
- ✅ Rejection workflow works

## Next Steps

1. **Customize the UI** - Update colors, layout, text to match your brand
2. **Add notifications** - Implement email/SMS alerts at each workflow stage
3. **Configure permissions** - Fine-tune role-based access control
4. **Train users** - Provide training on the new workflow process
5. **Monitor usage** - Track workflow metrics and identify bottlenecks

## Support

For issues or questions:

1. Check the documentation: `docs/TASK_APPROVAL_WORKFLOW.md`
2. Review the API code: `api/task-workflow.php`
3. Check database logs: Review `task_approval_history` table
4. Test with sample data: Use the test scenarios above

## Rollback Instructions

If you need to rollback the changes:

```sql
-- Remove new tables
DROP TABLE IF EXISTS task_rejection_reasons;
DROP TABLE IF EXISTS task_approval_history;
DROP TABLE IF EXISTS task_submissions;

-- Remove new columns from tasks
ALTER TABLE tasks 
DROP COLUMN workflow_status,
DROP COLUMN started_at,
DROP COLUMN submitted_at,
DROP COLUMN manager_reviewed_at,
DROP COLUMN manager_reviewed_by,
DROP COLUMN admin_reviewed_at,
DROP COLUMN admin_reviewed_by,
DROP COLUMN completed_at;

-- Remove views
DROP VIEW IF EXISTS v_tasks_pending_manager_review;
DROP VIEW IF EXISTS v_tasks_pending_admin_review;
DROP VIEW IF EXISTS v_staff_rejected_tasks;

-- Remove stored procedures
DROP PROCEDURE IF EXISTS sp_start_task;
DROP PROCEDURE IF EXISTS sp_submit_task_document;
DROP PROCEDURE IF EXISTS sp_manager_review_task;
DROP PROCEDURE IF EXISTS sp_admin_review_task;
```

## Congratulations!

You have successfully installed the Task Approval Workflow system. Your project now has a comprehensive document-based approval process with two-level review and complete audit trails.
