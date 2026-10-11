<?php
/**
 * AI-Powered Smart Notifications using Base44
 * Generates contextual, role-aware notifications
 */

class AINotificationGenerator {
    private $appId;
    private $apiKey;
    private $templateEntity;
    private $generatedEntity;
    private $baseUri;

    public function __construct() {
        $config = $this->loadBase44Config();
        
        $this->appId = $config['app_id'] ?? '';
        $this->apiKey = $config['api_key'] ?? '';
        $this->templateEntity = $config['notification_entity'] ?? 'NotificationTemplates';
        $this->generatedEntity = $config['generated_notifications_entity'] ?? 'GeneratedNotifications';
        
        $this->baseUri = 'https://base44.app/api/apps/' . $this->appId . '/entities/';
    }

    private function loadBase44Config() {
        $localConfigPath = __DIR__ . '/../config/base44.php';
        if (is_file($localConfigPath)) {
            $loaded = require $localConfigPath;
            if (is_array($loaded)) {
                return $loaded;
            }
        }

        return [
            'app_id' => getenv('BASE44_APP_ID') ?: '',
            'api_key' => getenv('BASE44_API_KEY') ?: '',
            'notification_entity' => getenv('BASE44_NOTIFICATION_ENTITY') ?: 'NotificationTemplates',
            'generated_notifications_entity' => getenv('BASE44_GENERATED_ENTITY') ?: 'GeneratedNotifications',
        ];
    }

    private function isConfigured() {
        return $this->appId !== '' && $this->apiKey !== '';
    }

    /**
     * Generate AI notification for a specific event and role
     */
    public function generateNotification($eventType, $targetRole, $context, $targetUserId = null) {
        if (!$this->isConfigured()) {
            return $this->generateFallbackNotification($eventType, $targetRole, $context);
        }

        try {
            // Get template from Base44
            $template = $this->getTemplate($eventType, $targetRole);
            
            if (!$template) {
                return $this->generateFallbackNotification($eventType, $targetRole, $context);
            }

            // Build prompt with context
            $aiPrompt = $this->buildPromptFromTemplate($template, $context);
            
            // Call Base44 AI (simulated - Base44 will process the prompt)
            $aiResponse = $this->generateAINotification($aiPrompt, $context, $template);

            if ($aiResponse) {
                return [
                    'success' => true,
                    'message' => $aiResponse['message'],
                    'priority_score' => $aiResponse['priority_score'] ?? $this->calculatePriority($eventType, $context),
                    'suggested_action' => $aiResponse['suggested_action'] ?? $this->suggestAction($eventType, $targetRole),
                    'icon_emoji' => $template['icon_emoji'] ?? '🔔',
                    'expires_after_hours' => $template['expires_after_hours'] ?? 48,
                    'source' => 'base44_ai'
                ];
            }

            return $this->generateFallbackNotification($eventType, $targetRole, $context);

        } catch (Exception $e) {
            error_log('[AI Notification] Error: ' . $e->getMessage());
            return $this->generateFallbackNotification($eventType, $targetRole, $context);
        }
    }

    /**
     * Generate notifications for multiple roles from one event
     */
    public function generateBatchNotifications($eventType, $context, $targetRoles = ['admin', 'manager', 'staff']) {
        $notifications = [];

        foreach ($targetRoles as $role) {
            $notification = $this->generateNotification($eventType, $role, $context);
            $notification['target_role'] = $role;
            $notifications[] = $notification;
        }

        return [
            'success' => true,
            'notifications' => $notifications,
            'count' => count($notifications)
        ];
    }

    /**
     * Get template from Base44
     */
    private function getTemplate($eventType, $role) {
        $uri = $this->baseUri . $this->templateEntity;
        
        // Build filter query
        $filters = http_build_query([
            'event_type' => $eventType,
            'role' => $role
        ]);

        $response = $this->makeRequest('GET', $uri . '?' . $filters);
        
        if ($response && isset($response['data']) && is_array($response['data'])) {
            $items = $response['data'];
            if (count($items) > 0) {
                return $items[0];
            }
        }

        // Try with role "all" if specific role not found
        if ($role !== 'all') {
            return $this->getTemplate($eventType, 'all');
        }

        return null;
    }

