#!/usr/bin/env bash
# ============================================================================
# security-smoke.sh — Regression + security baseline for the LLB system.
# Run BEFORE and AFTER every hardening phase and diff the output.
#
#   bash scripts/security-smoke.sh > /tmp/before.txt
#   # ...apply phase...
#   bash scripts/security-smoke.sh > /tmp/after.txt
#   diff /tmp/before.txt /tmp/after.txt
#
# Requires curl + a running Apache/MySQL. Read-only apart from normal logins.
# ============================================================================
set -uo pipefail

BASE="${SMOKE_BASE_URL:-http://localhost/capstone1}"
API="$BASE/api"
ORIGIN="${SMOKE_ORIGIN:-http://localhost}"
PW="${SMOKE_PASSWORD:-Lolrankgamers123@}"
# The historic `staff` login (users.id=3) is status='inactive', so it can never
# authenticate — every staff assertion below then failed with 401 and looked
# like a broken privilege boundary. Use a real active staff account, and keep
# the id in sync so the self-scoping assertions test the right row.
STAFF_USER="${SMOKE_STAFF_USER:-maria.gonzales}"
STAFF_ID="${SMOKE_STAFF_ID:-7}"
JARDIR="$(mktemp -d 2>/dev/null || echo "/tmp/llb-smoke-$$")"
mkdir -p "$JARDIR"

pass=0; fail=0; warn=0

hdr()  { printf '\n=== %s ===\n' "$1"; }
ok()   { pass=$((pass+1)); printf '  PASS  %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf '  FAIL  %s\n' "$1"; }
note() { warn=$((warn+1)); printf '  NOTE  %s\n' "$1"; }

status_of() {
  local url="$1"; shift
  curl -s -m 10 -o /dev/null -w '%{http_code}' "$url" "$@" 2>/dev/null || echo "000"
}

expect_status() {
  local label="$1" want="$2" url="$3"; shift 3
  local got; got="$(status_of "$url" "$@")"
  if [ "$got" = "$want" ]; then ok "$label ($got)"; else bad "$label want $want got $got"; fi
}

header_of() {
  local url="$1" name="$2"; shift 2
  curl -s -m 10 -D - -o /dev/null "$url" "$@" 2>/dev/null \
    | tr -d '\r' | grep -i "^$name:" | head -1 | cut -d' ' -f2- | sed 's/[[:space:]]*$//'
}

login() {
  local role="$1" ident="$2" body
  rm -f "$JARDIR/$role.txt"
  body="$(curl -s -m 15 -c "$JARDIR/$role.txt" -X POST "$API/auth.php?action=login" \
    -H 'Content-Type: application/json' -H "Origin: $ORIGIN" \
    -d "{\"email\":\"$ident\",\"password\":\"$PW\"}" 2>/dev/null)"
  if printf '%s' "$body" | grep -q '"success": *true'; then ok "login $role"; return 0; fi
  bad "login $role -> $(printf '%s' "$body" | tr -d '\n' | head -c 150)"
  return 1
}

authed() {
  local role="$1" label="$2" want="$3" path="$4"; shift 4
  local got
  got="$(curl -s -m 15 -o /dev/null -w '%{http_code}' -b "$JARDIR/$role.txt" \
    -H "Origin: $ORIGIN" "$API/$path" "$@" 2>/dev/null || echo 000)"
  if [ "$got" = "$want" ]; then ok "$role $label ($got)"; else bad "$role $label want $want got $got"; fi
}

printf '########################################################\n'
printf '# LLB security smoke — %s\n' "$(date '+%Y-%m-%d %H:%M:%S')"
printf '# base=%s origin=%s\n' "$BASE" "$ORIGIN"
printf '########################################################\n'

# ── 1. Sensitive file exposure ──────────────────────────────────────────────
hdr '1. Sensitive file exposure (want 403/404)'
for p in .env .env.local .env.example .git/config .gitignore \
         database/Capstone1.sql package.json composer.json composer.lock \
         next.config.ts runtime/jar_admin.txt .cookiejar backups/ \
         api/.htaccess api/.user.ini api/.altcha_hmac_key
do
  got="$(status_of "$BASE/$p")"
  case "$got" in
    403|404) ok "$p blocked ($got)" ;;
    *)       bad "$p reachable ($got)" ;;
  esac
done

# ── 2. Security headers ─────────────────────────────────────────────────────
hdr '2. Security headers — Apache-served frontend'
for h in X-Content-Type-Options X-Frame-Options Referrer-Policy Content-Security-Policy; do
  v="$(header_of "$BASE/" "$h")"
  if [ -n "$v" ]; then ok "$h: $v"; else bad "$h missing"; fi
