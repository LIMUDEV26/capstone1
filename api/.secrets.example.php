<?php
/**
 * api/.secrets.example.php — TEMPLATE. Safe to commit.
 *
 * Copy to api/.secrets.php (git-ignored) on the server and fill in real values:
 *     cp api/.secrets.example.php api/.secrets.php
 *
 * api/config.php loads api/.secrets.php automatically when it exists, so no
 * Apache or .htaccess change is needed. Prefer real server-environment
 * variables where your host supports them — this file exists for XAMPP and
 * other hosts where SetEnv in a tracked file is the only other option (and
 * that is what leaked the original credential).
 *
 * Never put production secrets in this template.
 */

if (getenv('SMTP_USERNAME') === false) {
    putenv('SMTP_USERNAME=CHANGE_ME@gmail.com');
}

if (getenv('SMTP_PASSWORD') === false) {
    putenv('SMTP_PASSWORD=CHANGE_ME_16_CHAR_APP_PASSWORD');
}

if (getenv('SMTP_FROM_EMAIL') === false) {
    putenv('SMTP_FROM_EMAIL=CHANGE_ME@gmail.com');
}
