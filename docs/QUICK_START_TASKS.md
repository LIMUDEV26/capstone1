# Quick Start Guide: Adding Tasks to Projects

## ✅ Your System Already Has This Feature!

The functionality you requested - "add tasks inside each project and assign someone to each task" - **is already fully implemented** in your system. This guide shows you how to use it.

## 📋 Step-by-Step: How to Add Tasks to a Project

### Step 1: Navigate to Projects
1. Log in to your system
2. Click on **"Projects"** in the sidebar menu
3. You'll see a list of all projects

### Step 2: Open a Project
1. Click on any project from the list
2. This opens the **Project Detail Page**
3. You'll see all tasks assigned to this project

### Step 3: Add a New Task
1. Click the **"Add Task"** button (usually at the top right)
2. A modal/form will appear

### Step 4: Fill in Task Details
Fill out the task form:
- **Title*** (required): Enter the task name
  - Example: "Design homepage layout"
- **Description**: Add details about what needs to be done
- **Priority**: Select Low, Medium, or High
- **Due Date**: Click the date picker to set a deadline
- **Assigned To**: Select a staff member from the dropdown

### Step 5: Save the Task
1. Click **"Create Task"** or **"Submit"**
2. The task will be added to the project
3. The assigned user will receive an email notification

### Step 6: Manage the Task
Once created, you can:
- **Change Status**: Click the status dropdown (Pending → In Progress → Completed)
- **Reassign**: Edit the task to change who it's assigned to
- **Add Collaborators**: Edit the task and add multiple team members
- **Add Comments**: Click on the task to add updates and files
- **Send Reports**: When completed, send completion report to client

## 🎯 Example Scenario

**Scenario**: You have a project "Website Redesign for ABC Company" and need to create tasks for your team.

### Creating Tasks:

**Task 1: Design Homepage**
```
Title: Design homepage mockup
Description: Create modern design mockup for the homepage including header, hero section, and footer
Priority: High
Due Date: July 10, 2026
Assigned To: John Doe (Designer)
```

**Task 2: Develop Backend API**
```
Title: Build REST API endpoints
Description: Create API for user authentication, data retrieval, and content management
Priority: High
Due Date: July 15, 2026
Assigned To: Jane Smith (Developer)
```

**Task 3: Quality Assurance**
```
Title: Test all functionality
Description: Perform comprehensive testing of all features across different browsers
Priority: Medium
Due Date: July 20, 2026
Assigned To: Bob Johnson (QA Tester)
```

### Result:
- All 3 tasks appear in the project
- Each team member sees their task in their "My Tasks" page
- Project manager can track progress
- Status updates are visible in real-time

## 👥 Assigning Users to Tasks

### Single Assignment (Primary)
When creating or editing a task:
1. Look for the **"Assigned To"** dropdown
2. Select a staff member's name
3. That person becomes the primary assignee

### Multiple Collaborators
For tasks requiring multiple people:
1. Open the task edit form
2. Scroll to **"Collaborators"** section
3. Click **"Add Collaborator"**
4. Select additional staff members
5. Optionally set shift schedules for each:
   - **None**: No specific shift
   - **Current Time**: Starting now
   - **Range**: Specific start and end times

### Example with Collaborators:
```
Task: Website Development
Primary Assignee: John Doe

Collaborators:
1. Jane Smith
   - Shift: 8:00 AM - 4:00 PM
   
2. Bob Johnson
   - Shift: 4:00 PM - 12:00 AM
   
3. Alice Williams
   - Shift: None (flexible)
```

## 🔍 Finding and Filtering Tasks

### In Project Detail Page:
- **Search Box**: Type to search task titles/descriptions
- **Status Filter**: Show only Pending, In Progress, Completed, or Cancelled tasks
- **Deadline Filter**: Show overdue or due soon tasks
- **Pagination**: Navigate through many tasks

### In My Tasks Page:
Staff members can see:
- All tasks assigned to them
- Tasks where they are collaborators
- Filter by project, status, priority

## 📊 Task Status Workflow

```
Pending → In Progress → Completed
                    ↓
                Cancelled
```

### Changing Status:
1. Find the task in the project detail page
2. Click the **Status** dropdown
3. Select new status
4. Status updates immediately
5. Notifications may be sent

## 🔐 Permissions

### Who Can Do What:

**Admin:**
- ✓ Create tasks in any project
- ✓ Assign tasks to anyone
- ✓ Edit/delete any task

**Manager:**
- ✓ Create tasks in their projects
- ✓ Assign tasks to staff in their branch
- ✓ Edit/delete tasks in their projects

**Staff:**
- ✗ Cannot create tasks
- ✗ Cannot assign tasks
- ✓ Can update status of THEIR tasks
- ✓ Can add comments to THEIR tasks

## 🎨 User Interface Features

The Project Detail page shows:

```
┌─────────────────────────────────────────────────┐
│  PROJECT: Website Redesign for ABC Company      │
│  Client: ABC Company | Manager: John Manager    │
├─────────────────────────────────────────────────┤
│  [Add Task] [Search...] [Filter ▼] [Status ▼]  │
├─────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────┐  │
│  │ ☐ Design homepage mockup                 │  │
│  │    Assigned: John Doe | High | Jul 10    │  │
│  │    Status: [In Progress ▼]  [Edit] [⋮]   │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │ ☐ Build REST API endpoints               │  │
│  │    Assigned: Jane Smith | High | Jul 15  │  │
│  │    Status: [Pending ▼]  [Edit] [⋮]        │  │
│  └───────────────────────────────────────────┘  │
│                                                  │
│  ┌───────────────────────────────────────────┐  │
│  │ ☐ Test all functionality                 │  │
│  │    Assigned: Bob Johnson | Med | Jul 20  │  │
│  │    Status: [Pending ▼]  [Edit] [⋮]        │  │
│  └───────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

## 🚀 Tips for Success

1. **Set Clear Deadlines**: Always set due dates for better tracking
2. **Use Priorities**: Mark urgent tasks as High priority
3. **Write Good Descriptions**: Help assignees understand what's needed
4. **Check Progress Daily**: Review task statuses regularly
5. **Use Comments**: Keep communication in the task comments
6. **Attach Files**: Upload relevant documents to tasks
7. **Send Reports**: When tasks complete, send reports to clients

## 📱 Mobile Access

The system is responsive and works on:
- Desktop computers
- Tablets
- Mobile phones

All task management features work on mobile devices!

## 🆘 Troubleshooting

**Problem: "Add Task" button not showing**
- Solution: Check you have Manager or Admin role

**Problem: "Cannot assign to staff member"**
- Solution: Managers can only assign staff in their branch

**Problem: "Task not appearing"**
- Solution: Check filters - it might be hidden by status filter

**Problem: "Cannot edit task"**
- Solution: Only managers and admins can edit tasks. Staff can only update their own task status.

## 📚 Related Documentation

- `PROJECT_TASK_MANAGEMENT_GUIDE.md` - Complete feature documentation
- `TASK_WORKFLOW_DIAGRAM.md` - Visual workflow diagrams
- API documentation in `/api/tasks.php`
- Frontend code in `/pages/projects/detail.tsx`

## ✅ Conclusion

**Your system is ready to use!** No development needed. You can:
1. Open any project
2. Click "Add Task"
3. Fill in details
4. Assign to a team member
5. Track progress

The task management system is fully functional with:
- ✅ Task creation
- ✅ User assignment
- ✅ Status tracking
- ✅ Collaborators
- ✅ Comments & attachments
- ✅ Email notifications
- ✅ Client reports
- ✅ Filtering & search
- ✅ Mobile responsive

**Start using it today!**