done
v="$(header_of "$BASE/" 'Server')"
if [ -n "$v" ]; then note "Server: $v (needs httpd.conf ServerTokens Prod)"; else ok 'Server suppressed'; fi
v="$(header_of "$BASE/" 'X-Powered-By')"
if [ -n "$v" ]; then note "X-Powered-By: $v"; else ok 'X-Powered-By suppressed'; fi

APIPROBE="$API/settings_api.php?action=public_login_title"
hdr '2b. Security headers — API responses'
for h in X-Content-Type-Options X-Frame-Options Content-Security-Policy; do
  v="$(header_of "$APIPROBE" "$h")"
  if [ -n "$v" ]; then ok "API $h: $v"; else note "API $h missing"; fi
done
v="$(header_of "$APIPROBE" 'X-Powered-By')"
if [ -n "$v" ]; then bad "API leaks X-Powered-By: $v"; else ok 'API X-Powered-By removed'; fi

# ── 3. CORS ─────────────────────────────────────────────────────────────────
hdr '3. CORS — hostile origin must NOT be reflected'
acao="$(header_of "$APIPROBE" 'Access-Control-Allow-Origin' -H 'Origin: https://evil.example')"
if [ "$acao" = "https://evil.example" ]; then
  bad "hostile origin reflected: $acao"
elif [ -z "$acao" ]; then
  ok 'hostile origin not reflected (no ACAO header)'
else
  ok "hostile origin not reflected (ACAO=$acao)"
fi

acao="$(header_of "$APIPROBE" 'Access-Control-Allow-Origin' \
        -H 'Origin: https://evil.example' -H 'X-Forwarded-Host: evil.example')"
if [ "$acao" = "https://evil.example" ]; then
  bad "X-Forwarded-Host CORS bypass works: $acao"
else
  ok 'X-Forwarded-Host CORS bypass blocked'
fi

acao="$(header_of "$APIPROBE" 'Access-Control-Allow-Origin' -H "Origin: $ORIGIN")"
if [ -n "$acao" ]; then ok "legit origin allowed (ACAO=$acao)"; else note 'legit origin got no ACAO'; fi

# Preflight from a hostile origin must not hand out credentials.
acao="$(header_of "$APIPROBE" 'Access-Control-Allow-Origin' \
        -X OPTIONS -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST')"
if [ "$acao" = "https://evil.example" ]; then bad 'preflight reflects hostile origin'; else ok 'preflight refuses hostile origin'; fi

# ── 4. Session cookie flags ─────────────────────────────────────────────────
hdr '4. Session cookie attributes'
sc="$(header_of "$APIPROBE" 'Set-Cookie')"
printf '  raw: %s\n' "${sc:-<none>}"
printf '%s' "$sc" | grep -qi 'httponly' && ok 'HttpOnly set' || bad 'HttpOnly missing'
printf '%s' "$sc" | grep -qi 'samesite' && ok 'SameSite set' || bad 'SameSite missing'
printf '%s' "$sc" | grep -qi 'secure'   && ok 'Secure set'   || note 'Secure unset (expected on plain HTTP; Phase 7)'

# ── 5. Unauthenticated access ───────────────────────────────────────────────
hdr '5. Unauthenticated API access (want 401/403)'
for ep in users.php employees.php payroll.php clients.php reports.php \
          backup.php security-control.php settings_api.php activity-logs.php \
          payroll_analytics.php analytics.php notifications.php tasks.php \
          projects.php contracts.php services.php documents.php
do
  got="$(status_of "$API/$ep" -H "Origin: $ORIGIN")"
  case "$got" in
    401|403) ok "$ep refused ($got)" ;;
    *)       bad "$ep NOT refused ($got)" ;;
  esac
done

hdr '5b. Dev/maintenance scripts must not be publicly usable'
for ep in convert_xls_to_sql.php setup.php migrate_users_dob.php \
          migrate_tasks_service.php preview_xls_import.php
do
  got="$(status_of "$API/$ep" -H "Origin: $ORIGIN")"
  case "$got" in
    401|403|404) ok "$ep refused ($got)" ;;
    *)           bad "$ep reachable ($got)" ;;
  esac
done

# ── 6. Public endpoints the login page needs ────────────────────────────────
hdr '6. Public endpoints required by login (want 200)'
expect_status 'public_login_title'    200 "$API/settings_api.php?action=public_login_title"             -H "Origin: $ORIGIN"
expect_status 'public_captcha_cfg'    200 "$API/settings_api.php?action=public_login_captcha_settings"  -H "Origin: $ORIGIN"
expect_status 'public_privacy_cfg'    200 "$API/settings_api.php?action=public_privacy_policy_settings" -H "Origin: $ORIGIN"
expect_status 'browser-lockout check' 200 "$API/browser-lockout.php?action=check"                       -H "Origin: $ORIGIN"
expect_status 'auth lockdown_status'  200 "$API/auth.php?action=lockdown_status"                        -H "Origin: $ORIGIN"

