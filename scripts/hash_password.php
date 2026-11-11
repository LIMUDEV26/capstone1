<?php
/** Generate a PHP password_hash() value to paste into database/admin-account.sql. */
if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "Run this script from a terminal, not through a web server.\n");
    exit(1);
}

fwrite(STDOUT, "Enter the new account password (input may be visible): ");
$line = fgets(STDIN);
if ($line === false) {
    fwrite(STDERR, "No password was entered.\n");
    exit(1);
}

$password = rtrim($line, "\r\n");
if (strlen($password) < 12) {
    fwrite(STDERR, "Use a password with at least 12 characters.\n");
    exit(1);
}
$hasUppercase = preg_match('/[A-Z]/', $password) === 1;
$hasNumber = preg_match('/[0-9]/', $password) === 1;
$hasSpecial = strpbrk($password, '!@#$%^&*()-_=+[]{};:,.<>/?\\\\|') !== false;
if (!$hasUppercase || !$hasNumber || !$hasSpecial) {
    fwrite(STDERR, "Use at least one uppercase letter, one number, and one special character.\n");
    exit(1);
}

$hash = password_hash($password, PASSWORD_BCRYPT);
if (!is_string($hash) || $hash === '') {
    fwrite(STDERR, "Could not create the password hash.\n");
    exit(1);
}

fwrite(STDOUT, "\nPassword hash (copy this hash, never the password):\n" . $hash . "\n");
