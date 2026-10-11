# Client Project Setup - Quick Reference

## 🎯 What This Feature Does

When you create a client, the system reminds you to create their initial project. If you skip it, the reminder appears when you edit the client later.

## 🚀 Quick Start

### For Developers

**The column is already in the main Capstone1.sql file!** Just use the main database schema.

**2. That's it!** The feature is ready to use.

### For End Users

**Creating a client:**
1. Fill client form → Click "Add Client"
2. Modal appears: "Create project for this client?"
3. Choose:
   - **Create Project** = Creates project immediately
   - **Cancel** = Skip for now, reminder will appear when you edit

**Editing a client (if project wasn't created):**
1. Click "Edit" on client
2. Modal appears again: "Create project for this client?"
3. Choose:
   - **Create Project** = Creates project, won't ask again
   - **Cancel** = Skips permanently, won't ask again

## 📋 Technical Details

### Database Column
```sql
needs_project_setup TINYINT(1) DEFAULT 0
```
- `1` = Needs project setup (shows modal)
- `0` = Completed or skipped (no modal)

### API Endpoints

**Create Client**
```http
POST /api/clients.php
```
Automatically sets `needs_project_setup = 1`

**Update Client**
```http
PUT /api/clients.php
Body: { "client_id": 123, "needs_project_setup": 0 }
```
Clears the flag

**Get Client**
```http
GET /api/clients.php?id=123
```
Returns `needs_project_setup` field

### Frontend State

```typescript
// Check flag when opening edit modal
if (client.needs_project_setup === 1) {
  showProjectPromptModal()
}

// Clear flag when creating project
await updateClient({ needs_project_setup: 0 })

// Clear flag when skipping (2nd time)
await updateClient({ needs_project_setup: 0 })
```

## 🐛 Troubleshooting

### Modal doesn't appear after creating client
- Check browser console for errors
- Verify `needs_project_setup` column exists in database
- Check API response includes `needs_project_setup` field

### Modal appears every time I edit
- The flag is still `1` in database
- Click "Cancel" on the modal to permanently skip
- Or create the project to clear the flag

### Existing clients show the modal
- They shouldn't! Default is `0` for existing clients
- Run: `UPDATE client SET needs_project_setup = 0 WHERE needs_project_setup IS NULL`

## 📊 Testing Checklist

```
✅ Create client → Modal appears
✅ Click Cancel → Modal closes, flag stays 1
✅ Edit client → Modal appears again
✅ Create project → Flag cleared to 0
✅ Edit client again → Modal doesn't appear
✅ Create client and skip twice → Flag cleared to 0
✅ Existing clients → No modal on edit
```

## 🔧 Configuration

No configuration needed! The feature works out of the box after migration.

### Disable Feature (if needed)
Remove or comment out this code in `pages/clients/index.tsx`:

```typescript
// In openEditModal function, remove this block:
if (c.needs_project_setup === 1) {
  setTimeout(() => {
    setProjectPromptClient({ ... })
  }, 100)
}
```

## 📚 Related Documentation

- Full feature guide: `CLIENT_PROJECT_SETUP_FEATURE.md`
- Flow diagram: `CLIENT_PROJECT_SETUP_FLOW.md`
- Implementation summary: `../IMPLEMENTATION_SUMMARY.md`

## 💡 Tips

1. **For project managers**: This ensures no client is created without a project
2. **For developers**: The flag auto-clears after project creation or 2nd skip
3. **For DBAs**: The column has an index for efficient querying
4. **For QA**: Test both "create immediately" and "skip then create" flows

## ⚠️ Important Notes

- The modal appears AFTER the edit modal opens (100ms delay)
- Skipping once keeps the flag, skipping twice clears it
- Creating a project always clears the flag
- Existing clients (pre-migration) default to `0` (no modal)
- The feature is backward compatible

## 🔄 Rollback

If you need to remove this feature:

```sql
-- Remove database column
ALTER TABLE client DROP COLUMN needs_project_setup;
ALTER TABLE client DROP INDEX idx_needs_project_setup;

-- Revert code changes or remove the openEditModal flag check
```

## 📞 Support

For questions or issues:
1. Check the full documentation in `docs/`
2. Review the implementation summary
3. Check browser console for errors
4. Verify database migration ran successfully
