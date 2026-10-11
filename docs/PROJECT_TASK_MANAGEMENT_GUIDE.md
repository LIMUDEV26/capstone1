# Project Task Management Guide

## Overview
Your system already has comprehensive task management functionality built into each project. This guide explains how to use these features.

## Features Available

### 1. **View Project Tasks**
- Navigate to **Projects** page
- Click on any project to view its details
- All tasks assigned to that project will be displayed

### 2. **Add Tasks to a Project**
When viewing a project detail page, you can add tasks by:
1. Click the **"Add Task"** button
2. Fill in the task details:
   - **Title** (required)
   - **Description**
   - **Priority** (Low, Medium, High)
   - **Due Date**
   - **Assigned To** (select a staff member)
3. Click **"Create Task"** to save

### 3. **Assign Users to Tasks**
Tasks can be assigned to users in two ways:

#### Primary Assignment
- When creating a task, select a user from the **"Assigned To"** dropdown
- Or, edit an existing task and change the assignment

#### Task Collaborators
- Tasks support multiple collaborators
- Each collaborator can have shift schedules
- Managers can add/remove collaborators when editing a task

### 4. **Update Task Status**
Available task statuses:
- **Pending** - Task not yet started
- **In Progress** - Task is being worked on
- **Completed** - Task is finished
- **Cancelled** - Task is no longer needed

To update status:
1. View the project details page
2. Find the task in the list
3. Click the status dropdown
4. Select the new status

### 5. **Task Filtering and Search**
You can filter tasks by:
- **Search** - Search by task title or description
- **Status** - Filter by task status
- **Deadline** - Filter by due date (overdue, due soon, etc.)

### 6. **Task Features**
- **Priority Levels**: Set task priority (Low, Medium, High)
- **Due Dates**: Set task deadlines with date and time
- **Completion Proof**: Tasks can require proof of completion
- **Comments**: Add comments and attachments to tasks
- **Task Reports**: Send completion reports to clients

## User Permissions

### Admin & Manager
- Create projects
- Add tasks to projects
- Assign tasks to any staff member
- Update task details
- Delete tasks
- View all projects and tasks

### Staff
- View assigned tasks
- View tasks where they are collaborators
- Update status of their assigned tasks
- Add comments to their tasks
- Cannot create projects or tasks
- Cannot assign tasks to others

## Technical Implementation

### Database Structure
```sql
-- Projects Table
projects (
    id, name, description, 
    client_id, manager_id, 
    status, start_date, end_date
)

-- Tasks Table
tasks (
    id, title, description,
    project_id, assigned_to,
    status, priority, due_date,
    require_completion_proof
)

-- Task Collaborators Table
task_collaborators (
    collaborator_id, task_id, user_id,
    shift_mode, shift_start, shift_end
)
```

### API Endpoints
- `GET /api/projects.php?id={id}` - Get project details
- `GET /api/tasks.php?project_id={id}` - Get project tasks
- `POST /api/tasks.php` - Create new task
- `PUT /api/tasks.php` - Update task
- `DELETE /api/tasks.php` - Delete task

### Frontend Pages
- `/pages/projects/index.tsx` - Project listing page
- `/pages/projects/detail.tsx` - Project detail with task management

## Usage Examples

### Example 1: Create a Project and Add Tasks
1. Go to **Projects** page
2. Click **"Add Project"**
3. Select a client and manager
4. Set project deadline
5. System automatically creates tasks based on client services
6. View project details to see auto-generated tasks
7. Click **"Add Task"** to add more custom tasks
8. Assign each task to a staff member

### Example 2: Track Task Progress
1. Open a project detail page
2. Review the task list
3. Update task status as work progresses
4. Add comments and attachments to tasks
5. Send completion reports when tasks finish

### Example 3: Assign Multiple Collaborators
1. Open project detail page
2. Click **"Edit"** on a task
3. Scroll to the **"Collaborators"** section
4. Click **"Add Collaborator"**
5. Select a staff member
6. Optionally set shift schedule
7. Save the task

## Best Practices

1. **Clear Task Titles**: Use descriptive task names
2. **Set Due Dates**: Always set realistic deadlines
3. **Assign Immediately**: Assign tasks to staff as soon as possible
4. **Update Status**: Keep task status current
5. **Use Comments**: Document progress and issues in task comments
6. **Review Regularly**: Check project progress regularly

## Troubleshooting

### Cannot Create Task
- Ensure you have Manager or Admin role
- Verify the project exists and is active
- Check that you're logged in

### Cannot Assign Staff Member
- Managers can only assign staff in their branch
- Admins can assign any staff member
- Verify the user account is active

### Task Not Showing
- Check task status filter
- Verify project is not archived
- Ensure you have permission to view the project

## Conclusion
Your system has full project and task management capabilities already built in. No additional development is needed. All features for adding tasks to projects and assigning users are already functional and accessible through the web interface.
