<?php
$user = getenv('SMTP_USERNAME');
$pass = getenv('SMTP_PASSWORD');
$from = getenv('SMTP_FROM_EMAIL');
echo "SMTP_USERNAME: " . ($user ?: '(empty)') . PHP_EOL;
echo "SMTP_PASSWORD: " . ($pass ? str_repeat('*', strlen($pass)) : '(empty)') . PHP_EOL;
echo "SMTP_FROM_EMAIL: " . ($from ?: '(empty)') . PHP_EOL;
