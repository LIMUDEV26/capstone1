# Service Checklist - Visual Example

## Feature Overview
This document shows a visual representation of the cascading dropdown checklist feature.

## Before Click (Collapsed State)
```
┌──────────────────────────────────────────────────────────┐
│  ▶  Bookkeeping Service                          [Edit] [Archive]  │
│     Monthly bookkeeping and financial record management             │
│     8 checklist items                                               │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  ▶  Tax Preparation                              [Edit] [Archive]  │
│     Annual tax filing and compliance services                      │
│     5 checklist items                                               │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  ▶  Payroll Services                             [Edit] [Archive]  │
│     Bi-weekly payroll processing                                   │
│     10 checklist items                                              │
└──────────────────────────────────────────────────────────┘
```

## After Click (Expanded with Cascade Animation)
```
┌──────────────────────────────────────────────────────────────────────┐
│  ▼  Bookkeeping Service                                  [Edit] [Archive]  │
│     Monthly bookkeeping and financial record management                     │
│     8 checklist items                                                       │
├──────────────────────────────────────────────────────────────────────┤
│  ✓ Service Checklist                              [+ Add Task]      │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [1] Review Bank Statements                    [Archive]   │  ← Item 1  │
│  │    Reconcile all bank accounts for the month               │  (0ms delay)│
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [2] Categorize Transactions                   [Archive]   │  ← Item 2  │
│  │    Assign proper categories to all transactions            │  (100ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [3] Generate Financial Reports                [Archive]   │  ← Item 3  │
│  │    Create P&L, balance sheet, and cash flow                │  (200ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [4] Review Accounts Payable                   [Archive]   │  ← Item 4  │
│  │    Check all outstanding invoices and bills                │  (300ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [5] Review Accounts Receivable                [Archive]   │  ← Item 5  │
│  │    Track customer payments and aging                       │  (400ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [6] Reconcile Credit Cards                    [Archive]   │  ← Item 6  │
│  │    Match credit card statements to transactions            │  (500ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [7] Update Financial Dashboard                [Archive]   │  ← Item 7  │
│  │    Refresh KPIs and metrics for stakeholders               │  (600ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Animates: slide from left + fade in                                  │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────┐            │
│  │● [8] Client Communication                      [Archive]   │  ← Item 8  │
│  │    Send monthly summary and answer questions               │  (700ms)   │
│  └────────────────────────────────────────────────────────────┘            │
│     ↓ Total animation time: ~1.2 seconds                                   │
└──────────────────────────────────────────────────────────────────────┘
```

## Animation Timeline

```
Time →
0ms     ┃ ▼ Dropdown opens (slideDown animation starts)
        ┃
400ms   ┃ ▼ Dropdown fully visible
        ┃ ● Item 1 starts cascading in
        ┃
500ms   ┃ ● Item 1 fully visible
        ┃ ● Item 2 starts cascading in
        ┃
600ms   ┃ ● Item 2 fully visible
        ┃ ● Item 3 starts cascading in
        ┃
700ms   ┃ ● Item 3 fully visible
        ┃ ● Item 4 starts cascading in
        ┃
800ms   ┃ ● Item 4 fully visible
        ┃ ● Item 5 starts cascading in
        ┃
...continues for remaining items...
```

## Hover State Example

### Normal State
```
┌────────────────────────────────────────────────────────────┐
│● [2] Categorize Transactions                   [Archive]   │
│    Assign proper categories to all transactions            │
└────────────────────────────────────────────────────────────┘
```

### Hover State
```
    ┌────────────────────────────────────────────────────────────┐
    │● [2] Categorize Transactions                   [Archive]   │ ← Slides right 8px
    │    Assign proper categories to all transactions            │    Border glows blue
    └────────────────────────────────────────────────────────────┘
```

## Empty State

When a service has no checklist items:
```
┌──────────────────────────────────────────────────────────────────────┐
│  ▼  New Service                                      [Edit] [Archive] │
│     A newly created service with no tasks yet                         │
│     0 checklist items                                                 │
├──────────────────────────────────────────────────────────────────────┤
│  ✓ Service Checklist                              [+ Add Task]       │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │          ╳                                                     │   │
│  │                                                                │   │
│  │      No checklist items yet                                   │   │
│  │      Add tasks to create a standard checklist for this service│   │
│  │                                                                │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

## Integration with Projects

### Step 1: View Service in Client Management
```
Client: ABC Corporation
Services: [Bookkeeping] [Tax Preparation]

┌──────────────────────────────────────────────────────┐
│ Service Checklist Preview                            │
│                                                       │
│ Bookkeeping Service                                  │
│   ☑ Review Bank Statements                          │
│   ☑ Categorize Transactions                         │
│   ☑ Generate Financial Reports                      │
│   ☐ Review Accounts Payable                         │
│   ☐ Review Accounts Receivable                      │
│   ☑ Reconcile Credit Cards                          │
│   ☐ Update Financial Dashboard                      │
│   ☑ Client Communication                            │
└──────────────────────────────────────────────────────┘
```

### Step 2: Create Project
```
Project: ABC Corp - January 2026 Bookkeeping

Tasks (from checked checklist items):
├─ Review Bank Statements
├─ Categorize Transactions
├─ Generate Financial Reports
├─ Reconcile Credit Cards
└─ Client Communication

Note: Only checked items become project tasks
Unchecked items are not included
```

## Color and Style Guide

### Colors Used
- **Primary Blue**: `#3b82f6` (borders, accents, buttons)
- **Dark Blue**: `#2563eb` (hover states)
- **Light Blue**: `#dbeafe` (number badges)
- **Background**: `#f8fafc → #f1f5f9` (gradient)
- **White**: `#ffffff` (card backgrounds)
- **Text Dark**: `#0f172a` (headings)
- **Text Medium**: `#64748b` (descriptions)
- **Text Light**: `#94a3b8` (placeholders)
- **Red**: `#ef4444` (archive button)
- **Red Background**: `#fef2f2` (archive button bg)

### Typography
- **Service Name**: 16px, font-weight: 600
- **Task Name**: 14px, font-weight: 600
- **Description**: 13px, font-weight: 400
- **Badge Number**: 11px, font-weight: 700

### Spacing
- Card padding: 20px
- Gap between items: 10px
- Border radius: 10px (cards), 8px (buttons)
- Left border width: 4px

## Accessibility Features

1. **Keyboard Navigation**: All buttons are focusable
2. **ARIA Labels**: Every button has descriptive aria-label
3. **Semantic HTML**: Proper heading hierarchy
4. **Color Contrast**: All text meets WCAG AA standards
5. **Hover States**: Clear visual feedback on interactive elements

## Mobile Responsiveness

On smaller screens, the layout adjusts:
- Cards stack vertically
- Checklist items remain full-width
- Touch targets are appropriately sized (minimum 44x44px)
- Hover effects work on touch devices

## Performance Notes

- **Animation Duration**: 0.4-0.5s (optimal for perceived speed)
- **Stagger Delay**: 0.1s per item (prevents overwhelming cascade)
- **GPU Acceleration**: Uses `transform` and `opacity` for smooth 60fps
- **Max Items**: No hard limit, but animations cap at reasonable delay
