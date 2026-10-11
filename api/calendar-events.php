<?php
/**
 * Calendar Events API
 * Google-Calendar style company events.
 *
 * GET    -> admin, manager, staff (view only)
 * POST   -> admin only
 * PUT    -> admin only
 * DELETE -> admin only
 *
 * Also serves employee birthdays (from users.date_of_birth) so every
 * authenticated role can see whose birthday falls on each day.
 */

require_once 'config.php';
require_once 'utils.php';

setCORSHeaders();

$method = getRequestMethod();
$conn = getDBConnection();
ensureCalendarEventStorage($conn);

switch ($method) {
    case 'GET':
        requireFeatureAccess('calendar', ['admin', 'manager', 'staff'], $conn);
        handleGet($conn);
        break;
    case 'POST':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handlePost($conn);
        break;
    case 'PUT':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handlePut($conn);
        break;
    case 'DELETE':
        requireFeatureAccess('calendar', ['admin'], $conn);
        handleDelete($conn);
        break;
    default:
        sendError('Method not allowed', 405);
}

function ensureCalendarEventStorage($conn) {
    $createSql = "CREATE TABLE IF NOT EXISTS calendar_events (
        event_id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(200) NOT NULL,
        description TEXT NULL,
        location VARCHAR(180) NULL,
        event_date DATE NOT NULL,
        end_date DATE NULL,
        all_day TINYINT(1) NOT NULL DEFAULT 1,
        start_time TIME NULL,
        end_time TIME NULL,
        color VARCHAR(20) NOT NULL DEFAULT 'blue',
        category VARCHAR(60) NOT NULL DEFAULT 'Event',
        recurrence VARCHAR(20) NOT NULL DEFAULT 'none',
        created_by INT NULL,
        updated_by INT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_event_date (event_date),
        INDEX idx_event_end_date (end_date),
        CONSTRAINT fk_cevent_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        CONSTRAINT fk_cevent_updated_by FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";

    if (!$conn->query($createSql)) {
        error_log($conn->error);
        sendError('Failed to initialize calendar event storage.', 500);
    }
}

function normalizeEventText($value, $limit) {
    $text = trim((string)$value);
    if ($text === '') return '';
    if (strlen($text) > $limit) {
        $text = substr($text, 0, $limit);
    }
    return sanitizeInput($text);
}

function normalizeTimeOrNull($value) {
    $text = trim((string)$value);
    if ($text === '') return null;
    if (!preg_match('/^\d{2}:\d{2}(:\d{2})?$/', $text)) return null;
    return strlen($text) === 5 ? $text . ':00' : $text;
}

function validColor($value) {
    $allowed = ['tomato', 'flamingo', 'tangerine', 'banana', 'sage', 'basil',
                'peacock', 'blueberry', 'lavender', 'grape', 'graphite'];
    return in_array($value, $allowed, true) ? $value : 'blue';
}

function validRecurrence($value) {
    $allowed = ['none', 'daily', 'weekly', 'monthly', 'yearly'];
    $text = strtolower(trim((string)$value));
    return in_array($text, $allowed, true) ? $text : 'none';
}

/**
 * Fetch birthdays of active users inside a range. Birthdays recur every year.
 */
