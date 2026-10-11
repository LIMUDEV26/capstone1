import React from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { getApiBaseUrl } from '@/utils/network';
import { warmRoute, warmRouteData } from '@/utils/routeWarmup';
import {
    hasRoleFeatureAccess,
    type RoleFeatureAccessMap,
    type RoleFeatureKey,
} from '@/utils/roleFeatureAccess';
import styles from '../styles/Layout.module.css';

const DEFAULT_OPEN_SECTIONS: Record<string, boolean> = {
    'MAIN': true,
    'MY WORK': true,
    'MASTER FILES': true,
    'TRANSACTION FILES': true,
    'SYSTEM': true
};

// Badge dots are currently not rendered (see showDot below). Avoid running
// several large API queries in the background for invisible UI.
const SIDEBAR_BADGES_ENABLED = process.env.NEXT_PUBLIC_SIDEBAR_BADGES === '1';

function getInitialOpenSections(): Record<string, boolean> {
    if (typeof window === 'undefined') return DEFAULT_OPEN_SECTIONS;

    try {
        const saved = window.localStorage.getItem('sidebarSectionsState');
        return saved ? JSON.parse(saved) : DEFAULT_OPEN_SECTIONS;
    } catch (e) {
        console.error('Failed to load sidebar state', e);
        return DEFAULT_OPEN_SECTIONS;
    }
}

interface SidebarProps {
    collapsed: boolean;
    role?: string;
    featureAccess?: RoleFeatureAccessMap | null;
    mobile?: boolean;
    mobileOpen?: boolean;
    onNavigate?: () => void;
}

type SidebarBadgeKey =
    | 'my_tasks'
    | 'tasks_board'
    | 'leave_requests'
    | 'overtime_requests'
    | 'cash_advance'
    | 'edit_requests'
    | 'projects';

type SidebarItem = {
    label: string;
    path?: string;
    featureKey?: RoleFeatureKey;
    badgeKey?: SidebarBadgeKey;
    roles: string[];
    icon: React.ReactNode;
};

type SidebarBadgeCounts = Partial<Record<SidebarBadgeKey, number>>;

// Returns the localStorage key used to store the dismissed count for a badge.
function getBadgeDismissKey(role: string, key: SidebarBadgeKey) {
    return `sidebarBadgeDismissed:${role}:${key}`;
}

function getDismissedCount(role: string, key: SidebarBadgeKey): number {
    if (typeof window === 'undefined') return 0;
    try {
        return Number(window.localStorage.getItem(getBadgeDismissKey(role, key)) || 0);
    } catch {
        return 0;
    }
}

function setDismissedCount(role: string, key: SidebarBadgeKey, count: number) {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(getBadgeDismissKey(role, key), String(count));
    } catch {
        // ignore
    }
}

function isOpenTaskStatus(status: unknown, workflowStatus: unknown = '') {
    const statusValue = String(status || '').trim().toLowerCase();
    const workflowValue = String(workflowStatus || '').trim().toLowerCase();
    if (['completed', 'cancelled', 'archived'].includes(statusValue)) return false;
    if (['completed', 'cancelled'].includes(workflowValue)) return false;
    return true;
}

function countListItems(payload: any): number {
    if (Array.isArray(payload)) return payload.length;
    if (Array.isArray(payload?.data)) return payload.data.length;
    if (Array.isArray(payload?.items)) return payload.items.length;
    if (Array.isArray(payload?.data?.items)) return payload.data.items.length;
    if (Array.isArray(payload?.data?.rows)) return payload.data.rows.length;
    return Number(payload?.count || payload?.data?.count || 0) || 0;
}

