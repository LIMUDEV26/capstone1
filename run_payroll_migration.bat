@echo off
REM =====================================================
REM Run Payroll Migration from 18_StandardReport.xls
REM =====================================================

echo.
echo =====================================================
echo Payroll Employee Migration
echo =====================================================
echo.
echo This will import 19 employees from 18_StandardReport.xls
echo and create payroll data for testing.
echo.
echo Press Ctrl+C to cancel, or
pause

echo.
echo Running migration...
echo.

REM Try different MySQL paths
if exist "c:\xampp\mysql\bin\mysql.exe" (
    c:\xampp\mysql\bin\mysql.exe -u root llb < database\migrate_payroll_employees.sql
    goto :success
)

if exist "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" (
    "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root llb < database\migrate_payroll_employees.sql
    goto :success
)

REM Try mysql from PATH
mysql --version >nul 2>&1
if %errorlevel% == 0 (
    mysql -u root llb < database\migrate_payroll_employees.sql
    goto :success
)

:error
echo.
echo ERROR: MySQL not found!
echo.
echo Please run the migration manually:
echo   c:\xampp\mysql\bin\mysql -u root llb ^< database\migrate_payroll_employees.sql
echo.
echo Or use phpMyAdmin:
echo   1. Open http://localhost/phpmyadmin
echo   2. Select 'llb' database
echo   3. Go to Import tab
echo   4. Upload: database\migrate_payroll_employees.sql
echo.
pause
exit /b 1

:success
echo.
echo =====================================================
echo Migration completed successfully!
echo =====================================================
echo.
echo Created:
echo   - 19 employees
echo   - 19 user accounts (password: Staff123@)
echo   - 3 test projects
echo   - 19 tasks
echo   - 19 attendance records
echo   - 19 payroll entries (draft)
echo.
echo Pay Period: July 1-10, 2026
echo.
echo To view results:
echo   1. Login to the application
echo   2. Go to Payroll Management
echo   3. Select period: July 1-10, 2026
echo.
echo Test login credentials:
echo   Username: emp_18
echo   Password: Staff123@
echo.
pause
