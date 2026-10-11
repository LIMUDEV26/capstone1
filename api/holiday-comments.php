<?php
/**
 * Holiday Comments API
 * Supports discussion threads for holiday calendar entries.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureHolidayTableExists($conn);
ensureHolidayCommentsTable($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('calendar', ['admin', 'manager', 'staff'], $conn);
        handleGetComments($conn);
        break;
    case 'POST':
        requireFeatureAccess('calendar', ['admin', 'manager', 'staff'], $conn);
        handleCreateComment($conn);
        break;
    case 'DELETE':
        requireRole(['admin']);
        handleDeleteComment($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function ensureHolidayTableExists($conn) {
    if (!$conn || !(isDbConnection($conn))) return;
    $result = $conn->query("SHOW TABLES LIKE 'holidays'");
    if ($result && $result->num_rows > 0) {
        $result->free();
        return;
    }

    $createSql = "CREATE TABLE IF NOT EXISTS holidays (
        holiday_id INT AUTO_INCREMENT PRIMARY KEY,
        holiday_name VARCHAR(160) NOT NULL,
        holiday_date DATE NOT NULL,
        holiday_type VARCHAR(60) NOT NULL DEFAULT 'Regular Holiday',
        holiday_scope VARCHAR(60) NOT NULL DEFAULT 'National',
        description TEXT NULL,
        source VARCHAR(140) NULL,
        is_system TINYINT(1) NOT NULL DEFAULT 1,
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_holiday_date_name (holiday_date, holiday_name),
        INDEX idx_holiday_date (holiday_date),
        CONSTRAINT fk_holiday_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_holiday_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($createSql)) {
        error_log($conn->error);
        sendError('Failed to initialize holiday storage.', 500);
    }
}

function ensureHolidayCommentsTable($conn) {
    $sql = "CREATE TABLE IF NOT EXISTS holiday_comment (
                comment_id INT AUTO_INCREMENT PRIMARY KEY,
                holiday_id INT NOT NULL,
                user_id INT NOT NULL,
                parent_comment_id INT NULL,
                comment_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                CONSTRAINT fk_holiday_comment_holiday FOREIGN KEY (holiday_id) REFERENCES holidays(holiday_id) ON DELETE CASCADE,
                CONSTRAINT fk_holiday_comment_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
                CONSTRAINT fk_holiday_comment_parent FOREIGN KEY (parent_comment_id) REFERENCES holiday_comment(comment_id) ON DELETE SET NULL,
                INDEX idx_holiday_comment_holiday (holiday_id),
                INDEX idx_holiday_comment_parent (parent_comment_id),
                INDEX idx_holiday_comment_created_at (created_at)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($sql)) {
        error_log($conn->error);
        sendError('Failed to initialize holiday comments storage.', 500);
    }
}

function ensureHolidayExists($conn, $holidayId) {
    $holidayId = intval($holidayId);
    if ($holidayId <= 0) {
        sendError('Holiday ID is required.', 400);
    }

    $stmt = $conn->prepare("SELECT holiday_id FROM holidays WHERE holiday_id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to prepare holiday lookup.', 500);
    }
    $stmt->bind_param('i', $holidayId);
    $stmt->execute();
    $row = $stmt->get_result()->fetch_assoc();
    $stmt->close();

    if (!$row) {
        sendError('Holiday not found.', 404);
    }

    return $holidayId;
}

function handleGetComments($conn) {
    $holidayId = intval($_GET['holiday_id'] ?? 0);
    $holidayId = ensureHolidayExists($conn, $holidayId);

    $sql = "SELECT c.comment_id,
                   c.holiday_id,
                   c.user_id,
                   c.parent_comment_id,
                   c.comment_text,
                   c.created_at,
                   c.updated_at,
                   u.first_name,
                   u.last_name,
                   u.username,
                   LOWER(COALESCE(u.role, '')) AS commenter_role
            FROM holiday_comment c
            LEFT JOIN users u ON c.user_id = u.id
            WHERE c.holiday_id = ?
            ORDER BY c.created_at ASC, c.comment_id ASC";

    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        sendError('Failed to prepare comments query.', 500);
    }
    $stmt->bind_param('i', $holidayId);
    $stmt->execute();
    $result = $stmt->get_result();

    $comments = [];
    while ($row = $result->fetch_assoc()) {
        $fullName = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
        $comments[] = [
            'comment_id' => intval($row['comment_id']),
            'holiday_id' => intval($row['holiday_id']),
            'user_id' => intval($row['user_id']),
            'parent_comment_id' => $row['parent_comment_id'] !== null ? intval($row['parent_comment_id']) : null,
            'comment_text' => (string)($row['comment_text'] ?? ''),
            'created_at' => (string)($row['created_at'] ?? ''),
            'updated_at' => (string)($row['updated_at'] ?? ''),
            'commenter_name' => $fullName !== '' ? $fullName : ((string)($row['username'] ?? 'Unknown User')),
            'commenter_role' => (string)($row['commenter_role'] ?? ''),
        ];
    }
    $stmt->close();

    sendResponse(true, $comments, 'Holiday comments retrieved successfully');
}

function handleCreateComment($conn) {
    $data = getJSONInput();
    $holidayId = intval($data['holiday_id'] ?? 0);
    $holidayId = ensureHolidayExists($conn, $holidayId);

    $commentTextRaw = trim((string)($data['comment_text'] ?? $data['comment'] ?? ''));
    if ($commentTextRaw === '') {
        sendError('Comment is required.', 400);
    }
    if (strlen($commentTextRaw) > 2000) {
        sendError('Comment is too long (max 2000 characters).', 400);
    }

    $currentUserId = intval($_SESSION['user_id'] ?? 0);
    if ($currentUserId <= 0) {
        sendError('Authentication required.', 401);
    }

    $parentCommentId = null;
    if (isset($data['parent_comment_id']) && $data['parent_comment_id'] !== null && $data['parent_comment_id'] !== '') {
        $parentCommentId = intval($data['parent_comment_id']);
        if ($parentCommentId <= 0) {
            sendError('Invalid parent comment ID.', 400);
        }

        $parentStmt = $conn->prepare(
            "SELECT comment_id
             FROM holiday_comment
             WHERE comment_id = ? AND holiday_id = ?
             LIMIT 1"
        );
        if (!$parentStmt) {
            sendError('Failed to prepare parent comment lookup.', 500);
        }
        $parentStmt->bind_param('ii', $parentCommentId, $holidayId);
        $parentStmt->execute();
        $parent = $parentStmt->get_result()->fetch_assoc();
        $parentStmt->close();

        if (!$parent) {
            sendError('Parent comment not found for this holiday.', 404);
        }
    }

    $commentText = sanitizeInput($commentTextRaw);
    if ($parentCommentId !== null) {
        $insert = $conn->prepare(
            "INSERT INTO holiday_comment (holiday_id, user_id, parent_comment_id, comment_text)
             VALUES (?, ?, ?, ?)"
        );
        if (!$insert) {
            sendError('Failed to prepare comment insert.', 500);
        }
        $insert->bind_param('iiis', $holidayId, $currentUserId, $parentCommentId, $commentText);
    } else {
        $insert = $conn->prepare(
            "INSERT INTO holiday_comment (holiday_id, user_id, comment_text)
             VALUES (?, ?, ?)"
        );
        if (!$insert) {
            sendError('Failed to prepare comment insert.', 500);
        }
        $insert->bind_param('iis', $holidayId, $currentUserId, $commentText);
    }

    if (!$insert->execute()) {
        $insert->close();
        error_log($conn->error);
        sendError('Failed to save comment.', 500);
    }

    $newCommentId = intval($conn->insert_id);
    $insert->close();

    if (function_exists('logActivity')) {
        logActivity(
            $conn,
            $currentUserId,
            'holiday_comment',
            'Added a comment to holiday ID: ' . $holidayId,
            'calendar'
        );
    }

    sendResponse(true, ['comment_id' => $newCommentId], 'Comment posted successfully', 201);
}

function handleDeleteComment($conn) {
    $commentId = intval($_GET['comment_id'] ?? 0);
    if ($commentId <= 0) {
        $payload = getJSONInput();
        $commentId = intval($payload['comment_id'] ?? 0);
    }
    if ($commentId <= 0) {
        sendError('Comment ID is required.', 400);
    }

    $check = $conn->prepare("SELECT holiday_id FROM holiday_comment WHERE comment_id = ? LIMIT 1");
    if (!$check) {
        sendError('Failed to prepare comment lookup.', 500);
    }
    $check->bind_param('i', $commentId);
    $check->execute();
    $row = $check->get_result()->fetch_assoc();
    $check->close();

    if (!$row) {
        sendError('Comment not found.', 404);
    }

    $stmt = $conn->prepare("DELETE FROM holiday_comment WHERE comment_id = ? LIMIT 1");
    if (!$stmt) {
        sendError('Failed to prepare comment delete.', 500);
    }
    $stmt->bind_param('i', $commentId);
    if (!$stmt->execute()) {
        $stmt->close();
        error_log($conn->error);
        sendError('Failed to delete comment.', 500);
    }
    $stmt->close();

    if (function_exists('logActivity')) {
        $actorId = intval($_SESSION['user_id'] ?? 0);
        if ($actorId > 0) {
            logActivity(
                $conn,
                $actorId,
                'holiday_comment_delete',
                'Deleted a holiday comment ID: ' . $commentId,
                'calendar'
            );
        }
    }

    sendResponse(true, null, 'Comment deleted successfully');
}

closeDBConnection($conn);
?>
