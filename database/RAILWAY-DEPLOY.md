# Railway database and account setup

## What the repository contains

The API expects the full LLB application schema, including `users`, `settings`,
`branches`, and the operational tables. A full SQL dump is not present in this
checkout (and the project deliberately excludes database dumps from Git and the
Docker image). `api/setup.php` is a destructive seed/reset endpoint: **do not run
it to initialize Railway**. Use the downloaded `.sql` export that was imported
into Railway before.

The application also has request-time auth and browser-lockout schema upgrades.
Those are incremental only; they do not create the entire application schema.

## Repair a missing `settings` table

Railway logs may show `Table 'railway.settings' doesn't exist`. This blocks API
requests because the shared request limiter writes its defaults to `settings`
before each endpoint runs. The PHP code now creates this table if it is missing.
You can also apply the matching migration directly to Railway MySQL:

1. In the repository, open `database/migrations/20261112_create_missing_settings_table.sql`.
2. Copy all of its contents.
3. In Railway-connected phpMyAdmin, select the application database (shown as
   `railway` in the error), then click the **SQL** tab.
4. Paste the SQL and click **Go** at the bottom.
5. Confirm the `settings` table appears in the left database tree. The migration
   is safe to run again and will not erase existing settings.

## Import the downloaded SQL dump (only if the Railway DB has no app tables)

1. Open Railway and click the **MySQL** service in the project canvas.
2. Open **Settings** and scroll to **Networking**. Keep the database private for
   the web app; it connects over Railway's private network.
3. Open the MySQL service's **Database** tab. Copy the private connection values
   or confirm the Railway variable references are available to `capstone1`.
4. Open phpMyAdmin connected to Railway MySQL and select the database named by
   Railway's `MYSQLDATABASE` value (often `railway`).
5. Before importing, look at the left database tree. If tables such as `users`,
   `settings`, and `branches` are already present, **do not import again**.
6. If the selected database is empty, click **Import** at the top, click
   **Choose File**, select the downloaded full `.sql` dump, keep the format as
   **SQL**, scroll to the bottom, and click **Import** or **Go**.
7. Wait for phpMyAdmin's green success message. Refresh the database tree and
   confirm that `users`, `settings`, and `branches` are present.

Do not use the MySQL server password as an application login password. The
Railway MySQL credentials and the `users.password` hash are different things.

## Repair/create the administrator login

1. In VS Code, open a terminal at the `capstone1` project folder.
2. Run `C:\xampp\php\php.exe scripts\hash_password.php` (or
   `php scripts/hash_password.php` if PHP is on PATH).
3. Enter a new application password of at least 12 characters, including an
   uppercase letter, a number, and a special character. The terminal may display
   what you type. Copy the resulting **hash**, not the password.
4. Open `database/admin-account.sql` and replace `PASTE_PASSWORD_HASH` with the
   generated hash and `YOUR_EMAIL` with the email for the existing account.
5. In Railway-connected phpMyAdmin, select the application database, click the
   **SQL** tab, paste the contents of `database/admin-account.sql`, and click
   **Go**. Expect one row to be updated.
6. If zero rows changed, that email is not present in the imported database.
   Create a user through the application's existing registration workflow, then
   rerun the update to grant the admin role. Do not run `api/setup.php`.

The login code trims and lowercases the identifier, searches email or username,
checks that the account status is `active`, and verifies the stored hash with
`password_verify()`. A local account does not automatically exist in Railway;
the Railway `users` row and its password hash must be present there.

## Railway variables

In Railway, click the **capstone1** service (not MySQL), open **Variables**, then
add these values. For the database entries use **Add Variable / Reference** and
select the matching variable from the **MySQL** service; do not type the literal
word `MYSQLHOST` or `MYSQLPASSWORD`.

| Variable | Value |
|---|---|
| `DB_HOST` | Reference `MySQL.MYSQLHOST` |
| `DB_PORT` | Reference `MySQL.MYSQLPORT` |
| `DB_USER` | Reference `MySQL.MYSQLUSER` |
| `DB_PASS` | Reference `MySQL.MYSQLPASSWORD` |
| `DB_NAME` | Reference `MySQL.MYSQLDATABASE` |
| `FRONTEND_URL` | `https://<your-capstone1-domain>.up.railway.app` |
| `CORS_ALLOWED_ORIGINS` | The exact same frontend origin, with no trailing slash |
| `SESSION_COOKIE_SAMESITE` | `Lax` for this same-site Railway deployment |
| `ALTCHA_HMAC_KEY` | A stable random secret of at least 32 bytes, used to sign CAPTCHA challenges |
| `RESEND_API_KEY` | Your Resend API key, stored only in Railway Variables |
| `MAIL_FROM` | For example `LLB Accountants <no-reply@your-verified-domain.com>` |
| `HCAPTCHA_SITE_KEY` | Your hCaptcha site key, if the login CAPTCHA is enabled |
| `HCAPTCHA_SECRET` | The matching hCaptcha secret, if enabled |

`MYSQL_URL=mysql://...` can replace the five DB references, but remove any
`DB_*` values when using it because explicit `DB_*` values take precedence.
Railway supplies `PORT`; do not set it yourself. `NEXT_PUBLIC_BACKEND_ORIGIN`
is a build-time setting and should be blank/unset when the static frontend and
PHP API share the current Railway domain. If they are on genuinely different
sites, set it to the API origin, list the frontend's exact origin in
`CORS_ALLOWED_ORIGINS`, and use `SESSION_COOKIE_SAMESITE=None` (which also
requires HTTPS/Secure cookies).

Resend requires `MAIL_FROM` to be an authorized sender. Verify your sending
domain in Resend before using an address at that domain. The code uses Resend's
HTTPS email endpoint; it does not fall back to SMTP for password-reset mail.

## Redeploy and verify

1. Save the changed files and push the branch connected to Railway's `capstone1`
   service. Railway should build a new deployment from that commit.
2. In Railway, select **capstone1 → Deployments → View logs**. Check build logs
   for successful Composer installation and deploy logs for Apache startup.
3. Open `https://<your-capstone1-domain>.up.railway.app/health`. A healthy
   response is JSON with `success: true`, `status: ok`, and `database: ok`.
4. If `/health` returns 503, use its `request_id` to find the matching PHP error
   in Railway deploy logs. The response stays safe; the actual MySQL message is
   logged to stderr with the same request ID.
5. Test the forgot-password flow with an email that exists in the Railway
   `users` table. A successful request should return the UI to the email-code
   step and a message should arrive through Resend. If it fails, the API returns
   a JSON message and Railway logs contain the Resend provider's status/body.
6. Verify the email code, set the new application password, then log in with
   that email and new password. If login still returns invalid credentials,
   confirm `status='active'` and that the SQL update affected the right row.

Railway domain URLs and database variables are service-specific. Use the exact
values shown on your Railway project rather than the example hostname above.
