# Client Project Setup Flow Diagram

## Visual Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                      CREATE NEW CLIENT                          │
│                                                                 │
│  User fills form and clicks "Add Client"                       │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│                   CLIENT SAVED TO DATABASE                      │
│                                                                 │
│  • client_id = 123                                             │
│  • client_name = "ABC Corporation"                             │
│  • needs_project_setup = 1  ◄── Flag set automatically         │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│               "NEXT STEP" MODAL APPEARS                         │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │  Create project for this client?                        │  │
│  │                                                         │  │
│  │  ABC Corporation was created successfully.             │  │
│  │  Choose a manager and due date:                        │  │
│  │                                                         │  │
│  │  Manager: [Dropdown ▼]                                 │  │
│  │  Due Date: [07/21/2026 05:00 PM]                      │  │
│  │                                                         │  │
│  │  [Cancel]  [Create Project]                            │  │
│  └─────────────────────────────────────────────────────────┘  │
└────────────────┬──────────────────────────┬─────────────────────┘
                 │                          │
      ┌──────────▼─────────┐     ┌─────────▼──────────┐
      │  User clicks       │     │  User clicks       │
      │    CANCEL          │     │  CREATE PROJECT    │
      └──────────┬─────────┘     └─────────┬──────────┘
                 │                          │
                 ▼                          ▼
┌────────────────────────────┐  ┌───────────────────────────────┐
│  needs_project_setup = 1   │  │  PROJECT CREATED              │
│  (stays at 1)              │  │                               │
│                            │  │  • project_id = 456           │
│  Modal closes              │  │  • client_id = 123            │
│  Client remains in list    │  │  • manager assigned           │
└──────────┬─────────────────┘  └──────────┬────────────────────┘
           │                               │
           │                               ▼
           │                    ┌──────────────────────────────┐
           │                    │  UPDATE CLIENT               │
           │                    │  needs_project_setup = 0     │
           │                    │  (Flag cleared)              │
           │                    └──────────┬───────────────────┘
           │                               │
           │                               ▼
           │                    ┌──────────────────────────────┐
           │                    │  REDIRECT TO PROJECT DETAIL  │
           │                    │  User can add tasks          │
           │                    └──────────────────────────────┘
           │
           │
           │  ═══ LATER: USER EDITS CLIENT ═══
           │
           ▼
┌────────────────────────────────────────────────────────────────┐
│                    EDIT CLIENT ACTION                          │
│                                                                │
│  User clicks "Edit" button on ABC Corporation                 │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│               CHECK needs_project_setup FLAG                   │
│                                                                │
│  If needs_project_setup === 1  →  Show "Next Step" Modal      │
│  If needs_project_setup === 0  →  Normal edit flow            │
└──────────────────────────┬─────────────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────────────┐
│          "NEXT STEP" MODAL APPEARS AGAIN                       │
│                                                                │
│  Same modal as before, giving user another chance             │
└────────────────┬──────────────────────────┬────────────────────┘
                 │                          │
      ┌──────────▼─────────┐     ┌─────────▼──────────┐
      │  User clicks       │     │  User clicks       │
      │    CANCEL          │     │  CREATE PROJECT    │
      │   (2nd time)       │     │                    │
      └──────────┬─────────┘     └─────────┬──────────┘
                 │                          │
                 ▼                          ▼
┌────────────────────────────┐  ┌───────────────────────────────┐
│  UPDATE CLIENT             │  │  PROJECT CREATED              │
│  needs_project_setup = 0   │  │  needs_project_setup = 0      │
│                            │  │                               │
│  Flag cleared permanently  │  │  Setup complete!              │
│  Won't appear again        │  │  Won't appear again           │
└────────────────────────────┘  └───────────────────────────────┘
```

## State Transitions

### Flag States

| State | Value | Meaning | Modal Behavior |
|-------|-------|---------|----------------|
| **Initial** | `1` | Client created, no project yet | Shows on create & edit |
| **Completed** | `0` | Project created | Never shows |
| **Skipped** | `0` | User skipped twice | Never shows |

## Code Flow

### 1. Client Creation (POST)
```javascript
// Frontend: pages/clients/index.tsx
handleSubmit() {
  // ... client data ...
  fetch('/api/clients.php', { method: 'POST', body: clientData })
  
  if (success) {
    setProjectPromptClient({
      client_id: newClientId,
      client_name: clientName,
      manager_id: defaultManager,
      end_date: nextWeek
    })
  }
}

// Backend: api/clients.php
$needs_project_setup = 1;  // Set flag
INSERT INTO client (..., needs_project_setup) VALUES (..., 1)
```

### 2. Edit Client with Flag Check
```javascript
// Frontend: pages/clients/index.tsx
openEditModal(client) {
  setEditingClient(client)
  setShowModal(true)
  
  // Check the flag
  if (client.needs_project_setup === 1) {
    setTimeout(() => {
      setProjectPromptClient({
        client_id: client.client_id,
        client_name: client.client_name,
        manager_id: defaultManager,
        end_date: nextWeek
      })
    }, 100)
  }
}
```

### 3. Create Project (Clear Flag)
```javascript
// Frontend: pages/clients/index.tsx
async handleCreateProjectForClient() {
  // Create project
  await fetch('/api/projects.php', { method: 'POST', body: projectData })
  
  // Clear flag
  await fetch('/api/clients.php', { 
    method: 'PUT', 
    body: { 
      client_id: clientId, 
      needs_project_setup: 0 
    }
  })
  
  setProjectPromptClient(null)
  router.push(`/projects/detail?id=${projectId}`)
}
```

### 4. Skip Project (Clear Flag on 2nd Skip)
```javascript
// Frontend: pages/clients/index.tsx
async handleSkipProjectCreation() {
  // Clear flag so it won't appear again
  await fetch('/api/clients.php', { 
    method: 'PUT', 
    body: { 
      client_id: clientId, 
      needs_project_setup: 0 
    }
  })
  
  setProjectPromptClient(null)
  await fetchClients()  // Refresh data
}
```

## Database Schema

```sql
CREATE TABLE client (
    client_id INT AUTO_INCREMENT PRIMARY KEY,
    client_name VARCHAR(100) NOT NULL,
    contact_person VARCHAR(100),
    email VARCHAR(100),
    phone VARCHAR(20),
    address TEXT,
    status ENUM('active', 'inactive', 'suspended') DEFAULT 'active',
    registration_date DATE,
    needs_project_setup TINYINT(1) DEFAULT 0,  -- NEW COLUMN
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    
    INDEX idx_client_name (client_name),
    INDEX idx_status (status),
    INDEX idx_needs_project_setup (needs_project_setup)  -- NEW INDEX
);
```

## User Scenarios

### Scenario A: Immediate Completion
1. Create client → ✅ Modal shows
2. Fill details → ✅ Click "Create Project"
3. Project created → ✅ Flag = 0
4. Edit client later → ❌ No modal (flag is 0)

### Scenario B: Delayed Completion
1. Create client → ✅ Modal shows
2. Click "Cancel" → ✅ Flag stays 1
3. Edit client → ✅ Modal shows again
4. Fill details → ✅ Click "Create Project"
5. Project created → ✅ Flag = 0
6. Edit client later → ❌ No modal (flag is 0)

### Scenario C: Permanent Skip
1. Create client → ✅ Modal shows
2. Click "Cancel" → ✅ Flag stays 1
3. Edit client → ✅ Modal shows again
4. Click "Cancel" again → ✅ Flag = 0 (cleared)
5. Edit client later → ❌ No modal (flag is 0)