function fetchBirthdaysInRange($conn, $dateFrom, $dateTo) {
    $sql = "SELECT id, first_name, last_name, role, date_of_birth
            FROM users
            WHERE date_of_birth IS NOT NULL AND YEAR(date_of_birth) > 0
            ORDER BY MONTH(date_of_birth), DAY(date_of_birth), first_name";
    $result = $conn->query($sql);
    if (!$result) return [];

    $rows = [];
    while ($row = $result->fetch_assoc()) {
        $dob = (string)$row['date_of_birth'];
        $month = intval(substr($dob, 5, 2));
        $day = intval(substr($dob, 8, 2));
        if ($month <= 0 || $day <= 0 || $month > 12) continue;

        foreach (birthdayOccurrencesInRange($month, $day, $dateFrom, $dateTo) as $occurrence) {
            $rows[] = [
                'birthday_id' => intval($row['id']),
                'user_id' => intval($row['id']),
                'first_name' => $row['first_name'],
                'last_name' => $row['last_name'],
                'full_name' => trim(($row['first_name'] ?? '') . ' ' . ($row['last_name'] ?? '')),
                'role' => $row['role'],
                'date_of_birth' => $dob,
                'birthday_date' => $occurrence,
                'turning_age' => intval(substr($occurrence, 0, 4)) - intval(substr($dob, 0, 4)),
                'is_recurring_yearly' => true,
            ];
        }
    }

    usort($rows, function ($a, $b) {
        return strcmp($a['birthday_date'], $b['birthday_date']);
    });
    return $rows;
}

function birthdayOccurrencesInRange($month, $day, $dateFrom, $dateTo) {
    $occurrences = [];
    $fromYear = intval(substr($dateFrom, 0, 4));
    $toYear = intval(substr($dateTo, 0, 4));
    for ($year = $fromYear; $year <= $toYear; $year++) {
        // Clamp Feb 29 birthdays to Feb 28 on non-leap years.
        $maxDay = intval(date('t', mktime(0, 0, 0, $month, 1, $year)));
        $candidate = sprintf('%04d-%02d-%02d', $year, $month, min($day, $maxDay));
        if ($candidate >= $dateFrom && $candidate <= $dateTo) {
            $occurrences[] = $candidate;
        }
    }
    return $occurrences;
}
/**
 * Expand recurring events into concrete occurrences within [dateFrom, dateTo].
 */
function expandRecurrences($events, $dateFrom, $dateTo) {
    $expanded = [];
    $rangeStart = new DateTime($dateFrom);
    $rangeEnd = new DateTime($dateTo);

    foreach ($events as $event) {
        $recurrence = strtolower((string)($event['recurrence'] ?? 'none'));
        if ($recurrence === '' || $recurrence === 'none') {
            $expanded[] = $event;
            continue;
        }

        try {
            $startDate = new DateTime($event['event_date']);
        } catch (Exception $e) {
            continue;
        }

        $cursor = $startDate < $rangeStart ? clone $rangeStart : clone $startDate;
        if (!empty($event['end_date'])) {
            try {
                $endDate = new DateTime($event['end_date']);
                // Skip series whose multi-day span already ended before the range.
                if ($endDate < $rangeStart) {
                    $stepSpecs = ['+1 day', '+7 days', '+1 month', '+1 year'];
                    $steps = ['daily' => 0, 'weekly' => 1, 'monthly' => 2, 'yearly' => 3];
                    while ($cursor <= $rangeEnd && $startDate < $rangeStart) {
                        $cursor->modify($stepSpecs[$steps[$recurrence] ?? 0]);
                        $startDate->modify($stepSpecs[$steps[$recurrence] ?? 0]);
                        $endDate->modify($stepSpecs[$steps[$recurrence] ?? 0]);
                    }
                    if ($startDate > $rangeEnd) {
                        continue;
                    }
                    $cursor = clone $startDate;
                }
            } catch (Exception $e) {
                // Ignore malformed end dates.
            }
        }

        $maxIterations = 500;
        $iterations = 0;

        while ($cursor <= $rangeEnd && $iterations < $maxIterations) {
            $copy = $event;
            $shift = $cursor->diff($startDate)->days;
            $copy['event_date'] = $cursor->format('Y-m-d');
            if (!empty($event['end_date'])) {
                try {
                    $baseEnd = new DateTime($event['end_date']);
                    $copy['end_date'] = $baseEnd->modify("+{$shift} days")->format('Y-m-d');
                } catch (Exception $e) {
                    $copy['end_date'] = null;
                }
            }
            $expanded[] = $copy;

            if ($recurrence === 'daily') {
                $cursor->modify('+1 day');
            } elseif ($recurrence === 'weekly') {
                $cursor->modify('+7 days');
            } elseif ($recurrence === 'monthly') {
                $cursor->modify('+1 month');
            } elseif ($recurrence === 'yearly') {
                $cursor->modify('+1 year');
            } else {
                break;
            }
            $iterations++;
        }
    }
    return $expanded;
}