    /**
     * Build AI prompt from template and context
     */
    private function buildPromptFromTemplate($template, $context) {
        $promptTemplate = $template['ai_prompt_template'] ?? '';
        
        if (empty($promptTemplate)) {
            return '';
        }

        // Replace placeholders with context values
        $prompt = $promptTemplate;
        foreach ($context as $key => $value) {
            $placeholder = '{{' . $key . '}}';
            $prompt = str_replace($placeholder, $value, $prompt);
        }

        return $prompt;
    }

    /**
     * Generate AI notification (simulated Base44 AI response)
     * In production, this would call Base44's AI endpoint
     */
    private function generateAINotification($prompt, $context, $template) {
        // For now, we'll generate smart notifications based on templates
        // This simulates what Base44 AI would return
        
        $eventType = $context['event_type'] ?? '';
        $message = '';
        $priorityScore = 5;
        $suggestedAction = 'View details';

        switch ($eventType) {
            case 'task_completed':
                $message = $this->generateTaskCompletedMessage($context);
                $priorityScore = 6;
                $suggestedAction = 'Review remaining tasks';
                break;

            case 'leave_requested':
                $message = $this->generateLeaveRequestedMessage($context);
                $priorityScore = 7;
                $suggestedAction = 'Review and approve';
                break;

            case 'payroll_ready':
                $message = $this->generatePayrollReadyMessage($context);
                $priorityScore = 6;
                $suggestedAction = 'View payslip';
                break;

            case 'task_assigned':
                $message = $this->generateTaskAssignedMessage($context);
                $priorityScore = 6;
                $suggestedAction = 'Start working';
                break;

            case 'project_milestone':
                $message = $this->generateMilestoneMessage($context);
                $priorityScore = 4;
                $suggestedAction = 'View progress';
                break;

            case 'task_overdue':
                $message = $this->generateOverdueMessage($context);
                $priorityScore = 8;
                $suggestedAction = 'Follow up immediately';
                break;

            default:
                $message = $this->generateGenericMessage($context);
                $priorityScore = 5;
        }

        return [
            'message' => $message,
            'priority_score' => $priorityScore,
            'suggested_action' => $suggestedAction
        ];
    }

    /**
     * Smart message generators (fallback when Base44 AI is unavailable)
     */
    private function generateTaskCompletedMessage($context) {
        $taskTitle = $context['task_title'] ?? 'Task';
        $completedBy = $context['completed_by_name'] ?? 'Someone';
        $projectName = $context['project_name'] ?? 'project';
        $wasEarly = isset($context['was_early']) && $context['was_early'];
        $daysVariance = $context['days_variance'] ?? 0;
        $remainingTasks = $context['remaining_tasks'] ?? 0;
        $daysUntilDeadline = $context['days_until_deadline'] ?? 0;

        if ($wasEarly && $daysVariance > 0) {
            return "✅ {$completedBy} completed '{$taskTitle}' {$daysVariance} day(s) early! {$remainingTasks} tasks remain for {$projectName}. " .
                   ($daysUntilDeadline <= 3 ? "⏰ Deadline in {$daysUntilDeadline} days!" : "On track for deadline.");
        }

        return "✅ {$completedBy} completed '{$taskTitle}' for {$projectName}. {$remainingTasks} tasks remaining.";
    }

    private function generateLeaveRequestedMessage($context) {
        $employeeName = $context['employee_name'] ?? 'Employee';
        $leaveType = $context['leave_type'] ?? 'Leave';
        $durationDays = $context['duration_days'] ?? 1;
        $startDate = $context['start_date'] ?? 'soon';
        $availableCoverage = $context['available_coverage'] ?? 0;
        $conflictingDeadlines = $context['conflicting_deadlines'] ?? 0;

        $message = "📝 {$employeeName} requested {$leaveType} ({$durationDays} day(s), starting {$startDate}).";
        
        if ($conflictingDeadlines > 0) {
            $message .= " ⚠️ {$conflictingDeadlines} deadline(s) conflict.";
        }
        
        $message .= " {$availableCoverage} team member(s) available for coverage.";
        
        return $message;
    }

