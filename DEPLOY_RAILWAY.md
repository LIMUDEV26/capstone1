# Deploying to Railway

This project can run as one Docker web service: Apache serves the exported Next.js UI and PHP API, while Railway MySQL stores application data.

## 1. Prepare a private repository

Create a **private** GitHub repository and push this project. Do not add `api/.secrets.php`, `.env.local`, database exports, backups, or uploaded employee documents. The Docker build excludes local secrets and builds the static UI itself.

Before the first build, rotate any SMTP app password that has been stored in a local secrets file. Add the replacement only as a Railway secret variable.

## 2. Create the Railway services

1. In Railway, create a project and add a MySQL database.
2. Add a service from the private GitHub repository. Railway detects the root `Dockerfile` and builds the web app.
3. Add a Railway volume to the web service mounted at `/var/www/html/capstone1/uploads`. This preserves uploaded files across deploys.
4. Generate a public domain for the web service and use that exact HTTPS origin in the variables below.

## 3. Configure web service variables

Set these in the web service's Variables page. Use Railway variable references for values provided by the MySQL service; do not paste database passwords into source files.

| Variable | Value |
| --- | --- |
| `DB_HOST` | MySQL service `MYSQLHOST` |
| `DB_PORT` | MySQL service `MYSQLPORT` |
| `DB_NAME` | MySQL service `MYSQLDATABASE` |
| `DB_USER` | MySQL service `MYSQLUSER` |
| `DB_PASS` | MySQL service `MYSQLPASSWORD` |
| `FRONTEND_BASE_URL` | The web service's public HTTPS origin |
| `CORS_ALLOWED_ORIGINS` | The same exact HTTPS origin; do not use `*` |
| `SMTP_HOST` | `smtp.gmail.com` (or the SMTP provider's host) |
| `SMTP_PORT` | `587` |
| `SMTP_ENCRYPTION` | `tls` |
| `SMTP_USERNAME` | The sender mailbox |
| `SMTP_PASSWORD` | The sender mailbox's app password, stored as a secret |
| `SMTP_FROM_EMAIL` | The sender mailbox |
| `SMTP_FROM_NAME` | `LLB Accountants` |
| `SMTP_DEBUG` | `0` |

Railway's MySQL template exposes the connection variables listed above. Select the MySQL service when inserting variable references so Railway uses the correct service name.

## 4. Move the existing database

Export the current `llb` database from local phpMyAdmin as SQL, then import it into the Railway MySQL database using a secure database client or Railway's database connection details. Keep the export private and delete temporary copies after import. The SQL export is intentionally not part of this repository.

Do not point a production deployment at the local XAMPP database: it is only reachable from your own computer and is not a hosted database.

## 5. Verify before sharing

After the first deploy, check the public HTTPS URL and test login/verification email, employee and branch management, payroll, archived record restore, and document upload/download. Confirm uploaded files remain after a redeploy, and set up regular database backups before using real payroll records.

The existing `render.yaml` is not used for this Railway path. It contains old repository and placeholder values; do not deploy it as-is.
