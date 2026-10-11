# User Interface Guide - Task Management

## 📸 Visual Guide to Using Tasks in Projects

This guide shows you what to look for in the user interface when managing tasks in projects.

## 1️⃣ Projects List Page

**URL**: `/projects`

**What You'll See**:
```
┌──────────────────────────────────────────────────────────────────┐
│ 🏠 Dashboard > Projects                                          │
│                                                                  │
│ Project Management                               [+ Add Project] │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ Search: [_____________________] [All Status ▼] [Filter ▼]  │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📊 Website Redesign - ABC Company                           │  │
│ │    Manager: John Smith | Due: Jul 30, 2026                 │  │
│ │    Tasks: 8/12 completed | Status: Active                  │  │
│ │    [View Details] [Edit] [Archive]                         │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📊 Mobile App Development - XYZ Corp                        │  │
│ │    Manager: Jane Doe | Due: Aug 15, 2026                   │  │
│ │    Tasks: 3/15 completed | Status: Active                  │  │
│ │    [View Details] [Edit] [Archive]                         │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ Page 1 of 3  [< Previous] [1] [2] [3] [Next >]                  │
└──────────────────────────────────────────────────────────────────┘
```

**Actions**:
- Click **[View Details]** to see project tasks
- Click **[+ Add Project]** to create new project

---

## 2️⃣ Project Detail Page (With Tasks)

**URL**: `/projects/detail?id=123`

**What You'll See**:

```
┌──────────────────────────────────────────────────────────────────┐
│ 🏠 Dashboard > Projects > Website Redesign - ABC Company        │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📋 PROJECT DETAILS                                          │  │
│ │                                                             │  │
│ │ Name: Website Redesign - ABC Company                       │  │
│ │ Client: ABC Company (John Client, john@abc.com)            │  │
│ │ Manager: John Smith                                         │  │
│ │ Status: 🟢 Active                                           │  │
│ │ Start Date: Jul 1, 2026                                     │  │
│ │ Due Date: Jul 30, 2026                                      │  │
│ │ Progress: 8/12 tasks completed (67%)                        │  │
│ │                                                             │  │
│ │ [Edit Project] [Archive Project] [Send Report]             │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📝 TASKS                                    [+ Add Task]    │  │
│ │                                                             │  │
│ │ Search: [_____] [All Status ▼] [All Priority ▼] [Filter ▼] │  │
│ │                                                             │  │
│ │ ┌─────────────────────────────────────────────────────┐    │  │
│ │ │ 🔴 HIGH | Design Homepage Mockup              [Edit]│    │  │
│ │ │ Assigned: Jane Designer                               │    │  │
│ │ │ Status: [In Progress ▼]                              │    │  │
│ │ │ Due: Jul 10, 2026 (⚠️ 5 days left)                   │    │  │
│ │ │ Collaborators: Bob Smith (Designer)                  │    │  │
│ │ │ [Comments (3)] [Attachments (2)] [Details]          │    │  │
│ │ └─────────────────────────────────────────────────────┘    │  │
│ │                                                             │  │
│ │ ┌─────────────────────────────────────────────────────┐    │  │
│ │ │ 🟡 MEDIUM | Develop REST API                  [Edit]│    │  │
│ │ │ Assigned: Mike Developer                             │    │  │
│ │ │ Status: [Pending ▼]                                  │    │  │
│ │ │ Due: Jul 15, 2026 (10 days left)                    │    │  │
│ │ │ Collaborators: Alice Dev (8am-4pm), Tom (4pm-12am)  │    │  │
│ │ │ [Comments (0)] [Attachments (0)] [Details]          │    │  │
│ │ └─────────────────────────────────────────────────────┘    │  │
│ │                                                             │  │
│ │ ┌─────────────────────────────────────────────────────┐    │  │
│ │ │ ✅ COMPLETED | Database Schema Design        [View]│    │  │
│ │ │ Assigned: Sarah Database                             │    │  │
│ │ │ Status: Completed ✓                                  │    │  │
│ │ │ Completed: Jul 5, 2026                               │    │  │
│ │ │ [View Report] [Comments (5)] [Details]              │    │  │
│ │ └─────────────────────────────────────────────────────┘    │  │
│ │                                                             │  │
│ │ Showing 3 of 12 tasks | Page 1 of 4                        │  │
│ │ [< Previous] [1] [2] [3] [4] [Next >]                      │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 💬 PROJECT UPDATES (Recent Messages)                       │  │
│ │ [View All] [Add Update]                                    │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📎 ATTACHMENTS (Project Files)                              │  │
│ │ [View All] [Upload File]                                   │  │
│ └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Key Elements**:
- **[+ Add Task]** button - Click to create new task
- **[Edit]** button - Click to modify task
- **Status Dropdown** - Click to change task status
- **Task Cards** - Each task shown in a card with details

---

## 3️⃣ Add Task Modal

**Triggered By**: Clicking **[+ Add Task]** button

**What You'll See**:

```
┌────────────────────────────────────────────────────────┐
│  Add New Task                                    [✕]   │
├────────────────────────────────────────────────────────┤
│                                                        │
│  Task Title *                                          │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Design homepage mockup                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Description                                           │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Create modern design mockup for the homepage     │ │
│  │ including header, hero section, and footer       │ │
│  │                                                  │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Assigned To                                           │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Select staff member...              ▼            │ │
│  ├──────────────────────────────────────────────────┤ │
│  │ Jane Designer (Staff - Design Dept)              │ │
│  │ Bob Smith (Staff - Design Dept)                  │ │
│  │ Mike Developer (Staff - Dev Dept)                │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Priority                                              │
│  ┌──────────────────────────────────────────────────┐ │
│  │ [○ Low] [○ Medium] [● High] [○ Urgent]           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Due Date                                              │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 2026-07-10  T  14:00          📅                 │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ☐ Require completion proof                            │
│                                                        │
│            [Cancel]            [Create Task]           │
└────────────────────────────────────────────────────────┘
```

**Form Fields**:
1. **Task Title** (required) - Enter task name
2. **Description** - Detailed explanation
3. **Assigned To** - Select from dropdown of staff members
4. **Priority** - Choose: Low, Medium, High, or Urgent
5. **Due Date** - Date and time picker
6. **Require completion proof** - Checkbox for proof requirement

**Actions**:
- Click **[Create Task]** to save
- Click **[Cancel]** to close without saving

---

## 4️⃣ Edit Task Modal (With Collaborators)

**Triggered By**: Clicking **[Edit]** on a task

**What You'll See**:

```
┌────────────────────────────────────────────────────────┐
│  Edit Task                                       [✕]   │
├────────────────────────────────────────────────────────┤
│                                                        │
│  Task Title *                                          │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Design homepage mockup                           │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Description                                           │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Create modern design mockup...                   │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Primary Assignee                                      │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Jane Designer                           ▼        │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Status                                                │
│  ┌──────────────────────────────────────────────────┐ │
│  │ In Progress                             ▼        │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  Priority: [○ Low] [○ Medium] [● High] [○ Urgent]     │
│                                                        │
│  Due Date: [2026-07-10 T 14:00] 📅                     │
│                                                        │
│  ─────────────────────────────────────────────────     │
│  👥 COLLABORATORS                    [+ Add Person]   │
│  ─────────────────────────────────────────────────     │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 1. Bob Smith (Staff - Design Dept)         [✕]  │ │
│  │    Shift: ● None  ○ Current Time  ○ Range       │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 2. Alice Developer (Staff - Dev Dept)       [✕]  │ │
│  │    Shift: ○ None  ○ Current Time  ● Range       │ │
│  │    Start: [2026-07-10 T 08:00] 📅               │ │
│  │    End:   [2026-07-10 T 16:00] 📅               │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 3. Tom Developer (Staff - Dev Dept)         [✕]  │ │
│  │    Shift: ○ None  ● Current Time  ○ Range       │ │
│  │    Start: [2026-07-10 T 16:00] 📅               │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│            [Cancel]            [Update Task]           │
└────────────────────────────────────────────────────────┘
```

**Collaborator Features**:
- **[+ Add Person]** - Add another collaborator
- **[✕]** - Remove collaborator
- **Shift Options**:
  - **None** - No specific schedule
  - **Current Time** - Starts from now
  - **Range** - Specific start and end times

---

## 5️⃣ Task Status Dropdown

**Triggered By**: Clicking status dropdown on a task

**What You'll See**:

```
┌─────────────────────────┐
│ Status:                 │
├─────────────────────────┤
│ ○ Pending               │
│ ● In Progress    ✓      │
│ ○ Completed             │
│ ○ Cancelled             │
└─────────────────────────┘
```

**Status Options**:
- **Pending** - Not started yet
- **In Progress** - Currently being worked on
- **Completed** - Finished successfully
- **Cancelled** - No longer needed

**Action**: Click any status to change immediately

---

## 6️⃣ Task Priority Indicators

**Visual Indicators in Task List**:

```
🔴 HIGH     - Red dot/badge
🟡 MEDIUM   - Yellow dot/badge
🟢 LOW      - Green dot/badge
🔥 URGENT   - Fire emoji or red badge
```

---

## 7️⃣ Filter and Search Options

**Search Bar**:
```
┌──────────────────────────────────────────────────────┐
│ 🔍 Search tasks...                                   │
└──────────────────────────────────────────────────────┘
```
Type anything to search task titles and descriptions.

**Status Filter**:
```
┌──────────────────┐
│ All Status    ▼  │
├──────────────────┤
│ ✓ All Status     │
│   Pending        │
│   In Progress    │
│   Completed      │
│   Cancelled      │
└──────────────────┘
```

**Priority Filter**:
```
┌──────────────────┐
│ All Priority  ▼  │
├──────────────────┤
│ ✓ All Priority   │
│   Low            │
│   Medium         │
│   High           │
│   Urgent         │
└──────────────────┘
```

**Deadline Filter**:
```
┌──────────────────┐
│ All Deadlines ▼  │
├──────────────────┤
│ ✓ All Deadlines  │
│   Overdue        │
│   Due Soon       │
│   This Week      │
│   This Month     │
└──────────────────┘
```

---

## 8️⃣ My Tasks Page (For Staff)

**URL**: `/my-tasks`

**What Staff Members See**:

```
┌──────────────────────────────────────────────────────────────────┐
│ 🏠 Dashboard > My Tasks                                          │
│                                                                  │
│ My Tasks                                          [Filter ▼]     │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 📊 Overview                                                 │  │
│ │ Total Tasks: 8 | In Progress: 3 | Pending: 2 | Overdue: 1  │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 🔴 Design Homepage Mockup                                   │  │
│ │ Project: Website Redesign - ABC Company                    │  │
│ │ Status: [In Progress ▼] | Priority: HIGH                   │  │
│ │ Due: Jul 10, 2026 (⚠️ 5 days left)                         │  │
│ │ [View Details] [Add Comment] [Update Status]               │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 🟡 Write User Documentation                                 │  │
│ │ Project: Mobile App Development - XYZ Corp                 │  │
│ │ Status: [Pending ▼] | Priority: MEDIUM                     │  │
│ │ Due: Jul 25, 2026 (20 days left)                           │  │
│ │ [View Details] [Add Comment] [Update Status]               │  │
│ └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│ ┌────────────────────────────────────────────────────────────┐  │
│ │ 👥 COLLABORATING ON                                         │  │
│ │                                                             │  │
│ │ • Develop REST API (Project: Website Redesign)             │  │
│ │   Your Shift: 8:00 AM - 4:00 PM                            │  │
│ │   Status: In Progress | Assigned to: Mike Developer        │  │
│ └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

