from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

import asyncpg
import bcrypt
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse


SESSION_COOKIE = "llb_session"
SESSION_SECONDS = 12 * 60 * 60

GENERIC_RESOURCES: dict[str, tuple[str, str]] = {
    "users.php": ("users", "id"),
    "employees.php": ("employees", "employee_id"),
    "clients.php": ("client", "client_id"),
    "projects.php": ("projects", "id"),
    "services.php": ("services", "service_id"),
    "tasks.php": ("tasks", "id"),
    "contracts.php": ("contracts", "id"),
    "holidays.php": ("holidays", "holiday_id"),
    "holiday-comments.php": ("holiday_comment", "comment_id"),
    "leave-types.php": ("leave_type", "leave_type_id"),
    "leave-requests.php": ("leave_request", "leave_request_id"),
    "overtime-requests.php": ("overtime_request", "overtime_request_id"),
    "cash-advance-requests.php": ("cash_advance_request", "cash_advance_request_id"),
    "deduction-types.php": ("deduction_type", "deduction_type_id"),
    "calendar-events.php": ("calendar_events", "event_id"),
    "shift-schedules.php": ("shift_schedule", "shift_schedule_id"),
    "project_messages.php": ("project_messages", "id"),
    "task-comments.php": ("task_comment", "comment_id"),
    "activity-logs.php": ("activity_log", "id"),
}


def envelope(success: bool, data: Any, message: str, status: int = 200) -> JSONResponse:
    return JSONResponse({"success": success, "data": data, "message": message}, status_code=status)


def database_url() -> str:
    value = os.getenv("POSTGRES_URL") or os.getenv("POSTGRES_URL_NON_POOLING")
    if not value:
        raise RuntimeError("POSTGRES_URL or POSTGRES_URL_NON_POOLING must be configured")
    return value


def session_secret() -> bytes:
    value = os.getenv("SUPABASE_JWT_SECRET") or os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not value:
        raise RuntimeError("SUPABASE_JWT_SECRET or SUPABASE_SERVICE_ROLE_KEY must be configured")
    return value.encode()


