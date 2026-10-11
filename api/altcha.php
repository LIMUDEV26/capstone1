<?php
/**
 * ALTCHA Challenge API
 *
 * GET  /api/altcha.php  -> Returns challenge JSON for <altcha-widget challengeurl="...">
 * POST /api/altcha.php  -> Optional payload verification endpoint
 */

require_once 'config.php';
require_once 'utils.php';
require_once 'altcha_bootstrap.php';
// Challenge bindings write session state — keep the session lock.
$GLOBALS['LLB_KEEP_SESSION_LOCK'] = true;

setCORSHeaders();

$method = getRequestMethod();

if ($method === 'GET') {
    handleAltchaChallenge();
} elseif ($method === 'POST') {
    handleAltchaVerify();
} else {
    sendError('Method not allowed', 405);
}

function handleAltchaChallenge() {
    $maxNumber = isset($_GET['maxnumber']) ? intval($_GET['maxnumber']) : 50000;
    $ttlSeconds = isset($_GET['ttl']) ? intval($_GET['ttl']) : 120;
    $scope = $_GET['scope'] ?? 'default';

    // Guardrails to keep challenge complexity and expiration within expected ranges.
    $maxNumber = max(1000, min(1000000, $maxNumber));
    $ttlSeconds = max(30, min(600, $ttlSeconds));

    $altcha = createAltchaService();
    $expires = (new DateTimeImmutable())->add(new DateInterval('PT' . $ttlSeconds . 'S'));
    $options = new \AltchaOrg\Altcha\ChallengeOptions(
        maxNumber: $maxNumber,
        expires: $expires,
        params: getAltchaChallengeParams($scope)
    );
    $challenge = $altcha->createChallenge($options);

    // ALTCHA widget expects this exact top-level challenge shape.
    $response = [
        'algorithm' => $challenge->algorithm,
        'challenge' => $challenge->challenge,
        'maxnumber' => $challenge->maxNumber,
        'salt' => $challenge->salt,
        'signature' => $challenge->signature,
    ];

    http_response_code(200);
    echo json_encode($response, JSON_UNESCAPED_UNICODE);
    exit();
}

function handleAltchaVerify() {
    $data = getJSONInput();
    $payload = trim((string)($data['altcha'] ?? $data['payload'] ?? ''));
    $scope = normalizeAltchaScope($data['scope'] ?? 'default');

    if ($payload === '') {
        sendError('Missing ALTCHA payload', 400);
    }

    if (!isAltchaPayloadBoundToScope($payload, $scope)) {
        sendError('ALTCHA payload is not valid for this session scope', 400);
    }

    if (!verifyAltchaPayload($payload)) {
        sendError('Invalid ALTCHA payload', 400);
    }

    sendResponse(true, ['verified' => true], 'ALTCHA verified');
}