    private function generatePayrollReadyMessage($context) {
        $employeeName = $context['employee_name'] ?? 'Employee';
        $netPay = $context['net_pay'] ?? '0';
        $payPeriodStart = $context['pay_period_start'] ?? '';
        $payPeriodEnd = $context['pay_period_end'] ?? '';
        $overtimeHours = $context['overtime_hours'] ?? 0;

        $message = "💰 Your payslip is ready! Net pay: ₱" . number_format($netPay, 2);
        
        if ($payPeriodStart && $payPeriodEnd) {
            $message .= " ({$payPeriodStart} - {$payPeriodEnd})";
        }
        
        if ($overtimeHours > 0) {
            $message .= " Includes {$overtimeHours} hour(s) overtime.";
        }
        
        return $message;
    }

    private function generateTaskAssignedMessage($context) {
        $taskTitle = $context['task_title'] ?? 'New task';
        $priority = $context['task_priority'] ?? 'Medium';
        $projectName = $context['project_name'] ?? '';
        $daysUntilDue = $context['days_until_due'] ?? 0;
        $assignerName = $context['assigner_name'] ?? 'Your manager';

        $priorityEmoji = $priority === 'High' ? '🔴' : ($priority === 'Medium' ? '🟡' : '🟢');
        
        $message = "📋 {$priorityEmoji} New {$priority} priority task: '{$taskTitle}'";
        
        if ($projectName) {
            $message .= " for {$projectName}";
        }
        
        $message .= ". Due in {$daysUntilDue} day(s). Assigned by {$assignerName}.";
        
        return $message;
    }

    private function generateMilestoneMessage($context) {
        $projectName = $context['project_name'] ?? 'Project';
        $milestoneName = $context['milestone_name'] ?? 'milestone';
        $completionPercentage = $context['completion_percentage'] ?? 0;
        $completedTasks = $context['completed_tasks'] ?? 0;
        $totalTasks = $context['total_tasks'] ?? 0;

        return "🎉 Milestone reached! {$projectName} - {$milestoneName} completed! " .
               "{$completionPercentage}% done ({$completedTasks}/{$totalTasks} tasks). Keep it up!";
    }

    private function generateOverdueMessage($context) {
        $taskTitle = $context['task_title'] ?? 'Task';
        $assigneeName = $context['assignee_name'] ?? 'Team member';
        $daysOverdue = $context['days_overdue'] ?? 1;
        $priority = $context['priority'] ?? 'Medium';
        $projectName = $context['project_name'] ?? '';

        $message = "⚠️ OVERDUE: '{$taskTitle}' is {$daysOverdue} day(s) late";
        
        if ($assigneeName) {
            $message .= " (Assigned to: {$assigneeName})";
        }
        
        if ($projectName) {
            $message .= " - {$projectName}";
        }
        
        $message .= ". {$priority} priority - follow up needed.";
        
        return $message;
    }

    private function generateGenericMessage($context) {
        $eventType = $context['event_type'] ?? 'Update';
        
        return "🔔 New " . str_replace('_', ' ', $eventType) . " notification. Check your dashboard for details.";
    }

    /**
     * Generate fallback notification
     */
    private function generateFallbackNotification($eventType, $targetRole, $context) {
        $context['event_type'] = $eventType;
        $context['target_role'] = $targetRole;
        
        $message = $this->generateGenericMessage($context);
        
        return [
            'success' => true,
            'message' => $message,
            'priority_score' => $this->calculatePriority($eventType, $context),
            'suggested_action' => $this->suggestAction($eventType, $targetRole),
            'icon_emoji' => '🔔',
            'expires_after_hours' => 48,
            'source' => 'fallback'
        ];
    }

