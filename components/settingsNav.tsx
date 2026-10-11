import type { ReactElement } from 'react';
import CrudActionIcon from './CrudActionIcon';

export type SettingsSection =
    | 'profile'
    | 'account-lockout'
    | 'browser-lockout'
    | 'session-timeout'
    | 'math-captcha'
    | 'data-storage'
    | 'system-backup'
    | 'pagination'
    | 'deduction-types'
    | 'leave-management'
    | 'leave-planner-display'
    | 'rate-limiting'
    | 'password-policy'
    | 'role-access-control'
    | 'logs-management';

export type SettingsNavItem = {
    id: SettingsSection;
    label: string;
    path: string;
    introTitle: string;
    introText: string;
    icon: ReactElement;
};

export const settingsNavItems: SettingsNavItem[] = [
    {
        id: 'profile',
        label: 'Admin Profile',
        path: '/settings',
        introTitle: 'Admin Profile & Security',
        introText: 'Update account identity and change your password via email OTP verification from this workspace.',
        icon: <CrudActionIcon action="view" size={15} />,
    },
    {
        id: 'account-lockout',
        label: 'Account Lockout',
        path: '/settings/account-lockout',
        introTitle: 'Account Lockout',
        introText: 'Adjust automated lockout thresholds and review locked user accounts without leaving the admin settings workspace.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
        ),
    },
    {
        id: 'browser-lockout',
        label: 'Browser Lockout',
        path: '/settings/browser-lockout',
        introTitle: 'Browser / Intruder Lockout',
        introText: 'Automatically block browsers that exceed 10 consecutive failed login attempts and review or unblock them here.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
            </svg>
        ),
    },
    {
        id: 'session-timeout',
        label: 'Session Timeout',
        path: '/settings/session-timeout',
        introTitle: 'Session Timeout',
        introText: 'Configure inactivity expiry rules for manager and staff sessions.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
            </svg>
        ),
    },
    {
        id: 'math-captcha',
        label: 'Captcha Management',
        path: '/settings/math-captcha',
        introTitle: 'Captcha Management',
        introText: 'Control the login captcha, expiry timing, and failed attempt limit before the account is locked.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
                <line x1="7" y1="8" x2="17" y2="8" />
                <line x1="7" y1="12" x2="11" y2="12" />
                <line x1="13" y1="12" x2="17" y2="12" />
                <line x1="7" y1="16" x2="11" y2="16" />
                <line x1="13" y1="16" x2="17" y2="16" />
            </svg>
        ),
    },
    {
        id: 'data-storage',
        label: 'Data Storage',
        path: '/settings/data-deletion',
        introTitle: 'Data Storage',
        introText: 'Review archived records and restore activity logs when they are needed again.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14H6L5 6" />
                <path d="M10 11v6" />
                <path d="M14 11v6" />
                <path d="M9 6V4h6v2" />
            </svg>
        ),
    },

    {
        id: 'system-backup',
        label: 'System Backup',
        path: '/settings/system-backup',
        introTitle: 'System Backup',
        introText: 'Create backups, review history, and manage backup schedules inside this current settings page.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
            </svg>
        ),
    },
    {
        id: 'pagination',
        label: 'Pagination',
        path: '/settings/pagination',
        introTitle: 'Pagination',
        introText: 'Set system table sizing defaults without opening a separate page.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="16" rx="2" ry="2" />
                <line x1="3" y1="10" x2="21" y2="10" />
                <line x1="9" y1="10" x2="9" y2="20" />
            </svg>
        ),
    },
    {
        id: 'deduction-types',
        label: 'Payroll Settings',
        path: '/settings/deduction-types',
        introTitle: 'Payroll Settings',
        introText: 'Manage payroll deduction definitions and the company daily rate.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="1" x2="12" y2="23" />
                <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14.5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
        ),
    },
    {
        id: 'leave-management',
        label: 'Leave Management',
        path: '/settings/leave-management',
        introTitle: 'Leave Management',
        introText: 'Open leave type management in the current page and keep the settings navigation visible.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8v13H3V8" />
                <path d="M1 3h22v5H1z" />
                <path d="M10 12h4" />
                <path d="M12 10v4" />
            </svg>
        ),
    },
    {
        id: 'leave-planner-display',
        label: 'Leave Planner Display',
        path: '/settings/leave-planner-display',
        introTitle: 'Leave Planner Display',
        introText: 'Control whether employee names are shown in the leave planner tracker.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
                <line x1="16" y1="2" x2="16" y2="6" />
                <line x1="8" y1="2" x2="8" y2="6" />
                <line x1="3" y1="10" x2="21" y2="10" />
            </svg>
        ),
    },
    {
        id: 'logs-management',
        label: 'Logs Management',
        path: '/settings/logs-management',
        introTitle: 'Logs Management',
        introText: 'Filter, review, and inspect the latest system audit events.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
        ),
    },
    {
        id: 'password-policy',
        label: 'Password Policy',
        path: '/settings/password-policy',
        introTitle: 'Password Expiration & History',
        introText: 'Force password changes on a schedule and prevent reuse of recent passwords for every user.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                <path d="M9 12h6" />
                <path d="M12 9v6" />
                <path d="M8 16l-1 4 4-2 4 2-1-4" />
            </svg>
        ),
    },
    {
        id: 'role-access-control',
        label: 'Role Access Control',
        path: '/settings/role-access-control',
        introTitle: 'Role-Based Access Control',
        introText: 'Manage manager and staff feature access, including contract visibility and request permissions.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
        ),
    },
    {
        id: 'rate-limiting',
        label: 'Rate Limiting',
        path: '/settings/rate-limiting',
        introTitle: 'Rate Limiting',
        introText: 'Throttle API requests per browser or network to reduce abusive spikes and DDoS-style floods.',
        icon: (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20V10" />
                <path d="M18.4 5.6A9 9 0 1 1 5 19.1" />
                <path d="M12 4v2" />
            </svg>
        ),
    },
];
