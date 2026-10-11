<?php
/**
 * setup.php — Seed / reset script.
 *
 * SECURITY GATES (all three must pass):
 *  1. SETUP_SECRET env var must be set and must match the X-Setup-Token request header.
 *  2. Caller must have an active admin session (session started by config.php).
 *  3. A one-time filesystem lock prevents re-running without an admin manually
 *     deleting /api/.setup_done on the server.
 *
 * In production: keep SETUP_SECRET in the server environment (not in code),
 * and remove or restrict this file once initial seeding is complete.
 */
require_once __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
header('Content-Type: text/plain; charset=utf-8');

// ── Gate 1: Secret token (env-controlled) ──
$setupSecret = trim((string)(getenv('SETUP_SECRET') ?: ''));
$providedToken = trim((string)($_SERVER['HTTP_X_SETUP_TOKEN'] ?? ''));
if ($setupSecret === '' || !hash_equals($setupSecret, $providedToken)) {
    http_response_code(403);
    exit("Forbidden: missing or invalid setup token.\n");
}

// ── Gate 2: Active admin session ──
$sessionRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
if ($sessionRole !== 'admin') {
    http_response_code(403);
    exit("Forbidden: admin session required.\n");
}

// ── Gate 3: One-time run-once lock ──
$lockFile = __DIR__ . DIRECTORY_SEPARATOR . '.setup_done';
if (file_exists($lockFile)) {
    http_response_code(403);
    exit("Setup has already been completed. Delete api/.setup_done on the server to re-run.\n");
}

$conn = getDBConnection();
$log = [];
$log[] = "=== SYSTEM SETUP ===\n";

// ── Phase 0: Clean slate for seed data ──

$conn->query("SET FOREIGN_KEY_CHECKS=0");
$conn->query("TRUNCATE payroll_user_archive");
$conn->query("TRUNCATE payroll");
$conn->query("TRUNCATE cash_advance_request");
$conn->query("TRUNCATE overtime_request");
$conn->query("TRUNCATE leave_request");
$conn->query("TRUNCATE leave_balance");
$conn->query("TRUNCATE profile_edit_request");
$conn->query("TRUNCATE project_messages");
$conn->query("TRUNCATE projects");
$conn->query("DELETE FROM client");
$conn->query("DELETE FROM branches WHERE branch_name != 'Main Office'");
$conn->query("DELETE FROM service_checklists");
$conn->query("DELETE FROM services");
$conn->query("DELETE FROM chart_of_accounts");
$conn->query("DELETE FROM settings");
$conn->query("DELETE FROM employee_role");
$conn->query("DELETE FROM users WHERE id > 3");
$conn->query("DELETE FROM employees WHERE employee_id > 3");
$conn->query("SET FOREIGN_KEY_CHECKS=1");
$log[] = "0. Old seed data cleaned";

// ── Phase 1: Core Infrastructure (idempotent) ──

$conn->query("UPDATE branches SET status='active' WHERE branch_name='Main Office'");
$r = $conn->query("SELECT branch_id FROM branches WHERE branch_name='Main Office' LIMIT 1");
if (!$r || $r->num_rows === 0) {
    $conn->query("INSERT IGNORE INTO branches (branch_name, location, status) VALUES ('Main Office', 'Head Office', 'active')");
}
$branchId = (int)$conn->query("SELECT branch_id FROM branches WHERE branch_name='Main Office' LIMIT 1")->fetch_row()[0];
$log[] = "1. Branch OK (ID $branchId)";

