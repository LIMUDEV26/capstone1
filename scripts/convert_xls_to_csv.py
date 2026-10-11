import sys, json, csv
try:
    import xlrd
except ImportError:
    print(json.dumps({"error": "xlrd library not installed. Run: pip install xlrd"}))
    sys.exit(1)

if len(sys.argv) < 2:
    print(json.dumps({"error": "Usage: python convert_xls_to_csv.py <xls_filepath>"}))
    sys.exit(1)

filepath = sys.argv[1]

try:
    wb = xlrd.open_workbook(filepath)
except Exception as e:
    print(json.dumps({"error": f"Failed to open XLS file: {e}"}))
    sys.exit(1)

sheet0 = wb.sheet_by_index(0)
OUTPUT_HEADERS = ['EmployeeID', 'EmployeeName', 'Role', 'Branch', 'DaysWorked', 'OvertimeHours', 'LateMinutes', 'AbsentDays', 'LeaveDays']


def safe_float(val):
    v = str(val).strip()
    if v == '' or v == '-' or v == 'None':
        return 0.0
    try:
        return float(v)
    except ValueError:
        return 0.0


def parse_hours(val):
    v = str(val).strip()
    if v == '' or v == '-' or v == 'None':
        return 0.0
    try:
        parts = v.split(':')
        if len(parts) == 2:
            return float(parts[0]) + float(parts[1]) / 60.0
        return float(v)
    except ValueError:
        return 0.0


def parse_att_days(val):
    v = str(val).strip()
    if '/' in v:
        parts = v.split('/')
        if len(parts) == 2:
            try:
                return float(parts[1])
            except ValueError:
                pass
    try:
        return float(v)
    except ValueError:
        return 0.0


# ------- Priority 1: Attendance Statistics sheet ("Att. Stat." / "Statistical Report") -------
# This has all employees in one table with summary columns:
#   Col 0: ID, Col 1: Name, Col 2: Dept, Col 6: LateMin, Col 9: OT Workday, Col 10: OT Holiday,
#   Col 11: "Nor/Real" days, Col 13: Absent(Day), Col 14: AFL (Day)
att_stat_sheet = None
for si in range(wb.nsheets):
    sheet = wb.sheet_by_index(si)
    name = str(sheet.name).strip()
    if 'att' in name.lower() and 'stat' in name.lower():
        att_stat_sheet = sheet
        break
    if sheet.nrows > 1:
        r0 = str(sheet.cell_value(0, 0)).strip().lower()
        if 'statistical report of attendance' in r0:
            att_stat_sheet = sheet
            break

if att_stat_sheet is not None and att_stat_sheet.nrows > 4:
    output = csv.writer(sys.stdout)
    output.writerow(OUTPUT_HEADERS)
    for r in range(4, att_stat_sheet.nrows):
        emp_id = str(att_stat_sheet.cell_value(r, 0)).strip()
        emp_name = str(att_stat_sheet.cell_value(r, 1)).strip()
        if not emp_id and not emp_name:
            continue
        dept = str(att_stat_sheet.cell_value(r, 2)).strip()
        late_min = int(safe_float(att_stat_sheet.cell_value(r, 6)))
        ot_hours = parse_hours(att_stat_sheet.cell_value(r, 9)) + parse_hours(att_stat_sheet.cell_value(r, 10))
        days_worked = parse_att_days(att_stat_sheet.cell_value(r, 11))
        absent_days = safe_float(att_stat_sheet.cell_value(r, 13))
        leave_days = safe_float(att_stat_sheet.cell_value(r, 14))
        output.writerow([emp_id, emp_name, 'staff', dept, days_worked, ot_hours, late_min, absent_days, leave_days])
    sys.exit(0)

# ------- Priority 2: Card Report sheets (ZKTeco "Card Report" format) -------
# Each sheet can have up to 3 employee blocks (15 cols each). Summary at row 6.
card_report_found = False
for si in range(wb.nsheets):
    sheet = wb.sheet_by_index(si)
    if sheet.nrows < 8:
        continue
    r0 = str(sheet.cell_value(0, 0)).strip().lower()
    if 'card report' in r0:
        card_report_found = True
        break

