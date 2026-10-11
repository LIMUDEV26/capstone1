# Security Hardening — LLB Accountants System

Living record of the security hardening programme for `capstone1`. Every phase
lists what changed, why, how it was verified, and how to roll it back.

**Audited stack (verified, not assumed):** Apache 2.4.58 (Win64) + `mod_php`
(`php8apache2_4.dll`), PHP 8.2.12, MariaDB/MySQL on `127.0.0.1:3306`,
Next.js 16.3.2 / React 19 frontend, 55 PHP endpoints under `api/`.
Frontend is served two ways: static export from `out/` via Apache, and
`next dev`/`next start` on port 3000 which proxies `/api/*` to Apache.

**Prime directive:** nothing ships that breaks login (all three roles),
captcha, SMTP, settings, or any existing feature. Every phase is verified with
`scripts/security-smoke.sh` before and after.

---

## Guiding rules

1. **Choke points, not shotgun edits.** `setCORSHeaders()` is called by 43 of
   55 endpoints; `utils/notify.ts` already wraps every mutating `fetch`;
   `getDBConnection()` and `sendError()` are universal. One edit at a choke
   point beats 43 chances to introduce a typo.
2. **Log before enforce.** Any control that can reject a request ships as
   `off | log | enforce` via env var, defaulting to `log`. Read the logs, fix
   the stragglers, then flip to `enforce`.
3. **Additive before subtractive.** Send the CSRF token before requiring it.
   Add migrations before removing runtime DDL.
4. **One concern per commit,** so a regression is a one-line revert.
5. **Verify with the smoke script,** never with "looks fine to me".

---

## Baseline verification harness

`scripts/security-smoke.sh` — run before and after every phase and diff:

```bash
bash scripts/security-smoke.sh > /tmp/before.txt
# ... apply phase ...
bash scripts/security-smoke.sh > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

It covers: sensitive-file exposure, security headers, CORS reflection
(including the `X-Forwarded-Host` bypass), session cookie flags,
unauthenticated refusal on 13 endpoints, the 5 public endpoints the login page
depends on, captcha config, login for admin/manager/staff, session validity,
~30 admin feature endpoints, manager and staff endpoints plus their privilege
boundaries, upload-proxy traversal, error-output hygiene, and logout.

---

## Findings (audit, verified live)

Live probes were run against `http://localhost/capstone1/`. Status codes below
are what the server actually returned, not what the code appears to do.

### Critical

| # | Finding | Evidence |
|---|---|---|
| C1 | Secrets committed to git **and** downloadable over HTTP | `.env.local` (SMTP password), `database/Capstone1.sql`, `.git/config`, `runtime/jar*.txt` (live `PHPSESSID`), `.cookiejar`, `package.json` all returned **200** |
| C2 | `backups/` directory listable; `api/backup.php` writes full DB dumps there | `backups/` returned **200**, `Options Indexes` on, no `.htaccess` |
| C3 | SMTP password hardcoded in tracked `api/.htaccess` | `SetEnv SMTP_PASSWORD` present, commit `d6a2455` |
| C4 | CORS reflects **any** origin with credentials | `CORS_ALLOWED_ORIGINS=*` → `$allowAll` branch echoes caller origin + `Allow-Credentials: true` |
| C5 | `X-Forwarded-Host` CORS bypass — client-controlled header widens the allowlist | verified: hostile origin reflected when header supplied |
| C6 | Zero CSRF protection | `grep -i csrf` = 0 hits repo-wide |
| C7 | App runs as MySQL `root` with empty password; needs it because DDL runs on request paths | `api/config.php` defaults + `ensure*Table()` / `ALTER TABLE` at runtime |
| C8 | Default passwords for admin/manager/staff published in plaintext in the SQL dump | `database/Capstone1.sql` line 548 comment |

### High

| # | Finding |
|---|---|
| H1 | `session.use_strict_mode=0` (session fixation), `expose_php=On` |
| H2 | Admin sessions never idle-expire — `shouldApplyManagedRoleSessionTimeout()` covers only `manager`/`staff` |
| H3 | IDOR in `api/analytics.php` — `?user_id=` honoured behind bare `requireAuth()` |
| H4 | Internal detail in responses: `attendance_import.php` returns `$e->getMessage()`; `getDBConnection()` returns `$conn->connect_error` |
| H5 | `api/convert_xls_to_sql.php` unauthenticated, echoes absolute filesystem paths (verified) |
| H6 | Dev/migration scripts in webroot: `setup.php`, `migrate_*.php`, `preview_xls_import.php` |
| H7 | No CSP on the Apache-served `out/` build; Next CSP has `'unsafe-inline' 'unsafe-eval'`, `connect-src *`, `frame-src *` |
| H8 | `npm audit`: 3 vulnerabilities (2 high — `browserslist`, `fast-uri`) |
| H9 | `Server:` / `X-Powered-By:` leak exact Apache/OpenSSL/PHP versions |