$conn->query("INSERT IGNORE INTO roles (role_name, description, permissions) VALUES
    ('Admin', 'System Administrator with full access', '{\"all\": true}'),
    ('Manager', 'Project and team manager', '{\"projects\":\"all\",\"tasks\":\"all\",\"clients\":\"all\",\"services\":\"all\",\"payroll\":\"all\",\"suppliers\":\"all\",\"employees\":\"read\",\"branches\":\"read\",\"analytics\":\"all\",\"leave\":\"all\",\"attendance\":\"all\",\"settings\":\"denied\",\"activity_log\":\"read\"}'),
    ('Staff', 'Staff member with limited access', '{\"tasks\":\"assigned\",\"documents\":\"upload\",\"profile\":\"own\",\"leave\":\"own\"}')");
$roleAdmin = (int)$conn->query("SELECT role_id FROM roles WHERE role_name='Admin'")->fetch_row()[0];
$roleManager = (int)$conn->query("SELECT role_id FROM roles WHERE role_name='Manager'")->fetch_row()[0];
$roleStaff = (int)$conn->query("SELECT role_id FROM roles WHERE role_name='Staff'")->fetch_row()[0];
$log[] = "2. Roles OK";

$conn->query("INSERT IGNORE INTO deduction_type (type_name,description,default_amount,threshold_amount,threshold_mode,threshold_rules,base_floor,base_cap,is_percentage) VALUES
    ('SSS','Employee share from the 2025 SSS MSC schedule: 5%, MSC floor PHP 5,000 and cap PHP 35,000.',5,0,'none',NULL,5000,35000,1),
    ('PhilHealth','Employee share: 2.5% of monthly basic salary; floor PHP 10,000 and ceiling PHP 100,000 (5% total premium).',2.5,0,'none',NULL,10000,100000,1),
    ('Pag-IBIG','Employee share: 1% at PHP 1,500 and below, otherwise 2%; compensation base capped at PHP 5,000 (maximum PHP 100).',2,1500,'above',NULL,0,5000,1),
    ('Withholding Tax','BIR monthly withholding table effective 2023 onwards. Taxable compensation is reduced by employee SSS, PhilHealth, and Pag-IBIG shares.',0,20833,'below','[{\"mode\":\"below\",\"amount\":20833,\"rate\":0},{\"mode\":\"above\",\"amount\":20833,\"rate\":15},{\"mode\":\"above\",\"amount\":33333,\"rate\":20},{\"mode\":\"above\",\"amount\":66667,\"rate\":25},{\"mode\":\"above\",\"amount\":166667,\"rate\":30},{\"mode\":\"above\",\"amount\":666667,\"rate\":35}]',0,0,0),
    ('Late Deduction','Deduction for tardiness',0,0,'none',NULL,0,0,0),
    ('Absence Deduction','Deduction for absences',0,0,'none',NULL,0,0,0)");
$log[] = "3. Deduction types OK";

$settings = [
    ['company_name','LLB Accountants','string'],['company_email','info@lbaccountants.com','string'],
    ['timezone','Asia/Manila','string'],['date_format','Y-m-d','string'],['currency','PHP','string'],
    ['tax_rate','12','number'],['fiscal_year_start','01-01','string'],
    ['session_timeout_enabled','1','boolean'],
    ['session_timeout_manager_minutes','30','number'],['session_timeout_staff_minutes','30','number'],
    ['captcha_timeout_seconds','300','number'],['login_failed_attempt_limit','5','number'],
    ['admin_dashboard_access_pin','1433','string'],['lockout_enabled','1','boolean'],
    ['lockout_threshold_manager','3','number'],['lockout_threshold_staff','3','number'],
    ['lockout_window_hours','24','number'],['rate_limit_enabled','1','boolean'],
    ['lockout_retry_delay_value','30','number'],['lockout_retry_delay_unit','seconds','string'],
    ['lockout_cooldown_start_attempt','3','number'],
    ['lockout_max_cooldown_attempts','3','number'],
    ['rate_limit_max_requests','180','number'],['rate_limit_window_seconds','60','number'],
    ['security_lockdown_enabled','0','boolean'],['security_lockdown_reason','','string'],
    ['security_lockdown_updated_at','','string'],['security_lockdown_updated_by','','string'],
    ['login_math_captcha_enabled','1','boolean'],
    ['login_otp_enabled','1','boolean'],
    ['hcaptcha_site_key','0e6421f6-28ce-4c68-87ae-c1fefa10eaea','string'],
    ['hcaptcha_secret','','string'],
];
$stmt = $conn->prepare("INSERT IGNORE INTO settings (setting_key, setting_value, setting_type) VALUES (?, ?, ?)");
foreach ($settings as $s) { $stmt->bind_param('sss', $s[0], $s[1], $s[2]); $stmt->execute(); }
$stmt->close();
$log[] = "4. Settings OK (28)";

$coa = [
    ['1000','Assets','asset',null],['1100','Current Assets','asset',1],['1110','Cash','asset',2],
    ['1120','Accounts Receivable','asset',2],['2000','Liabilities','liability',null],
    ['2100','Current Liabilities','liability',5],['2110','Accounts Payable','liability',6],
    ['3000','Equity','equity',null],['4000','Revenue','revenue',null],['5000','Expenses','expense',null],
];
foreach ($coa as $c) {
    $p = $c[3] === null ? 'NULL' : $c[3];
    $conn->query("INSERT IGNORE INTO chart_of_accounts (account_code,account_name,account_type,parent_account_id) VALUES ('$c[0]','$c[1]','$c[2]',$p)");
}
$log[] = "5. Chart of accounts OK (10)";

$conn->query("INSERT IGNORE INTO services (service_name, description) VALUES
    ('Audit','Financial statement auditing and compliance'),
    ('Tax','Tax return preparation and filing'),
    ('Bookkeeping','Daily financial record keeping')");
$log[] = "6. Services OK";

$checklists = [
    ['Audit','Review Financial Statements','Analyze balance sheet and income statement'],
    ['Audit','Check Compliance','Ensure regulatory compliance'],
    ['Tax','Collect Receipts','Gather all expense receipts'],
    ['Tax','File Returns','Submit tax returns to authorities'],
    ['Bookkeeping','Record Daily Transactions','Log all sales and expenses'],
    ['Bookkeeping','Reconcile Bank Accounts','Match ledger with bank statements'],
];
foreach ($checklists as $cl) {
    $conn->query("INSERT IGNORE INTO service_checklists (service_id, task_name, description)
        SELECT service_id, '" . $conn->real_escape_string($cl[1]) . "', '" . $conn->real_escape_string($cl[2]) . "'
        FROM services WHERE service_name='" . $conn->real_escape_string($cl[0]) . "'");
}
$log[] = "7. Service checklists OK (6)";

$log[] = "8. Approval timing config removed";

$hash = '$2y$10$kwBbF7Bagh18guDKeDDe9eK/PC5c8X4jPW93fHu4fO9WfhDzg.1jq';
$conn->query("INSERT IGNORE INTO users (username,password,email,first_name,last_name,role,status,branch_id) VALUES
    ('admin','$hash','kristinedais14@gmail.com','System','Administrator','admin','active',$branchId),
    ('manager','$hash','manager@lbaccountants.com','Default','Manager','manager','active',$branchId),
    ('staff','$hash','staff@lbaccountants.com','Default','Staff','staff','active',$branchId)");
$log[] = "9. Default users OK";

$conn->query("INSERT IGNORE INTO employees (first_name,last_name,email,position,status,branch_id)
    SELECT first_name,last_name,email,CASE role WHEN 'admin' THEN 'Administrator' WHEN 'manager' THEN 'Manager' ELSE 'Staff' END,status,$branchId
    FROM users WHERE email IS NOT NULL AND email!=''");
$conn->query("UPDATE users u INNER JOIN employees e ON u.email=e.email SET u.employee_id=e.employee_id WHERE u.employee_id IS NULL");
$log[] = "10. Default employees OK";

$xls = [
    ['18','Maria','Gonzales','maria.gonzales@lbaccountants.com','Staff',25000,'2024-06-01'],
    ['2','Juan','Zapata','juan.zapata@lbaccountants.com','Staff',28000,'2024-03-15'],
    ['6','Carlos','Santos','carlos.santos@lbaccountants.com','Staff',22000,'2024-08-20'],
    ['20180908','Cristina','Navarro','cristina.navarro@lbaccountants.com','Senior Staff',30000,'2023-01-10'],
    ['16','Jose','Ramirez','jose.ramirez@lbaccountants.com','Staff',26000,'2024-11-01'],
    ['3','Karen','Bautista','karen.bautista@lbaccountants.com','Senior Staff',32000,'2023-06-15'],
    ['4','Carlos','Martinez','carlos.martinez@lbaccountants.com','Staff',24000,'2024-09-01'],
    ['201805','Angela','Mendoza','angela.mendoza@lbaccountants.com','Manager',35000,'2022-05-01'],
    ['19','Michael','Dizon','michael.dizon@lbaccountants.com','Staff',27000,'2024-07-15'],
    ['20','Roberto','Santos','roberto.santos@lbaccountants.com','Staff',23000,'2024-10-01'],
];
$inserted = 0;
$stmt = $conn->prepare("INSERT IGNORE INTO employees (employee_date_id,first_name,last_name,email,position,salary,hire_date,status,branch_id) VALUES (?,?,?,?,?,?,?,'active',$branchId)");
foreach ($xls as $e) {
    $stmt->bind_param('sssssds', $e[0], $e[1], $e[2], $e[3], $e[4], $e[5], $e[6]);
    $stmt->execute();
    if ($stmt->affected_rows > 0) $inserted++;
}
$stmt->close();
$log[] = "11. XLS employees OK ($inserted new)";

$created = 0;
$res = $conn->query("SELECT e.employee_id, e.first_name, e.last_name, e.email, e.position FROM employees e WHERE e.email LIKE '%@lbaccountants.com' AND e.email NOT IN ('kristinedais14@gmail.com','manager@lbaccountants.com','staff@lbaccountants.com')");
$uStmt = $conn->prepare("INSERT IGNORE INTO users (username,password,email,first_name,last_name,role,status,employee_id,branch_id) VALUES (?,?,?,?,?,?,'active',?,$branchId)");
while ($row = $res->fetch_assoc()) {
    $username = strtolower($row['first_name']) . '.' . strtolower($row['last_name']);
    $username = preg_replace('/[^a-z0-9.]/', '', $username);
    $role = strtolower($row['position']) === 'manager' ? 'manager' : 'staff';
    $uStmt->bind_param('ssssssi', $username, $hash, $row['email'], $row['first_name'], $row['last_name'], $role, $row['employee_id']);
    $uStmt->execute();
    if ($uStmt->affected_rows > 0) $created++;
}
$uStmt->close();
$log[] = "12. XLS users OK ($created new)";

$linked = 0;
$res2 = $conn->query("SELECT e.employee_id, u.role FROM employees e INNER JOIN users u ON e.employee_id=u.employee_id");
$rStmt = $conn->prepare("INSERT IGNORE INTO employee_role (employee_id,role_id) VALUES (?,?)");
while ($row = $res2->fetch_assoc()) {
    $rid = $row['role'] === 'admin' ? $roleAdmin : ($row['role'] === 'manager' ? $roleManager : $roleStaff);
    $rStmt->bind_param('ii', $row['employee_id'], $rid);
    $rStmt->execute();
    if ($rStmt->affected_rows > 0) $linked++;
}
$rStmt->close();
$log[] = "13. Employee-role links OK ($linked new)";

// ── Build dynamic ID maps from actual DB state ──

function getValue($conn, $sql) { $r = $conn->query($sql); if ($r && $row = $r->fetch_row()) return (int)$row[0]; return 0; }

$adminUserId  = getValue($conn, "SELECT id FROM users WHERE role='admin' LIMIT 1");
$mgrUserId    = getValue($conn, "SELECT id FROM users WHERE role='manager' LIMIT 1");
$adminEmpId   = getValue($conn, "SELECT e.employee_id FROM employees e JOIN users u ON e.email=u.email WHERE u.role='admin' LIMIT 1");
$mgrEmpId     = getValue($conn, "SELECT e.employee_id FROM employees e JOIN users u ON e.email=u.email WHERE u.role='manager' LIMIT 1");

// Employee ID map by email
$empMap = []; $r = $conn->query("SELECT email, employee_id FROM employees WHERE employee_id > 3");
while ($row = $r->fetch_assoc()) { $empMap[$row['email']] = (int)$row['employee_id']; }

$maria   = $empMap['maria.gonzales@lbaccountants.com'] ?? 0;
$juan    = $empMap['juan.zapata@lbaccountants.com'] ?? 0;
$carlosS = $empMap['carlos.santos@lbaccountants.com'] ?? 0;
$cristina= $empMap['cristina.navarro@lbaccountants.com'] ?? 0;
$jose    = $empMap['jose.ramirez@lbaccountants.com'] ?? 0;
$karen   = $empMap['karen.bautista@lbaccountants.com'] ?? 0;
$carlosM = $empMap['carlos.martinez@lbaccountants.com'] ?? 0;
$angela  = $empMap['angela.mendoza@lbaccountants.com'] ?? 0;
$michael = $empMap['michael.dizon@lbaccountants.com'] ?? 0;
$roberto = $empMap['roberto.santos@lbaccountants.com'] ?? 0;

// User ID map by email
$userMap = []; $r2 = $conn->query("SELECT email, id FROM users WHERE id > 3");
while ($row = $r2->fetch_assoc()) { $userMap[$row['email']] = (int)$row['id']; }

$uMaria   = $userMap['maria.gonzales@lbaccountants.com'] ?? 0;
$uJuan    = $userMap['juan.zapata@lbaccountants.com'] ?? 0;
$uCarlosS = $userMap['carlos.santos@lbaccountants.com'] ?? 0;
$uCristina= $userMap['cristina.navarro@lbaccountants.com'] ?? 0;
$uJose    = $userMap['jose.ramirez@lbaccountants.com'] ?? 0;
$uKaren   = $userMap['karen.bautista@lbaccountants.com'] ?? 0;
$uCarlosM = $userMap['carlos.martinez@lbaccountants.com'] ?? 0;
$uAngela  = $userMap['angela.mendoza@lbaccountants.com'] ?? 0;
$uMichael = $userMap['michael.dizon@lbaccountants.com'] ?? 0;
$uRoberto = $userMap['roberto.santos@lbaccountants.com'] ?? 0;

$log[] = "   Maps: admin_user=$adminUserId mgr_user=$mgrUserId admin_emp=$adminEmpId mgr_emp=$mgrEmpId";

// ── Phase 2: Clients & Branches ──

$conn->query("INSERT IGNORE INTO client (client_name,contact_person,email,phone,address,status,registration_date) VALUES
    ('ABC Corporation','Juan dela Cruz','juan@abc-corp.com','09171234567','123 Rizal Ave, Makati City','active','2024-01-15'),
    ('XYZ Enterprises','Maria Santos','maria@xyz-enterprises.ph','09182345678','456 Ayala Ave, Makati City','active','2024-03-20'),
    ('LMN Trading Inc.','Pedro Reyes','pedro@lmn-trading.com','09193456789','789 Cebu Business Park, Cebu City','suspended','2024-06-01'),
    ('QRS Services Co.','Ana Gonzales','ana@qrs-services.com','09204567890','321 Quezon Ave, Quezon City','inactive','2024-02-10')");
$c1 = getValue($conn, "SELECT client_id FROM client WHERE client_name='ABC Corporation' LIMIT 1");
$c2 = getValue($conn, "SELECT client_id FROM client WHERE client_name='XYZ Enterprises' LIMIT 1");
$c3 = getValue($conn, "SELECT client_id FROM client WHERE client_name='LMN Trading Inc.' LIMIT 1");
$c4 = getValue($conn, "SELECT client_id FROM client WHERE client_name='QRS Services Co.' LIMIT 1");
$log[] = "14. Clients OK (ABC=$c1 XYZ=$c2 LMN=$c3 QRS=$c4)";

$conn->query("INSERT IGNORE INTO branches (branch_name,location,contact_info,status) VALUES
    ('Makati Satellite Office','Makati City','+63 2 8123 456','active'),
    ('Quezon City Branch','Quezon City','+63 2 9876 543','active'),
    ('Cebu Extension Office','Cebu City','+63 32 345 6789','inactive')");
$log[] = "15. More branches OK";

// ── Phase 3: Leave Balances ──

$lbInsert = $conn->prepare("INSERT IGNORE INTO leave_balance (employee_id,leave_type,total_days,used_days,remaining_days,year) VALUES (?,?,?,?,?,2026)");
$types = [['sick',15,2,13],['vacation',15,3,12],['emergency',5,0,5],['unpaid',10,1,9]];
$lbCount = 0;
foreach ($empMap as $eid) {
    foreach ($types as $t) {
        $lbInsert->bind_param('isddd', $eid, $t[0], $t[1], $t[2], $t[3]);
        $lbInsert->execute();
        if ($lbInsert->affected_rows > 0) $lbCount++;
    }
}
$lbInsert->close();
$log[] = "16. Leave balances OK ($lbCount inserted)";

// ── Phase 4: Projects ──

$conn->query("INSERT IGNORE INTO projects (name,description,client_id,manager_id,created_by,status,start_date,end_date,budget,actual_cost) VALUES
    ('Annual Audit 2026','Comprehensive financial audit for ABC Corporation FY 2026',$c1,$adminUserId,$adminUserId,'active','2026-01-15','2026-06-30',500000.00,0),
    ('Tax Compliance Filing','BIR tax return preparation and filing for XYZ Enterprises',$c2,$mgrUserId,$mgrUserId,'completed','2026-01-10','2026-04-15',150000.00,145000.00),
    ('Bookkeeping System Setup','QuickBooks setup and migration for LMN Trading Inc.',$c3,$mgrUserId,$adminUserId,'on_hold','2026-02-01','2026-05-01',80000.00,25000.00),
    ('Financial Advisory Project','Strategic financial planning for QRS Services Co.',$c4,$mgrUserId,$mgrUserId,'archived','2025-08-01','2025-12-31',200000.00,195000.00),
    ('Q1 2026 Audit Review','Quarterly audit review for ABC Corporation',$c1,$adminUserId,$adminUserId,'active','2026-04-01','2026-04-30',120000.00,0)");
$log[] = "17. Projects OK (5)";

// ── Phase 5: Profile Edit Requests ──

$conn->query("INSERT IGNORE INTO profile_edit_request (user_id,employee_id,requested_by,request_reason,requested_fields_json,request_snapshot_json,status,approved_by,approved_at) VALUES
    ($uMaria,$maria,$uMaria,'Updating my email and phone number','[\"email\",\"mobile_number\"]','{\"email\":\"maria@example.com\",\"mobile_number\":\"+639123456789\"}','pending',NULL,NULL),
    ($uJuan,$juan,$uJuan,'Correcting the spelling of my name','[\"first_name\",\"last_name\"]','{\"first_name\":\"Juan\",\"last_name\":\"Dela Cruz\"}','approved',$adminUserId,DATE_SUB(NOW(),INTERVAL 15 DAY)),
    ($uKaren,$karen,$uKaren,'Contact number update after changing provider','[\"mobile_number\"]','{\"mobile_number\":\"+639180001111\"}','used',$adminUserId,DATE_SUB(NOW(),INTERVAL 15 DAY)),
    ($uMichael,$michael,$uMichael,'Correcting my TIN number','[\"tin_number\"]','{\"tin_number\":\"123-456-789-000\"}','rejected',$adminUserId,DATE_SUB(NOW(),INTERVAL 10 DAY))");
$conn->query("UPDATE profile_edit_request SET used_at=DATE_SUB(NOW(),INTERVAL 5 DAY),used_by=$mgrUserId WHERE status='used'");
$log[] = "18. Profile edit requests OK (4)";

// ── Phase 6: Overtime Requests ──

$conn->query("INSERT IGNORE INTO overtime_request (employee_id,work_date,hours_requested,reason,status,approved_by,approved_at,manager_notes,created_by) VALUES
    ($cristina,'2026-06-10',3.00,'Completing quarterly report deliverables for ABC audit','submitted',NULL,NULL,NULL,$uCristina),
    ($jose,'2026-06-08',2.50,'Client presentation preparation for XYZ compliance','approved',$adminUserId,DATE_SUB(NOW(),INTERVAL 5 DAY),'Approved for client presentation prep',$uJose),
    ($roberto,'2026-06-05',4.00,'Catching up on personal backlog tasks','rejected',$mgrUserId,DATE_SUB(NOW(),INTERVAL 10 DAY),'Not needed, complete during regular hours',$uRoberto),
    ($michael,'2026-06-01',1.50,'Server migration support coverage','cancelled',NULL,NULL,NULL,$uMichael)");
$log[] = "19. Overtime requests OK (4)";

// ── Phase 7: Leave Requests ──

$conn->query("INSERT IGNORE INTO leave_request (employee_id,leave_type,start_date,end_date,reason,status,approved_by,approved_at) VALUES
    ($maria,'vacation','2026-07-01','2026-07-03','Family vacation in Batangas','pending',NULL,NULL),
    ($cristina,'sick','2026-05-20','2026-05-21','Medical checkup and recovery from flu','approved',$mgrEmpId,DATE_SUB(NOW(),INTERVAL 15 DAY)),
    ($jose,'emergency','2026-06-02','2026-06-02','Family emergency - late notice','rejected',$mgrEmpId,DATE_SUB(NOW(),INTERVAL 10 DAY)),
    ($angela,'vacation','2026-06-15','2026-06-19','Annual leave out-of-town trip','approved',$mgrEmpId,DATE_SUB(NOW(),INTERVAL 5 DAY)),
    ($roberto,'unpaid','2026-05-25','2026-05-26','Personal matters to attend to','cancelled',NULL,NULL)");
$log[] = "20. Leave requests OK (5)";

// ── Phase 8: Cash Advance Requests ──

$conn->query("INSERT IGNORE INTO cash_advance_request (employee_id,request_date,amount,reason,status,approved_by,approved_at,manager_notes,created_by) VALUES
    ($carlosS,'2026-06-05',5000.00,'Medical emergency fund for dental procedure','submitted',NULL,NULL,NULL,$uCarlosS),
    ($karen,'2026-05-15',10000.00,'Home repair advance for roof leakage','approved',$adminUserId,DATE_SUB(NOW(),INTERVAL 10 DAY),NULL,$uKaren),
    ($carlosM,'2026-05-01',20000.00,'Business trip accommodation and per diem','rejected',$mgrUserId,DATE_SUB(NOW(),INTERVAL 15 DAY),'Exceeds max advance limit for staff level',$uCarlosM),
    ($juan,'2026-06-01',3000.00,'Office supplies for remote work setup','cancelled',NULL,NULL,NULL,$uJuan)");
$log[] = "21. Cash advance requests OK (4)";

// ── Phase 9: Payrolls ──

$conn->query("INSERT IGNORE INTO payroll (employee_id,employee_name,pay_period_start,pay_period_end,basic_salary,overtime_hours,overtime_rate,overtime_pay,bonus,clothing_allowance,late_deduction,absence_deduction,tax,sss_contribution,pagibig_contribution,philhealth_contribution,gross_pay,total_deductions,net_pay,status,notes) VALUES
    ($maria,'Maria Gonzales','2026-06-01','2026-06-15',12500.00,0,0,0,0,0,0,0,0,0,0,0,12500.00,0,12500.00,'draft','First draft of June 1-15'),
    ($cristina,'Cristina Navarro','2026-05-16','2026-05-31',15000.00,2.00,273.00,546.00,0,0,150.00,0,750.00,450.00,200.00,375.00,15546.00,1925.00,13621.00,'pending','Pending for manager review'),
    ($angela,'Angela Mendoza','2026-05-01','2026-05-15',17500.00,0,0,0,5000.00,1000.00,0,1166.67,875.00,525.00,200.00,437.50,23500.00,3204.17,20295.83,'approved','Approved with bonus and clothing allowance'),
    ($jose,'Jose Ramirez','2026-05-01','2026-05-15',13000.00,3.00,236.00,708.00,0,0,0,0,0,390.00,200.00,325.00,13708.00,915.00,12793.00,'paid','Disbursed on May 20, 2026')");
// Get payroll ID for Jose
$josePayrollId = getValue($conn, "SELECT id FROM payroll WHERE employee_id=$jose AND status='paid' LIMIT 1");
$conn->query("INSERT IGNORE INTO payroll_user_archive (payroll_id,user_id,is_archived) VALUES ($josePayrollId,$uJose,0)");
$log[] = "22. Payrolls OK (4) + archive";

// Write lock file so this script cannot be re-run without manual server intervention.
file_put_contents($lockFile, date('Y-m-d H:i:s') . " setup completed\n", LOCK_EX);

echo implode("\n", $log) . "\n\n=== SETUP COMPLETE ===";
