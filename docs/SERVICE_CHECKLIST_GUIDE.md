# Service Checklist System Guide

## Overview
The Service Checklist system provides a cascading dropdown interface where services display their associated checklists with a smooth ladder animation effect. This guide explains how the system works and how to use it.

## Features

### 1. **Service Dropdown with Cascade Effect**
- Each service has an expandable dropdown (click the arrow icon)
- When expanded, checklists appear with a smooth cascade/ladder animation
- Each checklist item animates in sequence with a staggered delay
- Hover effects provide visual feedback

### 2. **Visual Design**
- **Service Cards**: Clean white cards with rounded corners
- **Expandable Arrow**: Rotates 90° when opened
- **Numbered Badges**: Each checklist item shows its position (1, 2, 3...)
- **Blue Accent**: Left border and dot indicators for visual hierarchy
- **Smooth Transitions**: All animations use ease-out timing for natural feel

### 3. **Checklist Item Features**
- **Numbered sequence**: Shows order of tasks
- **Task name**: Bold, prominent title
- **Description**: Optional details below the task name
- **Hover effect**: Cards slide right and glow on hover
- **Archive button**: Red-accented button to archive items

### 4. **Integration with Projects**
When a service is assigned to a client:
1. All active checklist items are available as templates
2. Project managers can select which items to include
3. Only checked items appear in the project tasks
4. This creates a custom task list per project based on the service

## How It Works

### Service Management Page (`/services`)

**Display Flow:**
```
Services List
  └─ Click Service Arrow
      └─ Dropdown expands with animation
          └─ Checklist items cascade in (one by one)
              └─ Each item slides from left with fade-in
```

**Animation Timing:**
- Dropdown: 0.4s ease-out
- Each checklist item: 0.5s ease-out + staggered delay (0.1s per item)
- First item: appears immediately
- Second item: 0.1s delay
- Third item: 0.2s delay
- And so on...

### Client/Project Integration

When creating or editing a client:
1. Select service(s) from the dropdown
2. Service checklist appears on the right side
3. Each checklist item can be checked/unchecked
4. When creating a project for this client:
   - Only checked checklist items become project tasks
   - Task names and descriptions are copied from the checklist
   - Tasks can be further customized in the project

## UI Components

### Service Card Structure
```
┌─────────────────────────────────────────┐
│ ▶ Service Name                     Edit │
│   Service description                   │
│   5 checklist items                     │
└─────────────────────────────────────────┘
```

### Expanded Service with Checklist
```
┌─────────────────────────────────────────────────┐
│ ▼ Service Name                            Edit  │
│   Service description                           │
│   5 checklist items                             │
├─────────────────────────────────────────────────┤
│ ✓ Service Checklist              [+ Add Task]  │
│                                                  │
│ ┌─────────────────────────────────────────┐    │
│ │● 1  Task Name                 [Archive] │    │
│ │    Task description here                │    │
│ └─────────────────────────────────────────┘    │
│                                                  │
│ ┌─────────────────────────────────────────┐    │
│ │● 2  Another Task              [Archive] │    │
│ │    Another description                   │    │
│ └─────────────────────────────────────────┘    │
│                                                  │
│ ┌─────────────────────────────────────────┐    │
│ │● 3  Third Task                [Archive] │    │
│ │    No description provided              │    │
│ └─────────────────────────────────────────┘    │
└─────────────────────────────────────────────────┘
```

## Color Scheme

| Element | Color | Purpose |
|---------|-------|---------|
| Service Card | White (#ffffff) | Clean background |
| Dropdown Background | Light Blue Gradient (#f8fafc → #f1f5f9) | Subtle depth |
| Border Accent | Blue (#3b82f6) | Visual hierarchy |
| Active Border | Darker Blue (#2563eb) | Hover state |
| Number Badge | Light Blue Background (#dbeafe) | Task numbering |
| Archive Button | Red (#ef4444) on Pink Background (#fef2f2) | Destructive action |

## API Endpoints

### Get Services with Checklists
```http
GET /api/services.php?checklists=1&with_archived_checklists=1
```

Response structure:
```json
{
  "success": true,
  "data": [
    {
      "service_id": 1,
      "service_name": "Bookkeeping",
      "description": "Monthly bookkeeping services",
      "checklists": [
        {
          "checklist_id": 1,
          "service_id": 1,
          "task_name": "Review bank statements",
          "description": "Reconcile all bank accounts",
          "is_required": 1,
          "is_deleted": 0
        }
      ]
    }
  ]
}
```

### Add Checklist Item
```http
POST /api/services.php?type=checklist
Content-Type: application/json

{
  "service_id": 1,
  "task_name": "New Task",
  "description": "Task description",
  "is_required": true
}
```

### Archive Checklist Item
```http
DELETE /api/services.php?type=checklist&id=123
```

## User Workflow

### As an Administrator:

1. **Navigate to Services** (`/services`)
2. **View a Service Checklist**:
   - Click the arrow icon next to a service name
   - Watch the checklist cascade in with animation
   - Review all checklist items

3. **Add a New Checklist Item**:
   - Expand a service
   - Click "Add Task" button
   - Fill in task name and description
   - Click "Save"
   - New item appears with animation

4. **Archive a Checklist Item**:
   - Expand a service
   - Click the red archive button on an item
   - Confirm the action
   - Item is soft-deleted (moved to archive)

### As a Project Manager:

1. **Create/Edit Client**:
   - Assign services to client
   - Review service checklists on the right
   - Check items to include in projects

2. **Create Project**:
   - Selected checklist items become project tasks
   - Customize tasks as needed
   - Assign to team members

## Best Practices

1. **Service Naming**: Use clear, descriptive service names (e.g., "Bookkeeping", "Tax Preparation")
2. **Checklist Order**: Items cascade in order, so organize logically (e.g., chronological workflow)
3. **Task Descriptions**: Provide clear descriptions to help project managers understand the task
4. **Archiving**: Archive outdated items instead of deleting (preserves history)
5. **Reusability**: Design checklists as templates that can be customized per project

## Technical Details

### Animation CSS
```css
@keyframes slideDown {
  from {
    max-height: 0;
    opacity: 0;
  }
  to {
    max-height: 1000px;
    opacity: 1;
  }
}

@keyframes cascadeIn {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
```

### State Management
- `expandedServiceId`: Tracks which service is currently expanded
- `activeChecklists`: Filters out archived items
- `showArchiveView`: Toggles between active and archived services

### Performance Considerations
- Checklist items are fetched once with the service
- Animations use CSS transforms (GPU-accelerated)
- Staggered animations limited to prevent lag on large lists
- Maximum 0.1s delay per item keeps total animation time reasonable

## Troubleshooting

### Checklist doesn't appear
- Ensure service has active checklist items
- Check that `is_deleted = 0` in database
- Verify API returns checklists with `?checklists=1` parameter

### Animation looks choppy
- Check browser performance
- Reduce number of concurrent animations
- Verify CSS animations are hardware-accelerated

### Items not saving
- Check API endpoint availability
- Verify user has proper permissions (admin/manager role)
- Check browser console for errors

## Future Enhancements

Potential improvements:
- Drag-and-drop reordering of checklist items
- Bulk import/export of checklists
- Checklist templates for common service types
- Progress tracking per checklist item in projects
- Due date assignments for checklist items
- Checklist dependencies (task B after task A)