export default function Sidebar({
    collapsed,
    role,
    featureAccess,
    mobile = false,
    mobileOpen = false,
    onNavigate,
}: SidebarProps) {
    const router = useRouter();
    const currentPath = router.pathname;
    const assetBasePath = router.basePath || '';
    const navRef = React.useRef<HTMLElement | null>(null);
    const longPressTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const normalizedRole = String(role || '').trim().toLowerCase();
    const roleClassName =
        normalizedRole === 'admin'
            ? styles.sidebarRoleAdmin
            : normalizedRole === 'manager'
                ? styles.sidebarRoleManager
                : normalizedRole === 'staff'
                    ? styles.sidebarRoleStaff
                    : '';
    const isCollapsed = mobile ? false : collapsed;
    const sidebarScrollStorageKey = `sidebarNavScroll:${mobile ? 'mobile' : 'desktop'}:${normalizedRole || 'anonymous'}`;
    const [badgeCounts, setBadgeCounts] = React.useState<SidebarBadgeCounts>({});
    // Collapsed-rail hover label ("<" arrow + title) rendered in a body
    // portal so no scroll container can clip it. { label, centerY }.
    const [railTip, setRailTip] = React.useState<{ label: string; centerY: number } | null>(null);
    const showRailTip = (label: string) => (e: React.SyntheticEvent<HTMLElement>) => {
        if (!isCollapsed || typeof window === 'undefined') return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        setRailTip({ label, centerY: r.top + r.height / 2 });
    };
    const hideRailTip = () => setRailTip(null);
    // Mirror of localStorage dismissed counts kept in state so hasDot re-renders correctly.
    const [dismissedCounts, setDismissedCounts] = React.useState<Partial<Record<SidebarBadgeKey, number>>>(() => {
        if (typeof window === 'undefined') return {};
        const initRole = String(role || '').trim().toLowerCase();
        const keys: SidebarBadgeKey[] = ['my_tasks', 'tasks_board', 'leave_requests', 'overtime_requests', 'cash_advance', 'edit_requests', 'projects'];
        const initial: Partial<Record<SidebarBadgeKey, number>> = {};
        keys.forEach((k) => { initial[k] = getDismissedCount(initRole, k); });
        return initial;
    });
    const API_BASE = React.useMemo(() => getApiBaseUrl(), []);

    const isActive = (path: string) => currentPath === path;

    // Map from sidebar path â†’ the badge key(s) it owns.
    const PATH_BADGE_KEYS: Record<string, SidebarBadgeKey[]> = {
        '/my-tasks':          ['my_tasks'],
        '/tasks':             ['tasks_board'],
        '/projects':          ['projects'],
        '/projects/detail':   ['projects'],
        '/leave-requests':    ['leave_requests'],
        '/overtime-requests': ['overtime_requests'],
        '/cash-advance':      ['cash_advance'],
        '/edit-requests':     ['edit_requests'],
    };

    // Persist dismissed count to both localStorage and React state.
    const dismiss = React.useCallback((key: SidebarBadgeKey, count: number) => {
        setDismissedCount(normalizedRole, key, count);
        setDismissedCounts((prev) => ({ ...prev, [key]: count }));
    }, [normalizedRole]);

    // Dot shows only when apiCount > dismissedCount (new items since last visit).
    const hasDot = React.useCallback((key: SidebarBadgeKey): boolean => {
        const count = Number(badgeCounts[key] || 0);
        if (count <= 0) return false;
        return count > Number(dismissedCounts[key] || 0);
    }, [badgeCounts, dismissedCounts]);

    // When the user navigates to a page, immediately dismiss using the current in-state count.
    React.useEffect(() => {
        const keys = PATH_BADGE_KEYS[currentPath];
        if (!keys || keys.length === 0) return;
        keys.forEach((key) => {
            dismiss(key, Number(badgeCounts[key] || 0));
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [currentPath, normalizedRole]);

    React.useEffect(() => {
        if (!SIDEBAR_BADGES_ENABLED) {
            setBadgeCounts({});
            return;
        }

        if (!normalizedRole || !['manager', 'staff', 'admin'].includes(normalizedRole)) {
            setBadgeCounts({});
            return;
        }

        let active = true;
        const controller = new AbortController();
        const abortReason = new DOMException('Sidebar unmounted', 'AbortError');

        const loadBadgeCounts = async () => {
            try {
                const next: SidebarBadgeCounts = {};
                const requests: Array<Promise<void>> = [];

                if (normalizedRole === 'staff' || normalizedRole === 'manager' || normalizedRole === 'admin') {
                    requests.push((async () => {
                        try {
                            const endpoint = normalizedRole === 'manager' || normalizedRole === 'admin'
                                ? `${API_BASE}/task-workflow.php?action=my_tasks`
                                : `${API_BASE}/tasks.php?include_collaborations=1`;
                            const res = await fetch(endpoint, { credentials: 'include', signal: controller.signal });
                            const data = await res.json();
                            // task-workflow returns data.data.tasks; tasks.php returns data.data
                            const rawList = Array.isArray(data?.data?.tasks)
                                ? data.data.tasks
                                : (Array.isArray(data?.data) ? data.data : []);
                            const openTasks = rawList.filter((task: any) => isOpenTaskStatus(task?.status, task?.workflow_status));
                            next.my_tasks = openTasks.length;
                            next.tasks_board = openTasks.length;

                            if (normalizedRole === 'manager') {
                                next.projects = rawList.filter((task: any) => {
                                    const workflow = String(task?.workflow_status || '').toLowerCase();
                                    const unassigned = !Number(task?.assigned_to || 0);
                                    return unassigned || ['pending_manager', 'not_started', 'in_progress', 'rejected_by_manager'].includes(workflow);
                                }).length;
                            } else {
                                next.projects = openTasks.length;
                            }
                        } catch {
                            // ignore badge fetch failures
                        }
                    })());
                }

                if (normalizedRole === 'manager' || normalizedRole === 'admin') {
                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/leave-requests.php?status=pending`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.leave_requests = countListItems(data);
                        } catch { /* ignore */ }
                    })());

                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/overtime-requests.php?status=submitted`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.overtime_requests = countListItems(data);
                        } catch { /* ignore */ }
                    })());

                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/cash-advance-requests.php?status=submitted`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.cash_advance = countListItems(data);
                        } catch { /* ignore */ }
                    })());
                }

                if (normalizedRole === 'staff') {
                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/leave-requests.php?status=pending`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.leave_requests = countListItems(data);
                        } catch { /* ignore */ }
                    })());

                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/overtime-requests.php?status=submitted`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.overtime_requests = countListItems(data);
                        } catch { /* ignore */ }
                    })());

                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/cash-advance-requests.php?status=submitted`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            next.cash_advance = countListItems(data);
                        } catch { /* ignore */ }
                    })());
                }

                if (normalizedRole === 'admin') {
                    requests.push((async () => {
                        try {
                            const res = await fetch(`${API_BASE}/edit-requests.php`, {
                                credentials: 'include',
                                signal: controller.signal,
                            });
                            const data = await res.json();
                            const rows = Array.isArray(data?.data?.active_items)
                                ? data.data.active_items
                                : (Array.isArray(data?.data)
                                    ? data.data
                                    : (Array.isArray(data?.data?.items) ? data.data.items : []));
                            next.edit_requests = rows.filter((row: any) => {
                                const status = String(row?.status || row?.request_status || '').toLowerCase();
                                return !status || status === 'pending' || status === 'submitted';
                            }).length || Number(data?.data?.summary?.pending || 0) || countListItems(data);
                        } catch { /* ignore */ }
                    })());
                }

                await Promise.all(requests);

                // After counts load, re-dismiss the current page so the dot
                // never shows for items that were already there on arrival.
                const activeKeys = PATH_BADGE_KEYS[currentPath];
                if (activeKeys) {
                    activeKeys.forEach((key) => {
                        dismiss(key, Number(next[key] || 0));
                    });
                }

                if (active) setBadgeCounts(next);
            } catch (err: unknown) {
                if ((err as { name?: string })?.name === 'AbortError' || (err as DOMException)?.code === DOMException.ABORT_ERR) return;
                if (active) setBadgeCounts({});
            }
        };

        const runBadgeCounts = () => {
            if (controller.signal.aborted) return;
            loadBadgeCounts().catch((err) => {
                if (err?.name === 'AbortError' || (err as DOMException)?.code === DOMException.ABORT_ERR) return;
                console.error(err);
            });
        };
        // Delay the initial badge fetch by 1.5 s so it doesn't race with the
        // page's own data requests on mount, keeping PHP connections free.
        const initialTimer = window.setTimeout(runBadgeCounts, 1500);
        const intervalId = window.setInterval(runBadgeCounts, 60000);

        return () => {
            active = false;
            window.clearTimeout(initialTimer);
            window.clearInterval(intervalId);
            controller.abort(abortReason);
        };
    }, [API_BASE, currentPath, normalizedRole]);
    const menuSections: Array<{ title: string; items: SidebarItem[] }> = [
        {
            title: 'MAIN',
            items: [
                {
                    label: 'Dashboard',
                    path: normalizedRole === 'admin'
                        ? '/admin/dashboard'
                        : normalizedRole === 'manager'
                            ? '/manager/dashboard'
                            : '/dashboard',
                    roles: ['admin', 'manager', 'staff'],
                    icon: (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="7" height="7"></rect>
                            <rect x="14" y="3" width="7" height="7"></rect>
                            <rect x="14" y="14" width="7" height="7"></rect>
                            <rect x="3" y="14" width="7" height="7"></rect>
                        </svg>
                    )
                },
                {
                    label: 'Calendar',
                    path: '/calendar',
                    featureKey: 'calendar',
                    roles: ['admin', 'manager', 'staff'],
                    icon: (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                            <line x1="16" y1="2" x2="16" y2="6"></line>
                            <line x1="8" y1="2" x2="8" y2="6"></line>
                            <line x1="3" y1="10" x2="21" y2="10"></line>
                            <path d="M8 14h.01"></path>
                            <path d="M12 14h.01"></path>
                            <path d="M16 14h.01"></path>
                            <path d="M8 18h.01"></path>
                            <path d="M12 18h.01"></path>
                            <path d="M16 18h.01"></path>
                        </svg>
                    )
                },
                {
                    label: 'Analytics',
                    path: '/analytics',
                    featureKey: 'analytics',
                    roles: ['staff'],
                    icon: (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="20" x2="18" y2="10"></line>
                            <line x1="12" y1="20" x2="12" y2="4"></line>
                            <line x1="6" y1="20" x2="6" y2="14"></line>
                        </svg>
                    )
                }
            ]
        },
        {
            title: 'MY WORK',
            items: [
                {
                    label: 'My Tasks',
                    path: '/my-tasks',
                    featureKey: 'my_tasks',
                    badgeKey: 'my_tasks',
                    roles: ['manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                },
                {
                    label: 'Tasks Board',
                    path: '/tasks',
                    featureKey: 'tasks_board',
                    badgeKey: 'tasks_board',
                    roles: ['manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>
                },
                {
                    label: 'Leave Requests',
                    path: '/leave-requests',
                    featureKey: 'leave_requests',
                    badgeKey: 'leave_requests',
                    roles: ['manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 7l-8 8-4-4"></path><path d="M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"></path></svg>
                },
                {
                    label: 'My Payslips',
                    path: '/my-payslips',
                    featureKey: 'my_payslips',
                    roles: ['admin', 'manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="3" y1="10" x2="21" y2="10"></line><path d="M8 15h3"></path><path d="M13 15h3"></path></svg>
                }
            ]
        },
        {
            title: 'MASTER FILES',
            items: [
                {
                    label: 'Client',
                    path: '/clients',
                    featureKey: 'clients',
                    roles: ['admin', 'manager'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>
                },
                {
                    label: 'Service',
                    path: '/services',
                    featureKey: 'services',
                    roles: ['admin', 'manager'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>
                },
                {
                    label: 'Contracts',
                    path: '/contracts',
                    featureKey: 'contract_management',
                    roles: ['admin', 'manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                },
                {
                    label: 'Documents',
                    path: '/documents',
                    featureKey: 'documents',
                    roles: ['admin', 'manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                },
                {
                    label: 'Employees',
                    path: '/users',
                    roles: ['admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                },
                {
                    label: 'Branch',
                    path: '/branches',
                    roles: ['admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>
                },

            ]
        },
        {
            title: 'TRANSACTION FILES',
            items: [
                {
                    label: 'Project',
                    path: '/projects',
                    featureKey: 'projects',
                    badgeKey: 'projects',
                    roles: ['admin', 'manager', 'staff'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
                },
                {
                    label: 'Payroll',
                    path: '/payroll-management',
                    featureKey: 'payroll',
                    roles: ['admin', 'manager'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>
                },
                {
                    label: 'Overtime Requests',
                    path: '/overtime-requests',
                    featureKey: 'overtime_requests',
                    badgeKey: 'overtime_requests',
                    roles: ['manager', 'staff', 'admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v4l3 3"></path><circle cx="12" cy="12" r="9"></circle><path d="M19 5l2 2"></path></svg>
                },
                {
                    label: 'Cash Advance',
                    path: '/cash-advance',
                    featureKey: 'cash_advance',
                    badgeKey: 'cash_advance',
                    roles: ['manager', 'staff', 'admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 1v22"></path><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7H14.5a3.5 3.5 0 0 1 0 7H6"></path></svg>
                },
                {
                    label: 'Profile Edit Request',
                    path: '/edit-requests',
                    featureKey: 'edit_requests',
                    badgeKey: 'edit_requests',
                    roles: ['admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path></svg>
                },
                {
                    label: 'Leave Approvals',
                    path: '/leave-requests',
                    badgeKey: 'leave_requests',
                    roles: ['admin'],
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 11 12 14 22 4"></polyline><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>
                }
            ]
        },
        {
            title: 'SYSTEM',
            items: [
                {
                    label: 'Reports',
                    path: '/reports',
                    roles: ['admin', 'manager'],
                    icon: (
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M8 6h13"></path>
                            <path d="M8 12h13"></path>
                            <path d="M8 18h13"></path>
                            <path d="M3 6h.01"></path>
                            <path d="M3 12h.01"></path>
                            <path d="M3 18h.01"></path>
                        </svg>
                    )
                }
            ]
        }
    ];

    // Filter menu items based on user role
    const filteredSections = menuSections
        .map(section => ({
            ...section,
            items: section.items.filter((item) => {
                if (!normalizedRole || !item.roles.includes(normalizedRole)) {
                    return false;
                }

                return hasRoleFeatureAccess(
                    normalizedRole,
                    (item.featureKey || null) as RoleFeatureKey | null,
                    featureAccess,
                );
            })
        }))
        .filter(section => section.items.length > 0);
    const accessiblePaths = (() => {
        const paths = new Set<string>();
        filteredSections.forEach((section) => {
            section.items.forEach((item) => {
                if (item.path) {
                    paths.add(item.path);
                }
            });
        });
        return Array.from(paths);
    })();
    const accessiblePathsSignature = accessiblePaths.join('|');

    // State for collapsible sections
    const [openSections, setOpenSections] = React.useState<Record<string, boolean>>(getInitialOpenSections);

    const toggleSection = (title: string) => {
        setOpenSections(prev => {
            const newState = { ...prev, [title]: !prev[title] };
            try {
                window.localStorage.setItem('sidebarSectionsState', JSON.stringify(newState));
            } catch {
                // Ignore storage access failures.
            }
            return newState;
        });
    };

    const saveSidebarScroll = React.useCallback(() => {
        if (typeof window === 'undefined') return;

        try {
            window.sessionStorage.setItem(
                sidebarScrollStorageKey,
                String(navRef.current?.scrollTop ?? 0),
            );
        } catch {
            // Ignore storage access failures.
        }
    }, [sidebarScrollStorageKey]);

    const restoreSidebarScroll = React.useCallback(() => {
        if (typeof window === 'undefined' || !navRef.current) return;

        try {
            const savedScrollTop = Number(window.sessionStorage.getItem(sidebarScrollStorageKey) || 0);
            if (!Number.isFinite(savedScrollTop) || savedScrollTop < 0) return;

            navRef.current.scrollTop = savedScrollTop;
        } catch {
            // Ignore storage access failures.
        }
    }, [sidebarScrollStorageKey]);

    React.useEffect(() => {
        restoreSidebarScroll();

        if (typeof window === 'undefined') return;

        const animationFrameId = window.requestAnimationFrame(restoreSidebarScroll);
        return () => {
            window.cancelAnimationFrame(animationFrameId);
        };
    }, [accessiblePathsSignature, currentPath, isCollapsed, openSections, restoreSidebarScroll]);

    React.useEffect(() => {
        router.events.on('routeChangeStart', saveSidebarScroll);

        return () => {
            saveSidebarScroll();
            router.events.off('routeChangeStart', saveSidebarScroll);
        };
    }, [router.events, saveSidebarScroll]);

    const clearLogoPressTimer = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
    }, []);

    const startLogoLongPress = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        if (normalizedRole !== 'admin') return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;

        clearLogoPressTimer();

        longPressTimerRef.current = setTimeout(() => {
            router.push('/create.admin');
        }, 5000);
    }, [clearLogoPressTimer, normalizedRole, router]);

    const stopLogoLongPress = React.useCallback(() => {
        clearLogoPressTimer();
    }, [clearLogoPressTimer]);

    React.useEffect(() => {
        return () => {
            clearLogoPressTimer();
        };
    }, [clearLogoPressTimer]);

    const handleWarmRoute = React.useCallback((path: string, warmData = false) => {
        if (!path || path === currentPath) return;
        warmRoute(router, path);
        if (warmData) warmRouteData(path);
    }, [currentPath, router]);

    return (
        <div
            className={`${styles.sidebar} ${roleClassName} ${isCollapsed ? styles.sidebarCollapsed : styles.sidebarExpanded} ${mobile ? styles.sidebarMobile : ''} ${mobile && mobileOpen ? styles.sidebarMobileOpen : ''}`}
            aria-hidden={mobile && !mobileOpen}
        >
            <div
                className={styles.logoArea}
                onPointerDown={startLogoLongPress}
                onPointerUp={stopLogoLongPress}
                onPointerLeave={stopLogoLongPress}
                onPointerCancel={stopLogoLongPress}
            >
                <img
                    src={`${assetBasePath}/logo.png`}
                    alt="Logo"
                    className={styles.logoImage}
                    width={36}
                    height={36}
                />
                <span className={styles.logoText}>LLB Accountants</span>
            </div>

            <nav ref={navRef} className={styles.nav} onScroll={() => { hideRailTip(); saveSidebarScroll(); }}>
                {filteredSections.map((section, sIndex) => {
                    // Check if section should be open. If sidebar is collapsed (minimized), default to closed OR open? 
                    // Usually collapsed sidebar hides headers so hierarchy is flat or icons only.
                    // User request: "dropdown btn".
                    // If sidebar is collapsed (minimized width), we typically confuse users if we hide items inside a hidden category.
                    // So let's force OPEN if collapsed.
                    const isOpen = isCollapsed ? true : (openSections[section.title] ?? true);
                    const sectionItemCountStyle = { '--section-items-count': section.items.length } as React.CSSProperties;

                    return (
                        <div key={sIndex}>
                            <div
                                className={styles.sectionHeader}
                                onClick={() => !isCollapsed && toggleSection(section.title)}
                                style={{
                                    cursor: isCollapsed ? 'default' : 'pointer',
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between'
                                }}
                            >
                                {isCollapsed ? '' : section.title}
                                {!isCollapsed && (
                                    <span style={{ display: 'inline-flex', alignItems: 'center', opacity: 0.85, transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform 250ms ease' }} aria-hidden="true">
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                                            <polyline points="6 9 12 15 18 9" />
                                        </svg>
                                    </span>
                                )}
                            </div>

                            <div
                                className={`${styles.sectionItems} ${isOpen ? styles.sectionItemsOpen : styles.sectionItemsClosed}`}
                                style={sectionItemCountStyle}
                            >
                                {section.items.map((item, iIndex) => {
                                    const itemIsActive = item.path ? isActive(item.path) : false;
                                    const showDot = false;
                                    const itemContent = (
                                        <div
                                            className={`${styles.navItem} ${styles.sectionButton} ${itemIsActive ? styles.activeNavItem : ''}`}
                                            onMouseEnter={showRailTip(item.label)}
                                            onMouseLeave={hideRailTip}
                                            onFocus={showRailTip(item.label)}
                                            onBlur={hideRailTip}
                                        >
                                            <div className={styles.navIcon} style={{ position: 'relative' }}>
                                                {item.icon}
                                                {showDot && (
                                                    <span className={styles.navBadgeDot} aria-label="New activity" />
                                                )}
                                            </div>
                                            <span className={styles.navText}>{item.label}</span>
                                            {showDot && (
                                                <span className={styles.navBadgeRedDot} aria-hidden="true" />
                                            )}
                                        </div>
                                    );

                                    if (item.path) {
                                        return (
                                            <Link
                                                href={item.path}
                                                key={iIndex}
                                                prefetch={false}
                                                scroll={false}
                                                style={{ textDecoration: 'none' }}
                                                onClick={() => {
                                                     saveSidebarScroll();
                                                     handleWarmRoute(item.path as string, true);
                                                    onNavigate?.();
                                                }}
                                                onMouseEnter={() => handleWarmRoute(item.path as string)}
                                                onFocus={() => handleWarmRoute(item.path as string)}
                                                onPointerDown={() => handleWarmRoute(item.path as string, true)}
                                                onTouchStart={() => handleWarmRoute(item.path as string, true)}
                                            >
                                                {itemContent}
                                            </Link>
                                        );
                                    }

                                    return null;
                                })}
                            </div>
                        </div>
                    );
                })}
            </nav>
            {isCollapsed && railTip && typeof document !== 'undefined' && createPortal(
                <div className={styles.railTip} style={{ top: railTip.centerY }} role="status" aria-label={railTip.label}>
                    {railTip.label}
                </div>,
                document.body
            )}
        </div>
    );
}
