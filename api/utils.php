<?php
/**
 * Utility Functions for API
 * 
 * Common functions used across all API endpoints
 */

/**
 * Build the CORS allowlist for this zquest.
 *
 * Sources, in order:
 *   1. CORS_ALLOWED_ORIGINS env var — comma-separated, explicit, authoritative.
 *   2. Host-derived defaults — the host serving this request. Localhost and
 *      Next.js development ports are added only outside Railway production.
 *
 * Phase 1.1 removed two things that made this unsafe:
 *   - the "*" wildcard, which reflected ANY origin back together with
 *     Access-Control-Allow-Credentials: true (so any website could read
 *     authenticated data out of a logged-in browser);
 *   - X-Forwarded-Host as an allowlist source, which let a client widen its own
 *     allowlist with a request header.
 *
 * "*" is treated as unset (warn + fall back) rather than accepted, because a
 * credentialed wildcard would let arbitrary origins read authenticated data.
 *
 * @return array<int, string>
 */
function getCorsAllowedOrigins() {
    static $allowedOrigins = null;
    if ($allowedOrigins !== null) {
        return $allowedOrigins;
    }

    $envOrigins = trim((string)(getenv('CORS_ALLOWED_ORIGINS') ?: ''));

    if ($envOrigins === '*') {
        error_log(
            'SECURITY: CORS_ALLOWED_ORIGINS="*" ignored — a credentialed wildcard '
            . 'lets any site read authenticated data. Falling back to host-derived '
            . 'origins. List real origins explicitly, e.g. '
            . 'CORS_ALLOWED_ORIGINS=https://your-frontend.example'
        );
        $envOrigins = '';
    }

    $origins = [];

    if ($envOrigins !== '') {
        foreach (explode(',', $envOrigins) as $candidate) {
            $candidate = trim($candidate);
            // Drop blanks and anything containing a wildcard so a stray "*"
            // inside a list cannot re-open the hole.
            if ($candidate === '' || strpos($candidate, '*') !== false) {
                continue;
            }
            $origins[] = rtrim($candidate, '/');
        }
    }

    // Include the explicitly configured frontend when the API is hosted on a
    // separate origin. CORS stays exact; credentialed wildcard origins remain blocked.
    $frontendBase = function_exists('getFrontendBaseUrl') ? getFrontendBaseUrl() : '';
    if ($frontendBase !== '') {
        $frontendParts = parse_url($frontendBase);
        if (is_array($frontendParts)
            && in_array(strtolower((string)($frontendParts['scheme'] ?? '')), ['http', 'https'], true)
            && !empty($frontendParts['host'])
        ) {
            $frontendOrigin = strtolower((string)$frontendParts['scheme']) . '://' . strtolower((string)$frontendParts['host']);
            if (isset($frontendParts['port'])) {
                $frontendOrigin .= ':' . (int)$frontendParts['port'];
            }
            $origins[] = $frontendOrigin;
        }
    }

    // Always allow the host this request was actually served on. Localhost
    // and Next.js development ports are added only outside Railway production;
    // production frontends must be listed explicitly above.
    $host = trim((string)($_SERVER['HTTP_HOST'] ?? 'localhost'));
    $bareHost = strtok($host, ':') ?: 'localhost';

    $isProduction = strtolower(trim((string)(getenv('APP_ENV') ?: ''))) === 'production'
        || getenv('RAILWAY_ENVIRONMENT_NAME') !== false;
    $hosts = [$host, $bareHost];
    if (!$isProduction) {
        $hosts = array_merge($hosts, ['localhost', '127.0.0.1']);
    }
    $requestScheme = strtolower(trim((string)(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0] ?? '')));
    if (!in_array($requestScheme, ['http', 'https'], true)) {
        $requestScheme = (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') ? 'https' : 'http';
    }
    foreach (array_unique($hosts) as $h) {
        if ($h === '') continue;
        // Railway terminates TLS at its proxy. Trust its forwarded scheme for
        // this request so production allows the HTTPS origin the browser uses,
        // without also adding an insecure HTTP origin for the same host.
        $origins[] = ($isProduction ? 'https' : $requestScheme) . '://' . $h;
        if (!$isProduction) {
            $origins[] = 'http://' . $h;
            $origins[] = 'https://' . $h;
        }
    }
    if (!$isProduction) {
        foreach (array_unique([$bareHost, 'localhost', '127.0.0.1']) as $h) {
            if ($h === '') continue;
            foreach ([3000, 3001, 3002, 3003, 3004, 3005] as $devPort) {
                $origins[] = 'http://' . $h . ':' . $devPort;
                $origins[] = 'https://' . $h . ':' . $devPort;
            }
        }
    }

    // Reverse-proxy support (ngrok tunnel, `next dev` on :3000 proxying /api/*).
    //
    // In those setups the page is loaded from a PUBLIC host while PHP sees
    // HTTP_HOST = the proxy target (127.0.0.1). The frontend calls the API with
    // relative URLs, so from the browser's point of view these are *same-origin*
    // requests — but browsers still attach Origin to same-origin POST/PUT/DELETE.
    // Without the public host in the allowlist every mutation would 403.
    // Next.js/ngrok forward X-Forwarded-Host, which names that public host.
    //
    // X-Forwarded-Host is client-controlled, so it is trusted only when BOTH:
    //   1. the TCP peer is loopback/private (our own proxy, not the internet), and
    //   2. the browser explicitly states Sec-Fetch-Site: same-origin.
    //
    // Sec-Fetch-Site is a forbidden header name — page JavaScript cannot set or
    // forge it, and neither can it set X-Forwarded-Host. So requiring an explicit
    // same-origin declaration means only a genuine browser request arriving via
    // our own proxy can extend the allowlist. A hostile page's request would say
    // cross-site; a hand-crafted curl request says nothing at all. Both are
    // rejected. (Non-browser callers lose nothing: CORS is browser-enforced and
    // they hold no victim cookies.)
    //
    // Caveat: Sec-Fetch-* requires Chrome/Edge 76+, Firefox 90+, Safari 16.4+.
    // On older browsers behind a tunnel, name the origin explicitly in
    // CORS_ALLOWED_ORIGINS — that is the documented, preferred path regardless.
    //
    // Overrides: CORS_TRUST_FORWARDED_HOST=1 forces trust (legacy, avoid);
    // =0 disables it entirely (correct when TLS terminates on an untrusted hop).
    $secFetchSite = strtolower(trim((string)($_SERVER['HTTP_SEC_FETCH_SITE'] ?? '')));

    $trustForwardedRaw = trim((string)(getenv('CORS_TRUST_FORWARDED_HOST') ?: ''));
    $remoteAddr = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($trustForwardedRaw === '1') {
        $trustForwarded = true;
    } elseif ($trustForwardedRaw === '0') {
        $trustForwarded = false;
    } else {
        $trustForwarded = (
            $remoteAddr !== ''
            && isLocalhostOrPrivate($remoteAddr)
            && $secFetchSite === 'same-origin'
        );
    }

    if ($trustForwarded) {
        $forwardedHost = trim((string)($_SERVER['HTTP_X_FORWARDED_HOST'] ?? ''));
        // A comma-separated chain means several proxies appended values; the
        // leftmost is the original public host.
        if ($forwardedHost !== '') {
            $forwardedHost = trim((string)(explode(',', $forwardedHost)[0] ?? ''));
        }
        // Reject anything that is not a bare host[:port] so a crafted value
        // cannot inject a header or smuggle a second origin.
        if ($forwardedHost !== '' && preg_match('/^[A-Za-z0-9.\-]+(:\d{1,5})?$/', $forwardedHost)) {
            $forwardedBare = strtok($forwardedHost, ':') ?: $forwardedHost;
            foreach (array_unique([$forwardedHost, $forwardedBare]) as $fh) {
                $origins[] = ($isProduction ? 'https' : $requestScheme) . '://' . $fh;
                if (!$isProduction) {
                    $origins[] = 'http://' . $fh;
                    $origins[] = 'https://' . $fh;
                }
            }
        }
    }

    $allowedOrigins = array_values(array_unique($origins));
    return $allowedOrigins;
}

/**
 * Emit hardening headers that apply to every JSON API response (Phase 1.2).
 *
 * API responses previously carried no CSP at all. JSON is inert, so
 * `default-src 'none'` cannot break a response body — it only bites when a
 * response is navigated to or framed directly, which is what we want blocked.
 *
 * @return void
 */
function setApiHardeningHeaders() {
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('Cross-Origin-Resource-Policy: same-site');
    header('Referrer-Policy: strict-origin-when-cross-origin');

    // php.ini has expose_php=On, and "Header always unset" in .htaccess does not
    // reliably strip this under mod_php. header_remove() does.
    header_remove('X-Powered-By');
}

/**
 * Set CORS headers
 */
function setCORSHeaders() {
    $allowedOrigins = getCorsAllowedOrigins();
    $origin = rtrim(trim((string)($_SERVER['HTTP_ORIGIN'] ?? '')), '/');

    setApiHardeningHeaders();

    if ($origin === '') {
        // No Origin header — same-origin navigation, a server-side call, or a
        // non-browser client (curl, Electron main process). No CORS headers
        // needed; the session cookie still governs access.
    } elseif (in_array($origin, $allowedOrigins, true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Vary: Origin');
        header('Access-Control-Allow-Credentials: true');
    } else {
        // Unknown cross-origin request. Deliberately send NO
        // Access-Control-Allow-Origin — without it the browser discards the
        // response regardless of status code.
        error_log('SECURITY: rejected cross-origin request from origin: ' . $origin);
        http_response_code(403);
        header('Content-Type: application/json; charset=UTF-8');
        exit(json_encode(['success' => false, 'message' => 'Cross-origin request not allowed']));
    }

    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
    header('Access-Control-Max-Age: 600');
    header('Content-Type: application/json; charset=UTF-8');

    // Handle preflight requests
    if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
        http_response_code(204);
        exit();
    }

    // Enforce configurable request throttling to reduce abusive floods.
    enforceRequestRateLimit();

    // Enforce optional system lockdown mode.
    // When enabled, only admin traffic is allowed.
    enforceSystemLockdown();
}

/**
 * Get authenticated user id for activity logging.
 * @return int 0 when unavailable
 */
function getActivityLogUserId() {
    $user_id = $_SESSION['user_id'] ?? 0;
    return (is_numeric($user_id) && (int)$user_id > 0) ? (int)$user_id : 0;
}

/**
 * Normalize text for safe activity action tokens.
 * @param mixed $value
 * @return string
 */
function normalizeActivityToken($value) {
    $token = strtolower(trim((string)$value));
    $token = preg_replace('/[^a-z0-9]+/', '_', $token);
    $token = trim((string)$token, '_');
    return $token !== '' ? $token : 'unknown';
}

/**
 * Resolve current API endpoint token (without .php extension).
 * @return string
 */
function getActivityEndpointToken() {
    $script = basename($_SERVER['SCRIPT_NAME'] ?? '');
    $name = preg_replace('/\.php$/i', '', $script);
    return normalizeActivityToken($name);
}

/**
 * Convert an endpoint/action token into a readable label.
 * @param mixed $value
 * @return string
 */
function humanizeActivityLabel($value) {
    $label = trim((string)$value);
    if ($label === '') return 'Request';

    $label = str_replace('\\', '/', $label);
    $label = basename($label);
    $label = preg_replace('/\.php$/i', '', $label);
    $label = str_replace(['_', '-'], ' ', $label);
    $label = preg_replace('/\s+/', ' ', $label);
    $label = trim((string)$label);

    return $label !== '' ? ucwords($label) : 'Request';
}

/**
 * Build a clean activity description for automatic API logs.
 * @param bool $success
 * @param int $code
 * @param string $method
 * @param string $endpoint
 * @param string $message
 * @return string
 */
function buildAutoActivityDescription($success, $code, $method, $endpoint, $message = '') {
    $cleanMessage = preg_replace('/\s+/', ' ', trim((string)$message));
    if ($cleanMessage !== '') {
        return $cleanMessage;
    }

    $statusLabel = $success ? 'Successful' : 'Failed';
    $methodLabel = strtoupper(trim((string)$method));
    $endpointLabel = humanizeActivityLabel($endpoint);

    return trim(sprintf('%s %s request for %s', $statusLabel, $methodLabel, $endpointLabel));
}

/**
 * Clean legacy auto-generated activity descriptions for display.
 * @param mixed $description
 * @return string
 */
function cleanAutoActivityDescription($description) {
    $text = trim((string)$description);
    if ($text === '') return '';

    // Make legacy attendance-import logs suitable for the dashboard. The batch
    // identifier and source code remain available in the audit trail, but are
    // implementation details that do not help a user read the activity feed.
    if (preg_match('/^Imported attendance:\s*(\d+)\s+payroll records created\s*\(Batch:\s*[^;]+;\s*Source:\s*[^)]+\)$/i', $text, $matches)) {
        $created = (int)$matches[1];
        $recordLabel = $created === 1 ? 'draft payroll record' : 'draft payroll records';
        return "Attendance file imported; {$created} {$recordLabel} created.";
    }

    if (!preg_match('/^(SUCCESS|FAILED)\s+\[(\d+)\]\s+([A-Z]+)\s+([^|]+?)(?:\s+\|\s+(.*))?$/', $text, $matches)) {
        return $text;
    }

    $message = trim((string)($matches[5] ?? ''));
    if ($message !== '') {
        return $message;
    }

    $success = strtoupper((string)$matches[1]) === 'SUCCESS';
    $code = intval($matches[2] ?? 200);
    $method = strtoupper(trim((string)($matches[3] ?? 'UNKNOWN')));
    $uri = trim((string)($matches[4] ?? ''));
    $path = parse_url($uri, PHP_URL_PATH);
    $endpoint = $path !== null && $path !== false && $path !== '' ? basename((string)$path) : $uri;

    return buildAutoActivityDescription($success, $code, $method, (string)$endpoint, '');
}

function normalizePhoneCountryCode($value, $fallback = '+63') {
    $raw = trim((string)$value);
    $digits = preg_replace('/\D+/', '', $raw);
    if ($digits === '') {
        $fallbackDigits = preg_replace('/\D+/', '', (string)$fallback);
        return $fallbackDigits === '' ? '+63' : '+' . $fallbackDigits;
    }
    return '+' . $digits;
}

function sanitizeInternationalPhoneDraft($value) {
    $raw = (string)($value ?? '');
    if ($raw === '') return '';

    $sanitized = preg_replace('/[^\d+]/', '', $raw);
    if ($sanitized === null) return '';

    if (strpos($sanitized, '00') === 0) {
        $sanitized = '+' . substr($sanitized, 2);
    }

    if (strpos($sanitized, '+') === 0) {
        $sanitized = '+' . str_replace('+', '', substr($sanitized, 1));
    } else {
        $sanitized = str_replace('+', '', $sanitized);
    }

    return trim($sanitized);
}

/**
 * Normalize a phone number into international E.164-like format.
 * Empty values return null. Invalid values return false.
 * Raw local numbers inherit the provided default country code.
 * @param mixed $value
 * @param string $defaultCountryCode
 * @return string|false|null
 */
function normalizeInternationalPhoneNumber($value, $defaultCountryCode = '+63') {
    if (!isset($value)) return null;

    $defaultCode = normalizePhoneCountryCode($defaultCountryCode, '+63');
    $defaultDigits = substr($defaultCode, 1);
    $draft = sanitizeInternationalPhoneDraft($value);

    if ($draft === '' || $draft === '+' || $draft === $defaultCode) {
        return null;
    }

    if (strpos($draft, '+') !== 0) {
        $digits = preg_replace('/\D+/', '', $draft);
        if ($digits === '') return false;

        $normalizedLocalDigits = ltrim($digits, '0');
        if ($normalizedLocalDigits === '') {
            $normalizedLocalDigits = $digits;
        }

        if (strpos($normalizedLocalDigits, $defaultDigits) === 0) {
            $draft = '+' . $normalizedLocalDigits;
        } else {
            $draft = $defaultCode . $normalizedLocalDigits;
        }
    }

    $digits = preg_replace('/\D+/', '', substr($draft, 1));
    if (!preg_match('/^[1-9]\d{6,14}$/', (string)$digits)) {
        return false;
    }

    return '+' . $digits;
}

