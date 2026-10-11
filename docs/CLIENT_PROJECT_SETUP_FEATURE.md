# Client Project Setup Tracking Feature

## Overview

This feature ensures that when a client is created, the system remembers if the initial project creation was skipped. When the user later edits that client, the project creation prompt will automatically reappear, giving them another chance to complete the setup.

## How It Works

### 1. Client Creation Flow

When a new client is created:
1. The client is saved to the database with `needs_project_setup = 1`
2. A "Next Step" modal appears prompting the user to create a project
3. User has two options:
   - **Create Project**: Creates the project and sets `needs_project_setup = 0`
   - **Cancel/Skip**: Closes the modal but keeps `needs_project_setup = 1`

### 2. Client Edit Flow

When editing an existing client:
1. The system checks if `needs_project_setup = 1`
2. If yes, after the edit modal closes, the "Next Step" modal automatically appears
3. User can then:
   - **Create Project**: Creates the project and sets `needs_project_setup = 0`
   - **Cancel/Skip**: Sets `needs_project_setup = 0` to stop showing the prompt

### 3. Database Schema

A new column has been added to the `client` table:

```sql
ALTER TABLE client 
ADD COLUMN needs_project_setup TINYINT(1) DEFAULT 0 
COMMENT 'Set to 1 when client is created but project creation was skipped';

ALTER TABLE client 
ADD INDEX idx_needs_project_setup (needs_project_setup);
```

## Implementation Details

### Backend Changes (api/clients.php)

1. **POST (Create Client)**
   - Automatically sets `needs_project_setup = 1` for new clients
   
2. **PUT (Update Client)**
   - Accepts `needs_project_setup` field in update payload
   - Can be set to `0` to mark project setup as complete or permanently skipped

3. **GET (Retrieve Clients)**
   - Returns `needs_project_setup` field with each client record

### Frontend Changes (pages/clients/index.tsx)

1. **openEditModal()**
   - Checks if `needs_project_setup === 1`
   - Automatically triggers the project prompt modal after a short delay

2. **handleCreateProjectForClient()**
   - On successful project creation, sets `needs_project_setup = 0`
   - Refreshes client list to reflect the change

3. **handleSkipProjectCreation()**
   - When user explicitly skips, sets `needs_project_setup = 0`
   - This prevents the prompt from appearing again

## Migration Instructions

The column is included in the main `database/Capstone1.sql` file.

For existing databases, run this ALTER statement:

```sql
ALTER TABLE client 
ADD COLUMN needs_project_setup TINYINT(1) DEFAULT 0 
COMMENT 'Set to 1 when client is created but project creation was skipped';

ALTER TABLE client 
ADD INDEX idx_needs_project_setup (needs_project_setup);
```

## User Experience

### Scenario 1: Complete Setup Immediately
1. Create client → Modal appears
2. Fill manager and due date → Click "Create Project"
3. Project created, user redirected to project detail page
4. ✅ `needs_project_setup = 0`, won't see prompt again

### Scenario 2: Skip and Complete Later
1. Create client → Modal appears
2. Click "Cancel" → Modal closes
3. ✅ `needs_project_setup = 1`, will see prompt again
4. Later: Edit client → Modal appears again
5. Fill details → Click "Create Project"
6. ✅ `needs_project_setup = 0`, won't see prompt again

### Scenario 3: Permanent Skip
1. Create client → Modal appears
2. Click "Cancel" → Modal closes
3. ✅ `needs_project_setup = 1`, will see prompt again
4. Later: Edit client → Modal appears again
5. Click "Cancel" again
6. ✅ `needs_project_setup = 0`, won't see prompt again

## Benefits

- **No Lost Leads**: Ensures clients aren't created without their initial project
- **Flexible Workflow**: Users can skip initially if they need more information
- **User-Friendly**: Automatic reminder when editing the client
- **Clean State**: Once handled (created or permanently skipped), the prompt stops appearing
- **Backward Compatible**: Existing clients aren't affected

## Technical Notes

- The column uses `TINYINT(1)` which is MySQL's boolean type
- Default value is `0` to avoid prompts for existing clients
- Index added for efficient querying of clients needing setup
- Frontend checks for multiple boolean formats: `1`, `'1'`, `true`
- Uses async/await for API calls to ensure state consistency