hdr '6b. Captcha configuration sanity'
cap="$(curl -s -m 10 "$API/settings_api.php?action=public_login_captcha_settings" -H "Origin: $ORIGIN" 2>/dev/null)"
printf '%s' "$cap" | grep -q 'login_math_captcha_enabled' && ok 'captcha settings payload present' || bad 'captcha settings payload missing'
printf '%s' "$cap" | grep -q 'hcaptcha_site_key'          && ok 'hcaptcha site key present'        || note 'no hcaptcha site key'
printf '%s' "$cap" | grep -q 'login_failed_attempt_limit'  && ok 'lockout threshold exposed'        || note 'no lockout threshold'

# ── 7. Logins ───────────────────────────────────────────────────────────────
hdr '7. Login — all three roles'
login admin   admin   || true
login manager manager || true
login staff   "$STAFF_USER" || true

hdr '7b. Login must still reject bad credentials'
body="$(curl -s -m 15 -X POST "$API/auth.php?action=login" -H 'Content-Type: application/json' \
        -H "Origin: $ORIGIN" -d '{"email":"admin","password":"definitely-wrong-pw"}' 2>/dev/null)"
printf '%s' "$body" | grep -q '"success": *false' && ok 'bad password rejected' || bad 'bad password accepted!'

hdr '8. Session validity after login'
for r in admin manager staff; do
  [ -f "$JARDIR/$r.txt" ] || continue
  body="$(curl -s -m 10 -b "$JARDIR/$r.txt" -H "Origin: $ORIGIN" "$API/auth.php?action=session" 2>/dev/null)"
  printf '%s' "$body" | grep -q '"success": *true' && ok "$r session valid" || bad "$r session invalid"
done

# ── 9. Admin feature coverage ───────────────────────────────────────────────
hdr '9. Admin feature access (want 200)'
if [ -f "$JARDIR/admin.txt" ]; then
  authed admin 'users'             200 'users.php'
  authed admin 'employees'         200 'employees.php'
  authed admin 'clients'           200 'clients.php'
  authed admin 'settings'          200 'settings_api.php?keys=session_timeout_enabled'
  authed admin 'activity logs'     200 'activity-logs.php'
  authed admin 'backup list'       200 'backup.php?action=list'
  authed admin 'security alerts'   200 'security-control.php?action=alerts'
  authed admin 'lockdown status'   200 'security-control.php?action=lockdown_status'
  authed admin 'reports'           200 'reports.php?action=list'
  authed admin 'notifications'     200 'notifications.php'
  authed admin 'branches'          200 'branches.php'
  authed admin 'holidays'          200 'holidays.php'
  authed admin 'calendar events'   200 'calendar-events.php'
  authed admin 'leave types'       200 'leave-types.php'
  authed admin 'deduction types'   200 'deduction-types.php'
  authed admin 'payroll'           200 'payroll.php'
  authed admin 'payroll analytics' 200 'payroll_analytics.php'
  authed admin 'tasks'             200 'tasks.php'
  authed admin 'projects'          200 'projects.php'
  authed admin 'documents'         200 'documents.php?action=list_received'
  authed admin 'contracts'         200 'contracts.php'
  authed admin 'services'          200 'services.php'
  authed admin 'shift schedules'   200 'shift-schedules.php'
  authed admin 'leave requests'    200 'leave-requests.php'
  authed admin 'overtime requests' 200 'overtime-requests.php'
  authed admin 'cash advance'      200 'cash-advance-requests.php'
  authed admin 'role access'       200 'role-feature-access.php'
  authed admin 'browser lockout'   200 'browser-lockout.php?action=settings'
  authed admin 'analytics'         200 'analytics.php'
  authed admin 'edit requests'     200 'edit-requests.php'
  authed admin 'approval inbox'    200 'approval-inbox.php'
  authed admin 'password policy'   200 'auth.php?action=password_policy'
  authed admin 'totp status'       200 'auth.php?action=totp_status'
fi