### Medium

| # | Finding |
|---|---|
| M1 | 19 raw `query()` calls interpolate variables (traced: internal identifiers / `intval`'d IDs — not currently exploitable, but one edit away) |
| M2 | `sanitizeInput()` applies `htmlspecialchars` on **input** in 20/55 files — wrong layer, corrupts stored data, double-encodes, false confidence |
| M3 | Upload validation inconsistent — `contracts.php` / `task-workflow.php` do `finfo` MIME checks; `privacy_policy_api.php` / `attendance_import.php` are extension-only |
| M4 | `serve-file.php` lets any authenticated user read any `task_submissions/` PDF |
| M5 | Password minimum length (8) enforced in exactly one place |

### Already correct — do not regress

644 `prepare()` vs 218 raw `query()`; bcrypt via `password_hash` with history
and expiry; TOTP + email OTP; account lockout, browser lockout, math/hCaptcha
gating; DB-backed rate limiting; lockdown mode; per-role feature access
(`requireFeatureAccess`) on 43 endpoints; `serve-file.php` traversal defence
(`realpath` containment + role check + `nosniff` + `no-store`);
`uploads/.htaccess` deny (verified 403); broad activity logging.

---

## Phase roadmap

| Phase | Scope | Risk | Status |
|---|---|---|---|
| 1 | Perimeter — CORS lockdown, CSP everywhere, session hardening, admin idle timeout, version banners | Low–Med | **Done** (126 pass / 0 regressions) |
| 0 | Containment — file exposure, secret rotation, `Options -Indexes`, backups out of webroot | Low (config only) | **Done** — applied, see Phase 0 below |
| 2 | CSRF at the choke point (`setCORSHeaders` + `notify.ts`), log→enforce | Med | Pending |
| 3 | Default-deny authorization, IDOR fixes, migration runner, least-privilege DB user | Med–High | Pending |
| 4 | Injection & I/O — identifier quoting, retire input-side escaping, unified upload validation | Med | Pending |
| 5 | Error hygiene + correlation IDs, security event feed | Low | Pending |
| 6 | Dependencies + CI lint gates | Low | Pending |
| 7 | Deployment — HTTPS, `cookie_secure`, prod allowlist, exclude dev scripts | Med | Pending |

Phase 1 runs first (as requested) even though Phase 0 closes the larger hole:
Phase 1 is pure code/config at known choke points and is trivially revertible,
making it the safest place to prove the harness works.

---

## Phase 1 — Perimeter hardening

**Goal:** stop hostile origins from reading authenticated data, apply CSP on
both delivery paths, close session fixation, give admin an idle timeout, and
stop advertising exact software versions — without breaking any current access
path (localhost, LAN IP, `next dev` on :3000, ngrok tunnel, Electron shell).

### 1.1 CORS: allowlist only, no wildcard, no client-controlled input

`api/utils.php` → `setCORSHeaders()`

Removed two things:
- the `CORS_ALLOWED_ORIGINS=*` → `$allowAll` branch (**C4**)
- `X-Forwarded-Host` as an allowlist source (**C5**)

Still works: same-origin (no `Origin` header sent), `localhost` / `127.0.0.1`
on ports 3000–3005, the server's own `HTTP_HOST`, and anything explicitly named
in `CORS_ALLOWED_ORIGINS`.

`*` in `CORS_ALLOWED_ORIGINS` is now treated as *unset* and falls back to the
safe host-derived defaults, with an `error_log()` warning. This matters: the
tracked `api/.htaccess` currently ships `SetEnv CORS_ALLOWED_ORIGINS "*"`, and
hard-failing on it would 403 the entire app. It degrades instead.

Tunnel and proxy hosts must now be named explicitly:

```apache
SetEnv CORS_ALLOWED_ORIGINS "https://curled-bluish-multitask.ngrok-free.dev,https://llb-laranjo.edgeone.dev"
```

`CORS_TRUST_FORWARDED_HOST=1` restores the old forwarded-host behaviour as an
escape hatch for a proxy setup that cannot be enumerated. Off by default;
should stay off.

### 1.2 CSP and hardening headers on API responses

API responses previously carried no CSP at all. Added at the same choke point:

- `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`
- `Cross-Origin-Resource-Policy: same-site`
- `Access-Control-Max-Age: 600` (fewer preflight round-trips)
- `header_remove('X-Powered-By')` — works under `mod_php` regardless of
  `expose_php`

JSON is inert, so `default-src 'none'` cannot break an API response. Endpoints
that stream binaries (`serve-file.php`, `backup.php?action=download`, the
attendance template) never call `setCORSHeaders()`, so they are untouched.

### 1.3 CSP on the Apache-served frontend

`next.config.ts` headers only apply when Node serves the app. The static `out/`
build that Apache serves had no CSP. The root `.htaccess` now carries one
matched to what the build actually loads — verified by grepping `out/` and the
page sources, which yielded exactly: Google Fonts CSS + webfonts, hCaptcha, and
`data:`/`blob:` images.

`'unsafe-inline'` and `'unsafe-eval'` stay in `script-src`: Next.js 16 inlines
hydration scripts and the React compiler runtime needs `eval` in dev. Removing
them requires nonce plumbing through `_document.tsx` — that is Phase 7 work,
not a drive-by change. `connect-src *` and `frame-src *` in `next.config.ts`
were narrowed to the origins actually in use.

### 1.4 Session hardening

- `session.use_strict_mode=1`, set from PHP in `api/config.php` before
  `session_start()` (**H1**). Fixes session fixation without touching
  `php.ini`, so it survives a XAMPP reinstall and needs no Apache restart.
- `session.cookie_httponly` and `SameSite=Lax` were already passed explicitly
  to `session_set_cookie_params()`; unchanged.
- `session.cookie_secure` still follows the detected scheme, so it stays `0` on
  plain HTTP **by design**. Forcing it on now would break login outright.
  Phase 7, together with HTTPS.
- `session_regenerate_id(true)` on login was already present (`auth.php:149`).

### 1.5 Admin idle timeout (H2)

`shouldApplyManagedRoleSessionTimeout()` returned true only for `manager` and
`staff` — the highest-privilege role never expired. Admin is now included,
reading a new `session_timeout_admin_minutes` setting, default **60 minutes**:
deliberately more generous than the 30-minute manager/staff default so an admin
doing long settings work is not kicked mid-task.

The setting is seeded by `ensureManagedRoleSessionTimeoutSettings()` and is
ignored whenever the existing global `session_timeout_enabled` toggle is off,
so Settings → Session Timeout keeps full control and can disable it entirely.

### 1.6 Version banner suppression (H9)

`ServerTokens Prod` / `ServerSignature Off` live in
`apache/conf/extra/httpd-default.conf`, which `.htaccess` cannot override, and
`Header always unset Server` does not strip `Server:` either. So:

- `.htaccess` and `api/.htaccess` unset `X-Powered-By` (this works)
- `setCORSHeaders()` calls `header_remove('X-Powered-By')` (this works)
- `Server:` suppression is a Phase 0 `httpd.conf` edit needing an Apache
  restart; until then the smoke script reports it as NOTE, not FAIL

### Files changed in Phase 1

| File | Change |
|---|---|
| `api/utils.php` | `setCORSHeaders()` split into `getCorsAllowedOrigins()` + `setApiHardeningHeaders()`; allowlist-only CORS; API CSP; `getSessionTimeoutMinutesForRole()`; admin in idle timeout; `tasks_board` + `approval_inbox` added to the feature catalog |
| `api/config.php` | `session.use_strict_mode=1`, `use_only_cookies=1`, `use_trans_sid=0` before `session_start()` |
| `api/auth.php` | login + session responses report the admin idle-timeout budget |
| `api/settings_api.php` | `session_timeout_admin_minutes` added to the number/allowed/label key lists |
| `api/notifications.php` | friendly label for the new setting in the activity feed |
| `api/serve-file.php` | per-response CSP for streamed uploads |
| `api/.htaccess` | unset the inherited frontend CSP so the strict API policy applies |
| `.htaccess` | CSP + hardening headers for the Apache-served `out/` build |
| `next.config.ts` | `connect-src` / `frame-src` narrowed from `*`; backend origins computed |
| `components/Layout.tsx` | idle countdown now armed for admin |
| `pages/settings/session-timeout.tsx` | Admin Timeout control added; copy corrected |
| `scripts/security-smoke.sh` | new — before/after regression + security harness |
| `docs/SECURITY_HARDENING.md` | this document |

### Verification results

`scripts/security-smoke.sh`, same machine, before vs after:

| | Before | After |
|---|---|---|
| PASS | 112 | **126** |
| FAIL | 24 | **15** |
| NOTE | 3 | 2 |

**Zero regressions** — no check that passed before fails now. All 15 remaining
failures are Phase 0 items (file exposure: `.env.local`, `.git/config`,
`database/Capstone1.sql`, `backups/`, cookie jars, `convert_xls_to_sql.php`).

Closed in this phase:

```
hostile origin reflected: https://evil.example    -> not reflected (no ACAO)
X-Forwarded-Host CORS bypass works                -> blocked
preflight reflects hostile origin                 -> preflight refuses
Content-Security-Policy missing (frontend)        -> present
API Content-Security-Policy missing               -> default-src 'none'
API leaks X-Powered-By: PHP/8.2.12                -> removed
```

Confirmed still working after the change (this was the point):

- Login for **admin, manager, and staff** — plus the two-step
  `login_precheck` → `login_complete` captcha path, and a wrong password is
  still rejected.
- Captcha config endpoint serves `login_math_captcha_enabled`,
  `hcaptcha_site_key`, and `login_failed_attempt_limit`; `captcha_required: true`
  still returned by precheck.
- **SMTP**: env vars visible to PHP under Apache, TCP+banner from
  `smtp.gmail.com:587`, PHPMailer autoloads, and `forgot_password` sent a real
  reset email successfully.
- Settings read **and** write round-trip (`session_timeout_admin_minutes`
  45 → 60 verified through the API).
- ~30 admin endpoints, 13 manager endpoints, 13 staff endpoints, all role
  boundaries (manager/staff blocked from admin-only endpoints), upload proxy
  traversal defence, logout invalidation for all three roles.
- `session.use_strict_mode=1`, `use_only_cookies=1`, `cookie_httponly=1`,
  `SameSite=Lax` confirmed live at runtime.
- `tsc --noEmit` clean.

`eslint` could not be run: ESLint 10.8.0 crashes with
`TypeError: Error while loading rule 'react/display-name'` from the
`eslint-plugin-react` bundled inside `eslint-config-next` — it fails the same way
on files this phase never touched, so it is a pre-existing toolchain
incompatibility, not a regression. Flagged for Phase 6.

### Bug found and fixed while verifying

The role-feature-access catalogs had **drifted between frontend and backend**.
`utils/roleFeatureAccess.ts` defined 19 features; `getRoleFeatureAccessCatalog()`
in `api/utils.php` defined only 17 — `tasks_board` and `approval_inbox` were
missing server-side.

Because `hasRoleFeatureAccess()` returns false for any key absent from the
catalog, `api/approval-inbox.php` (which calls
`requireFeatureAccess('approval_inbox', ['admin','manager'])`) returned **403 to
every manager**. The Approval Inbox was dead for managers, and the Settings →
Role Access Control page showed toggles that could never be persisted, because
`saveRoleFeatureAccessMap()` filters writes through `getSupportedRoleFeatureKeys()`.

Both keys are now in the backend catalog and the two lists are asserted equal.
Verified: manager `approval-inbox.php` went 403 → 200.

This was pre-existing, unrelated to the hardening, and would not have surfaced
without endpoint-level verification.

### Rollback

```bash
git checkout -- api/utils.php api/config.php api/auth.php api/settings_api.php \
  api/notifications.php api/serve-file.php api/.htaccess .htaccess \
  next.config.ts components/Layout.tsx pages/settings/session-timeout.tsx
```

Or, without reverting code: set `CORS_TRUST_FORWARDED_HOST=1` and add the needed
origins to `CORS_ALLOWED_ORIGINS` — that restores the old effective behaviour
except for the credentialed wildcard.

### Follow-ups this phase deliberately left open

1. `Server:` header still leaks the version string. Needs `ServerTokens Prod` in
   `apache/conf/extra/httpd-default.conf` + an Apache restart → Phase 0.
2. `session.cookie_secure` stays `0` because the app is served over plain HTTP.
   Forcing it now would break login → Phase 7 with HTTPS.
3. `'unsafe-inline'` / `'unsafe-eval'` remain in `script-src`. Removing them
   requires CSP nonces through `_document.tsx` → Phase 7.
4. The tracked `api/.htaccess` still contains `SetEnv CORS_ALLOWED_ORIGINS "*"`
   (now ignored with a logged warning) and a real SMTP password → Phase 0.


---

## Phase 0 — Containment (applied)

**Goal:** stop the webroot serving secrets, live sessions and source code, then
switch on the brute-force controls that already existed but were disabled.

### 0.1 Deny-list in the root `.htaccess`

`httpd.conf` grants `Options Indexes` to `C:/xampp/htdocs`, and an existing file
always wins the `out/` rewrite. Together those made all of the following return
**200** to an unauthenticated client. The deny-list now runs *before* the
rewrite, so a real file on disk can never be served:

| Was exposed | Now |
|---|---|
| `.env.local` (live SMTP password), `.env.example` | 403 |
| `.git/config`, `.gitignore` | 403 |
| `database/Capstone1.sql` (schema + password hashes + documented default passwords) | 403 |
| `runtime/jar2.txt`, `jar3.txt`, `jar_admin.txt` — **live `PHPSESSID` values** | 403 |
| `.cookiejar` | 403 |
| `api/.user.ini`, `api/.altcha_hmac_key` (the captcha signing key) | 403 |
| `backups/`, `runtime/`, `scripts/`, `docs/`, `memory/`, `.agent/`, `vendor/`, `api/lib/`, `config/` — full directory listings | 403 |
| `config/menu.ts`, `pages/_document.tsx`, `next.config.ts`, `package.json`, `composer.*` | 403 |
| `utputFormat` — an accidental HTTP dump containing a live `PHPSESSID` **and** the old `ACAO: *` + credentials response | deleted + untracked |

Rules added: `Options -Indexes +MultiViews`; dotfile/dot-directory block
(`.well-known` exempt); sensitive-extension block (`.sql .log .bak .ini .key
.phar .pem …`); server-side/build-tooling directory block; explicit root-file
block. `.json/.txt/.md/.ts/.mjs` are intentionally **not** blocked by extension
so static `out/` assets keep working — those root files are named explicitly.

`api/.htaccess` repeats the dotfile guard via `<FilesMatch>`, and
`uploads/.htaccess` now uses the Apache 2.4 `Require all denied` form with the
deprecated `Deny from all` kept only as a 2.2 fallback. `website/`, `public/`,
`out/`, `api/` and `uploads/` (own deny file) are deliberately untouched.

### 0.2 Pre-existing rewrite loop fixed

`^(.*)$ out/$1` re-prepended `out/` on every per-directory pass, so any request
for a **missing** file looped until `AH00124: Request exceeded the limit of 10
internal redirects` and returned a misleading **500** instead of a 404. A
`RewriteRule ^out/ - [L]` guard now stops the second pass. Verified:
`api/convert_xls_to_sql.php` and `api/nonexistent-endpoint.php` both return
**404** (were 500). Existing routes are unaffected — `/dashboard` still resolves
via MultiViews exactly as before.

### 0.3 Secrets moved out of tracked files

- `api/.htaccess` no longer contains `SetEnv SMTP_USERNAME / SMTP_PASSWORD /
  SMTP_FROM_EMAIL`. They load from `api/.secrets.php`, which is **git-ignored**,
  via a `require_once` at the top of `api/config.php` (**C3**). Values are
  exported with `putenv()` so every existing `getenv('SMTP_*')` call is
  unchanged. `api/.secrets.example.php` is the committed template.
- `SMTP_DEBUG` changed `2` → `0`: PHPMailer's debug output goes to stdout and
  corrupts JSON API responses.
- `SetEnv CORS_ALLOWED_ORIGINS "*"` → explicit local dev origins (the wildcard
  was already ignored by `getCorsAllowedOrigins()`, but it logged a warning on
  every request and invited someone to "fix" it by trusting the value).
- `.env.example` corrected: it still told operators to set
  `CORS_ALLOWED_ORIGINS=*`, which the code now rejects.
- New `.gitignore` entries: `api/.secrets.php`, `api/.altcha_hmac_key`,
  `api/.setup_done`, `.cookiejar`, `runtime/jar*.txt`, `runtime/*.log`.

### 0.4 Untracked from git (were committed)

`.cookiejar`, `api/.altcha_hmac_key`, `runtime/jar2.txt`, `runtime/jar3.txt`,
`runtime/jar_admin.txt`, `utputFormat`, `tsx.includes(x)`. Removed from the
index with `git rm --cached`; working files are untouched.

### 0.5 Brute-force controls enabled (were built but switched off)

All were already implemented and wired at the `setCORSHeaders()` choke point —
they were simply disabled in `settings`, so the login endpoint accepted
unlimited guesses with only hCaptcha in front of it.

| Setting | Was | Now |
|---|---|---|
| `rate_limit_enabled` | 0 | **1** |
| `browser_lockout_enabled` | 0 | **1** (threshold 10, IP+UA keyed, admin exempt) |

Confirmed live: `request_rate_limits` is now being populated (6 rows after one
smoke run), which only happens when the limiter is enabled.

Left **off** deliberately, because each changes end-user login behaviour and
needs the client's sign-off rather than a drive-by change:
`lockout_enabled` (account lockout, 3 strikes / 24 h — graduated by the
cooldown settings) and `login_math_captcha_enabled`. Both are one click in
Settings and are recommended before go-live.

### 0.6 Dead setting found

`intruder_ip_lockout_enabled` / `intruder_ip_lockout_threshold` /
`intruder_ip_lockout_window_hours` exist in `settings` but have **zero consumers
anywhere in the codebase** — they read as protection in the admin UI without
doing anything. The real IP+UA control is `browser_lockout_*`, which *is*
implemented. Either wire the intruder keys to `browser_lockout` or drop them.

### 0.7 Code fixes

| File | Change |
|---|---|
| `api/analytics.php` | **H3 IDOR closed** — `?user_id=` was honoured for any authenticated caller, so a staff user could read a colleague's metrics by guessing an id. Now admin/manager only, otherwise pinned to self. Also stopped echoing `$e->getMessage()` (**H4**) |
| `api/config.php` | loads `api/.secrets.php` when present |
| `api/convert_xls_to_sql.php` | **deleted** — unauthenticated, unauthenticatable, and crashed with a hard `mysqli_real_escape_string(null, …)` error (**H5/H6**) |
| `.htaccess`, `api/.htaccess`, `uploads/.htaccess` | see 0.1 |
| `scripts/security-smoke.sh` | staff login now uses an **active** account (`maria.gonzales`, id 7) instead of `staff` (id 3, `status='inactive'`). That inactive account made 14 staff assertions fail with 401, which looked like broken privilege boundaries and hid real regressions. Overridable with `SMOKE_STAFF_USER` / `SMOKE_STAFF_ID` |
| `.env.example` | CORS + SMTP guidance corrected |

### 0.8 Verification

`bash scripts/security-smoke.sh`, same machine, before vs after:

| | Before | After |
|---|---|---|
| PASS | 110 | **141** |
| FAIL | 31 | **0** |
| NOTE | 2 | 2 |

All 31 baseline failures resolved: 15 file/script exposures, 14 caused by the
inactive staff account, 1 the loop-crash. Re-confirmed working after the change:
login for all three roles, a wrong password still rejected, session validity,
32 admin endpoints, manager + staff feature access **and** their 403 boundaries,
upload-proxy traversal refusal, no path/trace leakage, logout invalidation.
`php -l` clean on every edited file. Rate limiting confirmed live.

### 0.9 Still requires a human — do these next

These cannot be done from the codebase and are **not** fixed by the above:

1. **Rotate the leaked secrets.** They are in git history and were fetchable, so
   assume they are public:
   - the Gmail app password (`SMTP_PASSWORD`) — revoke at
     <https://myaccount.google.com/apppasswords>, put the new one in
     `api/.secrets.php`, verify with `php scripts/check_smtp_env.php`
   - the Base44 API key in `config/base44.php` (`api_key`, `app_id`)
   - the hCaptcha secret + site key in `settings.hcaptcha_secret` /
     `hcaptcha_site_key`
   - every account password, because the default
     `admin / Lolrankgamers123@` was published in the world-readable
     `database/Capstone1.sql`
2. **Purge git history** (`git filter-repo`) or make the remote private. Deleting
   files now does nothing about `d6a2455` and earlier.
3. **Move `backups/` and `runtime/` off the webroot** — they are blocked from
   HTTP now, but there is no reason for them to live under `htdocs` at all.
4. `ServerTokens Prod` + `ServerSignature Off` in
   `apache/conf/extra/httpd-default.conf` (needs an Apache restart).
5. **Stop running MySQL as `root`.** `scripts/create_llb_app_user.sql` was never
   applied — `mysql.user` still contains only `root` and `pma`, and the app
   authenticates as `root` with an empty password (**C7**). Needs a migration
   runner first, because `ensure*Table()` / `ALTER TABLE` DDL currently runs on
   request paths.
