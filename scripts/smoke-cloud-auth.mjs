import fs from 'node:fs';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import pg from 'pg';

for (const raw of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match || process.env[match[1]]) continue;
  process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
}

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('POSTGRES_URL is required');
const databaseUrl = new URL(connectionString);
databaseUrl.searchParams.delete('sslmode');
const client = new pg.Client({ connectionString: databaseUrl.toString(), ssl: { rejectUnauthorized: false } });

const suffix = crypto.randomBytes(6).toString('hex');
const email = `cloud-smoke-${suffix}@example.invalid`;
const password = crypto.randomBytes(24).toString('base64url');
let userId = null;

await client.connect();
try {
  const passwordHash = await bcrypt.hash(password, 10);
  const inserted = await client.query(
    `INSERT INTO public.users (username, password, email, first_name, last_name, role, status, must_reset_password)
     VALUES ($1, $2, $3, 'Cloud', 'Smoke Test', 'admin', 'active', 0) RETURNING id`,
    [`cloud-smoke-${suffix}`, passwordHash, email],
  );
  userId = inserted.rows[0].id;

  const login = await fetch('https://llb-accountant.vercel.app/capstone1/api/auth.php?action=login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = await login.json();
  if (!login.ok || !loginBody.success) throw new Error(`Login smoke test failed with HTTP ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';', 1)[0];
  if (!cookie) throw new Error('Login did not set a session cookie');

  const session = await fetch('https://llb-accountant.vercel.app/capstone1/api/auth.php?action=session', {
    headers: { cookie },
  });
  const sessionBody = await session.json();
  if (!session.ok || !sessionBody.success || Number(sessionBody.data?.id) !== Number(userId)) {
    throw new Error(`Session smoke test failed with HTTP ${session.status}`);
  }

  const updateUser = await fetch('https://llb-accountant.vercel.app/capstone1/api/users.php', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: userId,
      first_name: 'Cloud Updated',
      document_resume: true,
      document_nbi_clearance: false,
    }),
  });
  const updateUserBody = await updateUser.json();
  if (!updateUser.ok || !updateUserBody.success) {
    throw new Error(`User boolean update smoke test failed with HTTP ${updateUser.status}: ${updateUserBody.message || ''}`);
  }
  const updatedUser = await client.query(
    'SELECT first_name, document_resume, document_nbi_clearance FROM public.users WHERE id = $1',
    [userId],
  );
  if (updatedUser.rows[0]?.first_name !== 'Cloud Updated' || Number(updatedUser.rows[0]?.document_resume) !== 1 || Number(updatedUser.rows[0]?.document_nbi_clearance) !== 0) {
    throw new Error('User boolean update did not persist the expected values');
  }

  const branches = await fetch('https://llb-accountant.vercel.app/capstone1/api/branches.php', { headers: { cookie } });
  const branchesBody = await branches.json();
  if (!branches.ok || !branchesBody.success || !Array.isArray(branchesBody.data)) {
    throw new Error(`Branches read smoke test failed with HTTP ${branches.status}`);
  }

  const branchName = `Cloud Smoke ${suffix}`;
  const createBranch = await fetch('https://llb-accountant.vercel.app/capstone1/api/branches.php', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ branch_name: branchName, location: 'Temporary smoke test' }),
  });
  const createBranchBody = await createBranch.json();
  const branchId = Number(createBranchBody.data?.branch_id || 0);
  if (!createBranch.ok || !createBranchBody.success || !branchId) {
    throw new Error(`Branch creation smoke test failed with HTTP ${createBranch.status}`);
  }
  const updateBranch = await fetch('https://llb-accountant.vercel.app/capstone1/api/branches.php', {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ branch_id: branchId, location: 'Temporary smoke test updated' }),
  });
  if (!updateBranch.ok) throw new Error(`Branch update smoke test failed with HTTP ${updateBranch.status}`);
  const removeBranch = await fetch(`https://llb-accountant.vercel.app/capstone1/api/branches.php?id=${branchId}&permanent=1`, {
    method: 'DELETE', headers: { cookie },
  });
  if (!removeBranch.ok) throw new Error(`Branch cleanup failed with HTTP ${removeBranch.status}`);

  console.log('Cloud login, session, user edit, and branch CRUD smoke tests passed.');
} finally {
  if (userId !== null) await client.query('DELETE FROM public.users WHERE id = $1', [userId]);
  await client.end();
}
