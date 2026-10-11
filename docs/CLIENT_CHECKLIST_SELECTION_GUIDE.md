# Client Checklist Selection Guide

## Overview
When adding or editing a client, you can now select which checklist tasks from each service will be used when creating projects. This allows you to customize the project template per client based on their specific needs.

## Features

### 1. **Service Selection with Task Preview**
- Select one or more services for the client
- Each service button shows selected/total tasks count (e.g., "3/8")
- Click a service button to view its checklist tasks

### 2. **Cascading Checkbox Animation**
- Tasks appear with a smooth ladder/cascade effect
- Each task slides in from the left with a staggered delay
- First task appears immediately, second after 0.1s, third after 0.2s, etc.

### 3. **Interactive Checklist Items**
- ✅ **Checkbox**: Click anywhere on the task card to toggle selection
- 🔢 **Number Badge**: Shows task order (1, 2, 3...)
- 📝 **Task Details**: Name and optional description
- 🎨 **Visual Feedback**: Selected tasks have blue background and border

### 4. **Smart Selection Tracking**
- Selected tasks are remembered per service
- Service button badge updates in real-time (e.g., "2/5" means 2 of 5 tasks selected)
- Deselecting a service clears its checklist selections

## User Interface

### Modal Layout
```
┌─────────────────────────────────────────────┐
│ Add New Client                              │
├─────────────────────────────────────────────┤
│ Client Name: [____________]                 │
│ Services: ☑ Audit  ☑ Bookkeeping  ☐ Tax   │
│                                             │
│ Service Checklist Tasks                     │
│ Select tasks for project creation          │
│                                             │
│ ┌────────────────────────────────────────┐ │
│ │ [Audit 2/2] [Bookkeeping 3/5]          │ │
│ └────────────────────────────────────────┘ │
│                                             │
│ ┌────────────────────────────────────────┐ │
│ │ ✓ Bookkeeping                           │ │
│ │ 5 tasks                                 │ │
│ │                                         │ │
│ │ ☑ [1] Review Bank Statements            │ │ ← Checked
│ │     Reconcile all bank accounts         │ │
│ │                                         │ │
│ │ ☐ [2] Categorize Transactions           │ │ ← Unchecked
│ │     Assign categories to transactions   │ │
│ │                                         │ │
│ │ ☑ [3] Generate Financial Reports        │ │ ← Checked
│ │     Create P&L and balance sheet        │ │
│ └────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

## Visual Design

### Service Button States

**Inactive Service:**
```
┌──────────────────┐
│ Bookkeeping 0/5  │  White background
└──────────────────┘  Gray border
```

**Active Service:**
```
┌──────────────────┐
│ Bookkeeping 3/5  │  Blue gradient background
└──────────────────┘  Blue border with shadow
```

### Task Card States

**Unselected Task:**
```
┌──────────────────────────────────────┐
│ ☐ [1] Review Bank Statements         │  Light gray background
│     Reconcile all bank accounts      │  Gray left border
└──────────────────────────────────────┘
```

**Selected Task:**
```
┌──────────────────────────────────────┐
│ ☑ [1] Review Bank Statements         │  Light blue background
│     Reconcile all bank accounts      │  Blue left border
└──────────────────────────────────────┘
```

**Hover Effect:**
```
    ┌──────────────────────────────────────┐
    │ ☑ [1] Review Bank Statements         │  Slides right 4px
    │     Reconcile all bank accounts      │  Blue glow shadow
    └──────────────────────────────────────┘
```

## Animation Details

### Cascade Timeline
```
Service expands (serviceExpand animation)
  ↓ 0.4s
Task 1 slides in (cascadeSlideIn)
  ↓ 0.1s delay
Task 2 slides in
  ↓ 0.1s delay
Task 3 slides in
  ↓ 0.1s delay
