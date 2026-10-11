<?php

return [
    // Payroll imports use local ZKTeco biometric IDs; no external mapping is needed.
    'employee_identity_enabled' => false,

    // Base44 App ID for AI Notification System
    'app_id' => '69da56bb99dd53afa0748283',

    // Base44 API Key
    'api_key' => '107b8bef035945f4bbf5948a3fbc1721',

    // Employee Identity Mapping Entity (for payroll)
    'entity' => 'EmployeeIdentityMap',
    
    // AI Notification Templates Entity
    'notification_entity' => 'NotificationTemplates',
    
    // Generated Notifications Entity
    'generated_notifications_entity' => 'GeneratedNotifications',
];
