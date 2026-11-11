-- Run this in the Railway database only after importing the full application SQL dump.
-- Replace YOUR_EMAIL and PASTE_PASSWORD_HASH below. Generate the hash locally
-- with: php scripts/hash_password.php
-- This creates the account if absent, or resets/promotes the matching account.

SET @admin_email = LOWER(TRIM('YOUR_EMAIL'));
SET @admin_password_hash = 'PASTE_PASSWORD_HASH';
SET @admin_branch_id = (
    SELECT branch_id FROM branches
    WHERE LOWER(TRIM(status)) = 'active'
    ORDER BY branch_id
    LIMIT 1
);

-- Existing account: set the new hash and administrator status.
UPDATE users
SET password = @admin_password_hash,
    role = 'admin',
    status = 'active'
WHERE LOWER(TRIM(email)) = @admin_email;

-- Missing account: create one with a unique generated username and active branch.
-- The app accepts email as the login identifier, so the generated username is
-- only a secondary identifier. A branch must already exist in the imported DB.
INSERT INTO users (username, password, email, first_name, last_name, role, status, branch_id)
SELECT CONCAT('railway-admin-', LOWER(SUBSTRING(REPLACE(UUID(), '-', ''), 1, 12))),
       @admin_password_hash, @admin_email, 'System', 'Administrator', 'admin', 'active', @admin_branch_id
WHERE @admin_branch_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users WHERE LOWER(TRIM(email)) = @admin_email);

-- Confirm exactly one row is present and active before attempting login.
SELECT id, email, username, role, status
FROM users
WHERE LOWER(TRIM(email)) = @admin_email;