function handleGet($conn) {
    $action = sanitizeInput($_GET['action'] ?? '');

    if ($action === 'birthdays') {
        $dateFrom = sanitizeInput($_GET['date_from'] ?? date('Y') . '-01-01');
        $dateTo = sanitizeInput($_GET['date_to'] ?? date('Y') . '-12-31');
        if (!validateDate($dateFrom)) $dateFrom = date('Y') . '-01-01';
        if (!validateDate($dateTo)) $dateTo = date('Y') . '-12-31';
        sendResponse(true, fetchBirthdaysInRange($conn, $dateFrom, $dateTo), 'Birthdays retrieved successfully');
    }

    $dateFrom = sanitizeInput($_GET['date_from'] ?? '');
    $dateTo = sanitizeInput($_GET['date_to'] ?? '');
    if (!validateDate($dateFrom)) $dateFrom = date('Y-m-01');
    if (!validateDate($dateTo)) $dateTo = date('Y-m-t');

    if ($dateTo < $dateFrom) {
        $tmp = $dateFrom;
        $dateFrom = $dateTo;
        $dateTo = $tmp;
    }

    $sql = "SELECT e.event_id, e.title, e.description, e.location, e.event_date, e.end_date,
                   e.all_day, e.start_time, e.end_time, e.color, e.category, e.recurrence,
                   e.created_at, e.updated_at,
                   CONCAT(u.first_name, ' ', u.last_name) AS creator_name
            FROM calendar_events e
            LEFT JOIN users u ON u.id = e.created_by
            WHERE (
                    (e.recurrence = 'none' AND e.event_date <= ? AND COALESCE(e.end_date, e.event_date) >= ?)
                 OR (e.recurrence <> 'none' AND e.event_date <= ?)
                  )";

    $params = [$dateTo, $dateFrom, $dateTo];
    $types = 'sss';

    $search = trim(sanitizeInput($_GET['search'] ?? ''));
    if ($search !== '') {
        $like = '%' . $search . '%';
        $sql .= " AND (e.title LIKE ? OR e.description LIKE ? OR e.location LIKE ? OR e.category LIKE ?)";
        array_push($params, $like, $like, $like, $like);
        $types .= 'ssss';
    }

    $sql .= " ORDER BY e.event_date ASC, e.all_day DESC, e.start_time ASC, e.title ASC LIMIT 2000";

    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare events query', 500);
    $stmt->bind_param($types, ...$params);
    $stmt->execute();
    $result = $stmt->get_result();

    $events = [];
    while ($row = $result->fetch_assoc()) {
        $row['event_id'] = intval($row['event_id']);
        $row['all_day'] = intval($row['all_day']);
        $row['color'] = validColor($row['color']);
        $row['recurrence'] = validRecurrence($row['recurrence']);
        $row['is_recurring_yearly'] = $row['recurrence'] === 'yearly';
        $events[] = $row;
    }
    $stmt->close();

    $events = expandRecurrences($events, $dateFrom, $dateTo);

    usort($events, function ($a, $b) {
        $byDate = strcmp($a['event_date'], $b['event_date']);
        if ($byDate !== 0) return $byDate;
        return strcmp((string)$a['start_time'], (string)$b['start_time']);
    });

    sendResponse(true, [
        'events' => $events,
        'birthdays' => fetchBirthdaysInRange($conn, $dateFrom, $dateTo),
        'range' => ['date_from' => $dateFrom, 'date_to' => $dateTo],
    ], 'Calendar data retrieved successfully');
}