if card_report_found:
    output = csv.writer(sys.stdout)
    output.writerow(OUTPUT_HEADERS)
    for si in range(wb.nsheets):
        sheet = wb.sheet_by_index(si)
        if sheet.nrows < 7:
            continue
        r0 = str(sheet.cell_value(0, 0)).strip().lower()
        if 'card report' not in r0:
            continue
        for block_offset in [0, 15, 30]:
            if sheet.ncols <= block_offset + 9:
                continue
            emp_id = str(sheet.cell_value(3, block_offset + 9)).strip()
            emp_name = str(sheet.cell_value(2, block_offset + 9)).strip()
            if not emp_id and not emp_name:
                continue
            absent_days = safe_float(sheet.cell_value(6, block_offset + 0))
            leave_days = safe_float(sheet.cell_value(6, block_offset + 1))
            on_duty_days = safe_float(sheet.cell_value(6, block_offset + 4))
            ot_hours = parse_hours(sheet.cell_value(6, block_offset + 5)) + parse_hours(sheet.cell_value(6, block_offset + 7))
            late_min = int(safe_float(sheet.cell_value(6, block_offset + 9)))
            output.writerow([emp_id, emp_name, 'staff', '', on_duty_days, ot_hours, late_min, absent_days, leave_days])
    sys.exit(0)

# ------- Priority 3: Schedule Information Report -------
# Sheet 0 has headers ID, Name, Department in row 2, attendance codes per day from row 4+
is_schedule_report = False
if sheet0.nrows > 3:
    row2 = [str(sheet0.cell_value(2, c)).strip() for c in range(min(sheet0.ncols, 5))]
    if row2[0] == 'ID' and row2[1] == 'Name' and row2[2] == 'Department':
        is_schedule_report = True

if is_schedule_report:
    date_cols = []
    for c in range(3, sheet0.ncols):
        if str(sheet0.cell_value(2, c)).strip():
            date_cols.append(c)
    output = csv.writer(sys.stdout)
    output.writerow(OUTPUT_HEADERS)
    for r in range(4, sheet0.nrows):
        emp_id = str(sheet0.cell_value(r, 0)).strip()
        emp_name = str(sheet0.cell_value(r, 1)).strip()
        dept = str(sheet0.cell_value(r, 2)).strip()
        if not emp_id and not emp_name:
            continue
        days_worked = 0
        absent_days = 0
        leave_days = 0
        for c in date_cols:
            val = str(sheet0.cell_value(r, c)).strip()
            if val in ('1.0', '1'):
                days_worked += 1
            elif val == '25':
                leave_days += 1
            elif val == '' or val == '-':
                absent_days += 1
        output.writerow([emp_id, emp_name, 'staff', dept, days_worked, 0, 0, absent_days, leave_days])
    sys.exit(0)

# ------- Priority 4: Generic sheet search -------
for si in range(wb.nsheets):
    sheet = wb.sheet_by_index(si)
    if sheet.nrows < 2:
        continue
    first_row = [str(sheet.cell_value(0, c)).strip().lower() for c in range(min(sheet.ncols, 10))]
    first_row_str = ' '.join(first_row)
    if any(kw in first_row_str for kw in ('employee', 'name', 'id')):
        output = csv.writer(sys.stdout)
        output.writerow(OUTPUT_HEADERS)
        for r in range(1, sheet.nrows):
            row_data = [str(sheet.cell_value(r, c)).strip() for c in range(sheet.ncols)]
            if any(cell for cell in row_data):
                output.writerow(row_data)
        sys.exit(0)

# ------- Priority 5: Raw first sheet fallback -------
output = csv.writer(sys.stdout)
output.writerow(OUTPUT_HEADERS)
for r in range(1, sheet0.nrows):
    row_data = [str(sheet0.cell_value(r, c)).strip() for c in range(sheet0.ncols)]
    if any(cell for cell in row_data):
        output.writerow(row_data)