/**
 * Backward-compatible alias retained for existing callers.
 * @param mixed $value
 * @return string|false|null
 */
function normalizePhilippineMobileNumber($value) {
    return normalizeInternationalPhoneNumber($value, '+63');
}

/**
 * Decide if this request should be auto-logged.
 * Auto logging targets authenticated data-changing operations.
 * @param bool $success
 * @return bool
 */
function shouldAutoLogActivity($success) {
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? '');
    if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
        return false;
    }

    if (getActivityLogUserId() <= 0) {
        return false;
    }

    // Avoid duplicate "success" entries when an endpoint already writes a manual log.
    if ($success && !empty($GLOBALS['__activity_logged_manually'])) {
        return false;
    }

    $script = strtolower(basename($_SERVER['SCRIPT_NAME'] ?? ''));
    if ($script === 'activity-logs.php') {
        return false;
    }

    return true;
}

/**
 * Resolve a database connection for automatic logging.
 * Reuses endpoint connection when available.
 * @return array{0:mixed,1:bool} [connection, shouldClose]
 */
function getAutoLogConnection() {
    if (isset($GLOBALS['conn']) && isDbConnection($GLOBALS['conn'])) {
        return [$GLOBALS['conn'], false];
    }

    return [null, false];
}

/**
 * Automatic activity logging for API responses.
 * @param bool $success
 * @param string $message
 * @param int $code
 * @return void
 */
function autoLogApiActivity($success, $message = '', $code = 200) {
    if (!shouldAutoLogActivity((bool)$success)) {
        return;
    }

    if (!function_exists('logActivity')) {
        return;
    }

    $user_id = getActivityLogUserId();
    if ($user_id <= 0) {
        return;
    }

    [$db, $should_close] = getAutoLogConnection();
    if (!$db) {
        return;
    }

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'UNKNOWN');
    $endpoint = getActivityEndpointToken();
    $action_param = normalizeActivityToken($_GET['action'] ?? '');
    $action = strtolower($method) . '_' . $endpoint;
    if (!empty($_GET['action'])) {
        $action .= '_' . $action_param;
    }
    $action = substr($action, 0, 100);

    $description = buildAutoActivityDescription((bool)$success, (int)$code, $method, $endpoint, (string)$message);

    try {
        logActivity($db, $user_id, $action, $description, $endpoint);
    } catch (Throwable $e) {
        // Intentionally ignore logging failures to avoid breaking API responses.
    }

    if ($should_close && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }
}

/**
 * Send JSON response
 * @param bool $success Success status
 * @param mixed $data Response data
 * @param string $message Response message
 * @param int $code HTTP status code
 */
function buildJsonResponsePayload($success, $data = null, $message = '', $errors = null) {
    $response = [
        'success' => $success,
        'message' => $message
    ];

    if ($data !== null) {
        $response['data'] = $data;
    }

    if ($errors !== null) {
        $response['errors'] = $errors;
    }

    return $response;
}

function sendResponse($success, $data = null, $message = '', $code = 200) {
    http_response_code($code);

    autoLogApiActivity((bool)$success, (string)$message, (int)$code);

    echo json_encode(buildJsonResponsePayload($success, $data, $message), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit();
}

/**
 * Send error response
 * @param string $message Error message
 * @param int $code HTTP status code
 * @param mixed $errors Additional error details
 */
function sendError($message, $code = 400, $errors = null) {
    http_response_code($code);

    autoLogApiActivity(false, (string)$message, (int)$code);

    echo json_encode(buildJsonResponsePayload(false, null, $message, $errors), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    exit();
}

/**
 * Send a JSON response to the client immediately, then continue running a callback.
 * Useful for background email work that should not block the UI.
 *
 * @param bool $success
 * @param mixed $data
 * @param string $message
 * @param int $code
 * @param callable|null $callback
 */
function sendResponseAndContinue($success, $data = null, $message = '', $code = 200, $callback = null) {
    http_response_code($code);

    autoLogApiActivity((bool)$success, (string)$message, (int)$code);

    $body = json_encode(buildJsonResponsePayload($success, $data, $message), JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);
    if ($body === false) {
        $body = json_encode([
            'success' => (bool)$success,
            'message' => (string)$message,
        ]);
    }

    header('Content-Type: application/json; charset=UTF-8');
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');

    if (function_exists('session_status') && session_status() === PHP_SESSION_ACTIVE) {
        @session_write_close();
    }

    ignore_user_abort(true);
    @set_time_limit(0);
    @ini_set('zlib.output_compression', '0');
    if (function_exists('apache_setenv')) {
        @apache_setenv('no-gzip', '1');
    }

    $bodyLength = strlen((string)$body);
    header('Connection: close');
    header('Content-Length: ' . $bodyLength);

    echo $body;

    $didFastClose = false;
    if (function_exists('fastcgi_finish_request')) {
        @fastcgi_finish_request();
        $didFastClose = true;
    }

    if (!$didFastClose) {
        while (ob_get_level() > 0) {
            @ob_end_flush();
        }
        @flush();
    }

    if (is_callable($callback)) {
        try {
            $callback();
        } catch (\Throwable $throwable) {
            error_log('Background callback failed: ' . $throwable->getMessage());
        } catch (\Exception $exception) {
            error_log('Background callback failed: ' . $exception->getMessage());
        }
    }

    exit();
}

/**
 * Get request method
 * @return string HTTP request method
 */
function getRequestMethod() {
    return $_SERVER['REQUEST_METHOD'];
}

/**
 * Get JSON input data
 * If JSON is invalid or empty, returns an empty array to avoid null deref errors.
 * @return array
 */
function getJSONInput() {
    $input = file_get_contents('php://input');
    if ($input === false || trim($input) === '') {
        return [];
    }

    $decoded = json_decode($input, true);
    if (!is_array($decoded)) {
        return [];
    }

    return $decoded;
}

/**
 * Validate email format
 * @param string $email Email address to validate
 * @return bool True if valid, false otherwise
 */
function validateEmail($email) {
    return filter_var($email, FILTER_VALIDATE_EMAIL) !== false;
}

/**
 * Validate any properly-formed email address.
 * Accepts any domain — client emails are not restricted to specific providers.
 * @param string $email Email address to validate
 * @return bool True if valid, false otherwise
 */
function validateGmailComEmail($email) {
    $value = trim((string)$email);
    return validateEmail($value);
}

/**
 * Validate date format (Y-m-d)
 * @param string $date Date string to validate
 * @return bool True if valid, false otherwise
 */
function validateDate($date) {
    $d = DateTime::createFromFormat('Y-m-d', $date);
    return $d && $d->format('Y-m-d') === $date;
}

/**
 * Validate datetime format (Y-m-d H:i:s)
 * @param string $datetime Datetime string to validate
 * @return bool True if valid, false otherwise
 */
function validateDateTime($datetime) {
    $d = DateTime::createFromFormat('Y-m-d H:i:s', $datetime);
    return $d && $d->format('Y-m-d H:i:s') === $datetime;
}

/**
 * Generate unique ID with prefix
 * @param string $prefix Prefix for the ID
 * @return string Generated unique ID
 */
function generateUniqueID($prefix = '') {
    return $prefix . date('Ymd') . '-' . uniqid();
}

/**
 * Check if user is authenticated (basic session check)
 * @return int|false User ID if authenticated, false otherwise
 */
function checkAuthentication() {
    // Session should already be started by the calling script
    
    if (isset($_SESSION['user_id']) && !empty($_SESSION['user_id'])) {
        return $_SESSION['user_id'];
    }
    
    return false;
}

/**
 * Resolve the request-scoped client identifier used for rate limiting.
 *
 * The key is derived exclusively from the server-observed IP address so a
 * client cannot rotate its identity by changing the X-Client-Browser-ID
 * header. The client-supplied header is intentionally ignored for this purpose.
 *
 * @return string
 */
function getIntruderBrowserIdentifier() {
    // Use the real remote address as the primary lockout key.
    // Behind a trusted reverse proxy (ngrok, Cloudflare, etc.) prefer the
    // forwarded IP; otherwise fall back to REMOTE_ADDR.
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));

    // Accept X-Forwarded-For only when the connection comes from a known
    // private/loopback range (i.e. a local reverse proxy like ngrok's agent).
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
    if ($xff !== '' && isLocalhostOrPrivate($remote)) {
        // Take the leftmost (client) IP from the XFF chain.
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') {
            $remote = $candidate;
        }
    }

    // Prefix with 'ip_' to make the key namespace explicit.
    return 'ip_' . substr(hash('sha256', $remote), 0, 40);
}

/**
 * Return true when $addr is localhost or RFC-1918 / RFC-4193 private.
 * @param string $addr
 * @return bool
 */
function isLocalhostOrPrivate($addr) {
    if ($addr === '127.0.0.1' || $addr === '::1' || $addr === 'localhost') {
        return true;
    }
    // IPv4 private ranges
    if (preg_match('/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/', $addr)) {
        return true;
    }
    return false;
}

/**
 * Resolve the request throttling key for the current client.
 * Reuses the browser identifier when available and falls back to a network fingerprint.
 * @return string
 */
function getRequestRateLimitClientKey() {
    $browserKey = trim((string)getIntruderBrowserIdentifier());
    if ($browserKey !== '') {
        return substr($browserKey, 0, 64);
    }

    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'));
    $ua = trim((string)($_SERVER['HTTP_USER_AGENT'] ?? 'unknown'));
    return substr(hash('sha256', $remote . '|' . $ua), 0, 64);
}

/**
 * Ensure request throttling storage and default settings exist.
 * @param mysqli $conn
 * @return void
 */
function ensureRequestRateLimitStorage($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "CREATE TABLE IF NOT EXISTS request_rate_limits (
            client_key VARCHAR(64) NOT NULL PRIMARY KEY,
            request_count INT NOT NULL DEFAULT 0,
            window_start DATETIME NOT NULL,
            last_request_at DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_request_rate_limits_last_request_at (last_request_at),
            INDEX idx_request_rate_limits_window_start (window_start)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $conn->query(
        "INSERT INTO settings (setting_key, setting_value, setting_type) VALUES
            ('rate_limit_enabled', '1', 'boolean'),
            ('rate_limit_max_requests', '180', 'number'),
            ('rate_limit_window_seconds', '60', 'number')
         ON DUPLICATE KEY UPDATE setting_key = setting_key"
    );
}

/**
 * Load global request throttling settings.
 * @param mysqli $conn
 * @return array{enabled:bool,max_requests:int,window_seconds:int}
 */
function getRequestRateLimitConfig($conn) {
    $cfg = [
        'rate_limit_enabled' => '1',
        'rate_limit_max_requests' => '180',
        'rate_limit_window_seconds' => '60',
    ];

    $keys = array_keys($cfg);
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $stmt = $conn->prepare("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ($placeholders)");
    if ($stmt) {
        $stmt->bind_param($types, ...$keys);
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            $cfg[$row['setting_key']] = $row['setting_value'];
        }
        $stmt->close();
    }

    $enabledRaw = strtolower(trim((string)($cfg['rate_limit_enabled'] ?? '1')));
    $enabled = in_array($enabledRaw, ['1', 'true', 'yes', 'on'], true);
    $maxRequests = max(10, min(5000, (int)($cfg['rate_limit_max_requests'] ?? 180)));
    $windowSeconds = max(10, min(86400, (int)($cfg['rate_limit_window_seconds'] ?? 60)));

    return [
        'enabled' => $enabled,
        'max_requests' => $maxRequests,
        'window_seconds' => $windowSeconds,
    ];
}

/**
 * Advance the request throttling counter for the current client.
 * @param mysqli $conn
 * @param string $clientKey
 * @param int $windowSeconds
 * @return array{request_count:int,window_start:string,last_request_at:string}|null
 */
function updateRequestRateLimitState($conn, $clientKey, $windowSeconds) {
    $now = date('Y-m-d H:i:s');
    $windowResetBefore = date('Y-m-d H:i:s', time() - max(1, (int)$windowSeconds));

    $upsert = $conn->prepare(
        "INSERT INTO request_rate_limits (client_key, request_count, window_start, last_request_at)
         VALUES (?, 1, ?, ?)
         ON DUPLICATE KEY UPDATE
            request_count = CASE WHEN window_start <= ? THEN 1 ELSE request_count + 1 END,
            window_start = CASE WHEN window_start <= ? THEN VALUES(window_start) ELSE window_start END,
            last_request_at = VALUES(last_request_at),
            updated_at = CURRENT_TIMESTAMP"
    );
    if (!$upsert) return null;

    $upsert->bind_param('sssss', $clientKey, $now, $now, $windowResetBefore, $windowResetBefore);
    $upsert->execute();
    $upsert->close();

    $read = $conn->prepare(
        "SELECT request_count, window_start, last_request_at
         FROM request_rate_limits
         WHERE client_key = ?
         LIMIT 1"
    );
    if (!$read) return null;

    $read->bind_param('s', $clientKey);
    $read->execute();
    $row = $read->get_result()->fetch_assoc();
    $read->close();

    if (!$row) return null;

    return [
        'request_count' => (int)($row['request_count'] ?? 0),
        'window_start' => (string)($row['window_start'] ?? ''),
        'last_request_at' => (string)($row['last_request_at'] ?? ''),
    ];
}

/**
 * Best-effort cleanup for stale request throttling rows.
 * @param mysqli $conn
 * @return void
 */
function cleanupRequestRateLimitState($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (mt_rand(1, 100) !== 1) return;

    $cutoff = date('Y-m-d H:i:s', time() - 86400);
    $stmt = $conn->prepare("DELETE FROM request_rate_limits WHERE last_request_at < ? LIMIT 500");
    if (!$stmt) return;

    $stmt->bind_param('s', $cutoff);
    $stmt->execute();
    $stmt->close();
}



/**
 * Enforce configurable request throttling globally for this request.
 * @param mysqli|null $conn
 * @return void
 */
function enforceRequestRateLimit($conn = null) {
    static $checked = false;
    if ($checked) return;
    $checked = true;

    $db = (isDbConnection($conn)) ? $conn : null;
    if (!$db && isset($GLOBALS['conn']) && isDbConnection($GLOBALS['conn'])) {
        $db = $GLOBALS['conn'];
    }

    $shouldClose = false;
    if (!$db && function_exists('getDBConnection')) {
        try {
            $db = getDBConnection();
            $shouldClose = true;
        } catch (Throwable $e) {
            $db = null;
        }
    }

    if (!$db) return;

    ensureRequestRateLimitStorage($db);
    $cfg = getRequestRateLimitConfig($db);

    if (!$cfg['enabled']) {
        if ($shouldClose && function_exists('closeDBConnection')) {
            closeDBConnection($db);
        }
        return;
    }

    $clientKey = getRequestRateLimitClientKey();
    $state = updateRequestRateLimitState($db, $clientKey, (int)$cfg['window_seconds']);
    cleanupRequestRateLimitState($db);

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    if (!$state) return;
    if ((int)$state['request_count'] <= (int)$cfg['max_requests']) return;

    $windowStartTs = strtotime((string)$state['window_start']);
    $retryAfterSeconds = 1;
    if ($windowStartTs !== false) {
        $retryAfterSeconds = max(1, ($windowStartTs + (int)$cfg['window_seconds']) - time());
    }

    header('Retry-After: ' . $retryAfterSeconds);
    sendError(
        "Too many request, please try again after {$retryAfterSeconds} seconds.",
        429,
        [
            'retry_after_seconds' => $retryAfterSeconds,
            'limit' => (int)$cfg['max_requests'],
            'window_seconds' => (int)$cfg['window_seconds'],
        ]
    );
}

