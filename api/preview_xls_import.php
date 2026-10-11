<?php
/**
 * Preview 18_StandardReport.xls Import
 * 
 * This script reads the Excel file and shows what will be imported
 * Run: php api/preview_xls_import.php
 */

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/utils.php';

// Admin-only: this script exposes file paths and payroll data.
requireAuth();
$sessionRole = strtolower(trim((string)($_SESSION['role'] ?? '')));
if ($sessionRole !== 'admin') {
    http_response_code(403);
    exit("Forbidden: admin session required.\n");
}

error_reporting(0);
ini_set('display_errors', 0);

echo "===========================================\n";
echo "18_StandardReport.xls Import Preview\n";
echo "===========================================\n\n";

$xlsFile = __DIR__ . '/../test-data/18_StandardReport.xls';

if (!file_exists($xlsFile)) {
    die("ERROR: Excel file not found at: $xlsFile\n");
}

echo "Excel file found: $xlsFile\n";
echo "File size: " . number_format(filesize($xlsFile)) . " bytes\n\n";

// Check if PHPSpreadsheet is available
$vendorAutoload = __DIR__ . '/../vendor/autoload.php';

if (file_exists($vendorAutoload)) {
    require_once $vendorAutoload;
    
    try {
        echo "Loading Excel file...\n";
        $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($xlsFile);
        $worksheet = $spreadsheet->getActiveSheet();
        $rows = $worksheet->toArray();
        
        echo "Excel loaded successfully!\n";
        echo "Total rows: " . count($rows) . "\n\n";
        
        // Display header
        echo "===========================================\n";
        echo "COLUMN HEADERS\n";
        echo "===========================================\n";
        $header = array_shift($rows);
        foreach ($header as $index => $columnName) {
            echo sprintf("Column %d: %s\n", $index, $columnName);
        }
        
        echo "\n===========================================\n";
        echo "EMPLOYEE DATA PREVIEW\n";
        echo "===========================================\n\n";
        
        $validEmployees = 0;
        echo str_pad("ID", 12) . str_pad("Name", 15) . str_pad("Days", 8) . str_pad("OT Hrs", 10) . str_pad("Late", 8) . str_pad("Absent", 8) . str_pad("Salary", 12) . "\n";
        echo str_repeat("-", 73) . "\n";
        
        foreach ($rows as $index => $row) {
            // Skip empty rows
            if (empty($row[0])) continue;
            
            $employeeId = $row[0] ?? '';
            $employeeName = $row[1] ?? '';
            $daysWorked = $row[3] ?? 0;
            $overtimeHours = $row[4] ?? 0;
            $lateMinutes = $row[5] ?? 0;
            $absentDays = $row[6] ?? 0;
            $salary = $row[8] ?? 35000;
            
            echo str_pad($employeeId, 12);
            echo str_pad($employeeName, 15);
            echo str_pad(number_format($daysWorked, 2), 8);
            echo str_pad(number_format($overtimeHours, 2), 10);
            echo str_pad($lateMinutes, 8);
            echo str_pad(number_format($absentDays, 2), 8);
            echo str_pad(number_format($salary, 0), 12);
            echo "\n";
            
            $validEmployees++;
        }
        
        echo str_repeat("-", 73) . "\n";
        echo "Total valid employees: $validEmployees\n\n";
        
        // Calculate totals
        echo "===========================================\n";
        echo "PAYROLL SUMMARY\n";
        echo "===========================================\n\n";
        
        $totalSalary = 0;
        $totalDaysWorked = 0;
        $totalOvertimeHours = 0;
        $totalLateMinutes = 0;
        $totalAbsentDays = 0;
        
        // Reset rows pointer
        $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($xlsFile);
        $worksheet = $spreadsheet->getActiveSheet();
        $rows = $worksheet->toArray();
        array_shift($rows); // Remove header
        
        foreach ($rows as $row) {
            if (empty($row[0])) continue;
            
            $totalSalary += floatval($row[8] ?? 0);
            $totalDaysWorked += floatval($row[3] ?? 0);
            $totalOvertimeHours += floatval($row[4] ?? 0);
            $totalLateMinutes += intval($row[5] ?? 0);
            $totalAbsentDays += floatval($row[6] ?? 0);
        }
        
        echo "Total Employees: $validEmployees\n";
        echo "Total Monthly Salaries: ₱" . number_format($totalSalary, 2) . "\n";
        echo "Total Days Worked: " . number_format($totalDaysWorked, 2) . "\n";
        echo "Total Overtime Hours: " . number_format($totalOvertimeHours, 2) . "\n";
        echo "Total Late Minutes: " . number_format($totalLateMinutes) . " (" . number_format($totalLateMinutes / 60, 2) . " hours)\n";
        echo "Total Absent Days: " . number_format($totalAbsentDays, 2) . "\n\n";
        
        // Categorize employees
        echo "===========================================\n";
        echo "EMPLOYEE CATEGORIES\n";
        echo "===========================================\n\n";
        
        $fullAttendance = 0;
        $partialAttendance = 0;
        $noAttendance = 0;
        $withOvertime = 0;
        $withLate = 0;
        
        $spreadsheet = \PhpOffice\PhpSpreadsheet\IOFactory::load($xlsFile);
        $worksheet = $spreadsheet->getActiveSheet();
        $rows = $worksheet->toArray();
        array_shift($rows);
        
        foreach ($rows as $row) {
            if (empty($row[0])) continue;
            
            $daysWorked = floatval($row[3] ?? 0);
            $overtimeHours = floatval($row[4] ?? 0);
            $lateMinutes = intval($row[5] ?? 0);
            
            if ($daysWorked >= 9) $fullAttendance++;
            else if ($daysWorked > 0) $partialAttendance++;
            else $noAttendance++;
            
            if ($overtimeHours > 0) $withOvertime++;
            if ($lateMinutes > 0) $withLate++;
        }
        
        echo "Full Attendance (9-10 days): $fullAttendance employees\n";
        echo "Partial Attendance (1-8 days): $partialAttendance employees\n";
        echo "No Attendance (0 days): $noAttendance employees\n";
        echo "With Overtime: $withOvertime employees\n";
        echo "With Late Deductions: $withLate employees\n\n";
        
        // SQL Preview
        echo "===========================================\n";
        echo "SQL MIGRATION PREVIEW\n";
        echo "===========================================\n\n";
        
        echo "This migration will create:\n";
        echo "  ✓ $validEmployees employee records\n";
        echo "  ✓ $validEmployees user accounts (username: emp_[id], password: Staff123@)\n";
        echo "  ✓ 3 test projects\n";
        echo "  ✓ $validEmployees task assignments\n";
        echo "  ✓ $validEmployees attendance records (July 1-10, 2026)\n";
        echo "  ✓ $validEmployees payroll entries (draft status)\n\n";
        
        echo "To run the migration:\n";
        echo "  mysql -u root llb < database/migrate_payroll_employees.sql\n\n";
        
        echo "Or using full path:\n";
        echo "  c:\\xampp\\mysql\\bin\\mysql -u root llb < c:\\xampp\\htdocs\\capstone1\\database\\migrate_payroll_employees.sql\n\n";
        
    } catch (Exception $e) {
        echo "ERROR: " . $e->getMessage() . "\n\n";
        echo "Stack trace:\n" . $e->getTraceAsString() . "\n";
    }
    
} else {
    echo "PHPSpreadsheet not installed.\n\n";
    echo "To install, run:\n";
    echo "  cd c:\\xampp\\htdocs\\capstone1\n";
    echo "  composer require phpoffice/phpspreadsheet\n\n";
    
    echo "Or download composer from: https://getcomposer.org/download/\n\n";
    
    echo "Alternative: Export the Excel file to CSV and use a CSV importer.\n";
}

echo "===========================================\n";
echo "Preview Complete\n";
echo "===========================================\n";