...and so on
```

### CSS Animations
```css
@keyframes cascadeSlideIn {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes serviceExpand {
  from {
    max-height: 0;
    opacity: 0;
  }
  to {
    max-height: 2000px;
    opacity: 1;
  }
}
```

## Workflow

### Creating a New Client

1. **Open Add Client Modal**
   - Click "Add Client" button
   - Modal opens with a 700px width

2. **Fill Basic Information**
   - Client Name (required)
   - Contact details
   - Email and Phone

3. **Select Services**
   - Check one or more service checkboxes
   - Services appear in the "Service Checklist Tasks" section below

4. **Select Checklist Tasks**
   - Click on a service button to view its tasks
   - Service button shows "0/5" initially (0 selected out of 5 total)
   - Tasks cascade down with animation
   - Click on task cards to select/deselect them
   - Selected count updates in real-time (e.g., "3/5")

5. **Switch Between Services**
   - Click different service buttons to view other checklists
   - Selections are preserved when switching between services
   - Each service maintains its own selection state

6. **Save Client**
   - Click "Create Client" button
   - Selected checklist items are saved with the client
   - When creating a project, only selected tasks will be used

### Editing an Existing Client

1. **Open Edit Modal**
   - Click edit icon on a client
   - Modal opens with existing data

2. **Modify Service Selections**
   - Add or remove services
   - Update checklist task selections
   - Changes are preserved per service

3. **Save Changes**
   - Click "Update Client"
   - New selections apply to future projects

## How It Works with Projects

### Project Creation Flow

1. **Client has services with selected tasks:**
   ```
   Client: ABC Corp
   Services:
     - Bookkeeping: [✓ Task 1, ✓ Task 3, ✓ Task 5]
     - Tax Preparation: [✓ Task 2, ✓ Task 4]
   ```

2. **Create a new project for this client:**
   - System uses only the checked tasks
   - Each checked task becomes a project task
   - Task names and descriptions are copied

3. **Project tasks created:**
   ```
   Project: ABC Corp - January 2026
   Tasks:
     1. Review Bank Statements (from Bookkeeping)
     2. Generate Financial Reports (from Bookkeeping)
     3. Client Communication (from Bookkeeping)
     4. Prepare Tax Documents (from Tax Preparation)
     5. File Tax Returns (from Tax Preparation)
   ```

## Color Scheme

| Element | Unselected | Selected | Purpose |
|---------|-----------|----------|---------|
| Task Background | `#f8fafc` | `#eff6ff` | Light blue when selected |
| Task Border | `#e2e8f0` | `#3b82f6` (2px) | Blue border when selected |
| Left Border | `#cbd5e1` (4px) | `#3b82f6` (4px) | Strong blue accent |
| Number Badge | `#cbd5e1` | `#3b82f6` | Blue for selected items |
| Service Button | White | Blue Gradient | Gradient for active service |
| Count Badge | `#e0e7ff` / `#3730a3` | `rgba(255,255,255,0.25)` / White | Translucent on active |

## State Management

### Selected Checklist Items Structure
```typescript
selectedChecklistItems: {
  [serviceId: number]: number[]  // Array of checklist_ids
}

// Example:
{
  1: [101, 103, 105],  // Bookkeeping: tasks 101, 103, 105 selected
  2: [201, 204],       // Tax: tasks 201, 204 selected
}
```

### Functions

**Toggle Selection:**
```typescript
toggleChecklistItem(serviceId: number, checklistId: number)
```

**Check if Selected:**
```typescript
isChecklistItemSelected(serviceId: number, checklistId: number): boolean
```

**Reset on Service Deselect:**
- When a service is unchecked, its checklist selections are cleared
- Prevents orphaned selections

## Accessibility

1. **Keyboard Navigation**
   - All checkboxes are keyboard accessible
   - Tab through tasks and services
   - Space/Enter to toggle selection

2. **Screen Readers**
   - Checkboxes announce checked/unchecked state
   - Service buttons announce task counts
   - Task descriptions are properly labeled

3. **Visual Indicators**
   - Clear selected/unselected states
   - High contrast colors
   - Multiple visual cues (border, background, checkbox)

## Performance Considerations

1. **Animation Performance**
   - CSS animations use GPU-accelerated properties (transform, opacity)
   - Staggered animations prevent lag
   - Maximum 0.1s delay per task keeps total time reasonable

2. **State Updates**
   - Selections stored in efficient data structure (Map by service ID)
   - No unnecessary re-renders
   - Optimized toggle operations

3. **Memory Management**
   - Selections cleared when modal closes
   - No memory leaks from animation timers
   - Efficient state cleanup

## Best Practices

### For Administrators

1. **Define Comprehensive Checklists**
   - Create detailed task descriptions
   - Order tasks logically (chronological workflow)
   - Keep task names clear and concise

2. **Service Organization**
   - Group related tasks under appropriate services
   - Avoid duplicate tasks across services
   - Review and update checklists regularly

### For Managers

1. **Client-Specific Customization**
   - Review all tasks before selecting
   - Consider client's specific needs
   - Don't just select all tasks by default

2. **Project Planning**
   - Selected tasks become project baseline
   - Can be modified in individual projects
   - Use as a starting template, not rigid structure

## Troubleshooting

### Tasks don't cascade
- Ensure service has active checklist items
- Check that service is properly selected
- Verify animations are enabled in browser

### Selection not saving
- Check that checkbox is clicked (entire card is clickable)
- Verify state is updating (watch count badge)
- Ensure no JavaScript errors in console

### Service button not updating count
- Confirm checkbox toggle is working
- Check React state management
- Verify selectedChecklistItems is updating

## Future Enhancements

Potential improvements:
- **Select All / Deselect All**: Quick buttons per service
- **Copy selections**: Copy task selections from another client
- **Task templates**: Save common selection patterns
- **Task dependencies**: Indicate required/optional tasks
- **Custom task order**: Drag-and-drop reordering
- **Task notes**: Add client-specific notes to tasks
- **Task due dates**: Pre-set due dates for common tasks
