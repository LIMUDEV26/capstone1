#!/usr/bin/env python3
"""Parse database/Capstone1.sql and generate Database_ERD.html.

Run:  python scripts/generate_erd_html.py
Out:  Database_ERD.html (repo root) — self-contained, offline, no libraries.
The HTML embeds the parsed schema (tables/columns/FKs) as JSON.
"""

import json
import os
import re

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(REPO, "database", "Capstone1.sql")
TEMPLATE = os.path.join(REPO, "scripts", "erd_template.html")
OUT = os.path.join(REPO, "Database_ERD.html")

# logical groups (left-to-right columns in the default layout)
GROUPS = [
    ("Core: Org & People", ["branches", "roles", "employees", "employee_role", "users"]),
    ("Clients & Services", ["client", "services", "service_checklists", "client_services",
                            "projects", "work", "client_receivables_fines", "project_messages"]),
    ("Tasks & Workflow", ["tasks", "task_collaborators", "checklist_items",
                          "task_completion_reports", "audit_report"]),
    ("HR & Attendance", ["leave_request", "leave_request_comment", "leave_balance",
                         "shift_schedule", "attendance_records", "holidays",
                         "cash_advance_request"]),
    ("Payroll & Finance", ["payroll", "payroll_user_archive", "deduction", "deduction_type",
                           "chart_of_accounts"]),
    ("Docs & System", ["document_received", "document_submission", "settings",
                       "activity_log", "request_rate_limits"]),
]

CONST_RE = re.compile(
    r"^(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE(\s+KEY)?|INDEX|KEY|CONSTRAINT|CHECK)\b",
    re.I,
)


def split_top(body):
    """Split on commas that sit at paren-depth 0."""
    parts, depth, cur = [], 0, []
    for ch in body:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            parts.append("".join(cur))
            cur = []
        else:
            cur.append(ch)
    if "".join(cur).strip():
        parts.append("".join(cur))
    return parts


def short_type(t):
    """ENUM('a','b') -> ENUM, keep sizes like VARCHAR(100), DECIMAL(12,2)."""
    t = t.upper()
    if t.startswith("ENUM("):
        return "ENUM"
    return t


def parse():
    sql = open(SQL, encoding="utf-8-sig").read()
    sql = re.sub(r"--[^\n]*", "", sql)
    tables, relations = {}, []

    def add_fk(child, col, parent, pcol, on_delete=""):
        relations.append({
            "child": child, "col": col, "parent": parent, "pcol": pcol,
            "onDelete": on_delete.replace("ON DELETE ", "").strip(),
        })

    for m in re.finditer(
        r"CREATE TABLE IF NOT EXISTS\s+`?(\w+)`?\s*\((.*?)\)\s*ENGINE",
        sql, re.S | re.I,
    ):
        tname, body = m.group(1), m.group(2)
        cols, pks = [], []
        uniq_keys = []
        for defn in split_top(body):
            defn = defn.strip()
            if not defn:
                continue
            if CONST_RE.match(defn):
                d = re.sub(r"^CONSTRAINT\s+\w+\s+", "", defn, flags=re.I)
                pk = re.match(r"^PRIMARY KEY\s*\(([^)]*)\)", d, re.I)
                if pk:
                    pks += [c.strip().strip("`") for c in pk.group(1).split(",")]
                    continue
                fk = re.search(
                    r"FOREIGN KEY\s*\((\w+)\)\s*REFERENCES\s+`?(\w+)`?\((\w+)\)"
                    r"(?:\s*ON DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?",
                    d, re.I,
                )
                if fk:
                    add_fk(tname, fk.group(1), fk.group(2), fk.group(3),
                           fk.group(4) or "")
                    for c in cols:
                        if c["name"] == fk.group(1):
                            c["fk"] = True
                    continue
                uq = re.match(r"^UNIQUE(?: KEY)?(?:\s+\w+)?\s*\(([^)]*)\)", d, re.I)
                if uq:
                    parts = [c.strip().strip("`") for c in uq.group(1).split(",")]
                    if len(parts) > 1:
                        uniq_keys.append(parts)
                    else:
                        for c in cols:
                            if c["name"] == parts[0]:
                                c["uq"] = True
                    continue
                continue  # INDEX / KEY / CHECK

            cm = re.match(r"^`?(\w+)`?\s+([A-Za-z]+(?:\s*\([^)]*\))?)\s*(.*)$",
                          defn, re.S)
            if not cm:
                continue
            name, typ, rest = cm.group(1), cm.group(2), cm.group(3)
            up = rest.upper()
            col = {
                "name": name, "type": short_type(typ),
                "pk": False, "fk": False, "nn": "NOT NULL" in up,
                "uq": "UNIQUE" in up, "ai": "AUTO_INCREMENT" in up,
            }
            if re.search(r"\bPRIMARY KEY\b", up):
                col["pk"] = True
            ref = re.search(
                r"REFERENCES\s+`?(\w+)`?\((\w+)\)"
                r"(?:\s*ON DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?",
                rest, re.I,
            )
            if ref:
                col["fk"] = True
                add_fk(tname, name, ref.group(1), ref.group(2), ref.group(3) or "")
            cols.append(col)

        for p in pks:
            for c in cols:
                if c["name"] == p:
                    c["pk"] = True
        tables[tname] = {"name": tname, "columns": cols, "keys": uniq_keys}

    # ALTER TABLE ... ADD [CONSTRAINT ...] FOREIGN KEY ...
    for am in re.finditer(r"ALTER TABLE\s+`?(\w+)`?(.*?);", sql, re.S | re.I):
        child, stmt = am.group(1), am.group(2)
        for fm in re.finditer(
            r"FOREIGN KEY\s*\((\w+)\)\s*REFERENCES\s+`?(\w+)`?\((\w+)\)"
            r"(?:\s*ON DELETE\s+(CASCADE|SET NULL|RESTRICT|NO ACTION))?",
            stmt, re.I,
        ):
            add_fk(child, fm.group(1), fm.group(2), fm.group(3), fm.group(4) or "")
            if child in tables:
                for c in tables[child]["columns"]:
                    if c["name"] == fm.group(1):
                        c["fk"] = True

    # group assignment
    for gname, names in GROUPS:
        for n in names:
            if n in tables:
                tables[n]["group"] = gname
    for t in tables.values():
        t.setdefault("group", "Other")

    # drop FKs pointing at missing tables (defensive)
    relations = [r for r in relations
                 if r["child"] in tables and r["parent"] in tables]
    # dedupe
    seen, uniq = set(), []
    for r in relations:
        k = (r["child"], r["col"], r["parent"], r["pcol"])
        if k not in seen:
            seen.add(k)
            uniq.append(r)
    return {"tables": list(tables.values()), "relations": uniq}


def main():
    data = parse()
    tpl = open(TEMPLATE, encoding="utf-8").read()
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # long form first so the trailing " null;" of a pre-seeded template is replaced too
    html = tpl.replace("/*__ERD_DATA__*/ null", payload)
    html = html.replace("/*__ERD_DATA__*/", payload)
    open(OUT, "w", encoding="utf-8").write(html)
    n_cols = sum(len(t["columns"]) for t in data["tables"])
    print(f"Wrote {OUT}: {len(data['tables'])} tables, {n_cols} columns, "
          f"{len(data['relations'])} relations")


if __name__ == "__main__":
    main()