/**
 * Leave integration columns on payroll (informational breakdown + auto
 * unpaid-leave deduction audit trail). Shared by payroll.php and
 * attendance_import.php — keep the definition in exactly one place.
 * @param mysqli $conn
 * @return void
 */
function ensurePayrollLeaveColumns($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;
    $dbName = DB_NAME;
    foreach ([
        'unpaid_leave_days' => 'DECIMAL(8,2) NULL DEFAULT 0',
        'unpaid_leave_amount' => 'DECIMAL(12,2) NULL DEFAULT 0',
    ] as $column => $definition) {
        $check = $conn->prepare(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'payroll' AND COLUMN_NAME = ? LIMIT 1"
        );
        if (!$check) continue;
        $check->bind_param('ss', $dbName, $column);
        $check->execute();
        $exists = $check->get_result()->num_rows > 0;
        $check->close();
        if (!$exists) {
            $conn->query("ALTER TABLE `payroll` ADD COLUMN `$column` $definition");
        }
    }
}

function payrollTableExists($conn, $table) {
    if (!$conn || !(isDbConnection($conn))) return false;
    $safe = preg_replace('/[^a-zA-Z0-9_]/', '', (string)$table);
    if ($safe === '') return false;
    $res = $conn->query("SHOW TABLES LIKE '" . $conn->real_escape_string($safe) . "'");
    return $res && $res->num_rows > 0;
}

/**
 * Single daily-rate definition for the whole payroll system.
 *
 * Daily = (monthly salary / 2) / calendar days in the pay period. This is
 * the exact figure the payslip sheet prints in its "Daily Rate" column, so
 * absence, late, overtime-hourly (daily / 8), and unpaid-leave math all
 * reconcile with what employees see on their slips.
 */
function payrollPeriodDailyRate($monthlySalary, $periodStart, $periodEnd) {
    $monthlySalary = max(0.0, (float)$monthlySalary);
    $pStart = substr(trim((string)$periodStart), 0, 10);
    $pEnd = substr(trim((string)$periodEnd), 0, 10);
    if ($monthlySalary <= 0) return 0.0;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $pStart) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $pEnd)) return 0.0;
    $startTs = strtotime($pStart);
    $endTs = strtotime($pEnd);
    if ($startTs === false || $endTs === false || $endTs < $startTs) return 0.0;
    $periodDays = (int)(floor(($endTs - $startTs) / 86400) + 1);
    if ($periodDays <= 0) return 0.0;
    return round(($monthlySalary / 2) / $periodDays, 2);
}

/**
 * Count scheduled Monday-to-Friday workdays in an inclusive pay period.
 * This gives attendance imports their full pre-attendance salary baseline;
 * absences are then reflected only by the absence deduction.
 */
function payrollPeriodScheduledWorkdays($periodStart, $periodEnd) {
    $start = substr(trim((string)$periodStart), 0, 10);
    $end = substr(trim((string)$periodEnd), 0, 10);
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $start) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $end)) return 0;

    $startTs = strtotime($start);
    $endTs = strtotime($end);
    if ($startTs === false || $endTs === false || $endTs < $startTs) return 0;

    $workdays = 0;
    for ($day = $startTs; $day <= $endTs; $day += 86400) {
        $weekday = intval(date('N', $day));
        if ($weekday >= 1 && $weekday <= 5) $workdays++;
    }
    return $workdays;
}

function getCompanyDailyRate($conn, $branchId = 0) {
    if (!$conn || !(isDbConnection($conn))) return 0.0;
    static $rates = null;
    if ($rates === null) {
        $rates = ['default' => 0.0, 'branches' => []];
        $stmt = $conn->prepare("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('company_daily_rate', 'company_daily_rate_by_branch')");
        if (!$stmt) return 0.0;
        if ($stmt->execute()) {
            $result = $stmt->get_result();
            while ($row = $result->fetch_assoc()) {
                if ($row['setting_key'] === 'company_daily_rate') {
                    $rates['default'] = max(0.0, (float)$row['setting_value']);
                } elseif ($row['setting_key'] === 'company_daily_rate_by_branch') {
                    $decoded = json_decode((string)$row['setting_value'], true);
                    if (is_array($decoded)) {
                        foreach ($decoded as $id => $value) {
                            if (is_numeric($id) && (int)$id > 0 && is_numeric($value)) {
                                $rates['branches'][(int)$id] = max(0.0, (float)$value);
                            }
                        }
                    }
                }
            }
        }
        $stmt->close();
    }
    $branchId = (int)$branchId;
    if ($branchId > 0 && isset($rates['branches'][$branchId]) && $rates['branches'][$branchId] > 0) {
        return $rates['branches'][$branchId];
    }
    return (float)$rates['default'];
}

/**
 * Ensure system lockdown settings exist.
 * @param mysqli $conn
 * @return void
 */
function ensureSystemLockdownSettings($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "INSERT INTO settings (setting_key, setting_value, setting_type) VALUES
            ('security_lockdown_enabled', '0', 'boolean'),
            ('security_lockdown_reason', '', 'string'),
            ('security_lockdown_updated_at', '', 'string'),
            ('security_lockdown_updated_by', '', 'string')
         ON DUPLICATE KEY UPDATE setting_key = setting_key"
    );
}

/**
 * Read lockdown status from settings.
 * @param mysqli $conn
 * @return array{enabled:bool,reason:string,updated_at:string,updated_by:string}
 */
function getSystemLockdownState($conn) {
    ensureSystemLockdownSettings($conn);

    $defaults = [
        'enabled'    => false,
        'reason'     => '',
        'updated_at' => '',
        'updated_by' => '',
    ];

    if (!$conn || !(isDbConnection($conn))) {
        return $defaults;
    }

    $keys = ['security_lockdown_enabled', 'security_lockdown_reason',
             'security_lockdown_updated_at', 'security_lockdown_updated_by'];
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $stmt = $conn->prepare("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ($placeholders)");
    if (!$stmt) {
        return $defaults;
    }
    $stmt->bind_param('ssss', ...$keys);
    $stmt->execute();
    $result = $stmt->get_result();
    $raw = [];
    while ($row = $result->fetch_assoc()) {
        $raw[$row['setting_key']] = $row['setting_value'];
    }
    $stmt->close();

    $enabledRaw = strtolower(trim((string)($raw['security_lockdown_enabled'] ?? '0')));
    return [
        'enabled'    => in_array($enabledRaw, ['1', 'true', 'yes', 'on'], true),
        'reason'     => (string)($raw['security_lockdown_reason'] ?? ''),
        'updated_at' => (string)($raw['security_lockdown_updated_at'] ?? ''),
        'updated_by' => (string)($raw['security_lockdown_updated_by'] ?? ''),
    ];
}

/**
 * True when request should bypass lockdown gate before role checks.
 * This keeps admin login/logout flows available while lockdown is enabled.
 * @return bool
 */
function isSystemLockdownBypassRequest() {
    $script = strtolower((string)basename($_SERVER['SCRIPT_NAME'] ?? ''));
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $action = strtolower(trim((string)($_GET['action'] ?? '')));

    if ($script === 'auth.php') {
        // Allow essential auth operations even during lockdown (admin login/logout).
        if ($method === 'POST' && in_array($action, ['login', 'logout'], true)) {
            return true;
        }
        // Allow session checks so non-admins can receive lockdown status messaging.
        if ($method === 'GET' && in_array($action, ['', 'session', 'lockdown_status'], true)) {
            return true;
        }
    }

    return false;
}

/**
 * Enforce lockdown mode globally.
 * @param mysqli|null $conn
 * @return void
 */
function enforceSystemLockdown($conn = null) {
    static $checked = false;
    if ($checked) return;
    $checked = true;

    if (isSystemLockdownBypassRequest()) {
        return;
    }

    $db = (isDbConnection($conn)) ? $conn : null;
    if (!$db && isset($GLOBALS['conn']) && isDbConnection($GLOBALS['conn'])) {
        $db = $GLOBALS['conn'];
    }

    $shouldClose = false;
    if (!$db && function_exists('getDBConnection')) {
        try {
            $db = getDBConnection();
            $shouldClose = true;
        } catch (Throwable $e) {
            $db = null;
        }
    }

    if (!$db) return;

    $state = getSystemLockdownState($db);

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    if (!$state['enabled']) return;

    // Admins are always allowed through even during lockdown.
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if ($role === 'admin') return;

    $reason = trim((string)($state['reason'] ?? ''));
    $msg = $reason !== ''
        ? 'System is temporarily locked down: ' . $reason
        : 'System is temporarily locked down. Please try again later.';

    sendError($msg, 503);
}

/**
 * Presence window (seconds) used for "online" checks.
 * Accounts with a heartbeat newer than this window are treated as online.
 * @return int
 */
function getSessionPresenceWindowSeconds() {
    return 180; // 3 minutes
}

/**
 * Ensure table exists for active account presence tracking.
 * @param mysqli $conn
 * @return void
 */
function ensureSessionPresenceStorage($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "CREATE TABLE IF NOT EXISTS active_user_sessions (
            user_id INT NOT NULL PRIMARY KEY,
            session_id VARCHAR(128) NOT NULL,
            role VARCHAR(20) NOT NULL,
            last_seen DATETIME NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_active_user_last_seen (last_seen)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

/**
 * Resolve DB connection for presence operations.
 * @param mysqli|null $conn
 * @return array{0:mixed,1:bool}
 */
function resolvePresenceConnection($conn = null) {
    if (isDbConnection($conn)) return [$conn, false];
    if (isset($GLOBALS['conn']) && isDbConnection($GLOBALS['conn'])) return [$GLOBALS['conn'], false];

    if (function_exists('getDBConnection')) {
        try {
            return [getDBConnection(), true];
        } catch (Throwable $e) {
            return [null, false];
        }
    }

    return [null, false];
}

/**
 * Remove stale presence rows outside the online window.
 * @param mysqli $conn
 * @return void
 */
function purgeStaleSessionPresence($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    $windowSeconds = max(30, intval(getSessionPresenceWindowSeconds()));
    $stmt = $conn->prepare(
        "DELETE FROM active_user_sessions
         WHERE last_seen < DATE_SUB(NOW(), INTERVAL ? SECOND)"
    );
    if (!$stmt) return;
    $stmt->bind_param('i', $windowSeconds);
    $stmt->execute();
    $stmt->close();
}

/**
 * Upsert presence heartbeat for current authenticated session identity.
 *
 * Single-session rule: a heartbeat only refreshes the row when it belongs to
 * the current holder (matching auth token) or is a legacy row without one.
 * A superseded session never overwrites the newer holder's row.
 * @param mysqli|null $conn
 * @return void
 */
function touchCurrentSessionPresence($conn = null) {
    $userId = intval($_SESSION['user_id'] ?? 0);
    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if ($userId <= 0 || $role === '') return;

    $sid = session_id();
    if (!$sid) return;

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) return;

    ensureSessionPresenceStorage($db);
    ensureSingleSessionColumns($db);
    purgeStaleSessionPresence($db);

    $myToken = (string)($_SESSION['auth_token'] ?? '');
    if ($myToken === '') {
        $myToken = mintSessionAuthToken();
        $_SESSION['auth_token'] = $myToken;
    }

    $hasRow = false;
    $rowToken = '';
    $stmt = $db->prepare("SELECT auth_token FROM active_user_sessions WHERE user_id = ? LIMIT 1");
    if ($stmt) {
        $stmt->bind_param('i', $userId);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if (is_array($row)) {
            $hasRow = true;
            $rowToken = (string)($row['auth_token'] ?? '');
        }
    }

    if (!$hasRow) {
        $device = buildSessionDeviceLabel();
        $ip = getSingleSessionClientIp();
        $ins = $db->prepare(
            "INSERT INTO active_user_sessions
                (user_id, session_id, role, last_seen, auth_token, device_label, ip_address, login_at)
             VALUES (?, ?, ?, NOW(), ?, ?, ?, NOW())"
        );
        if ($ins) {
            $ins->bind_param('isssss', $userId, $sid, $role, $myToken, $device, $ip);
            $ins->execute();
            $ins->close();
        }
    } elseif ($rowToken === '' || hash_equals($rowToken, $myToken)) {
        $device = buildSessionDeviceLabel();
        $ip = getSingleSessionClientIp();
        $upd = $db->prepare(
            "UPDATE active_user_sessions
             SET session_id = ?, role = ?, last_seen = NOW(), auth_token = ?,
                 device_label = ?, ip_address = ?, updated_at = CURRENT_TIMESTAMP
             WHERE user_id = ?"
        );
        if ($upd) {
            $upd->bind_param('sssssi', $sid, $role, $myToken, $device, $ip, $userId);
            $upd->execute();
            $upd->close();
        }
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }
}

/**
 * Remove a presence row for a user id.
 *
 * Only removes the row when it belongs to the current session token, so
 * logging out (or expiring) on one device never kicks a newer session on
 * another device.
 * @param int $userId
 * @param mysqli|null $conn
 * @return void
 */
function clearSessionPresenceByUser($userId, $conn = null) {
    $uid = intval($userId);
    if ($uid <= 0) return;

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) return;

    ensureSessionPresenceStorage($db);
    ensureSingleSessionColumns($db);

    $myToken = (string)($_SESSION['auth_token'] ?? '');
    if ($myToken !== '') {
        $stmt = $db->prepare("DELETE FROM active_user_sessions WHERE user_id = ? AND auth_token = ?");
        if ($stmt) {
            $stmt->bind_param('is', $uid, $myToken);
            $stmt->execute();
            $stmt->close();
        }
    } else {
        $stmt = $db->prepare("DELETE FROM active_user_sessions WHERE user_id = ?");
        if ($stmt) {
            $stmt->bind_param('i', $uid);
            $stmt->execute();
            $stmt->close();
        }
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }
}

/**
 * ── Single-session enforcement ("1 account = 1 active session") ──────────
 * The active_user_sessions row (PRIMARY KEY user_id) holds the current
 * holder's auth token. A fresh login claims the row; any older session whose
 * token no longer matches is superseded and gets the takeover prompt.
 */

/**
 * Ensure the single-session columns exist on active_user_sessions.
 * @param mysqli $conn
 * @return void
 */
function ensureSingleSessionColumns($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;
    static $done = false;
    if ($done) return;

    ensureSessionPresenceStorage($conn);

    $columns = [
        'auth_token' => 'auth_token VARCHAR(64) NULL',
        'device_label' => 'device_label VARCHAR(255) NULL',
        'ip_address' => 'ip_address VARCHAR(64) NULL',
        'login_at' => 'login_at DATETIME NULL',
    ];
    foreach ($columns as $name => $definition) {
        $stmt = $conn->prepare(
            "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'active_user_sessions' AND COLUMN_NAME = ?
             LIMIT 1"
        );
        if (!$stmt) continue;
        $stmt->bind_param('s', $name);
        $stmt->execute();
        $exists = $stmt->get_result()->num_rows > 0;
        $stmt->close();
        if (!$exists) {
            $conn->query("ALTER TABLE `active_user_sessions` ADD COLUMN $definition");
        }
    }
    $done = true;
}

/**
 * Mint a random single-session auth token.
 * @return string
 */
function mintSessionAuthToken() {
    try {
        return bin2hex(random_bytes(32));
    } catch (Throwable $e) {
        return bin2hex(openssl_random_pseudo_bytes(32));
    }
}

/**
 * Best-effort client IP for session device labelling.
 * @return string
 */
