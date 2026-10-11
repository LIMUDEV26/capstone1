# Task Features Implementation Summary

## 1. Deadline Reminder (deadline_reminder_at)

### Backend
- **`api/tasks.php`**: Added `deadline_reminder_at` DATETIME column via auto-migration (`ensureTaskDeadlineReminderColumn`)
  - POST: Accepts `deadline_reminder_at` field on task creation
  - PUT: Accepts `deadline_reminder_at` field on task update; validates reminder must be before `due_date` via `assertDeadlineReminderBeforeDueDate()`
  - The column auto-initializes if missing
- **`api/notifications.php`**: Deadline reminder notification logic (already existed, uses `deadline_reminder_at` column). Queries open tasks where `deadline_reminder_at <= NOW()` and creates notifications for assignees, collaborators, and project managers.

### Frontend (pages/projects/detail.tsx)
- **Add Task modal**: "Deadline Reminder" datetime-local field below Due Date with helper text
- **Edit Task panel**: "Deadline Reminder" datetime-local field with same behavior; populated from `task.deadline_reminder_at`
- **Payload wiring**: Both `handleAddTask` and `handleUpdateTask` send `deadline_reminder_at` to the API
- **Default forms**: `defaultTaskForm` and `defaultEditTaskForm` both include `deadline_reminder_at: ''`

## 2. Draft Assignment Save Button

### Backend
- Existing `PUT /tasks.php` with `assigned_to` field (no changes needed)

### Frontend (pages/projects/detail.tsx)
- **`taskDraftAssignments`**: State map tracking pending assignment changes (keyed by task ID)
- **`handleTaskDraftAssignmentChange(task, userId)`**: Records assignment draft instead of saving immediately; reverts to original if same value selected
- **`getTaskDraftAssignmentValue(task)`**: Returns draft value if changed, else original `task.assigned_to`
- **`handleSaveProjectTaskChanges()`**: Batch saves all pending draft assignments via individual API calls; updates local state and clears drafts
- **Task list dropdown**: Uses `getTaskDraftAssignmentValue()` for value and `handleTaskDraftAssignmentChange()` for onChange (replacing immediate `handleAssignTask`)
- **Save button**: Appears above paginated task list when `isAssignedManager` and there are unsaved draft changes; shows count of pending changes

## 3. Dashboard Clickable Cards

### Status: Already Implemented
All three dashboard pages already have clickable stat cards:
- **Staff dashboard** (`pages/dashboard.tsx`): Cards link to `/my-tasks` and `/projects`
- **Admin dashboard** (`pages/admin/dashboard.tsx`): Cards have `onClick={() => router.push(item.route)}` with routes per item
- **Manager dashboard** (`pages/manager/dashboard.tsx`): Cards have explicit `onClick` handlers to `/users`, `/my-tasks`, `/projects`, `/clients`, `/payroll-management`