    /**
     * Calculate priority score
     */
    private function calculatePriority($eventType, $context) {
        $priorityMap = [
            'task_completed' => 6,
            'leave_requested' => 7,
            'leave_approved' => 4,
            'leave_rejected' => 6,
            'payroll_ready' => 6,
            'task_assigned' => 6,
            'project_milestone' => 4,
            'task_overdue' => 8,
            'system_critical' => 10
        ];

        $basePriority = $priorityMap[$eventType] ?? 5;

        // Adjust based on context
        if (isset($context['days_overdue']) && $context['days_overdue'] > 3) {
            $basePriority = min(10, $basePriority + 2);
        }

        if (isset($context['is_peak_season']) && $context['is_peak_season']) {
            $basePriority = min(10, $basePriority + 1);
        }

        return $basePriority;
    }

    /**
     * Suggest action based on event type and role
     */
    private function suggestAction($eventType, $targetRole) {
        $actions = [
            'task_completed' => 'Review progress',
            'leave_requested' => 'Review and approve',
            'leave_approved' => 'Check schedule',
            'leave_rejected' => 'Communicate decision',
            'payroll_ready' => 'View payslip',
            'task_assigned' => 'Start working',
            'project_milestone' => 'View details',
            'task_overdue' => 'Follow up',
            'system_critical' => 'Take immediate action'
        ];

        return $actions[$eventType] ?? 'View details';
    }

    /**
     * Make HTTP request to Base44 API
     */
    private function makeRequest($method, $url, $body = null) {
        $headers = [
            'api_key: ' . $this->apiKey,
            'Content-Type: application/json'
        ];

        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CUSTOMREQUEST, strtoupper($method));
        curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);
        curl_setopt($ch, CURLOPT_TIMEOUT, 15);

        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($response === false || $httpCode >= 400) {
            error_log('[Base44 API] Request failed with HTTP ' . $httpCode);
            return null;
        }

        return json_decode($response, true);
    }

    /**
     * Save generated notification to Base44
     */
    public function saveGeneratedNotification($notificationData) {
        if (!$this->isConfigured()) {
            return false;
        }

        $uri = $this->baseUri . $this->generatedEntity;
        
        $response = $this->makeRequest('POST', $uri, $notificationData);
        
        return $response !== null;
    }
}

/**
 * Helper function to create and store AI notification
 * Call this when events happen in the system
 */
function createAINotification($conn, $eventType, $targetUserId, $targetRole, $context, $actionUrl = null) {
    $generator = new AINotificationGenerator();
    
    // Generate AI notification
    $result = $generator->generateNotification($eventType, $targetRole, $context, $targetUserId);
    
    if (!$result['success']) {
        return false;
    }
    
    // Calculate expiry
    $expiresAt = date('Y-m-d H:i:s', strtotime('+' . $result['expires_after_hours'] . ' hours'));
    
    // Store in database
    $sql = "INSERT INTO ai_notifications
            (event_type, target_user_id, target_role, ai_message, icon_emoji,
             priority_score, suggested_action, action_url, context_json,
             expires_at, source, is_sent, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NOW())";
    
    $stmt = $conn->prepare($sql);
    if (!$stmt) {
        error_log('[AI Notification] Failed to prepare statement: ' . $conn->error);
        return false;
    }
    
    $contextJson = json_encode($context);
    $message = $result['message'];
    $emoji = $result['icon_emoji'];
    $priority = $result['priority_score'];
    $action = $result['suggested_action'];
    $source = $result['source'];
    
    $priority = (int)$priority;
    $stmt->bind_param('sisssisssss',
        $eventType,
        $targetUserId,
        $targetRole,
        $message,
        $emoji,
        $priority,
        $action,
        $actionUrl,
        $contextJson,
        $expiresAt,
        $source
    );
    
    $success = $stmt->execute();
    
    if (!$success) {
        error_log('[AI Notification] Failed to insert: ' . $stmt->error);
    }
    
    $stmt->close();
    
    return $success;
}

/**
 * Create batch AI notifications for multiple users
 */
function createBatchAINotifications($conn, $eventType, $targets, $context, $actionUrl = null) {
    $count = 0;
    
    foreach ($targets as $target) {
        $userId = $target['user_id'];
        $role = $target['role'];
        
        if (createAINotification($conn, $eventType, $userId, $role, $context, $actionUrl)) {
            $count++;
        }
    }
    
    return $count;
}