**Staff Can**:
- View assigned tasks
- View tasks where they're collaborators
- Update status of their own tasks
- Add comments to their tasks
- Cannot create or assign tasks

---

## 9️⃣ Task Comments Section

**Triggered By**: Clicking on a task to view details

**What You'll See**:

```
┌────────────────────────────────────────────────────────┐
│  💬 Comments & Updates                                 │
├────────────────────────────────────────────────────────┤
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 👤 John Manager - Jul 5, 2026 at 10:30 AM       │ │
│  │                                                  │ │
│  │ Great progress on this task! The mockup looks    │ │
│  │ professional. Please ensure mobile responsive.   │ │
│  │                                                  │ │
│  │ 📎 mockup_v2.pdf (1.2 MB) [Download]            │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ 👤 Jane Designer - Jul 5, 2026 at 2:15 PM       │ │
│  │                                                  │ │
│  │ Updated the mockup with mobile responsive        │ │
│  │ design. Ready for review.                        │ │
│  │                                                  │ │
│  │ 📎 mockup_v3_mobile.pdf (1.5 MB) [Download]     │ │
│  │ 📎 screenshots.zip (3.2 MB) [Download]          │ │
│  └──────────────────────────────────────────────────┘ │
│                                                        │
│  ┌──────────────────────────────────────────────────┐ │
│  │ Add Comment:                                     │ │
│  │ ┌──────────────────────────────────────────────┐ │ │
│  │ │ Type your comment here...                    │ │ │
│  │ │                                              │ │ │
│  │ └──────────────────────────────────────────────┘ │ │
│  │                                                  │ │
│  │ 📎 Attach File [Choose File]                     │ │
│  │                                                  │ │
│  │              [Cancel]      [Post Comment]        │ │
│  └──────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────┘
```

