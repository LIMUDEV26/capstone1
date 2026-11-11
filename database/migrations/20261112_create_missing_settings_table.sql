-- Repairs the missing Railway settings table reported by MySQL error 1146.
-- Safe to run more than once; it preserves an existing settings table and its rows.

CREATE TABLE IF NOT EXISTS settings (
    setting_key VARCHAR(191) NOT NULL PRIMARY KEY,
    setting_value LONGTEXT NOT NULL,
    setting_type VARCHAR(30) NOT NULL DEFAULT 'string',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO settings (setting_key, setting_value, setting_type) VALUES
    ('rate_limit_enabled', '1', 'boolean'),
    ('rate_limit_max_requests', '180', 'number'),
    ('rate_limit_window_seconds', '60', 'number')
ON DUPLICATE KEY UPDATE setting_key = setting_key;