# ── 10. Manager ─────────────────────────────────────────────────────────────
hdr '10. Manager feature access + privilege boundaries'
if [ -f "$JARDIR/manager.txt" ]; then
  authed manager 'clients'            200 'clients.php'
  authed manager 'tasks'              200 'tasks.php'
  authed manager 'projects'           200 'projects.php'
  authed manager 'notifications'      200 'notifications.php'
  authed manager 'approval inbox'     200 'approval-inbox.php'
  authed manager 'leave requests'     200 'leave-requests.php'
  authed manager 'overtime requests'  200 'overtime-requests.php'
  authed manager 'reports'            200 'reports.php?action=list'
  authed manager 'activity logs'      200 'activity-logs.php'
  authed manager 'users readable'     200 'users.php'
  authed manager 'employees'          200 'employees.php'
  authed manager 'user create blocked' 403 'users.php' -X POST -H 'Content-Type: application/json' -d '{}'
  authed manager 'user delete blocked' 403 'users.php?id=3' -X DELETE
  authed manager 'backup blocked'     403 'backup.php?action=list'
  authed manager 'settings blocked'   403 'settings_api.php?keys=session_timeout_enabled'
  authed manager 'security blocked'   403 'security-control.php?action=alerts'
fi

# ── 11. Staff ───────────────────────────────────────────────────────────────
hdr '11. Staff feature access + privilege boundaries'
if [ -f "$JARDIR/staff.txt" ]; then
  authed staff 'notifications'       200 'notifications.php'
  authed staff 'tasks'               200 'tasks.php'
  authed staff 'leave requests'      200 'leave-requests.php'
  authed staff 'overtime requests'   200 'overtime-requests.php'
  authed staff 'cash advance'        200 'cash-advance-requests.php'
  # users.php GET is intentionally readable by staff — handleGet() scopes the
  # result to the caller's own row. Assert the scoping, not a blanket 403.
  authed staff 'own user record'     200 "users.php?id=$STAFF_ID"
  authed staff 'other user blocked'  403 'users.php?id=1'
  authed staff 'employees blocked'   403 'employees.php'
  authed staff 'backup blocked'      403 'backup.php?action=list'
  authed staff 'security blocked'    403 'security-control.php?action=alerts'
  authed staff 'settings blocked'    403 'settings_api.php'
  authed staff 'logs blocked'        403 'activity-logs.php'
  authed staff 'payroll cfg blocked' 403 'payroll_analytics.php'
  authed staff 'reports blocked'     403 'reports.php?action=list'
fi

# ── 12. Upload serving ──────────────────────────────────────────────────────
hdr '12. Upload serving / traversal'
expect_status 'direct uploads/ blocked' 403 "$BASE/uploads/task_submissions/"
got="$(status_of "$API/serve-file.php?path=../api/config.php" -H "Origin: $ORIGIN")"
case "$got" in 400|401|403) ok "serve-file traversal refused ($got)" ;; *) bad "serve-file traversal ($got)" ;; esac
if [ -f "$JARDIR/admin.txt" ]; then
  got="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$JARDIR/admin.txt" \
        "$API/serve-file.php?path=../../.env.local" 2>/dev/null)"
  case "$got" in 400|403|404) ok "serve-file escape refused ($got)" ;; *) bad "serve-file escaped root ($got)" ;; esac
fi

# ── 13. Error hygiene ───────────────────────────────────────────────────────
hdr '13. Error output must not leak internals'
leaked=0
for ep in convert_xls_to_sql.php users.php auth.php nonexistent-endpoint.php; do
  body="$(curl -s -m 10 "$API/$ep" -H "Origin: $ORIGIN" 2>/dev/null)"
  if printf '%s' "$body" | grep -qiE 'C:\\\\xampp|/htdocs/|Fatal error|Stack trace|on line [0-9]'; then
    bad "$ep leaks internals"; leaked=1
  fi
done
[ "$leaked" -eq 0 ] && ok 'no path/trace leakage in probed endpoints'

# ── 14. Logout ──────────────────────────────────────────────────────────────
hdr '14. Logout invalidates the session'
for r in staff manager admin; do
  [ -f "$JARDIR/$r.txt" ] || continue
  body="$(curl -s -m 10 -b "$JARDIR/$r.txt" -c "$JARDIR/$r.txt" -X POST \
    "$API/auth.php?action=logout" -H "Origin: $ORIGIN" -H 'Content-Type: application/json' 2>/dev/null)"
  printf '%s' "$body" | grep -q '"success": *true' && ok "$r logout" || bad "$r logout failed"
  got="$(curl -s -m 10 -o /dev/null -w '%{http_code}' -b "$JARDIR/$r.txt" \
        -H "Origin: $ORIGIN" "$API/notifications.php" 2>/dev/null)"
  case "$got" in 401|403) ok "$r session dead after logout ($got)" ;; *) bad "$r session alive after logout ($got)" ;; esac
done

# ── summary ─────────────────────────────────────────────────────────────────
printf '\n########################################################\n'
printf '# PASS=%s  FAIL=%s  NOTE=%s\n' "$pass" "$fail" "$warn"
printf '########################################################\n'
rm -rf "$JARDIR"
[ "$fail" -eq 0 ]