def b64encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def encode_session(user_id: int) -> str:
    body = b64encode(json.dumps({"userId": user_id, "exp": int(time.time()) + SESSION_SECONDS}, separators=(",", ":")).encode())
    signature = b64encode(hmac.new(session_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{signature}"


def decode_session(token: str | None) -> int | None:
    if not token:
        return None
    try:
        body, signature = token.split(".", 1)
        expected = hmac.new(session_secret(), body.encode(), hashlib.sha256).digest()
        if not hmac.compare_digest(b64decode(signature), expected):
            return None
        payload = json.loads(b64decode(body))
        user_id = int(payload["userId"])
        if user_id <= 0 or int(payload["exp"]) <= int(time.time()):
            return None
        return user_id
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None


def allowed_origins() -> list[str]:
    configured = os.getenv("CORS_ALLOWED_ORIGINS", "https://llb-accountant.vercel.app")
    return [origin.strip().rstrip("/") for origin in configured.split(",") if origin.strip()]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.pool = await asyncpg.create_pool(database_url(), min_size=1, max_size=4, command_timeout=30)
    try:
        yield
    finally:
        await app.state.pool.close()


app = FastAPI(title="LLB Accountant API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(Exception)
async def unhandled_error(_: Request, error: Exception) -> JSONResponse:
    print(f"Unhandled API error: {error!r}")
    return envelope(False, None, "The cloud API encountered an error.", 500)


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "llb-accountant-api", "status": "ok"}


@app.get("/health")
async def health(request: Request) -> dict[str, str]:
    await request.app.state.pool.fetchval("SELECT 1")
    return {"status": "ok"}


async def request_body(request: Request) -> dict[str, Any]:
    if request.method in {"GET", "DELETE"}:
        return {}
    try:
        value = await request.json()
        return value if isinstance(value, dict) else {}
    except (json.JSONDecodeError, UnicodeDecodeError):
        return {}


async def find_user(pool: asyncpg.Pool, user_id: int) -> asyncpg.Record | None:
    return await pool.fetchrow(
        """SELECT u.id, u.username, u.email, u.first_name, u.last_name, u.role, u.status,
                  u.photo, u.employee_id, u.branch_id, u.must_reset_password,
                  CONCAT(e.first_name, ' ', e.last_name) AS full_name, b.branch_name
             FROM public.users u
             LEFT JOIN public.employees e ON e.employee_id = u.employee_id
             LEFT JOIN public.branches b ON b.branch_id = u.branch_id
            WHERE u.id = $1 LIMIT 1""",
        user_id,
    )


def public_user(row: asyncpg.Record) -> dict[str, Any]:
    role = str(row["role"] or "").lower()
    value = dict(row)
    value.update(
        full_name=row["full_name"] or f"{row['first_name'] or ''} {row['last_name'] or ''}".strip(),
        role=role,
        employee_id=int(row["employee_id"]) if row["employee_id"] is not None else None,
        branch_id=int(row["branch_id"]) if row["branch_id"] is not None else None,
        must_reset_password=int(row["must_reset_password"] or 0),
        password_change_reason="",
        session_timeout_enabled=True,
        session_timeout_minutes=30,
        session_timeout_warning_seconds=30,
        dashboard_path="/admin/dashboard" if role == "admin" else "/manager/dashboard" if role == "manager" else "/dashboard",
        role_feature_access={},
        lockdown_enabled=False,
    )
    return value


async def current_user(request: Request) -> asyncpg.Record | None:
    user_id = decode_session(request.cookies.get(SESSION_COOKIE))
    if not user_id:
        return None
    user = await find_user(request.app.state.pool, user_id)
    return user if user and user["status"] == "active" else None


async def require_user(request: Request) -> asyncpg.Record:
    user = await current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user


async def handle_auth(request: Request) -> JSONResponse:
    action = request.query_params.get("action") or ("session" if request.method == "GET" else "login")
    if action == "logout":
        response = envelope(True, None, "Logged out")
        response.delete_cookie(SESSION_COOKIE, path="/")
        return response

    if action == "login":
        if request.method != "POST":
            return envelope(False, None, "Method not allowed", 405)
        body = await request_body(request)
        identifier = str(body.get("email", "")).strip().lower()
        password = str(body.get("password", ""))
        if not identifier or not password:
            return envelope(False, None, "Email and password are required.", 400)
        user = await request.app.state.pool.fetchrow(
            """SELECT u.*, CONCAT(e.first_name, ' ', e.last_name) AS full_name, b.branch_name
                 FROM public.users u
                 LEFT JOIN public.employees e ON e.employee_id = u.employee_id
                 LEFT JOIN public.branches b ON b.branch_id = u.branch_id
                WHERE LOWER(TRIM(u.email)) = $1 OR LOWER(TRIM(u.username)) = $1 LIMIT 1""",
            identifier,
        )
        stored_hash = str(user["password"] if user else "").replace("$2y$", "$2b$").encode()
        valid = bool(user and user["status"] == "active" and bcrypt.checkpw(password.encode(), stored_hash))
        if not valid:
            return JSONResponse({"success": False, "message": "Invalid email or password.", "errors": {"code": "invalid_credentials"}}, status_code=401)
        response = envelope(True, public_user(user), "Login successful")
        response.set_cookie(
            SESSION_COOKIE,
            encode_session(int(user["id"])),
            httponly=True,
            secure=True,
            samesite=os.getenv("COOKIE_SAMESITE", "lax").lower(),
            max_age=SESSION_SECONDS,
            path="/",
        )
        await request.app.state.pool.execute("UPDATE public.users SET last_login = CURRENT_TIMESTAMP WHERE id = $1", user["id"])
        return response

    user = await current_user(request)
    if not user:
        return envelope(False, None, "Not authenticated", 401)
    if action == "session_status":
        return envelope(True, {"authenticated": True, "superseded": False}, "Session active")
    return envelope(True, public_user(user), "Authenticated")


async def table_columns(pool: asyncpg.Pool, table: str) -> dict[str, dict[str, Any]]:
    rows = await pool.fetch(
        """SELECT column_name, is_identity, data_type, udt_name
             FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = $1""",
        table,
    )
    return {row["column_name"]: dict(row) for row in rows}


def database_value(value: Any, column: dict[str, Any]) -> Any:
    if value is None:
        return None
    data_type = str(column.get("data_type", "")).lower()
    numeric = data_type in {"smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision"}
    date_type = data_type == "date" or "timestamp" in data_type or data_type.startswith("time")
    if isinstance(value, bool):
        if data_type == "boolean":
            return value
        if numeric:
            return int(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if data_type == "boolean" and normalized in {"true", "false", "1", "0"}:
            return normalized in {"true", "1"}
        if numeric and normalized in {"true", "false"}:
            return int(normalized == "true")
        if not normalized and (numeric or date_type):
            return None
    if isinstance(value, (dict, list)):
        return json.dumps(value)
    return value


async def handle_branches(request: Request) -> JSONResponse:
    user = await require_user(request)
    pool = request.app.state.pool
    if request.method == "GET":
        values: list[Any] = []
        conditions: list[str] = []
        branch_id = int(request.query_params.get("id", "0") or 0)
        if branch_id > 0:
            values.append(branch_id)
            conditions.append(f"b.branch_id = ${len(values)}")
        if request.query_params.get("status"):
            values.append(request.query_params["status"])
            conditions.append(f"b.status = ${len(values)}")
        if request.query_params.get("search"):
            values.append(f"%{request.query_params['search']}%")
            conditions.append(f"(b.branch_name ILIKE ${len(values)} OR b.location ILIKE ${len(values)})")
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = await pool.fetch(
            f"""SELECT b.*, CONCAT(e.first_name, ' ', e.last_name) AS manager_name,
                       (SELECT COUNT(*)::int FROM public.employees x WHERE x.branch_id = b.branch_id) AS employee_count
                  FROM public.branches b LEFT JOIN public.employees e ON e.employee_id = b.manager_id
                  {where} ORDER BY LOWER(TRIM(COALESCE(b.branch_name, ''))), b.branch_id""",
            *values,
        )
        if branch_id > 0 and not rows:
            return envelope(False, None, "Branch not found", 404)
        return envelope(True, dict(rows[0]) if branch_id > 0 else [dict(row) for row in rows], "Branch retrieved successfully" if branch_id > 0 else "Branches retrieved successfully")

    if str(user["role"]).lower() != "admin":
        return envelope(False, None, "Forbidden", 403)
    body = await request_body(request)
    if request.method == "POST":
        name = " ".join(str(body.get("branch_name", "")).split())
        if not name:
            return envelope(False, None, "Branch name is required", 400)
        if await pool.fetchval("SELECT 1 FROM public.branches WHERE LOWER(TRIM(branch_name)) = LOWER($1) LIMIT 1", name):
            return envelope(False, None, "Branch name already exists.", 409)
        branch_id = await pool.fetchval(
            """INSERT INTO public.branches (branch_name, location, latitude, longitude, contact_info, manager_id, status)
               VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING branch_id""",
            name, body.get("location", ""), body.get("latitude"), body.get("longitude"),
            json.dumps(body.get("contact_info")) if isinstance(body.get("contact_info"), dict) else body.get("contact_info", ""),
            body.get("manager_id"), "inactive" if body.get("status") == "inactive" else "active",
        )
        return envelope(True, {"branch_id": branch_id}, "Branch created successfully", 201)
    branch_id = int(body.get("branch_id") or request.query_params.get("id", "0") or 0)
    if not branch_id:
        return envelope(False, None, "Branch ID is required", 400)
    if request.method == "PUT":
        allowed = ["branch_name", "location", "latitude", "longitude", "contact_info", "manager_id", "status"]
        keys = [key for key in allowed if key in body]
        if not keys:
            return envelope(False, None, "No fields to update", 400)
        values = [json.dumps(body[key]) if key == "contact_info" and isinstance(body[key], dict) else body[key] for key in keys]
        values.append(branch_id)
        result = await pool.execute(
            f"UPDATE public.branches SET {', '.join(f'\"{key}\" = ${index + 1}' for index, key in enumerate(keys))}, updated_at = CURRENT_TIMESTAMP WHERE branch_id = ${len(values)}",
            *values,
        )
        if result == "UPDATE 0":
            return envelope(False, None, "Branch not found", 404)
        return envelope(True, None, "Branch updated successfully")
    if request.method == "DELETE":
        permanent = request.query_params.get("permanent") == "1"
        sql = "DELETE FROM public.branches WHERE branch_id = $1" if permanent else "UPDATE public.branches SET status = 'inactive', updated_at = CURRENT_TIMESTAMP WHERE branch_id = $1"
        result = await pool.execute(sql, branch_id)
        if result.endswith(" 0"):
            return envelope(False, None, "Branch not found", 404)
        return envelope(True, None, "Branch deleted permanently" if permanent else "Branch archived successfully")
    return envelope(False, None, "Method not allowed", 405)


async def handle_generic(request: Request, table: str, key: str) -> JSONResponse:
    user = await require_user(request)
    pool = request.app.state.pool
    columns = await table_columns(pool, table)
    body = await request_body(request)
    record_id = int(request.query_params.get("id") or body.get(key) or body.get("id") or 0)
    if request.method == "GET":
        values: list[Any] = []
        conditions: list[str] = []
        if record_id > 0:
            values.append(record_id)
            conditions.append(f'"{key}" = ${len(values)}')
        status = request.query_params.get("status")
        if status and "status" in columns:
            values.append(status)
            conditions.append(f'status = ${len(values)}')
        limit = min(1000, max(1, int(request.query_params.get("limit", "500"))))
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        rows = await pool.fetch(f'SELECT * FROM public."{table}" {where} ORDER BY "{key}" DESC LIMIT {limit}', *values)
        return envelope(True, dict(rows[0]) if record_id > 0 and rows else None if record_id > 0 else [dict(row) for row in rows], "Records retrieved successfully")
    if str(user["role"]).lower() not in {"admin", "manager"}:
        return envelope(False, None, "Forbidden", 403)
    if table == "users" and isinstance(body.get("password"), str) and body["password"]:
        body["password"] = bcrypt.hashpw(body["password"].encode(), bcrypt.gensalt(rounds=10)).decode()
    if request.method == "POST":
        keys = [name for name in body if name in columns and name != key and columns[name]["is_identity"] != "YES"]
        if not keys:
            return envelope(False, None, "No valid fields supplied", 400)
        values = [database_value(body[name], columns[name]) for name in keys]
        placeholders = ",".join(f"${index + 1}" for index in range(len(keys)))
        row = await pool.fetchrow(f'INSERT INTO public."{table}" ({",".join(f"\"{name}\"" for name in keys)}) VALUES ({placeholders}) RETURNING *', *values)
        return envelope(True, dict(row), "Record created successfully", 201)
    if request.method in {"PUT", "PATCH"}:
        if not record_id:
            return envelope(False, None, "Record ID is required", 400)
        keys = [name for name in body if name in columns and name not in {key, "id"}]
        if not keys:
            return envelope(False, None, "No valid fields supplied", 400)
        values = [database_value(body[name], columns[name]) for name in keys] + [record_id]
        assignments = ",".join(f'"{name}" = ${index + 1}' for index, name in enumerate(keys))
        row = await pool.fetchrow(f'UPDATE public."{table}" SET {assignments} WHERE "{key}" = ${len(values)} RETURNING *', *values)
        if not row:
            return envelope(False, None, "Record not found", 404)
        return envelope(True, dict(row), "Record updated successfully")
    if request.method == "DELETE":
        if not record_id:
            return envelope(False, None, "Record ID is required", 400)
        if "status" in columns and request.query_params.get("permanent") != "1":
            result = await pool.execute(f'UPDATE public."{table}" SET status = \'inactive\' WHERE "{key}" = $1', record_id)
        else:
            result = await pool.execute(f'DELETE FROM public."{table}" WHERE "{key}" = $1', record_id)
        if result.endswith(" 0"):
            return envelope(False, None, "Record not found", 404)
        return envelope(True, None, "Record deleted successfully")
    return envelope(False, None, "Method not allowed", 405)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
@app.api_route("/capstone1/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
async def legacy_api(path: str, request: Request) -> JSONResponse:
    if path == "auth.php":
        return await handle_auth(request)
    if path == "branches.php":
        return await handle_branches(request)
    if path == "settings_api.php" and request.query_params.get("action") == "public_login_captcha_settings":
        return envelope(True, {"login_math_captcha_enabled": True, "math_captcha_timeout_seconds": 60}, "Settings loaded")
    if path == "browser-lockout.php":
        return envelope(True, {"blocked": False, "just_blocked": False, "attempt_count": 0}, "Browser access allowed")
    resource = GENERIC_RESOURCES.get(path)
    if resource:
        return await handle_generic(request, *resource)
    return envelope(True, [], "No cloud records are available for this endpoint yet.")