---

## 🔟 Mobile View (Responsive)

**On Mobile Phones**:

```
┌───────────────────────┐
│ ☰  My Tasks      👤   │
├───────────────────────┤
│                       │
│ [Search...] [Filter]  │
│                       │
│ ┌───────────────────┐ │
│ │ 🔴 HIGH           │ │
│ │ Design Homepage   │ │
│ │                   │ │
│ │ Project: Website  │ │
│ │ Due: Jul 10       │ │
│ │                   │ │
│ │ [In Progress ▼]   │ │
│ │                   │ │
│ │ [Details]  [Edit] │ │
│ └───────────────────┘ │
│                       │
│ ┌───────────────────┐ │
│ │ 🟡 MEDIUM         │ │
│ │ Write Docs        │ │
│ │                   │ │
│ │ Project: Mobile   │ │
│ │ Due: Jul 25       │ │
│ │                   │ │
│ │ [Pending ▼]       │ │
│ │                   │ │
│ │ [Details]  [Edit] │ │
│ └───────────────────┘ │
│                       │
│ [Page 1 of 2]         │
│ [< Prev] [Next >]     │
└───────────────────────┘
```

---

## 🎯 Key UI Elements Summary

### Buttons:
- **[+ Add Task]** - Green/blue button, creates new task
- **[Edit]** - Pencil icon or text, opens edit modal
- **[Delete]** / **[✕]** - Red icon, removes item
- **[View Details]** - Eye icon or text, opens detailed view
- **[Comments]** - Speech bubble icon with count
- **[Attachments]** - Paperclip icon with count

### Status Badges:
- **Pending** - Gray badge
- **In Progress** - Blue badge
- **Completed** - Green badge with checkmark
- **Cancelled** - Red badge with X

### Priority Badges:
- **🔴 HIGH** - Red badge/indicator
- **🟡 MEDIUM** - Yellow badge/indicator
- **🟢 LOW** - Green badge/indicator
- **🔥 URGENT** - Red with fire emoji

### Warning Indicators:
- **⚠️ Overdue** - Red warning with days overdue
- **⚠️ Due Soon** - Yellow warning with days left
- **✓ On Track** - Green checkmark

---

## 📱 Responsive Breakpoints

### Desktop (> 1024px):
- Full layout with sidebar
- Table/grid view of tasks
- All columns visible
- Expanded forms

### Tablet (768px - 1024px):
- Sidebar collapses to icon-only
- Task cards stack
- Some columns hidden
- Forms adapt

### Mobile (< 768px):
- Hamburger menu
- Single column layout
- Cards stack vertically
- Simplified forms
- Bottom navigation

---

## 🎨 Color Scheme

### Primary Colors:
- **Primary Blue**: #3B82F6 (buttons, links)
- **Success Green**: #10B981 (completed, success)
- **Warning Yellow**: #F59E0B (warnings, medium priority)
- **Danger Red**: #EF4444 (high priority, errors, overdue)
- **Info Gray**: #6B7280 (pending, secondary info)

### Status Colors:
- Pending: `#94A3B8` (slate)
- In Progress: `#3B82F6` (blue)
- Completed: `#10B981` (green)
- Cancelled: `#EF4444` (red)

---

## Conclusion

This UI guide shows the visual layout and structure of the task management system. All these screens and features are already built and functional in your system. Simply navigate to the Projects page and click on any project to start managing tasks!