function getSingleSessionClientIp() {
    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    $xff = trim((string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
    if ($xff !== '' && ($remote === '' || $remote === '127.0.0.1' || $remote === '::1' || (function_exists('isLocalhostOrPrivate') && isLocalhostOrPrivate($remote)))) {
        $parts = explode(',', $xff);
        $candidate = trim((string)($parts[0] ?? ''));
        if ($candidate !== '') return $candidate;
    }
    return $remote !== '' ? $remote : 'unknown';
}

/**
 * Short human-readable device label from the User-Agent (e.g. "Chrome on Windows").
 * @return string
 */
function buildSessionDeviceLabel() {
    $ua = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');
    $browser = 'Unknown browser';
    if (stripos($ua, 'Edg/') !== false) $browser = 'Edge';
    elseif (stripos($ua, 'OPR/') !== false || stripos($ua, 'Opera') !== false) $browser = 'Opera';
    elseif (stripos($ua, 'Chrome/') !== false) $browser = 'Chrome';
    elseif (stripos($ua, 'Firefox/') !== false) $browser = 'Firefox';
    elseif (stripos($ua, 'Safari/') !== false) $browser = 'Safari';
    $os = 'Unknown OS';
    if (stripos($ua, 'Windows') !== false) $os = 'Windows';
    elseif (stripos($ua, 'Android') !== false) $os = 'Android';
    elseif (stripos($ua, 'iPhone') !== false || stripos($ua, 'iPad') !== false) $os = 'iOS';
    elseif (stripos($ua, 'Mac OS') !== false) $os = 'macOS';
    elseif (stripos($ua, 'Linux') !== false) $os = 'Linux';
    return substr($browser . ' on ' . $os, 0, 120);
}

/**
 * Claim the single active session for this login.
 * @param mysqli $conn
 * @param int $userId
 * @param string $role
 * @return array{token:string,ended_other:bool}
 */
function claimSingleSession($conn, $userId, $role) {
    $result = ['token' => '', 'ended_other' => false];
    $uid = intval($userId);
    if ($uid <= 0 || !$conn || !(isDbConnection($conn))) return $result;

    ensureSessionPresenceStorage($conn);
    ensureSingleSessionColumns($conn);
    purgeStaleSessionPresence($conn);

    $windowSeconds = function_exists('getSessionPresenceWindowSeconds')
        ? max(30, intval(getSessionPresenceWindowSeconds()))
        : 180;
    $stmt = $conn->prepare("SELECT auth_token, last_seen FROM active_user_sessions WHERE user_id = ? LIMIT 1");
    if ($stmt) {
        $stmt->bind_param('i', $uid);
        $stmt->execute();
        $row = $stmt->get_result()->fetch_assoc();
        $stmt->close();
        if (is_array($row) && !empty($row['auth_token'])) {
            $lastSeen = strtotime((string)($row['last_seen'] ?? ''));
            if ($lastSeen && (time() - $lastSeen) <= $windowSeconds) {
                $result['ended_other'] = true;
            }
        }
    }

    $token = mintSessionAuthToken();
    $_SESSION['auth_token'] = $token;
    $result['token'] = $token;

    $sid = (string)session_id();
    $roleNorm = strtolower(trim((string)$role));
    $device = buildSessionDeviceLabel();
    $ip = getSingleSessionClientIp();
    $upsert = $conn->prepare(
        "INSERT INTO active_user_sessions
            (user_id, session_id, role, last_seen, auth_token, device_label, ip_address, login_at)
         VALUES (?, ?, ?, NOW(), ?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE
            session_id = VALUES(session_id),
            role = VALUES(role),
            last_seen = VALUES(last_seen),
            auth_token = VALUES(auth_token),
            device_label = VALUES(device_label),
            ip_address = VALUES(ip_address),
            login_at = VALUES(login_at),
            updated_at = CURRENT_TIMESTAMP"
    );
    if ($upsert) {
        $upsert->bind_param('isssss', $uid, $sid, $roleNorm, $token, $device, $ip);
        $upsert->execute();
        $upsert->close();
    }
    return $result;
}

/**
 * Check whether the current session still holds the account.
 * Never modifies the holder row — safe to call on every poll.
 * @param mysqli $conn
 * @return array{authenticated:bool,superseded:bool,holder:array|null}
 */
function getSingleSessionStatus($conn) {
    $uid = intval($_SESSION['user_id'] ?? 0);
    if ($uid <= 0) return ['authenticated' => false, 'superseded' => false, 'holder' => null];
    if (!$conn || !(isDbConnection($conn))) return ['authenticated' => true, 'superseded' => false, 'holder' => null];

    ensureSessionPresenceStorage($conn);
    ensureSingleSessionColumns($conn);

    $myToken = (string)($_SESSION['auth_token'] ?? '');
    if ($myToken === '') {
        // Session predates this feature: mint a token so future logins can displace it.
        $myToken = mintSessionAuthToken();
        $_SESSION['auth_token'] = $myToken;
    }

    $stmt = $conn->prepare("SELECT auth_token, device_label, ip_address, login_at FROM active_user_sessions WHERE user_id = ? LIMIT 1");
    if (!$stmt) return ['authenticated' => true, 'superseded' => false, 'holder' => null];
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!is_array($row) || empty($row['auth_token']) || hash_equals((string)$row['auth_token'], $myToken)) {
        return ['authenticated' => true, 'superseded' => false, 'holder' => null];
    }
    return ['authenticated' => true, 'superseded' => true, 'holder' => [
        'device' => (string)($row['device_label'] ?? 'another device'),
        'ip' => (string)($row['ip_address'] ?? 'unknown'),
        'at' => (string)($row['login_at'] ?? ''),
    ]];
}

/**
 * ── Login approval gate ───────────────────────────────────────────────────
 * When an account already has a live session and a new login arrives, the new
 * login is held as an approval request instead of barging in. The active
 * holder sees a Stay (= deny the newcomer) / Logout (= allow them in) prompt.
 */
const LOGIN_APPROVAL_TTL_SECONDS = 90;

/**
 * Ensure the login approval request table exists.
 * @param mysqli $conn
 * @return void
 */
function ensureLoginApprovalStorage($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;
    $conn->query(
        "CREATE TABLE IF NOT EXISTS login_approval_requests (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            device_label VARCHAR(255) NULL,
            ip_address VARCHAR(64) NULL,
            status ENUM('pending','approved','denied','expired') NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at DATETIME NOT NULL,
            decided_at DATETIME NULL,
            INDEX idx_lar_user (user_id),
            INDEX idx_lar_status_exp (status, expires_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

/**
 * Mark overdue approval requests as expired.
 * @param mysqli $conn
 * @return void
 */
function expireStaleLoginApprovals($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    $conn->query(
        "UPDATE login_approval_requests
         SET status = 'expired', decided_at = NOW()
         WHERE status = 'pending' AND expires_at < NOW()"
    );
}

/**
 * Return the currently active session holder for an account, if any.
 * "Active" = a presence heartbeat inside the online window.
 * @param mysqli $conn
 * @param int $userId
 * @return array|null {device,ip,at} or null when nobody is actively using the account
 */
function getActiveSessionHolder($conn, $userId) {
    $uid = intval($userId);
    if ($uid <= 0 || !$conn || !(isDbConnection($conn))) return null;

    ensureSessionPresenceStorage($conn);
    ensureSingleSessionColumns($conn);

    $windowSeconds = function_exists('getSessionPresenceWindowSeconds')
        ? max(30, intval(getSessionPresenceWindowSeconds()))
        : 180;
    $stmt = $conn->prepare(
        "SELECT device_label, ip_address, login_at
         FROM active_user_sessions
         WHERE user_id = ? AND last_seen >= DATE_SUB(NOW(), INTERVAL ? SECOND)
         LIMIT 1"
    );
    if (!$stmt) return null;
    $stmt->bind_param('ii', $uid, $windowSeconds);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!is_array($row)) return null;
    return [
        'device' => (string)($row['device_label'] ?? 'another device'),
        'ip' => (string)($row['ip_address'] ?? 'unknown'),
        'at' => (string)($row['login_at'] ?? ''),
    ];
}

/**
 * Hold a new login for approval, expiring any previous pending requests.
 * @param mysqli $conn
 * @param int $userId
 * @param int $ttlSeconds
 * @return array{id:int,expires_in:int}
 */
function createLoginApprovalRequest($conn, $userId, $ttlSeconds = LOGIN_APPROVAL_TTL_SECONDS) {
    $uid = intval($userId);
    $ttl = max(30, min(300, intval($ttlSeconds)));
    ensureLoginApprovalStorage($conn);
    expireStaleLoginApprovals($conn);

    $exp = $conn->prepare("UPDATE login_approval_requests SET status = 'expired', decided_at = NOW() WHERE user_id = ? AND status = 'pending'");
    if ($exp) {
        $exp->bind_param('i', $uid);
        $exp->execute();
        $exp->close();
    }

    $device = buildSessionDeviceLabel();
    $ip = getSingleSessionClientIp();
    $ins = $conn->prepare(
        "INSERT INTO login_approval_requests (user_id, device_label, ip_address, status, expires_at)
         VALUES (?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? SECOND))"
    );
    $id = 0;
    if ($ins) {
        $ins->bind_param('issi', $uid, $device, $ip, $ttl);
        $ins->execute();
        $id = (int)$conn->insert_id;
        $ins->close();
    }
    return ['id' => $id, 'expires_in' => $ttl];
}

/**
 * Latest still-pending approval request for an account (sweeping overdue ones first).
 * @param mysqli $conn
 * @param int $userId
 * @return array|null
 */
function getPendingLoginApproval($conn, $userId) {
    $uid = intval($userId);
    if ($uid <= 0 || !$conn || !(isDbConnection($conn))) return null;
    ensureLoginApprovalStorage($conn);
    expireStaleLoginApprovals($conn);
    $stmt = $conn->prepare(
        "SELECT id, user_id, device_label, ip_address, status, created_at, expires_at
         FROM login_approval_requests
         WHERE user_id = ? AND status = 'pending'
         ORDER BY id DESC LIMIT 1"
    );
    if (!$stmt) return null;
    $stmt->bind_param('i', $uid);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    if (!is_array($row)) return null;
    $remaining = strtotime((string)($row['expires_at'] ?? '')) - time();
    if ($remaining <= 0) {
        expireStaleLoginApprovals($conn);
        return null;
    }
    return [
        'id' => (int)$row['id'],
        'device' => (string)($row['device_label'] ?? 'another device'),
        'ip' => (string)($row['ip_address'] ?? 'unknown'),
        'at' => (string)($row['created_at'] ?? ''),
        'expires_in' => (int)$remaining,
    ];
}

/**
 * Fetch one approval request by id.
 * @param mysqli $conn
 * @param int $requestId
 * @return array|null
 */
function getLoginApprovalById($conn, $requestId) {
    $id = intval($requestId);
    if ($id <= 0 || !$conn || !(isDbConnection($conn))) return null;
    ensureLoginApprovalStorage($conn);
    $stmt = $conn->prepare(
        "SELECT id, user_id, device_label, ip_address, status, created_at, expires_at
         FROM login_approval_requests WHERE id = ? LIMIT 1"
    );
    if (!$stmt) return null;
    $stmt->bind_param('i', $id);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();
    return is_array($row) ? $row : null;
}

/**
 * Transition an approval request to a terminal state.
 * @param mysqli $conn
 * @param int $requestId
 * @param string $status approved|denied|expired
 * @return void
 */
function setLoginApprovalStatus($conn, $requestId, $status) {
    $id = intval($requestId);
    if ($id <= 0 || !$conn || !(isDbConnection($conn))) return;
    $allowed = ['approved', 'denied', 'expired'];
    if (!in_array($status, $allowed, true)) return;
    $stmt = $conn->prepare("UPDATE login_approval_requests SET status = ?, decided_at = NOW() WHERE id = ? AND status = 'pending'");
    if ($stmt) {
        $stmt->bind_param('si', $status, $id);
        $stmt->execute();
        $stmt->close();
    }
}

/**
 * Check whether the account holder is currently online.
 * @param mysqli $conn
 * @param int $userId
 * @return bool
 */
function isRealUserCurrentlyOnline($conn, $userId) {
    $uid = intval($userId);
    if ($uid <= 0 || !$conn || !(isDbConnection($conn))) return false;

    ensureSessionPresenceStorage($conn);
    purgeStaleSessionPresence($conn);
    $windowSeconds = max(30, intval(getSessionPresenceWindowSeconds()));

    $stmt = $conn->prepare(
         "SELECT 1
         FROM active_user_sessions
         WHERE user_id = ?
           AND last_seen >= DATE_SUB(NOW(), INTERVAL ? SECOND)
         LIMIT 1"
    );
    if (!$stmt) return false;
    $stmt->bind_param('ii', $uid, $windowSeconds);
    $stmt->execute();
    $online = $stmt->get_result()->num_rows > 0;
    $stmt->close();
    return $online;
}

/**
 * Default inactivity timeout policy for manager/staff sessions.
 * @return array{enabled:bool,manager_minutes:int,staff_minutes:int}
 */
function getDefaultManagedRoleSessionTimeoutConfig() {
    return [
        'enabled' => true,
        'manager_minutes' => 30,
        'staff_minutes' => 30,
        // Phase 1.5: admin previously had NO idle timeout at all. 60 minutes is
        // deliberately more generous than manager/staff so an admin working
        // through settings pages is not logged out mid-task.
        'admin_minutes' => 60,
    ];
}

/**
 * Ensure manager/staff/admin session timeout settings exist.
 * @param mysqli $conn
 * @return void
 */
function ensureManagedRoleSessionTimeoutSettings($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "INSERT INTO settings (setting_key, setting_value, setting_type) VALUES
            ('session_timeout_enabled', '1', 'boolean'),
            ('session_timeout_manager_minutes', '30', 'number'),
            ('session_timeout_staff_minutes', '30', 'number'),
            ('session_timeout_admin_minutes', '60', 'number')
         ON DUPLICATE KEY UPDATE setting_key = setting_key"
    );
}

/**
 * Load manager/staff inactivity timeout policy from settings.
 * @param mysqli|null $conn
 * @return array{enabled:bool,manager_minutes:int,staff_minutes:int}
 */
function getManagedRoleSessionTimeoutConfig($conn = null) {
    static $cached = null;
    if (is_array($cached)) {
        return $cached;
    }

    $defaults = getDefaultManagedRoleSessionTimeoutConfig();
    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = $defaults;
        return $cached;
    }

    ensureManagedRoleSessionTimeoutSettings($db);

    $raw = [
        'session_timeout_enabled' => $defaults['enabled'] ? '1' : '0',
        'session_timeout_manager_minutes' => (string)$defaults['manager_minutes'],
        'session_timeout_staff_minutes' => (string)$defaults['staff_minutes'],
        'session_timeout_admin_minutes' => (string)$defaults['admin_minutes'],
    ];

    $keys = array_keys($raw);
    $placeholders = implode(',', array_fill(0, count($keys), '?'));
    $types = str_repeat('s', count($keys));

    $stmt = $db->prepare("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ($placeholders)");
    if ($stmt) {
        $stmt->bind_param($types, ...$keys);
        $stmt->execute();
        $res = $stmt->get_result();
        while ($row = $res->fetch_assoc()) {
            $key = (string)($row['setting_key'] ?? '');
            if (array_key_exists($key, $raw)) {
                $raw[$key] = (string)($row['setting_value'] ?? $raw[$key]);
            }
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $enabledRaw = strtolower(trim((string)($raw['session_timeout_enabled'] ?? '1')));
    $enabled = in_array($enabledRaw, ['1', 'true', 'yes', 'on'], true);
    $managerMinutes = max(1, min(1440, intval($raw['session_timeout_manager_minutes'] ?? $defaults['manager_minutes'])));
    $staffMinutes = max(1, min(1440, intval($raw['session_timeout_staff_minutes'] ?? $defaults['staff_minutes'])));
    $adminMinutes = max(1, min(1440, intval($raw['session_timeout_admin_minutes'] ?? $defaults['admin_minutes'])));

    $cached = [
        'enabled' => $enabled,
        'manager_minutes' => $managerMinutes,
        'staff_minutes' => $staffMinutes,
        'admin_minutes' => $adminMinutes,
    ];

    return $cached;
}

/**
 * Default login math captcha enabled state.
 * @return bool
 */
function getDefaultLoginMathCaptchaEnabled() {
    return true;
}

/**
 * Default login captcha expiry window in seconds.
 * @return int
 */
function getDefaultCaptchaTimeoutSeconds() {
    return 300;
}

/**
 * Default failed login/captcha attempt limit before the account is locked.
 * @return int
 */
function getDefaultLoginFailedAttemptLimit() {
    return 5;
}

/**
 * Ensure login captcha timeout setting exists.
 * @param mysqli $conn
 * @return void
 */
function ensureCaptchaTimeoutSetting($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;

    runRuntimeSchemaUpgradeOnce('captcha_settings_v1', function () use ($conn) {
        $defaultSeconds = (string)getDefaultCaptchaTimeoutSeconds();
        $defaultEnabled = getDefaultLoginMathCaptchaEnabled() ? '1' : '0';
        $defaultAttemptLimit = (string)getDefaultLoginFailedAttemptLimit();
        $conn->query(
            "INSERT INTO settings (setting_key, setting_value, setting_type) VALUES
                ('captcha_timeout_seconds', '{$defaultSeconds}', 'number'),
                ('login_math_captcha_enabled', '{$defaultEnabled}', 'boolean'),
                ('login_failed_attempt_limit', '{$defaultAttemptLimit}', 'number')
             ON DUPLICATE KEY UPDATE setting_key = setting_key"
        );
    });
}

/**
 * Load login captcha expiry window from settings.
 * @param mysqli|null $conn
 * @return int
 */
function getCaptchaTimeoutSeconds($conn = null) {
    static $cached = null;
    if (is_int($cached)) {
        return $cached;
    }

    $defaultSeconds = getDefaultCaptchaTimeoutSeconds();
    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = $defaultSeconds;
        return $cached;
    }

    ensureCaptchaTimeoutSetting($db);

    $value = $defaultSeconds;
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'captcha_timeout_seconds' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($settingValue);
        if ($stmt->fetch()) {
            $value = (int)$settingValue;
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $cached = max(30, min(86400, (int)$value));
    return $cached;
}

/**
 * The login security challenge is always enabled and is presented only in
 * the floating verification dialog. The legacy inline-math mode is retired.
 *
 * @param mysqli|null $conn Retained for backward-compatible callers.
 * @return bool
 */
function isLoginMathCaptchaEnabled($conn = null) {
    return true;
}

/**
 * Whether the emailed login OTP step is enabled. Defaults to ON.
 * Managed from Admin Profile settings ("Login OTP").
 * Deliberately NOT statically cached — the toggle must take effect immediately.
 */
function isLoginOtpEnabled($conn = null) {
    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        return true;
    }

    $value = '1';
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'login_otp_enabled' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($settingValue);
        if ($stmt->fetch()) {
            $value = (string)$settingValue;
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $normalized = strtolower(trim((string)$value));
    return !in_array($normalized, ['0', 'false', 'off', 'no'], true);
}

/**
 * Load login failed attempt limit from settings.
 * This applies to both invalid passwords and failed captcha verification.
 * @param mysqli|null $conn
 * @return int
 */
function getLoginFailedAttemptLimit($conn = null) {
    static $cached = null;
    if (is_int($cached)) {
        return $cached;
    }

    $defaultLimit = getDefaultLoginFailedAttemptLimit();
    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = $defaultLimit;
        return $cached;
    }

    ensureCaptchaTimeoutSetting($db);

    $value = $defaultLimit;
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'login_failed_attempt_limit' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($settingValue);
        if ($stmt->fetch()) {
            $value = (int)$settingValue;
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $cached = max(1, min(20, (int)$value));
    return $cached;
}

/**
 * Resolve the account-lockout threshold for a specific user role.
 *
 * The Account Lockout admin settings page (pages/settings/account-lockout.tsx)
 * stores per-role thresholds:
 *   - manager -> 'lockout_threshold_manager'
 *   - staff   -> 'lockout_threshold_staff'
 * Any other role (or a missing/unset role-specific setting) falls back to the
 * generic 'login_failed_attempt_limit' setting via getLoginFailedAttemptLimit().
 *
 * @param mysqli|null $conn
 * @param string|null $role
 * @return int
 */
function getLockoutThresholdForRole($conn = null, $role = null) {
    static $cache = [];

    $roleKey = strtolower(trim((string)$role));
    if ($roleKey === 'manager') {
        $roleSettingKey = 'lockout_threshold_manager';
    } elseif ($roleKey === 'staff') {
        $roleSettingKey = 'lockout_threshold_staff';
    } else {
        $roleSettingKey = null;
    }

    if ($roleSettingKey !== null) {
        if (!array_key_exists($roleSettingKey, $cache)) {
            // Unknown until proven otherwise.
            $cache[$roleSettingKey] = null;

            [$db, $shouldClose] = resolvePresenceConnection($conn);
            if ($db) {
                $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = ? LIMIT 1");
                if ($stmt) {
                    $stmt->bind_param('s', $roleSettingKey);
                    $stmt->execute();
                    $stmt->bind_result($settingValue);
                    if ($stmt->fetch() && $settingValue !== null && (int)$settingValue > 0) {
                        $cache[$roleSettingKey] = max(1, min(20, (int)$settingValue));
                    }
                    $stmt->close();
                }
                if ($shouldClose && function_exists('closeDBConnection')) {
                    closeDBConnection($db);
                }
            }
        }

        if (is_int($cache[$roleSettingKey])) {
            return $cache[$roleSettingKey];
        }
    }

    // No role-specific threshold configured — use the generic limit.
    return getLoginFailedAttemptLimit($conn);
}

/**
 * Resolve the "attempt return" wait duration (in seconds) configured by the
 * admin on the Account Lockout settings page. Combines
 * 'lockout_retry_delay_value' + 'lockout_retry_delay_unit' ('seconds'|'minutes').
 * Returns 0 when the delay is disabled or not configured.
 * @param mysqli|null $conn
 * @return int
 */
function getLockoutRetryDelaySeconds($conn = null) {
    static $cached = null;
    if (is_int($cached)) {
        return $cached;
    }

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = 0;
        return $cached;
    }

    $value = 0;
    $unit = 'seconds';
    $stmt = $db->prepare(
        "SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('lockout_retry_delay_value','lockout_retry_delay_unit')"
    );
    if ($stmt) {
        $stmt->execute();
        $result = $stmt->get_result();
        while ($row = $result->fetch_assoc()) {
            if ($row['setting_key'] === 'lockout_retry_delay_value') {
                $value = (int)$row['setting_value'];
            } elseif ($row['setting_key'] === 'lockout_retry_delay_unit') {
                $unit = strtolower(trim((string)$row['setting_value']));
            }
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    if ($value <= 0) {
        $cached = 0;
        return $cached;
    }

    $cached = $unit === 'minutes' ? max(1, $value) * 60 : max(1, $value);
    return $cached;
}

/**
 * Resolve the failed-attempt number after which the "attempt return" countdown
 * applies ('lockout_cooldown_start_attempt'). Returns 0 when disabled.
 * @param mysqli|null $conn
 * @return int
 */
function getLockoutCooldownStartAttempt($conn = null) {
    static $cached = null;
    if (is_int($cached)) {
        return $cached;
    }

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = 0;
        return $cached;
    }

    $value = 0;
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'lockout_cooldown_start_attempt' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($settingValue);
        if ($stmt->fetch() && $settingValue !== null) {
            $value = max(0, (int)$settingValue);
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $cached = $value;
    return $cached;
}

/**
 * Resolve how many 30s cooldown cycles are allowed before auto-lock.
 * Default 3 → with threshold 3 and cooldown_start 3, attempts 3,4,5 are
 * 30s waits and attempt 6 locks. Returns 1-10 (default 3).
 * @param mysqli|null $conn
 * @return int
 */
function getLockoutMaxCooldownAttempts($conn = null) {
    static $cached = null;
    if (is_int($cached)) {
        return $cached;
    }

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        $cached = 3;
        return $cached;
    }

    $value = 3;
    $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'lockout_max_cooldown_attempts' LIMIT 1");
    if ($stmt) {
        $stmt->execute();
        $stmt->bind_result($settingValue);
        if ($stmt->fetch() && $settingValue !== null && $settingValue !== '') {
            $value = max(1, min(10, (int)$settingValue));
        }
        $stmt->close();
    }

    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }

    $cached = $value;
    return $cached;
}

/**
 * Make sure the users table has the lockout_cooldown_until column.
 * Runs at most once per request.
 * @param mysqli|null $conn
 * @return void
 */
function ensureLockoutCooldownColumn($conn = null) {
    static $done = false;
    if ($done) {
        return;
    }

    [$db, $shouldClose] = resolvePresenceConnection($conn);
    if (!$db) {
        return;
    }

    $exists = false;
    $stmt = $db->prepare(
        "SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'lockout_cooldown_until'
         LIMIT 1"
    );
    if ($stmt) {
        $stmt->execute();
        $exists = $stmt->get_result()->num_rows > 0;
        $stmt->close();
    }

    if (!$exists) {
        $db->query("ALTER TABLE `users` ADD COLUMN lockout_cooldown_until DATETIME NULL");
    }

    $done = true;
    if ($shouldClose && function_exists('closeDBConnection')) {
        closeDBConnection($db);
    }
}

/**
 * How many seconds remain before the user may attempt to log in again,
 * based on the stored lockout_cooldown_until timestamp. 0 = no active cooldown.
 * @param mysqli $conn
 * @param array $user
 * @return int
 */
function getAccountCooldownRemainingSeconds($conn, $user) {
    ensureLockoutCooldownColumn($conn);

    $raw = trim((string)($user['lockout_cooldown_until'] ?? ''));
    if ($raw === '') {
        return 0;
    }

    $ts = strtotime($raw);
    if ($ts === false) {
        return 0;
    }

    $remaining = $ts - time();
    return $remaining > 0 ? (int)$remaining : 0;
}

/**
 * Get the hCaptcha site key from settings.
 * @return string
 */
function getHcaptchaSiteKey() {
    static $cached = null;
    if (is_string($cached)) return $cached;

    $envKey = getenv('HCAPTCHA_SITE_KEY');
    if (is_string($envKey) && $envKey !== '') {
        $cached = $envKey;
        return $cached;
    }

    [$db, $shouldClose] = resolvePresenceConnection(null);
    if ($db) {
        $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'hcaptcha_site_key' LIMIT 1");
        if ($stmt) {
            $stmt->execute();
            $stmt->bind_result($value);
            if ($stmt->fetch() && is_string($value) && $value !== '') {
                $cached = $value;
                if ($shouldClose) closeDBConnection($db);
                return $cached;
            }
            $stmt->close();
        }
        if ($shouldClose) closeDBConnection($db);
    }

    $cached = '';
    return $cached;
}

/**
 * Get the hCaptcha secret key from settings.
 * @return string
 */
function getHcaptchaSecret() {
    static $cached = null;
    if (is_string($cached)) return $cached;

    $envKey = getenv('HCAPTCHA_SECRET');
    if (is_string($envKey) && $envKey !== '') {
        $cached = $envKey;
        return $cached;
    }

    [$db, $shouldClose] = resolvePresenceConnection(null);
    if ($db) {
        $stmt = $db->prepare("SELECT setting_value FROM settings WHERE setting_key = 'hcaptcha_secret' LIMIT 1");
        if ($stmt) {
            $stmt->execute();
            $stmt->bind_result($value);
            if ($stmt->fetch() && is_string($value) && $value !== '') {
                $cached = $value;
                if ($shouldClose) closeDBConnection($db);
                return $cached;
            }
            $stmt->close();
        }
        if ($shouldClose) closeDBConnection($db);
    }

    $cached = '';
    return $cached;
}

/**
 * Verify a raw hCaptcha token against hCaptcha's siteverify API.
 * Returns null on success, or an error message string on failure.
 * Does NOT require pending_login — safe to call outside the login flow.
 */
function verifyHcaptchaTokenRaw(string $token): ?string {
    $siteKey = getHcaptchaSiteKey();
    $secret  = getHcaptchaSecret();

    if ($siteKey === '' || $secret === '') {
        return 'CAPTCHA service is not configured. Contact an administrator.';
    }
    if ($token === '') {
        return 'CAPTCHA token is missing.';
    }

    // hCaptcha test site key — the siteverify API requires the dummy passcode
    // "pass" which real browsers never produce.  Accept any non-empty token
    // locally so the test key works end-to-end without that restriction.
    if ($siteKey === '0e6421f6-28ce-4c68-87ae-c1fefa10eaea') {
        return null;
    }

    $ch = curl_init('https://api.hcaptcha.com/siteverify');
    if ($ch === false) {
        return 'CAPTCHA verification service unavailable.';
    }

    curl_setopt_array($ch, [
        CURLOPT_POST          => true,
        CURLOPT_POSTFIELDS    => http_build_query([
            'secret'   => $secret,
            'response' => $token,
            'sitekey'  => $siteKey,
            'remoteip' => $_SERVER['REMOTE_ADDR'] ?? '',
        ]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 10,
        CURLOPT_CONNECTTIMEOUT => 5,
    ]);

    $response  = curl_exec($ch);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false || $curlError !== '') {
        return 'CAPTCHA verification service unreachable.';
    }

    $result = json_decode($response, true);
    if (!is_array($result) || empty($result['success'])) {
        $errorCodes = isset($result['error-codes']) ? implode(', ', $result['error-codes']) : '';
        return 'CAPTCHA verification failed.' . ($errorCodes ? " ($errorCodes)" : '');
    }

    return null; // success
}

/**
 * Roles included in inactivity timeout policy.
 * @param string $role
 * @return bool
 */
function shouldApplyManagedRoleSessionTimeout($role) {
    $normalized = strtolower(trim((string)$role));
    // Phase 1.5: admin was previously excluded, so the highest-privilege role
    // was the only one whose session never idled out.
    return in_array($normalized, ['admin', 'manager', 'staff'], true);
}

/**
 * Track latest authenticated activity in session.
 * @return void
 */
function markSessionActivityNow() {
    $now = time();
    if (intval($_SESSION['session_started_at'] ?? 0) <= 0) {
        $_SESSION['session_started_at'] = $now;
    }
    $_SESSION['last_activity_at'] = $now;
}

/**
 * Release the PHP session lock early while keeping session data readable.
 *
 * PHP's default session handler serializes same-session requests: every page
 * load fires several parallel API calls and each one queues on the session
 * lock for the full duration of the previous request. Touching the
 * idle-timeout heartbeat first preserves timeout semantics, then dropping
 * the lock lets the remaining (read-only) work run concurrently.
 * $_SESSION stays readable in-memory afterwards — only later writes are
 * lost (identity memoization re-resolves from DB, which is harmless).
 * Flows that MUST keep the lock (login, password reset, captcha, lockouts)
 * opt out via $GLOBALS['LLB_KEEP_SESSION_LOCK'].
 * Idempotent: extra calls are no-ops once the session is closed.
 * @return void
 */
function releaseSessionLock() {
    if (session_status() !== PHP_SESSION_ACTIVE) return;
    if (function_exists('markSessionActivityNow')) {
        markSessionActivityNow();
    }
    @session_write_close();
}

/**
 * Clear current auth session state and presence row.
 * @param int|null $userId
 * @param mysqli|null $conn
 * @return void
 */
function clearManagedRoleSessionState($userId = null, $conn = null) {
    $uid = intval($userId ?? ($_SESSION['user_id'] ?? 0));
    if ($uid > 0) {
        clearSessionPresenceByUser($uid, $conn);
    }

    unset(
        $_SESSION['user_id'],
        $_SESSION['username'],
        $_SESSION['role'],
        $_SESSION['employee_id'],
        $_SESSION['branch_id'],
        $_SESSION['must_reset_password'],
        $_SESSION['session_started_at'],
        $_SESSION['last_activity_at']
    );

    if (session_status() === PHP_SESSION_ACTIVE) {
        session_unset();
        session_destroy();
    }
}

/**
 * Resolve the idle-timeout budget (in minutes) for a role.
 *
 * Single source of truth so api/auth.php (which reports the budget to the
 * frontend) and enforceManagedRoleSessionTimeout()(which enforces it) can
 * never drift apart.
 *
 * @param string $role
 * @param array<string, mixed>|null $cfg Pre-loaded config, or null to load it.
 * @param mysqli|null $conn
 * @return int
 */
function getSessionTimeoutMinutesForRole($role, $cfg = null, $conn = null) {
    $normalized = strtolower(trim((string)$role));
    if (!is_array($cfg)) {
        $cfg = getManagedRoleSessionTimeoutConfig($conn);
    }

    if ($normalized === 'admin')   return max(1, intval($cfg['admin_minutes'] ?? 60));
    if ($normalized === 'manager') return max(1, intval($cfg['manager_minutes'] ?? 30));
    if ($normalized === 'staff')   return max(1, intval($cfg['staff_minutes'] ?? 30));

    return 0;
}

/**
 * Enforce inactivity timeout for admin/manager/staff sessions.
 * @param mysqli|null $conn
 * @param bool $touchActivity
 * @return void
 */
function enforceManagedRoleSessionTimeout($conn = null, $touchActivity = true) {
    $userId = intval($_SESSION['user_id'] ?? 0);
    if ($userId <= 0) return;

    $role = strtolower(trim((string)($_SESSION['role'] ?? '')));
    if (!shouldApplyManagedRoleSessionTimeout($role)) return;

    $cfg = getManagedRoleSessionTimeoutConfig($conn);
    if (empty($cfg['enabled'])) {
        if ($touchActivity) markSessionActivityNow();
        return;
    }

    // Per-role idle limit. Admin gets its own (more generous) budget; see
    // getDefaultManagedRoleSessionTimeoutConfig().
    $limitMinutes = getSessionTimeoutMinutesForRole($role, $cfg);
    $limitSeconds = max(60, $limitMinutes * 60);
    $now = time();

    $lastActivity = intval($_SESSION['last_activity_at'] ?? 0);
    if ($lastActivity <= 0) {
        $sessionStarted = intval($_SESSION['session_started_at'] ?? 0);
        if ($sessionStarted <= 0) {
            $sessionStarted = $now;
            $_SESSION['session_started_at'] = $sessionStarted;
        }
        $lastActivity = $sessionStarted;
        $_SESSION['last_activity_at'] = $lastActivity;
    }

    if (($now - $lastActivity) > $limitSeconds) {
        clearManagedRoleSessionState($userId, $conn);
        sendError('Session expired due to inactivity. Please log in again.', 401);
    }

    if ($touchActivity) {
        markSessionActivityNow();
    }
}

/**
 * Require authentication
 * Sends error response if not authenticated
 */
function requireAuth() {
    $user_id = checkAuthentication();
    
    if (!$user_id) {
        sendError('Authentication required', 401);
    }

    enforceManagedRoleSessionTimeout(null, false);

    // Keep online presence fresh for authenticated activity.
    touchCurrentSessionPresence();
    markSessionActivityNow();

    // Drop the session lock so parallel same-session requests (every page
    // load fires several) run concurrently instead of queueing on the lock.
    // Stateful flows opt out via $GLOBALS['LLB_KEEP_SESSION_LOCK'].
    if (empty($GLOBALS['LLB_KEEP_SESSION_LOCK'])) {
        releaseSessionLock();
    }

    return $user_id;
}

/**
 * Paginate results
 * @param int $total_records Total number of records
 * @param int $page Current page number
 * @param int $per_page Records per page
 * @return array Pagination information
 */
function getPaginationInfo($total_records, $page = 1, $per_page = 10) {
    $page = max(1, intval($page));
    $per_page = max(1, min(100, intval($per_page)));
    
    $total_pages = ceil($total_records / $per_page);
    $offset = ($page - 1) * $per_page;
    
    return [
        'current_page' => $page,
        'per_page' => $per_page,
        'total_records' => $total_records,
        'total_pages' => $total_pages,
        'offset' => $offset
    ];
}

/**
 * Build WHERE clause from filters
 * @param array $filters Filter conditions
 * @param array $allowed_fields Allowed field names
 * @return array Array with 'clause' and 'params' keys
 */
function buildWhereClause($filters, $allowed_fields) {
    $conditions = [];
    $params = [];
    $types = '';
    
    foreach ($filters as $field => $value) {
        if (in_array($field, $allowed_fields) && $value !== null && $value !== '') {
            $conditions[] = "$field = ?";
            $params[] = $value;
            
            // Determine parameter type
            if (is_int($value)) {
                $types .= 'i';
            } elseif (is_float($value)) {
                $types .= 'd';
            } else {
                $types .= 's';
            }
        }
    }
    
    $clause = !empty($conditions) ? 'WHERE ' . implode(' AND ', $conditions) : '';
    
    return [
        'clause' => $clause,
        'params' => $params,
        'types' => $types
    ];
}

/**
 * Format currency (PHP)
 * @param float $amount Amount to format
 * @return string Formatted currency string
 */
function formatCurrency($amount) {
    return '₱' . number_format($amount, 2);
}

/**
 * Calculate net pay for payroll
 * @param float $gross_pay Gross pay amount
 * @param float $total_deductions Total deductions
 * @return float Net pay amount
 */
function calculateNetPay($gross_pay, $total_deductions) {
    return max(0, $gross_pay - $total_deductions);
}

/**
 * Resolve the manual/base cash advance component stored on a payroll row.
 * @param array|null $payrollRow
 * @return float
 */
function getPayrollCashAdvanceManualBase($payrollRow) {
    if (!is_array($payrollRow)) return 0;
    if (array_key_exists('cash_advance_manual_deduction', $payrollRow)) {
        return floatval($payrollRow['cash_advance_manual_deduction'] ?? 0);
    }
    return floatval($payrollRow['cash_advance_deduction'] ?? 0);
}

/**
 * Recalculate payroll gross pay from its component fields.
 * @param array|null $payrollRow
 * @return float
 */
function calculatePayrollGrossFromRow($payrollRow) {
    if (!is_array($payrollRow)) return 0;

    return round(
        floatval($payrollRow['basic_salary'] ?? 0)
        + floatval($payrollRow['overtime_pay'] ?? 0)
        + floatval($payrollRow['clothing_allowance'] ?? 0)
        + floatval($payrollRow['travel_allowance'] ?? 0)
        + floatval($payrollRow['salary_adjustment'] ?? 0)
        - floatval($payrollRow['late_deduction'] ?? 0)
        - floatval($payrollRow['absence_deduction'] ?? 0),
        2
    );
}

/**
 * Recalculate total payroll deductions from its component fields.
 * @param array|null $payrollRow
 * @return float
 */
function calculatePayrollTotalDeductionsFromRow($payrollRow) {
    if (!is_array($payrollRow)) return 0;

    return round(
        floatval($payrollRow['tax'] ?? 0)
        + floatval($payrollRow['sss_contribution'] ?? 0)
        + floatval($payrollRow['pagibig_contribution'] ?? 0)
        + floatval($payrollRow['philhealth_contribution'] ?? 0)
        + floatval($payrollRow['cash_advance_deduction'] ?? 0)
        + floatval($payrollRow['laptop_loan_deduction'] ?? 0)
        + floatval($payrollRow['other_deductions'] ?? 0),
        2
    );
}

/**
 * Recalculate payroll net pay from its component fields.
 * @param array|null $payrollRow
 * @return float
 */
function calculatePayrollNetFromRow($payrollRow) {
    if (!is_array($payrollRow)) return 0;
    $grossPay = calculatePayrollGrossFromRow($payrollRow);
    $totalDeductions = calculatePayrollTotalDeductionsFromRow($payrollRow);
    return round(max(0, $grossPay - $totalDeductions + floatval($payrollRow['bonus'] ?? 0)), 2);
}

/**
 * Attach approved undeducted cash advances to a payroll and refresh totals.
 * The payroll keeps its manual/base cash advance component and adds approved requests on top.
 * @param mysqli $conn
 * @param int $payrollId
 * @return array|null
 */
function syncPayrollCashAdvanceRequests($conn, $payrollId) {
    if (!$conn || !(isDbConnection($conn))) return null;

    $payrollId = intval($payrollId);
    if ($payrollId <= 0) return null;

    $payrollStmt = $conn->prepare(
        "SELECT id, employee_id, pay_period_end,
                basic_salary, overtime_pay, bonus,
                clothing_allowance, travel_allowance, salary_adjustment,
                late_deduction, absence_deduction,
                tax, sss_contribution, pagibig_contribution, philhealth_contribution,
                cash_advance_deduction, cash_advance_manual_deduction,
                laptop_loan_deduction, other_deductions
         FROM payroll
         WHERE id = ?
         LIMIT 1"
    );
    if (!$payrollStmt) return null;
    $payrollStmt->bind_param('i', $payrollId);
    $payrollStmt->execute();
    $payroll = $payrollStmt->get_result()->fetch_assoc();
    $payrollStmt->close();

    if (!$payroll) return null;

    $employeeId = intval($payroll['employee_id'] ?? 0);
    $payPeriodEnd = trim((string)($payroll['pay_period_end'] ?? ''));
    if ($employeeId <= 0 || $payPeriodEnd === '') return null;

    $releaseStmt = $conn->prepare(
        "UPDATE cash_advance_request
         SET deducted_payroll_id = NULL,
             deducted_at = NULL
         WHERE deducted_payroll_id = ?
           AND (employee_id <> ? OR status <> 'approved' OR request_date > ?)"
    );
    if ($releaseStmt) {
        $releaseStmt->bind_param('iis', $payrollId, $employeeId, $payPeriodEnd);
        $releaseStmt->execute();
        $releaseStmt->close();
    }

    $assignStmt = $conn->prepare(
        "UPDATE cash_advance_request
         SET deducted_payroll_id = ?,
             deducted_at = NOW()
         WHERE employee_id = ?
           AND status = 'approved'
           AND deducted_payroll_id IS NULL
           AND request_date <= ?"
    );
    if ($assignStmt) {
        $assignStmt->bind_param('iis', $payrollId, $employeeId, $payPeriodEnd);
        $assignStmt->execute();
        $assignStmt->close();
    }

    $sumStmt = $conn->prepare(
        "SELECT COALESCE(SUM(amount), 0) AS total_amount
         FROM cash_advance_request
         WHERE deducted_payroll_id = ?
           AND status = 'approved'"
    );
    if (!$sumStmt) return null;
    $sumStmt->bind_param('i', $payrollId);
    $sumStmt->execute();
    $sumRow = $sumStmt->get_result()->fetch_assoc();
    $sumStmt->close();

    $approvedRequestTotal = round(floatval($sumRow['total_amount'] ?? 0), 2);
    $manualBase = round(getPayrollCashAdvanceManualBase($payroll), 2);
    $payroll['cash_advance_manual_deduction'] = $manualBase;
    $payroll['cash_advance_deduction'] = round($manualBase + $approvedRequestTotal, 2);

    $grossPay = calculatePayrollGrossFromRow($payroll);
    $totalDeductions = calculatePayrollTotalDeductionsFromRow($payroll);
    $netPay = calculatePayrollNetFromRow($payroll);

    $updateStmt = $conn->prepare(
        "UPDATE payroll
         SET cash_advance_deduction = ?,
             gross_pay = ?,
             total_deductions = ?,
             net_pay = ?
         WHERE id = ?"
    );
    if (!$updateStmt) return null;
    $updateStmt->bind_param('ddddi', $payroll['cash_advance_deduction'], $grossPay, $totalDeductions, $netPay, $payrollId);
    $updateStmt->execute();
    $updateStmt->close();

    return [
        'payroll_id' => $payrollId,
        'cash_advance_manual_deduction' => $manualBase,
        'cash_advance_deduction' => $payroll['cash_advance_deduction'],
        'gross_pay' => $grossPay,
        'total_deductions' => $totalDeductions,
        'net_pay' => $netPay,
    ];
}

/**
 * If a matching open payroll exists, attach approved cash advances to it immediately.
 * Open payrolls are draft, pending, or approved records that are not yet paid out.
 * @param mysqli $conn
 * @param int $employeeId
 * @param string $requestDate
 * @return array|null
 */
function syncNextDraftPayrollCashAdvanceRequests($conn, $employeeId, $requestDate) {
    if (!$conn || !(isDbConnection($conn))) return null;

    $employeeId = intval($employeeId);
    $requestDate = trim((string)$requestDate);
    if ($employeeId <= 0 || $requestDate === '') return null;

    $payrollStmt = $conn->prepare(
        "SELECT id
         FROM payroll
         WHERE employee_id = ?
           AND status IN ('draft', 'pending', 'approved')
           AND pay_period_end >= ?
         ORDER BY pay_period_end ASC, id ASC
         LIMIT 1"
    );
    if (!$payrollStmt) return null;
    $payrollStmt->bind_param('is', $employeeId, $requestDate);
    $payrollStmt->execute();
    $row = $payrollStmt->get_result()->fetch_assoc();
    $payrollStmt->close();

    $payrollId = intval($row['id'] ?? 0);
    if ($payrollId <= 0) return null;

    return syncPayrollCashAdvanceRequests($conn, $payrollId);
}

/**
 * Normalize a deduction type name for matching.
 * @param string $name
 * @return string
 */
function normalizeDeductionTypeKey($name) {
    $key = strtolower(trim((string)$name));
    $key = preg_replace('/[^a-z0-9]+/', ' ', $key);
    $key = preg_replace('/\s+/', ' ', (string)$key);
    return trim((string)$key);
}

/**
 * Check if a government ID number is present.
 * @param mixed $value
 * @return bool
 */
function hasGovernmentNumber($value) {
    return trim((string)$value) !== '';
}

/**
 * Build eligibility map for gov deductions based on employee numbers.
 * @param array|null $employeeRow
 * @return array<string, bool>
 */
function buildGovEligibilityFromEmployee($employeeRow) {
    if (!is_array($employeeRow)) {
        return [
            'tax' => false,
            'sss_contribution' => false,
            'pagibig_contribution' => false,
            'philhealth_contribution' => false,
        ];
    }

    return [
        'tax' => hasGovernmentNumber($employeeRow['tin_number'] ?? null),
        'sss_contribution' => hasGovernmentNumber($employeeRow['sss_number'] ?? null),
        'pagibig_contribution' => hasGovernmentNumber($employeeRow['pagibig_number'] ?? null),
        'philhealth_contribution' => hasGovernmentNumber($employeeRow['philhealth_number'] ?? null),
    ];
}

/**
 * Load active deduction types keyed by normalized names.
 * @param mysqli $conn
 * @return array<string, array>
 */
function getActiveDeductionTypes($conn) {
    $types = [];
    if (!$conn || !(isDbConnection($conn))) return $types;

    $sql = "SELECT type_name, default_amount, is_percentage, is_active, threshold_amount, threshold_mode, threshold_rules, base_floor, base_cap
            FROM deduction_type
            WHERE is_active = 1";
    $result = $conn->query($sql);
    if (!$result) return $types;

    while ($row = $result->fetch_assoc()) {
        $key = normalizeDeductionTypeKey($row['type_name'] ?? '');
        if ($key === '') continue;
        $types[$key] = $row;
        $compact = str_replace(' ', '', $key);
        if ($compact !== '') {
            $types[$compact] = $row;
        }
    }

    return $types;
}

/**
 * Apply base floor/cap bounds to a deduction computation base.
 * @param float $base
 * @param array|null $typeRow
 * @return float
 */
function applyDeductionBaseBounds($base, $typeRow) {
    $base = floatval($base);
    if (!$typeRow) return $base;
    $floor = floatval($typeRow['base_floor'] ?? 0);
    $cap = floatval($typeRow['base_cap'] ?? 0);
    if ($floor > 0 && $base < $floor) {
        $base = $floor;
    }
    if ($cap > 0 && $base > $cap) {
        $base = $cap;
    }
    return $base;
}

/**
 * Resolve a deduction type row by name candidates.
 * @param array<string, array> $types
 * @param array $names
 * @return array|null
 */
function findDeductionType($types, $names) {
    foreach ($names as $name) {
        $key = normalizeDeductionTypeKey((string)$name);
        if ($key !== '' && isset($types[$key])) return $types[$key];
        $compact = str_replace(' ', '', $key);
        if ($compact !== '' && isset($types[$compact])) return $types[$compact];
    }
    return null;
}

/**
 * Compute a deduction amount from a type row.
 * @param float $base
 * @param array|null $typeRow
 * @return float|null
 */
function computeThresholdRateDeduction($base, $rules) {
    $base = floatval($base);
    if ($base <= 0) return 0;

    $above = [];
    $below = [];
    foreach ($rules as $rule) {
        if (!is_array($rule)) continue;
        $mode = strtolower(trim((string)($rule['mode'] ?? 'none')));
        $amountRule = floatval($rule['amount'] ?? 0);
        if ($amountRule <= 0) continue;
        $rate = floatval($rule['rate'] ?? 0);
        if ($mode === 'above') {
            $above[] = ['amount' => $amountRule, 'rate' => $rate];
        } elseif ($mode === 'below') {
            $below[] = ['amount' => $amountRule, 'rate' => $rate];
        }
    }

    if (empty($above) && empty($below)) return 0;

    usort($above, function ($a, $b) {
        return $a['amount'] <=> $b['amount'];
    });
    usort($below, function ($a, $b) {
        return $a['amount'] <=> $b['amount'];
    });

    $bands = [];
    $firstAboveAmount = !empty($above) ? $above[0]['amount'] : 0;

    if (!empty($below)) {
        $belowRule = $below[0];
        $end = $firstAboveAmount > 0 ? min($belowRule['amount'], $firstAboveAmount) : $belowRule['amount'];
        if ($end > 0) {
            $bands[] = [
                'start' => 0,
                'end' => $end,
                'rate' => max(0, $belowRule['rate']),
            ];
        }
    } elseif ($firstAboveAmount > 0) {
        $bands[] = [
            'start' => 0,
            'end' => $firstAboveAmount,
            'rate' => 0,
        ];
    }

    $count = count($above);
    for ($i = 0; $i < $count; $i += 1) {
        $current = $above[$i];
        $next = $above[$i + 1] ?? null;
        $start = $current['amount'];
        $end = $next ? $next['amount'] : INF;
        if ($end > $start) {
            $bands[] = [
                'start' => $start,
                'end' => $end,
                'rate' => max(0, $current['rate']),
            ];
        }
    }

    $total = 0;
    foreach ($bands as $band) {
        if ($base <= $band['start']) break;
        $taxable = min($base, $band['end']) - $band['start'];
        if ($taxable > 0) {
            $total += $taxable * ($band['rate'] / 100);
        }
    }

    return round($total, 2);
}

function computeDeductionAmount($base, $typeRow) {
    if (!$typeRow) return null;
    $originalBase = floatval($base);
    $base = applyDeductionBaseBounds($originalBase, $typeRow);
    $amount = floatval($typeRow['default_amount'] ?? 0);
    $isPercentage = !empty($typeRow['is_percentage']);
    $rules = [];
    $hasRate = false;
    if (!empty($typeRow['threshold_rules'])) {
        $rawRules = $typeRow['threshold_rules'];
        if (is_string($rawRules)) {
            $decoded = json_decode($rawRules, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $rawRules = $decoded;
            }
        }

        if (is_array($rawRules)) {
            foreach ($rawRules as $rule) {
                if (!is_array($rule)) continue;
                $mode = strtolower(trim((string)($rule['mode'] ?? ($rule['threshold_mode'] ?? 'none'))));
                $amountRule = floatval($rule['amount'] ?? ($rule['threshold_amount'] ?? 0));
                $rateProvided = array_key_exists('rate', $rule) || array_key_exists('threshold_rate', $rule);
                $rateValue = $rateProvided ? floatval($rule['rate'] ?? ($rule['threshold_rate'] ?? 0)) : 0;
                if ($mode === 'above' || $mode === 'below') {
                    if ($amountRule > 0) {
                        $entry = ['mode' => $mode, 'amount' => $amountRule];
                        if ($rateProvided) {
                            $entry['rate'] = $rateValue;
                            $hasRate = true;
                        }
                        $rules[] = $entry;
                    }
                }
            }
        }
    }

    if (empty($rules)) {
        $thresholdAmount = floatval($typeRow['threshold_amount'] ?? 0);
        $thresholdMode = strtolower(trim((string)($typeRow['threshold_mode'] ?? 'none')));
        if ($thresholdAmount > 0 && in_array($thresholdMode, ['above', 'below'], true)) {
            $rules[] = ['mode' => $thresholdMode, 'amount' => $thresholdAmount];
        }
    }

    if ($hasRate) {
        return computeThresholdRateDeduction($base, $rules);
    }

    foreach ($rules as $rule) {
        if ($rule['mode'] === 'above' && $originalBase <= $rule['amount']) {
            return 0;
        }
        if ($rule['mode'] === 'below' && $originalBase > $rule['amount']) {
            return 0;
        }
    }

    $computed = $isPercentage ? ($base * ($amount / 100)) : $amount;
    return round($computed, 2);
}

/**
 * Employee SSS share from the regular 2025 SSS contribution schedule.
 * The schedule uses a Monthly Salary Credit (MSC), rather than an exact
 * percentage of every peso of salary. This schedule remains the configured
 * payroll basis until SSS publishes a replacement schedule.
 */
function computeSssEmployeeContribution($monthlySalary, $typeRow) {
    $monthlySalary = max(0, floatval($monthlySalary));
    $employeeRate = floatval($typeRow['default_amount'] ?? 5);

    if ($monthlySalary < 5250) {
        $msc = 5000;
    } elseif ($monthlySalary >= 34750) {
        $msc = 35000;
    } else {
        // P5,250–P5,749.99 maps to P5,500 MSC; each next bracket is P500.
        $msc = 5500 + (floor(($monthlySalary - 5250) / 500) * 500);
    }

    return round($msc * ($employeeRate / 100), 2);
}

/**
 * Pag-IBIG employee share: 1% at P1,500 and below, otherwise 2%, with the
 * statutory P5,000 compensation ceiling (maximum employee share: P100).
 */
function computePagibigEmployeeContribution($monthlySalary, $typeRow) {
    $monthlySalary = max(0, floatval($monthlySalary));
    $base = min($monthlySalary, 5000);
    $rate = $monthlySalary <= 1500 ? 1 : floatval($typeRow['default_amount'] ?? 2);
    return round($base * ($rate / 100), 2);
}

/**
 * Compute government-mandated deductions based on deduction type settings.
 * @param mysqli $conn
 * @param float $baseAmount
 * @return array<string, float>
 */
function computeGovernmentDeductionsFromTypes($conn, $baseAmount, $eligibility = null) {
    $types = getActiveDeductionTypes($conn);
    if (empty($types)) return [];

    $mapping = [
        'sss_contribution' => ['sss'],
        'philhealth_contribution' => ['philhealth', 'phil health'],
        'pagibig_contribution' => ['pag-ibig', 'pag ibig', 'pagibig'],
    ];

    $out = [];
    foreach ($mapping as $field => $names) {
        if (is_array($eligibility) && array_key_exists($field, $eligibility) && !$eligibility[$field]) {
            continue;
        }
        $row = findDeductionType($types, $names);
        if (!$row) continue;
        if ($field === 'sss_contribution') {
            $amount = computeSssEmployeeContribution($baseAmount, $row);
        } elseif ($field === 'pagibig_contribution') {
            $amount = computePagibigEmployeeContribution($baseAmount, $row);
        } else {
            $amount = computeDeductionAmount($baseAmount, $row);
        }
        if ($amount !== null) {
            $out[$field] = $amount;
        }
    }

    // BIR withholding uses taxable compensation after the employee shares of
    // the mandatory contributions, not the gross monthly compensation alone.
    $taxEligible = !is_array($eligibility) || !array_key_exists('tax', $eligibility) || $eligibility['tax'];
    $taxType = findDeductionType($types, ['withholding tax', 'tax']);
    if ($taxEligible && $taxType) {
        $mandatoryEmployeeShares = floatval($out['sss_contribution'] ?? 0)
            + floatval($out['philhealth_contribution'] ?? 0)
            + floatval($out['pagibig_contribution'] ?? 0);
        $taxableCompensation = max(0, floatval($baseAmount) - $mandatoryEmployeeShares);
        $out['tax'] = computeDeductionAmount($taxableCompensation, $taxType);
    }

    return $out;
}

/**
 * Role feature access catalog for manager/staff capabilities.
 * Admin always keeps full access and is not configurable here.
 *
 * @return array<string, array{label:string,roles:array<string,bool>}>
 */
function getRoleFeatureAccessCatalog() {
    return [
        'calendar' => [
            'label' => 'Calendar',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'analytics' => [
            'label' => 'Analytics',
            'roles' => ['manager' => false, 'staff' => true],
        ],
        'my_tasks' => [
            'label' => 'My Tasks',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'tasks_board' => [
            'label' => 'Tasks Board',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'leave_requests' => [
            'label' => 'Leave Requests',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'my_payslips' => [
            'label' => 'My Payslips',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'clients' => [
            'label' => 'Clients',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'contract_management' => [
            'label' => 'Contract Management',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'services' => [
            'label' => 'Services',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'employees' => [
            'label' => 'Employees',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'shift_schedules' => [
            'label' => 'Shift Schedules',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'projects' => [
            'label' => 'Projects',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'payroll' => [
            'label' => 'Payroll',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'payroll_precheck' => [
            'label' => 'Payroll Pre-check',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'overtime_requests' => [
            'label' => 'Overtime Requests',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'cash_advance' => [
            'label' => 'Cash Advance',
            'roles' => ['manager' => true, 'staff' => true],
        ],
        'approval_inbox' => [
            'label' => 'Approval Inbox',
            'roles' => ['manager' => true, 'staff' => false],
        ],
        'edit_requests' => [
            'label' => 'Edit Request',
            'roles' => ['manager' => false, 'staff' => false],
        ],
        'documents' => [
            'label' => 'Documents',
            'roles' => ['manager' => true, 'staff' => true],
        ],
    ];
}

/**
 * Normalize bool-like input from settings/JSON.
 * @param mixed $value
 * @param bool $default
 * @return bool
 */
function normalizeFeatureAccessBool($value, $default = false) {
    if (is_bool($value)) return $value;
    if (is_int($value) || is_float($value)) return ((int)$value) !== 0;
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === '') return $default;
        if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) return true;
        if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) return false;
    }
    return $default;
}

/**
 * @param string $role
 * @return string
 */
function normalizeFeatureAccessRole($role) {
    $normalized = strtolower(trim((string)$role));
    if (in_array($normalized, ['admin', 'manager', 'staff'], true)) {
        return $normalized;
    }
    return '';
}

/**
 * @param string $role
 * @return string
 */
function getFeatureAccessRoleRowName($role) {
    $normalized = normalizeFeatureAccessRole($role);
    if ($normalized === 'admin') return 'Admin';
    if ($normalized === 'manager') return 'Manager';
    if ($normalized === 'staff') return 'Staff';
    return '';
}

/**
 * Ensure role records exist so feature-access preferences have a stable home.
 */
function ensureRoleFeatureAccessStorage($conn) {
    if (!$conn) return;
    if (isPostgresConnection($conn)) return;

    $conn->query(
        "CREATE TABLE IF NOT EXISTS roles (
            role_id INT AUTO_INCREMENT PRIMARY KEY,
            role_name VARCHAR(100) NOT NULL UNIQUE,
            description TEXT NULL,
            permissions JSON NULL,
            status VARCHAR(20) NOT NULL DEFAULT 'active'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );

    $dbName = DB_NAME;
    $checkStmt = $conn->prepare(
        "SELECT 1
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'roles' AND COLUMN_NAME = 'status'
         LIMIT 1"
    );
    if ($checkStmt) {
        $checkStmt->bind_param('s', $dbName);
        $checkStmt->execute();
        $hasStatus = $checkStmt->get_result()->num_rows > 0;
        $checkStmt->close();
        if (!$hasStatus) {
            $conn->query("ALTER TABLE roles ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active'");
            $conn->query("UPDATE roles SET status = 'active' WHERE status IS NULL OR status = ''");
        }
    }

    $defaults = [
        ['Admin', 'System administrator'],
        ['Manager', 'Manager role'],
        ['Staff', 'Staff member with limited access'],
    ];

    foreach ($defaults as $row) {
        [$roleName, $description] = $row;
        $stmt = $conn->prepare(
            "INSERT INTO roles (role_name, description, permissions, status)
             VALUES (?, ?, '{}', 'active')
             ON DUPLICATE KEY UPDATE
               description = COALESCE(NULLIF(description, ''), VALUES(description)),
               status = 'active'"
        );
        if ($stmt) {
            $stmt->bind_param('ss', $roleName, $description);
            $stmt->execute();
            $stmt->close();
        }
    }
}

/**
 * @return array<string, bool>
 */
function getDefaultRoleFeatureAccessMap($role) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    $catalog = getRoleFeatureAccessCatalog();
    $access = [];

    foreach ($catalog as $featureKey => $definition) {
        $access[$featureKey] = $normalizedRole === 'admin'
            ? true
            : !empty($definition['roles'][$normalizedRole]);
    }

    return $access;
}

/**
 * @return string[]
 */
function getSupportedRoleFeatureKeys($role) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    if (!in_array($normalizedRole, ['manager', 'staff'], true)) return [];

    $catalog = getRoleFeatureAccessCatalog();
    $supported = [];
    foreach ($catalog as $featureKey => $definition) {
        if (!empty($definition['roles'][$normalizedRole])) {
            $supported[] = $featureKey;
        }
    }
    return $supported;
}

/**
 * @return array<string, mixed>
 */
function getStoredRolePermissions($conn, $role) {
    ensureRoleFeatureAccessStorage($conn);

    $rowName = getFeatureAccessRoleRowName($role);
    if ($rowName === '') return [];

    $stmt = $conn->prepare(
        "SELECT permissions
         FROM roles
         WHERE LOWER(TRIM(role_name)) = LOWER(TRIM(?))
         LIMIT 1"
    );
    if (!$stmt) return [];

    $stmt->bind_param('s', $rowName);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    $decoded = json_decode((string)($row['permissions'] ?? '{}'), true);
    return is_array($decoded) ? $decoded : [];
}

/**
 * @return array<string, bool>
 */
function getRoleFeatureAccessMap($role, $conn = null) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    $defaults = getDefaultRoleFeatureAccessMap($normalizedRole);

    if ($normalizedRole === '' || $normalizedRole === 'admin') {
        return $defaults;
    }

    $db = $conn;
    $ownsConnection = false;
    if (!$db) {
        $db = getDBConnection();
        $ownsConnection = true;
    }

    $permissions = getStoredRolePermissions($db, $normalizedRole);
    $storedAccess = [];
    if (isset($permissions['feature_access']) && is_array($permissions['feature_access'])) {
        $storedAccess = $permissions['feature_access'];
    }

    foreach ($defaults as $featureKey => $defaultEnabled) {
        if (array_key_exists($featureKey, $storedAccess)) {
            $defaults[$featureKey] = normalizeFeatureAccessBool($storedAccess[$featureKey], $defaultEnabled);
        }
    }

    if ($ownsConnection) {
        closeDBConnection($db);
    }

    return $defaults;
}

/**
 * Persist manager/staff feature access selections into roles.permissions.feature_access.
 *
 * @param array<string, mixed> $featureAccess
 * @return array<string, bool>
 */
function saveRoleFeatureAccessMap($conn, $role, $featureAccess) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    if (!in_array($normalizedRole, ['manager', 'staff'], true)) {
        sendError('Invalid role for feature access update.', 400);
    }

    ensureRoleFeatureAccessStorage($conn);

    $permissions = getStoredRolePermissions($conn, $normalizedRole);
    $storedFeatureAccess = isset($permissions['feature_access']) && is_array($permissions['feature_access'])
        ? $permissions['feature_access']
        : [];
    $supportedKeys = getSupportedRoleFeatureKeys($normalizedRole);
    $defaults = getDefaultRoleFeatureAccessMap($normalizedRole);
    $nextAccess = [];

    foreach ($supportedKeys as $featureKey) {
        $incoming = is_array($featureAccess) && array_key_exists($featureKey, $featureAccess)
            ? $featureAccess[$featureKey]
            : ($storedFeatureAccess[$featureKey] ?? $defaults[$featureKey] ?? false);
        $nextAccess[$featureKey] = normalizeFeatureAccessBool($incoming, $defaults[$featureKey] ?? false);
    }

    $permissions['feature_access'] = $nextAccess;
    $encodedPermissions = json_encode($permissions, JSON_UNESCAPED_SLASHES);
    if ($encodedPermissions === false) {
        sendError('Failed to encode role feature access settings.', 500);
    }

    $rowName = getFeatureAccessRoleRowName($normalizedRole);
    $stmt = $conn->prepare(
        "UPDATE roles
         SET permissions = ?, status = 'active'
         WHERE LOWER(TRIM(role_name)) = LOWER(TRIM(?))
         LIMIT 1"
    );
    if (!$stmt) sendError('Failed to prepare role feature access update.', 500);
    $stmt->bind_param('ss', $encodedPermissions, $rowName);
    $stmt->execute();
    $stmt->close();

    return getRoleFeatureAccessMap($normalizedRole, $conn);
}

/**
 * @param string $featureKey
 * @return bool
 */
function roleSupportsFeatureAccess($role, $featureKey) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    if ($normalizedRole === 'admin') return true;

    $catalog = getRoleFeatureAccessCatalog();
    if (!isset($catalog[$featureKey])) return false;

    return !empty($catalog[$featureKey]['roles'][$normalizedRole]);
}

/**
 * @param string $featureKey
 * @return bool
 */
function hasRoleFeatureAccess($role, $featureKey, $conn = null) {
    $normalizedRole = normalizeFeatureAccessRole($role);
    if ($normalizedRole === 'admin') return true;
    if ($normalizedRole === '' || !roleSupportsFeatureAccess($normalizedRole, $featureKey)) {
        return false;
    }

    $access = getRoleFeatureAccessMap($normalizedRole, $conn);
    return !empty($access[$featureKey]);
}

/**
 * Require current user to have a configurable feature enabled for their role.
 *
 * @param string $featureKey
 * @param array<int, string> $allowedRoles
 * @return string
 */
function requireFeatureAccess($featureKey, $allowedRoles = ['admin', 'manager', 'staff'], $conn = null) {
    requireAuth();

    $role = normalizeFeatureAccessRole($_SESSION['role'] ?? '');
    $normalizedAllowed = array_values(array_filter(array_map('normalizeFeatureAccessRole', $allowedRoles)));

    if ($role === '' || !in_array($role, $normalizedAllowed, true)) {
        sendError('Forbidden: insufficient permissions', 403);
    }

    if ($role !== 'admin' && !hasRoleFeatureAccess($role, $featureKey, $conn)) {
        sendError('Forbidden: this feature is disabled for your role', 403);
    }

    return $role;
}

/**
 * Require at least one feature from a shared capability set.
 *
 * @param array<int, string> $featureKeys
 * @param array<int, string> $allowedRoles
 * @return string
 */
function requireAnyFeatureAccess($featureKeys, $allowedRoles = ['admin', 'manager', 'staff'], $conn = null) {
    requireAuth();

    $role = normalizeFeatureAccessRole($_SESSION['role'] ?? '');
    $normalizedAllowed = array_values(array_filter(array_map('normalizeFeatureAccessRole', $allowedRoles)));

    if ($role === '' || !in_array($role, $normalizedAllowed, true)) {
        sendError('Forbidden: insufficient permissions', 403);
    }

    if ($role === 'admin') {
        return $role;
    }

    foreach ((array)$featureKeys as $featureKey) {
        if (hasRoleFeatureAccess($role, (string)$featureKey, $conn)) {
            return $role;
        }
    }

    sendError('Forbidden: this feature is disabled for your role', 403);
}

/**
 * Hash password using bcrypt
 * @param string $password Plain text password
 * @return string Hashed password
 */
function hashPassword($password) {
    return password_hash($password, PASSWORD_BCRYPT);
}

/**
 * Verify password against hash
 * @param string $password Plain text password
 * @param string $hash Hashed password
 * @return bool True if password matches, false otherwise
 */
function verifyPassword($password, $hash) {
    return password_verify($password, $hash);
}

/**
 * RBAC: Require user to have one of the specified roles
 * @param array $allowed_roles Array of allowed role strings, e.g. ['admin', 'manager']
 */
function requireRole($allowed_roles) {
    requireAuth();
    $role = $_SESSION['role'] ?? '';
    if (!in_array($role, $allowed_roles)) {
        sendError('Forbidden: insufficient permissions', 403);
    }
    return $role;
}

/**
 * RBAC: Require user to have at least the specified minimum role level
 * Hierarchy: admin > manager > staff
 * @param string $min_role Minimum role required
 */
function requireMinRole($min_role) {
    requireAuth();
    $hierarchy = ['staff' => 1, 'manager' => 2, 'admin' => 3];
    $role = $_SESSION['role'] ?? '';
    $user_level = $hierarchy[$role] ?? 0;
    $required_level = $hierarchy[$min_role] ?? 99;
    if ($user_level < $required_level) {
        sendError('Forbidden: insufficient permissions', 403);
    }
    return $role;
}

/**
 * Get current user's role from session
 * @return string The role or empty string
 */
function getCurrentRole() {
    return $_SESSION['role'] ?? '';
}

/**
 * ── Central Document Management registry ────────────────────────────────
 * One row per file known to the system (direct uploads, task submissions,
 * task comment attachments, signed contracts, received documents) so the
 * Document Management library can list everything in one place.
 */

function ensureManagedDocumentsTable($conn) {
    static $ensured = false;
    if ($ensured) return;
    $ensured = true;
    if (!$conn || !(isDbConnection($conn))) return;
    if (isPostgresConnection($conn)) return;
    $conn->query(
        "CREATE TABLE IF NOT EXISTS managed_documents (
            id INT AUTO_INCREMENT PRIMARY KEY,
            title VARCHAR(255) NOT NULL,
            document_type VARCHAR(60) NOT NULL DEFAULT 'Other',
            client_id INT NULL,
            task_id INT NULL,
            project_id INT NULL,
            source ENUM('upload','task_submission','task_attachment','contract_file','received') NOT NULL DEFAULT 'upload',
            source_table VARCHAR(60) NULL,
            source_id INT NULL,
            file_path VARCHAR(500) NULL,
            file_name VARCHAR(255) NULL,
            mime_type VARCHAR(100) NULL,
            file_size INT NULL,
            status ENUM('active','archived') NOT NULL DEFAULT 'active',
            notes TEXT NULL,
            uploaded_by INT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_managed_doc_source (source, source_id, file_path(191)),
            INDEX idx_managed_doc_client (client_id),
            INDEX idx_managed_doc_task (task_id),
            INDEX idx_managed_doc_project (project_id),
            INDEX idx_managed_doc_status (status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
}

function validManagedDocumentType($value) {
    $allowed = ['Contract', 'Report', 'Receipt', 'ID', 'Certificate', 'Letter', 'Form', 'Other'];
    $text = trim((string)$value);
    foreach ($allowed as $option) {
        if (strcasecmp($text, $option) === 0) return $option;
    }
    return 'Other';
}

/**
 * Register (or refresh) a file in the central registry. Idempotent per
 * (source, source_id, file_path). Best-effort: never throws, returns id or 0.
 * Missing client/task/project links are derived from the task when possible.
 */
function registerManagedDocument($conn, $args) {
    if (!$conn || !(isDbConnection($conn)) || !is_array($args)) return 0;
    ensureManagedDocumentsTable($conn);

    $source = strtolower(trim((string)($args['source'] ?? 'upload')));
    if (!in_array($source, ['upload', 'task_submission', 'task_attachment', 'contract_file', 'received'], true)) {
        $source = 'upload';
    }
    $sourceId = isset($args['source_id']) && is_numeric($args['source_id']) ? intval($args['source_id']) : null;
    $filePath = trim((string)($args['file_path'] ?? ''));
    if ($filePath === '') return 0;

    $taskId = isset($args['task_id']) && is_numeric($args['task_id']) && intval($args['task_id']) > 0 ? intval($args['task_id']) : null;
    $projectId = isset($args['project_id']) && is_numeric($args['project_id']) && intval($args['project_id']) > 0 ? intval($args['project_id']) : null;
    $clientId = isset($args['client_id']) && is_numeric($args['client_id']) && intval($args['client_id']) > 0 ? intval($args['client_id']) : null;

    // Derive missing links: task → project → client.
    if ($taskId !== null && ($projectId === null || $clientId === null)) {
        $tStmt = $conn->prepare(
            "SELECT t.project_id, p.client_id
             FROM tasks t
             LEFT JOIN projects p ON p.id = t.project_id
             WHERE t.id = ? LIMIT 1"
        );
        if ($tStmt) {
            $tStmt->bind_param('i', $taskId);
            $tStmt->execute();
            if ($tRow = $tStmt->get_result()->fetch_assoc()) {
                if ($projectId === null && !empty($tRow['project_id'])) $projectId = intval($tRow['project_id']);
                if ($clientId === null && !empty($tRow['client_id'])) $clientId = intval($tRow['client_id']);
            }
            $tStmt->close();
        }
    }
    if ($projectId !== null && $clientId === null) {
        $pStmt = $conn->prepare("SELECT client_id FROM projects WHERE id = ? LIMIT 1");
        if ($pStmt) {
            $pStmt->bind_param('i', $projectId);
            $pStmt->execute();
            if ($pRow = $pStmt->get_result()->fetch_assoc()) {
                if (!empty($pRow['client_id'])) $clientId = intval($pRow['client_id']);
            }
            $pStmt->close();
        }
    }

    $title = trim((string)($args['title'] ?? ''));
    if ($title === '') $title = trim((string)($args['file_name'] ?? ''));
    if ($title === '') $title = 'Untitled document';
    $title = substr($title, 0, 255);
    $docType = validManagedDocumentType($args['document_type'] ?? 'Other');
    $sourceTable = substr(trim((string)($args['source_table'] ?? '')), 0, 60);
    if ($sourceTable === '') $sourceTable = null;
    $fileName = substr(trim((string)($args['file_name'] ?? '')), 0, 255);
    if ($fileName === '') $fileName = null;
    $mimeType = substr(trim((string)($args['mime_type'] ?? '')), 0, 100);
    if ($mimeType === '') $mimeType = null;
    $fileSize = isset($args['file_size']) && is_numeric($args['file_size']) ? max(0, intval($args['file_size'])) : null;
    $notes = trim((string)($args['notes'] ?? ''));
    if ($notes === '') $notes = null;
    $uploadedBy = isset($args['uploaded_by']) && is_numeric($args['uploaded_by']) && intval($args['uploaded_by']) > 0 ? intval($args['uploaded_by']) : null;

    // Idempotent: refresh the existing row for the same source file.
    $check = $conn->prepare("SELECT id FROM managed_documents WHERE source = ? AND COALESCE(source_id, 0) = ? AND file_path = ? LIMIT 1");
    if ($check) {
        $lookupSourceId = $sourceId === null ? 0 : $sourceId;
        $check->bind_param('sis', $source, $lookupSourceId, $filePath);
        $check->execute();
        $existing = $check->get_result()->fetch_assoc();
        $check->close();
        if (is_array($existing)) {
            $upId = intval($existing['id']);
            $upd = $conn->prepare("UPDATE managed_documents SET title = ?, document_type = ?, client_id = ?, task_id = ?, project_id = ?, file_name = ?, mime_type = ?, file_size = ?, notes = ?, status = 'active' WHERE id = ?");
            if ($upd) {
                // NULL-able ints are bound as 0 placeholders, then normalized back to NULL.
                // Params: title(s) docType(s) client(i) task(i) project(i) fileName(s) mime(s) fileSize(i) notes(s) id(i).
                $uClient = $clientId === null ? 0 : $clientId;
                $uTask = $taskId === null ? 0 : $taskId;
                $uProject = $projectId === null ? 0 : $projectId;
                $uSize = $fileSize === null ? 0 : $fileSize;
                $upd->bind_param(
                    'ssiiissisi',
                    $title, $docType,
                    $uClient, $uTask, $uProject,
                    $fileName, $mimeType,
                    $uSize,
                    $notes, $upId
                );
                $upd->execute();
                $upd->close();
                $conn->query("UPDATE managed_documents SET client_id = NULLIF(client_id, 0), task_id = NULLIF(task_id, 0), project_id = NULLIF(project_id, 0) WHERE id = " . $upId);
            }
            return $upId;
        }
    }

    $ins = $conn->prepare(
        "INSERT INTO managed_documents (title, document_type, client_id, task_id, project_id, source, source_table, source_id, file_path, file_name, mime_type, file_size, notes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    if (!$ins) {
        error_log('registerManagedDocument: prepare failed: ' . $conn->error);
        return 0;
    }
    // Bind NULL-able values safely: use strings for nullable ints via SQL NULLIF trick is messy with bind;
    // instead convert NULL links to 0 then normalize back to NULL after insert.
    $cId = $clientId === null ? 0 : $clientId;
    $tId = $taskId === null ? 0 : $taskId;
    $pId = $projectId === null ? 0 : $projectId;
    $sId = $sourceId === null ? 0 : $sourceId;
    $fSize = $fileSize === null ? 0 : $fileSize;
    $uBy = $uploadedBy === null ? 0 : $uploadedBy;
    // Params: title(s) docType(s) client(i) task(i) project(i) source(s) sourceTable(s) sourceId(i) filePath(s) fileName(s) mime(s) fileSize(i) notes(s) uploadedBy(i).
    $ins->bind_param('ssiiississsisi', $title, $docType, $cId, $tId, $pId, $source, $sourceTable, $sId, $filePath, $fileName, $mimeType, $fSize, $notes, $uBy);
    if (!$ins->execute()) {
        // Likely a duplicate from a concurrent insert — fetch the winner.
        if (stripos((string)$ins->error, 'Duplicate') !== false) {
            $ins->close();
            $get = $conn->prepare("SELECT id FROM managed_documents WHERE source = ? AND COALESCE(source_id, 0) = ? AND file_path = ? LIMIT 1");
            if ($get) {
                $get->bind_param('sis', $source, $sId, $filePath);
                $get->execute();
                $row = $get->get_result()->fetch_assoc();
                $get->close();
                if (is_array($row)) return intval($row['id']);
            }
            return 0;
        }
        error_log('registerManagedDocument: execute failed: ' . $ins->error);
        $ins->close();
        return 0;
    }
    $newId = intval($conn->insert_id);
    $ins->close();
    $conn->query("UPDATE managed_documents SET client_id = NULLIF(client_id, 0), task_id = NULLIF(task_id, 0), project_id = NULLIF(project_id, 0), source_id = NULLIF(source_id, 0), file_size = NULLIF(file_size, 0), uploaded_by = NULLIF(uploaded_by, 0) WHERE id = " . $newId);
    return $newId;
}

?>