function handlePost($conn) {
    $data = getJSONInput();
    $missing = validateRequiredFields($data, ['title', 'event_date']);
    if ($missing) sendError('Missing required fields: ' . implode(', ', $missing), 400);

    $title = normalizeEventText($data['title'] ?? '', 200);
    $eventDate = normalizeEventText($data['event_date'] ?? '', 10);
    if ($title === '') sendError('Event title is required', 400);
    if (!validateDate($eventDate)) sendError('Invalid event date format (expected Y-m-d)', 400);

    $description = normalizeEventText($data['description'] ?? '', 3000);
    $location = normalizeEventText($data['location'] ?? '', 180);
    $endDate = normalizeEventText($data['end_date'] ?? '', 10);
    if ($endDate !== '' && !validateDate($endDate)) sendError('Invalid end date format (expected Y-m-d)', 400);
    if ($endDate !== '' && $endDate < $eventDate) sendError('End date cannot be before the start date', 400);

    $allDay = !empty($data['all_day']) ? 1 : 0;
    $startTime = $allDay ? null : normalizeTimeOrNull($data['start_time'] ?? '');
    $endTime = $allDay ? null : normalizeTimeOrNull($data['end_time'] ?? '');
    if (!$allDay && $startTime === null) sendError('Start time is required for timed events', 400);

    $color = validColor($data['color'] ?? 'blue');
    $category = normalizeEventText($data['category'] ?? 'Event', 60);
    if ($category === '') $category = 'Event';
    $recurrence = validRecurrence($data['recurrence'] ?? 'none');

    $userId = intval($_SESSION['user_id'] ?? 0);

    $sql = "INSERT INTO calendar_events
            (title, description, location, event_date, end_date, all_day, start_time, end_time,
             color, category, recurrence, created_by, updated_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare insert', 500);
    $stmt->bind_param(
        'sssssisssssii',
        $title, $description, $location, $eventDate, $endDate, $allDay, $startTime, $endTime,
        $color, $category, $recurrence, $userId, $userId
    );

    if ($stmt->execute()) {
        logActivity($conn, $userId, 'create_calendar_event', "Created calendar event: {$title}", 'calendar_management');
        sendResponse(true, ['event_id' => $conn->insert_id], 'Event created successfully', 201);
    }

    error_log($conn->error);
    sendError('Failed to create event.', 500);
}

function handlePut($conn) {
    $data = getJSONInput();
    if (!isset($data['event_id'])) sendError('Event ID is required', 400);
    $eventId = intval($data['event_id']);
    if ($eventId <= 0) sendError('Invalid event ID', 400);

    $check = $conn->prepare("SELECT event_id FROM calendar_events WHERE event_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $eventId);
    $check->execute();
    $current = $check->get_result()->fetch_assoc();
    $check->close();
    if (!$current) sendError('Event not found', 404);

    $updates = [];
    $params = [];
    $types = '';

    if (array_key_exists('title', $data)) {
        $title = normalizeEventText($data['title'] ?? '', 200);
        if ($title === '') sendError('Event title is required', 400);
        $updates[] = 'title = ?';
        $params[] = $title;
        $types .= 's';
    }

    if (array_key_exists('description', $data)) {
        $updates[] = 'description = ?';
        $params[] = normalizeEventText($data['description'] ?? '', 3000);
        $types .= 's';
    }

    if (array_key_exists('location', $data)) {
        $updates[] = 'location = ?';
        $params[] = normalizeEventText($data['location'] ?? '', 180);
        $types .= 's';
    }

    if (array_key_exists('event_date', $data)) {
        $date = normalizeEventText($data['event_date'] ?? '', 10);
        if (!validateDate($date)) sendError('Invalid event date format (expected Y-m-d)', 400);
        $updates[] = 'event_date = ?';
        $params[] = $date;
        $types .= 's';
    }

    if (array_key_exists('end_date', $data)) {
        $endDate = normalizeEventText($data['end_date'] ?? '', 10);
        if ($endDate !== '' && !validateDate($endDate)) sendError('Invalid end date format (expected Y-m-d)', 400);
        $updates[] = 'end_date = ' . ($endDate === '' ? 'NULL' : '?');
        if ($endDate !== '') {
            $params[] = $endDate;
            $types .= 's';
        }
    }

    if (array_key_exists('all_day', $data)) {
        $allDay = !empty($data['all_day']) ? 1 : 0;
        $updates[] = 'all_day = ?';
        $params[] = $allDay;
        $types .= 'i';
    }

    foreach ([['start_time', 'start_time'], ['end_time', 'end_time']] as [$field, $column]) {
        if (array_key_exists($field, $data)) {
            $timeValue = normalizeTimeOrNull($data[$field] ?? '');
            $updates[] = "{$column} = " . ($timeValue === null ? 'NULL' : '?');
            if ($timeValue !== null) {
                $params[] = $timeValue;
                $types .= 's';
            }
        }
    }

    if (array_key_exists('color', $data)) {
        $updates[] = 'color = ?';
        $params[] = validColor($data['color'] ?? 'blue');
        $types .= 's';
    }

    if (array_key_exists('category', $data)) {
        $category = normalizeEventText($data['category'] ?? 'Event', 60);
        if ($category === '') $category = 'Event';
        $updates[] = 'category = ?';
        $params[] = $category;
        $types .= 's';
    }

    if (array_key_exists('recurrence', $data)) {
        $updates[] = 'recurrence = ?';
        $params[] = validRecurrence($data['recurrence'] ?? 'none');
        $types .= 's';
    }

    if (empty($updates)) sendError('No fields provided for update', 400);

    $userId = intval($_SESSION['user_id'] ?? 0);
    $updates[] = 'updated_by = ?';
    $params[] = $userId;
    $types .= 'i';

    $params[] = $eventId;
    $types .= 'i';

    $sql = 'UPDATE calendar_events SET ' . implode(', ', $updates) . ' WHERE event_id = ?';
    $stmt = $conn->prepare($sql);
    if (!$stmt) sendError('Failed to prepare update', 500);
    $stmt->bind_param($types, ...$params);

    if ($stmt->execute()) {
        logActivity($conn, $userId, 'update_calendar_event', 'Updated calendar event #' . $eventId, 'calendar_management');
        sendResponse(true, null, 'Event updated successfully');
    }

    error_log($conn->error);
    sendError('Failed to update event.', 500);
}

function handleDelete($conn) {
    $id = isset($_GET['id']) ? intval($_GET['id']) : 0;
    if ($id <= 0) {
        $payload = getJSONInput();
        $id = intval($payload['event_id'] ?? 0);
    }
    if ($id <= 0) sendError('Event ID is required', 400);

    $check = $conn->prepare("SELECT title FROM calendar_events WHERE event_id = ? LIMIT 1");
    if (!$check) sendError('Failed to prepare existence check', 500);
    $check->bind_param('i', $id);
    $check->execute();
    $current = $check->get_result()->fetch_assoc();
    $check->close();
    if (!$current) sendError('Event not found', 404);

    $stmt = $conn->prepare('DELETE FROM calendar_events WHERE event_id = ?');
    if (!$stmt) sendError('Failed to prepare delete', 500);
    $stmt->bind_param('i', $id);

    if ($stmt->execute()) {
        logActivity($conn, intval($_SESSION['user_id'] ?? 0), 'delete_calendar_event', 'Deleted calendar event: ' . ($current['title'] ?? '#' . $id), 'calendar_management');
        sendResponse(true, null, 'Event deleted successfully');
    }

    error_log($conn->error);
    sendError('Failed to delete event.', 500);
}
