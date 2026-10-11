import { useState, ReactNode, MouseEvent, useEffect, useMemo, useRef, useCallback, CSSProperties } from 'react';
import { DATA_MUTATED_EVENT } from '@/utils/liveSync';
import Link from 'next/link';
import { useRouter } from 'next/router';
import Sidebar from './Sidebar';
import Pagination from './Pagination';
import PasswordChangeModal from './PasswordChangeModal';
import styles from '../styles/Layout.module.css';
import { getBackendBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/notify';
import {
    getFeatureKeyForPath,
    getRoleFallbackPath,
    hasRoleFeatureAccess,
    type RoleFeatureAccessMap,
} from '@/utils/roleFeatureAccess';
import {
    countUnreadNotifications,
    getNotificationReadState,
    isNotificationRead,
    markNotificationsReadInStorage,
    markNotificationsUnreadInStorage,
    parseNotificationTimestamp,
    subscribeToNotificationReadState,
} from '@/utils/notificationReadState';
import { formatRouteLabel, getRouteBreadcrumbs } from '@/utils/routeLabels';
import { getFlipForTrigger } from '@/utils/dropdownSystem';
import { fetchManagementCalendarMaps, type DashboardCalendarEventMap } from './DashboardCalendar';

interface LayoutProps {
    children: ReactNode;
    role?: string;
    user?: {
        full_name?: string;
        username?: string;
        photo?: string | null;
        role_feature_access?: RoleFeatureAccessMap;
        [key: string]: unknown;
    } | null;
    onLogout: () => void;
}

type SecurityAlert = {
    id: string;
    kind: string;
    severity: 'high' | 'medium' | 'low';
    direction: 'inbound' | 'outbound';
    ip_address: string;
    title: string;
    message: string;
    occurred_at: string;
    action?: string;
    activity_type?: string;
    user?: string;
    username?: string;
    user_id?: number;
    user_role?: string;
    email?: string;
};

type TaskAssignmentNotificationMeta = {
    kind?: string;
    task_id?: number;
    task_title?: string;
    assigned_by_name?: string;
    assigned_by_role?: string;
    project_name?: string;
    client_name?: string;
    priority?: string;
    due_date?: string;
};

type AppNotification = {
    id: string;
    read_key?: string;
    type: string;
    title: string;
    message: string;
    severity: 'info' | 'medium' | 'high' | 'success' | string;
    occurred_at: string;
    link?: string;
    user_role?: string;
    meta?: {
        assignment?: TaskAssignmentNotificationMeta;
        [key: string]: unknown;
    };
};

const NOTIFICATION_CENTER_ITEMS_PER_PAGE = 8;
const HEADER_DATA_CACHE_TTL_MS = 30_000;

let cachedNotifications: { identity: string; items: AppNotification[]; timestamp: number } | null = null;
let cachedSecurityAlerts: { identity: string; items: SecurityAlert[]; timestamp: number } | null = null;

function parseAlertTimestamp(value: string) {
    return parseNotificationTimestamp(value);
}

function formatAlertTimestamp(value: string) {
    const ms = parseAlertTimestamp(value);
    if (!ms) return String(value || '');
    return new Date(ms).toLocaleString();
}

export default function Layout({ children, role, user, onLogout }: LayoutProps) {
    const sidebarIdentity = String(user?.id ?? user?.username ?? role ?? 'anonymous').trim().toLowerCase() || 'anonymous';
    const sidebarStorageKey = `sidebarCollapsed:${sidebarIdentity}`;
    const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
        if (typeof window === 'undefined') return false;
        try {
            return window.localStorage.getItem(sidebarStorageKey) === '1';
        } catch {
            return false;
        }
    });
    const [isMobileViewport, setIsMobileViewport] = useState(false);
    const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

    // Live-sync: fade the <main> element briefly when any mutation event fires.
    useEffect(() => {
        const FADE_OUT_MS = 180;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const handleMutated = () => {
            const el = document.querySelector('main.live-sync-fade') as HTMLElement | null;
            if (!el) return;

            el.classList.add('live-sync-refreshing');
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                el.classList.remove('live-sync-refreshing');
                timer = null;
            }, FADE_OUT_MS + 1000); // fade-out + 1s fade-in
        };

        window.addEventListener(DATA_MUTATED_EVENT, handleMutated);
        return () => {
            window.removeEventListener(DATA_MUTATED_EVENT, handleMutated);
            if (timer !== null) clearTimeout(timer);
        };
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const mediaQuery = window.matchMedia('(max-width: 1024px)');
        const applyViewport = (isMobile: boolean) => {
            setIsMobileViewport(isMobile);
            if (!isMobile) {
                setMobileSidebarOpen(false);
            }
        };

        applyViewport(mediaQuery.matches);

        const onChange = (event: MediaQueryListEvent) => {
            applyViewport(event.matches);
        };

        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', onChange);
            return () => {
                mediaQuery.removeEventListener('change', onChange);
            };
        }

        mediaQuery.addListener(onChange);
        return () => {
            mediaQuery.removeListener(onChange);
        };
    }, []);
    useEffect(() => {
        if (typeof window === 'undefined') return;

        try {
            const stored = window.localStorage.getItem(sidebarStorageKey);
            if (stored === '1') {
                setSidebarCollapsed(true);
                return;
            }
            if (stored === '0') {
                setSidebarCollapsed(false);
                return;
            }

            window.localStorage.setItem(sidebarStorageKey, sidebarCollapsed ? '1' : '0');
        } catch {
            // Ignore storage access failures.
        }
    }, [sidebarCollapsed, sidebarStorageKey]);
    const [idleWarningOpen, setIdleWarningOpen] = useState(false);
    const [idleWarningCountdown, setIdleWarningCountdown] = useState(30);
    const [isIdleAutoLoggingOut, setIsIdleAutoLoggingOut] = useState(false);
    const [notifications, setNotifications] = useState<AppNotification[]>(() => {
        if (cachedNotifications?.identity !== sidebarIdentity) return [];
        if (Date.now() - cachedNotifications.timestamp > HEADER_DATA_CACHE_TTL_MS) return [];
        return cachedNotifications.items;
    });
    const [notificationsOpen, setNotificationsOpen] = useState(false);
    // System dropdown standard — Rule 2 (flip on viewport edge) for header menus.
    const [notificationFlipUp, setNotificationFlipUp] = useState(false);
    const [profileMenuOpen, setProfileMenuOpen] = useState(false);
    const [profileFlipUp, setProfileFlipUp] = useState(false);
    const profileTriggerRef = useRef<HTMLDivElement | null>(null);
    // NOTE: flip is measured from the bell button (trigger), not the wrapper —
    // the wrapper includes the open menu and would inflate the rect.
    const notificationBellRef = useRef<HTMLButtonElement | null>(null);
    const [notificationsLoading, setNotificationsLoading] = useState(false);
    const [notificationsUnseenCount, setNotificationsUnseenCount] = useState(0);
    const [notificationReadState, setNotificationReadState] = useState<Record<string, number>>({});
    const [notificationCenterOpen, setNotificationCenterOpen] = useState(false);
    const [notificationCenterPage, setNotificationCenterPage] = useState(1);
    // Track filter combination so page auto-resets when filters change (avoids set-state-in-effect)
    const [notificationCenterFilterKey, setNotificationCenterFilterKey] = useState('');
    const [notificationCenterTypeFilter, setNotificationCenterTypeFilter] = useState('all');
    const [notificationCenterSeverityFilter, setNotificationCenterSeverityFilter] = useState('all');
    const [notificationCenterDateFilter, setNotificationCenterDateFilter] = useState('all');
    const [notificationCenterReadFilter, setNotificationCenterReadFilter] = useState('all');
    const [notificationCenterUserRoleFilter, setNotificationCenterUserRoleFilter] = useState('all');
    const [notificationCenterSearch, setNotificationCenterSearch] = useState('');
    const [selectedNotification, setSelectedNotification] = useState<AppNotification | null>(null);
    const [securityCenterOpen, setSecurityCenterOpen] = useState(false);
    const [securityCenterPage, setSecurityCenterPage] = useState(1);
    const [securityCenterFilterKey, setSecurityCenterFilterKey] = useState('');
    const [securityCenterSeverityFilter, setSecurityCenterSeverityFilter] = useState('all');
    const [securityCenterUserRoleFilter, setSecurityCenterUserRoleFilter] = useState('all');
    const [securityCenterSearch, setSecurityCenterSearch] = useState('');
    const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>(() => {
        if (cachedSecurityAlerts?.identity !== sidebarIdentity) return [];
        if (Date.now() - cachedSecurityAlerts.timestamp > HEADER_DATA_CACHE_TTL_MS) return [];
        return cachedSecurityAlerts.items;
    });
    const [securityAlertsOpen, setSecurityAlertsOpen] = useState(false);
    const [securityAlertsLoading, setSecurityAlertsLoading] = useState(false);
    const [securityAlertsUnseenCount, setSecurityAlertsUnseenCount] = useState(0);
    const [selectedSecurityAlert, setSelectedSecurityAlert] = useState<SecurityAlert | null>(null);
    const [isPageRefreshing, setIsPageRefreshing] = useState(false);
    const [lockdownEnabled, setLockdownEnabled] = useState(false);
    const [lockdownReason, setLockdownReason] = useState('');
    const [lockdownUpdatedAt, setLockdownUpdatedAt] = useState('');
    const [passwordChangeOpen, setPasswordChangeOpen] = useState(false);
    const [passwordChangeReason, setPasswordChangeReason] = useState<'manual' | 'expired' | 'first_login'>('manual');
    const router = useRouter();
    const breadcrumbRole = typeof role === 'string'
        ? role
        : typeof user?.role === 'string'
            ? user.role
            : undefined;
    const routeBreadcrumbs = useMemo(() => {
        return getRouteBreadcrumbs(router.asPath || router.pathname, breadcrumbRole);
    }, [breadcrumbRole, router.asPath, router.pathname]);
    const API_BASE_URL = getBackendBaseUrl();

    // ── Today's calendar events for header banner ────────────────────────────
    const [todayCalendarEvents, setTodayCalendarEvents] = useState<DashboardCalendarEventMap[string] | null>(null);
    const [todayEventModalOpen, setTodayEventModalOpen] = useState(false);
    useEffect(() => {
        // Layout renders once while AuthProvider is still resolving. Waiting
        // for an authenticated user avoids four guaranteed 401 requests and
        // ensures the calendar actually loads after authentication succeeds.
        if (!user?.id) return;

        const todayStr = (() => {
            const d = new Date();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${d.getFullYear()}-${mm}-${dd}`;
        })();
        fetchManagementCalendarMaps(`${API_BASE_URL}/api`)
            .then(map => { setTodayCalendarEvents(map[todayStr] ?? null); })
            .catch(() => {});
    }, [API_BASE_URL, user?.id]);

    const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const notificationClickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastResetAtRef = useRef<number>(0);
    const resetIdleTimerRef = useRef<(() => void) | null>(null);
    const notificationsMenuRef = useRef<HTMLDivElement | null>(null);
    const notificationsRef = useRef<AppNotification[]>(notifications);
    notificationsRef.current = notifications;
    const securityAlertsRef = useRef<SecurityAlert[]>(securityAlerts);
    securityAlertsRef.current = securityAlerts;
    const notificationFetchPromiseRef = useRef<Promise<void> | null>(null);
    const securityAlertFetchPromiseRef = useRef<Promise<void> | null>(null);
    const lastNotificationAutoRefreshAtRef = useRef(0);
    const lastSecurityAlertAutoRefreshAtRef = useRef(0);
    const lastLockdownStatusRefreshAtRef = useRef(0);

    const resolvePhotoUrl = (photo: string | null | undefined) => {
        return resolveBackendAssetUrl(photo);
    };

    const photoUrl = resolvePhotoUrl(user?.photo);
    const normalizeBooleanSetting = (value: unknown, fallback = true): boolean => {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const normalized = value.trim().toLowerCase();
            if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
            if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
        }
        return fallback;
    };

    const sessionTimeoutMinutes = useMemo(() => {
        const raw = Number(user?.session_timeout_minutes ?? 30);
        if (!Number.isFinite(raw)) return 30;
        return Math.max(1, Math.min(1440, Math.trunc(raw)));
    }, [user?.session_timeout_minutes]);

    const sessionTimeoutEnabled = useMemo(
        () => normalizeBooleanSetting(user?.session_timeout_enabled, true),
        [user?.session_timeout_enabled]
    );

    const normalizedRole = String(role || user?.role || '').toLowerCase();
    const passwordStatus = (user?.password_status || null) as {
        expired?: boolean;
        requires_change?: boolean;
        reason?: string;
        days_remaining?: number | null;
        password_expires_at?: string | null;
        max_age_days?: number;
        history_count?: number;
    } | null;
    const passwordRequiresChange = Number(user?.must_reset_password ?? 0) === 1 || Boolean(passwordStatus?.requires_change);
    const passwordChangeReasonForUser = passwordRequiresChange
        ? (String(user?.password_change_reason || passwordStatus?.reason || 'expired') === 'first_login' ? 'first_login' : 'expired')
        : 'manual';
    const passwordExpiresLabel = passwordStatus?.password_expires_at
        ? `Expires ${new Date(passwordStatus.password_expires_at).toLocaleDateString()}`
        : 'Expiration not set';
    const currentFeatureKey = useMemo(
        () => getFeatureKeyForPath(router.pathname || router.asPath || ''),
        [router.asPath, router.pathname],
    );
    const canAccessCurrentFeature = useMemo(() => (
        !currentFeatureKey
        || !normalizedRole
        || hasRoleFeatureAccess(
            normalizedRole,
            currentFeatureKey,
            (user?.role_feature_access || null) as RoleFeatureAccessMap | null,
        )
    ), [currentFeatureKey, normalizedRole, user?.role_feature_access]);
    const isAdminRole = normalizedRole === 'admin';
    const isLockdownRestricted = lockdownEnabled && !isAdminRole;
    const isLogoutDisabled = lockdownEnabled;
    const normalizedLockdownReason = String(lockdownReason || '').trim();
    const displayLockdownReason =
        normalizedLockdownReason !== ''
        && normalizedLockdownReason !== 'Emergency response: lockdown mode enabled from Admin Profile & Security.'
            ? normalizedLockdownReason
            : '';
    const notificationsReadStorageKey = `notificationsRead:${sidebarIdentity}`;
    const securityAlertsLastSeenStorageKey = `securityAlertsLastSeen:${sidebarIdentity}`;
    const securityReadStorageKey = `securityAlertsRead:${sidebarIdentity}`;
    const [securityReadState, setSecurityReadState] = useState<{
        identity: string;
        items: Record<string, number>;
        legacyLastSeen: number;
    }>({ identity: '', items: {}, legacyLastSeen: 0 });

    useEffect(() => {
        const syncReadState = () => {
            let legacyLastSeen = 0;
            try {
                legacyLastSeen = Number(window.localStorage.getItem(securityAlertsLastSeenStorageKey)) || 0;
                if (!Number.isFinite(legacyLastSeen) || legacyLastSeen < 0) legacyLastSeen = 0;
            } catch {
                // Storage may be unavailable in private browsing.
            }
            setSecurityReadState({
                identity: sidebarIdentity,
                items: getNotificationReadState(securityReadStorageKey),
                legacyLastSeen,
            });
        };
        syncReadState();
        return subscribeToNotificationReadState(securityReadStorageKey, syncReadState);
    }, [securityReadStorageKey, securityAlertsLastSeenStorageKey, sidebarIdentity]);

    const isSecurityAlertRead = useCallback((alert: SecurityAlert) => {
        if (securityReadState.identity !== sidebarIdentity) return false;
        const timestamp = parseAlertTimestamp(alert.occurred_at);
        return isNotificationRead(alert, securityReadState.items)
            || (timestamp > 0 && timestamp <= securityReadState.legacyLastSeen);
    }, [securityReadState, sidebarIdentity]);
    const shouldTrackIdleTimeout =
        (normalizedRole === 'admin' || normalizedRole === 'manager' || normalizedRole === 'staff')
        && sessionTimeoutEnabled;
    const idleWarningSeconds = useMemo(() => {
        return Math.max(1, Math.ceil(Math.min(30000, sessionTimeoutMinutes * 60 * 1000) / 1000));
    }, [sessionTimeoutMinutes]);

    const closeUserDropdown = () => {
        if (typeof document === 'undefined') return;
        const dropdown = document.getElementById('userDropdown');
        if (dropdown) {
            dropdown.classList.remove(styles.open);
        }
        setProfileMenuOpen(false);
    };

    // Rule 2 — flip the notification menu upward when it would hit the viewport bottom.
    useEffect(() => {
        if (!notificationsOpen || typeof window === 'undefined') return;
        setNotificationFlipUp(getFlipForTrigger(notificationBellRef.current, 420));
        const onReposition = () => setNotificationFlipUp(getFlipForTrigger(notificationBellRef.current, 420));
        window.addEventListener('resize', onReposition);
        window.addEventListener('scroll', onReposition, true);
        return () => {
            window.removeEventListener('resize', onReposition);
            window.removeEventListener('scroll', onReposition, true);
        };
    }, [notificationsOpen]);

    useEffect(() => {
        if (!router.isReady || !normalizedRole || !currentFeatureKey || canAccessCurrentFeature) return;

        const fallbackPath = getRoleFallbackPath(normalizedRole);
        if ((router.pathname || '') === fallbackPath) return;

        void router.replace(fallbackPath);
    }, [canAccessCurrentFeature, currentFeatureKey, normalizedRole, router]);

    const canRunThrottledRefresh = useCallback((ref: { current: number }, minIntervalMs: number) => {
        const now = Date.now();
        if (now - ref.current < minIntervalMs) {
            return false;
        }
        ref.current = now;
        return true;
    }, []);

    const applyLockdownState = useCallback(() => {
        setLockdownEnabled(false);
        setLockdownReason('');
        setLockdownUpdatedAt('');
    }, []);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        try {
            const raw = window.localStorage.getItem('lockdown_state');
            if (raw) {
                JSON.parse(raw);
                applyLockdownState();
            }
        } catch {
            // Ignore storage issues.
        }
    }, [applyLockdownState]);

    useEffect(() => {
        const enabledFromUser = (user as { lockdown_enabled?: boolean } | null | undefined)?.lockdown_enabled;
        if (typeof enabledFromUser !== 'undefined') {
            setLockdownEnabled(Boolean(enabledFromUser));
        }
        const reasonFromUser = (user as { lockdown_reason?: string } | null | undefined)?.lockdown_reason;
        if (typeof reasonFromUser !== 'undefined') {
            setLockdownReason(String(reasonFromUser || ''));
        }
        const updatedFromUser = (user as { lockdown_updated_at?: string } | null | undefined)?.lockdown_updated_at;
        if (typeof updatedFromUser !== 'undefined') {
            setLockdownUpdatedAt(String(updatedFromUser || ''));
        }
    }, [user]);

    const handleLogoutClick = () => {
        closeUserDropdown();
        setNotificationsOpen(false);
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSelectedSecurityAlert(null);
        if (isLogoutDisabled) return;
        notifySuccess('Logout successful');
        onLogout();
    };

    const syncNotificationReadState = useCallback(() => {
        setNotificationReadState(getNotificationReadState(notificationsReadStorageKey));
    }, [notificationsReadStorageKey]);

    useEffect(() => {
        syncNotificationReadState();
    }, [syncNotificationReadState]);

    useEffect(() => {
        return subscribeToNotificationReadState(notificationsReadStorageKey, syncNotificationReadState);
    }, [notificationsReadStorageKey, syncNotificationReadState]);

    const deriveUnseenNotificationCount = useCallback((itemsToCount: AppNotification[], readStateOverride?: Record<string, number>) => {
        return countUnreadNotifications(itemsToCount, readStateOverride ?? notificationReadState);
    }, [notificationReadState]);

    const markNotificationsAsRead = useCallback((itemsOverride?: AppNotification[]) => {
        const list = itemsOverride ?? notificationsRef.current;
        if (!Array.isArray(list) || list.length === 0) {
            setNotificationsUnseenCount(deriveUnseenNotificationCount(Array.isArray(list) ? list : notificationsRef.current));
            return;
        }

        const nextReadState = markNotificationsReadInStorage(notificationsReadStorageKey, list);
        setNotificationReadState(nextReadState);
        setNotificationsUnseenCount(deriveUnseenNotificationCount(list, nextReadState));
    }, [deriveUnseenNotificationCount, notificationsReadStorageKey]);

    const markNotificationsAsUnread = useCallback((itemsOverride?: AppNotification[]) => {
        const list = itemsOverride ?? notificationsRef.current;
        if (!Array.isArray(list) || list.length === 0) return;

        const nextReadState = markNotificationsUnreadInStorage(notificationsReadStorageKey, list);
        setNotificationReadState(nextReadState);
        setNotificationsUnseenCount(deriveUnseenNotificationCount(notificationsRef.current, nextReadState));
    }, [deriveUnseenNotificationCount, notificationsReadStorageKey]);

    const isReadNotification = useCallback((notification: AppNotification) => {
        return isNotificationRead(notification, notificationReadState);
    }, [notificationReadState]);

    const fetchNotifications = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
        if (notificationFetchPromiseRef.current) {
            return notificationFetchPromiseRef.current;
        }

        const runRequest = async () => {
            if (!silent) {
                setNotificationsLoading(true);
            }

            try {
                const res = await fetch(`${API_BASE_URL}/api/notifications.php`, {
                    credentials: 'include',
                });
                const data = await res.json();
                const nextNotifications = Array.isArray(data?.data) ? (data.data as AppNotification[]) : [];
                cachedNotifications = {
                    identity: sidebarIdentity,
                    items: nextNotifications,
                    timestamp: Date.now(),
                };
                setNotifications(nextNotifications);
            } catch {
                if (!silent) {
                    setNotifications([]);
                    setNotificationsUnseenCount(0);
                }
            }

            if (!silent) {
                setNotificationsLoading(false);
            }
            notificationFetchPromiseRef.current = null;
        };

        const request = runRequest();

        notificationFetchPromiseRef.current = request;
        return request;
    }, [API_BASE_URL, sidebarIdentity]);

    const deriveUnseenAlertCount = useCallback((alerts: SecurityAlert[]) => {
        return alerts.reduce((count, alert) => {
            return isSecurityAlertRead(alert) ? count : count + 1;
        }, 0);
    }, [isSecurityAlertRead]);

    const markSecurityAlertsAsRead = useCallback((alertsOverride?: SecurityAlert[]) => {
        if (typeof window === 'undefined') return;
        const list = alertsOverride ?? securityAlertsRef.current;
        if (!Array.isArray(list) || list.length === 0) {
            setSecurityAlertsUnseenCount(0);
            return;
        }

        const items = markNotificationsReadInStorage(securityReadStorageKey, list);
        setSecurityReadState((previous) => ({ ...previous, identity: sidebarIdentity, items }));
    }, [securityReadStorageKey, sidebarIdentity]);

    const fetchSecurityAlerts = useCallback(async ({ silent = false }: { silent?: boolean } = {}) => {
        if (!isAdminRole) return;

        if (securityAlertFetchPromiseRef.current) {
            return securityAlertFetchPromiseRef.current;
        }

        const runRequest = async () => {
            if (!silent) {
                setSecurityAlertsLoading(true);
            }

            try {
                const res = await fetch(`${API_BASE_URL}/api/security-control.php?action=alerts&limit=20`, {
                    credentials: 'include',
                });
                const data = await res.json();
                const alerts = Array.isArray(data?.data?.alerts) ? (data.data.alerts as SecurityAlert[]) : [];
                const lockdown = data?.data?.lockdown;
                cachedSecurityAlerts = {
                    identity: sidebarIdentity,
                    items: alerts,
                    timestamp: Date.now(),
                };
                setSecurityAlerts(alerts);
                if (typeof lockdown?.enabled !== 'undefined') {
                    applyLockdownState();
                }
            } catch {
                if (!silent) {
                    setSecurityAlerts([]);
                    setSecurityAlertsUnseenCount(0);
                }
            }

            if (!silent) {
                setSecurityAlertsLoading(false);
            }
            securityAlertFetchPromiseRef.current = null;
        };

        const request = runRequest();

        securityAlertFetchPromiseRef.current = request;
        return request;
    }, [API_BASE_URL, applyLockdownState, isAdminRole, sidebarIdentity]);

    const securityUnseenCountDerived = deriveUnseenAlertCount(securityAlerts);
    if (securityUnseenCountDerived !== securityAlertsUnseenCount) {
        setSecurityAlertsUnseenCount(securityUnseenCountDerived);
    }


    // Derive unseen count inline — avoids a set-state-in-effect
    const notificationsUnseenCountDerived = useMemo(
        () => deriveUnseenNotificationCount(notifications),
        [deriveUnseenNotificationCount, notifications],
    );
    if (notificationsUnseenCountDerived !== notificationsUnseenCount) {
        setNotificationsUnseenCount(notificationsUnseenCountDerived);
    }

    const clearIdleTimers = useCallback(() => {
        if (warningTimerRef.current) {
            clearTimeout(warningTimerRef.current);
            warningTimerRef.current = null;
        }
        if (logoutTimerRef.current) {
            clearTimeout(logoutTimerRef.current);
            logoutTimerRef.current = null;
        }
        if (countdownTimerRef.current) {
            clearInterval(countdownTimerRef.current);
            countdownTimerRef.current = null;
        }
    }, []);

    const executeIdleAutoLogout = useCallback(async () => {
        if (isIdleAutoLoggingOut) return;
        setIsIdleAutoLoggingOut(true);
        setIdleWarningOpen(false);
        setNotificationsOpen(false);
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        clearIdleTimers();
        closeUserDropdown();
        try {
            await Promise.resolve(onLogout());
        } catch {
            setIsIdleAutoLoggingOut(false);
        }
    }, [clearIdleTimers, closeUserDropdown, isIdleAutoLoggingOut, onLogout]);

    const executeIdleAutoLogoutRef = useRef(executeIdleAutoLogout);
    executeIdleAutoLogoutRef.current = executeIdleAutoLogout;

    useEffect(() => {
        if (!normalizedRole) {
            setNotifications([]);
            setNotificationsUnseenCount(0);
            setNotificationsOpen(false);
            setNotificationCenterOpen(false);
            setSelectedNotification(null);
            return;
        }

        const refreshNotifications = (silent: boolean, autoTriggered = false) => {
            if (autoTriggered && !canRunThrottledRefresh(lastNotificationAutoRefreshAtRef, 10000)) {
                return;
            }
            void fetchNotifications({ silent });
        };
        const handleWindowFocus = () => {
            refreshNotifications(true, true);
        };
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                refreshNotifications(true, true);
            }
        };

        const freshCachedNotifications = cachedNotifications?.identity === sidebarIdentity
            && Date.now() - cachedNotifications.timestamp <= HEADER_DATA_CACHE_TTL_MS
            ? cachedNotifications
            : null;
        if (freshCachedNotifications) {
            setNotifications(freshCachedNotifications.items);
            setNotificationsUnseenCount(deriveUnseenNotificationCount(freshCachedNotifications.items));
        } else {
            refreshNotifications(false);
        }
        window.addEventListener('focus', handleWindowFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('focus', handleWindowFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [canRunThrottledRefresh, deriveUnseenNotificationCount, fetchNotifications, normalizedRole, sidebarIdentity]);

    useEffect(() => {
        if (!shouldTrackIdleTimeout || isIdleAutoLoggingOut) {
            clearIdleTimers();
            return;
        }

        const timeoutMs = sessionTimeoutMinutes * 60 * 1000;
        const warningLeadMs = Math.min(30000, timeoutMs);
        const warningDelayMs = Math.max(0, timeoutMs - warningLeadMs);
        const warningSeconds = Math.max(1, Math.ceil(warningLeadMs / 1000));

        const armIdleTimers = () => {
            clearIdleTimers();
            setIdleWarningOpen(false);
            setIdleWarningCountdown(warningSeconds);

            warningTimerRef.current = setTimeout(() => {
                setIdleWarningOpen(true);
                void notifyWarning(`Logging out in ${warningSeconds}s.`, 3500);

                countdownTimerRef.current = setInterval(() => {
                    setIdleWarningCountdown((prev) => Math.max(1, prev - 1));
                }, 1000);
            }, warningDelayMs);

            logoutTimerRef.current = setTimeout(() => {
                void executeIdleAutoLogoutRef.current();
            }, timeoutMs);
        };

        const handleActivity = () => {
            const now = Date.now();
            if (now - lastResetAtRef.current < 1000) return;
            lastResetAtRef.current = now;
            armIdleTimers();
        };
        resetIdleTimerRef.current = armIdleTimers;

        const events: Array<keyof WindowEventMap> = ['mousemove', 'mousedown', 'keydown', 'touchstart'];
        events.forEach((eventName) => {
            window.addEventListener(eventName, handleActivity, { passive: true });
        });

        armIdleTimers();

        return () => {
            events.forEach((eventName) => {
                window.removeEventListener(eventName, handleActivity);
            });
            resetIdleTimerRef.current = null;
            clearIdleTimers();
        };
    // The effect intentionally depends only on the idle-timeout policy values.
    // Including executeIdleAutoLogout (which captures the page-provided onLogout
    // prop and changes identity on most re-renders) would tear down and re-arm the
    // timers on every Layout re-render, so the inactivity countdown could never fire.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [clearIdleTimers, isIdleAutoLoggingOut, sessionTimeoutMinutes, shouldTrackIdleTimeout]);

    useEffect(() => {
        if (!isAdminRole) {
            setSecurityAlerts([]);
            setSecurityAlertsUnseenCount(0);
            setSecurityAlertsOpen(false);
            setSelectedSecurityAlert(null);
            return;
        }

        const refreshSecurityAlerts = (silent: boolean, autoTriggered = false) => {
            if (autoTriggered && !canRunThrottledRefresh(lastSecurityAlertAutoRefreshAtRef, 12000)) {
                return;
            }
            void fetchSecurityAlerts({ silent });
        };
        const handleWindowFocus = () => {
            refreshSecurityAlerts(true, true);
        };
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                refreshSecurityAlerts(true, true);
            }
        };

        const freshCachedAlerts = cachedSecurityAlerts?.identity === sidebarIdentity
            && Date.now() - cachedSecurityAlerts.timestamp <= HEADER_DATA_CACHE_TTL_MS
            ? cachedSecurityAlerts
            : null;
        if (freshCachedAlerts) {
            setSecurityAlerts(freshCachedAlerts.items);
            setSecurityAlertsUnseenCount(deriveUnseenAlertCount(freshCachedAlerts.items));
        } else {
            refreshSecurityAlerts(false);
        }
        window.addEventListener('focus', handleWindowFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            window.removeEventListener('focus', handleWindowFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [canRunThrottledRefresh, deriveUnseenAlertCount, fetchSecurityAlerts, isAdminRole, sidebarIdentity]);

    useEffect(() => {
        if (isAdminRole) return;

        let isActive = true;
        const handleLockdownEvent = () => {
            if (!isActive) return;
            applyLockdownState();
        };
        const handleLockdownState = () => {
            if (!isActive) return;
            applyLockdownState();
        };
        const handleStorage = (event: StorageEvent) => {
            if (!isActive) return;
            if (event.key !== 'lockdown_state' || !event.newValue) return;
            try {
                JSON.parse(event.newValue);
                applyLockdownState();
            } catch {
                // Ignore parse errors.
            }
        };

        window.addEventListener('lockdown:active', handleLockdownEvent);
        window.addEventListener('lockdown:state', handleLockdownState);
        window.addEventListener('storage', handleStorage);
        const fetchLockdownStatus = async (autoTriggered = false) => {
            if (autoTriggered && !canRunThrottledRefresh(lastLockdownStatusRefreshAtRef, 15000)) {
                return;
            }
            try {
                const res = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
                await res.json();
                if (!isActive) return;
                applyLockdownState();
            } catch {
                // Keep last known lockdown state on network errors.
            }
        };
        const handleWindowFocus = () => {
            void fetchLockdownStatus(true);
        };
        const handleVisibilityChange = () => {
            if (!document.hidden) {
                void fetchLockdownStatus(true);
            }
        };

        void fetchLockdownStatus();
        window.addEventListener('focus', handleWindowFocus);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return () => {
            isActive = false;
            window.removeEventListener('lockdown:active', handleLockdownEvent);
            window.removeEventListener('lockdown:state', handleLockdownState);
            window.removeEventListener('storage', handleStorage);
            window.removeEventListener('focus', handleWindowFocus);
            document.removeEventListener('visibilitychange', handleVisibilityChange);
        };
    }, [API_BASE_URL, applyLockdownState, canRunThrottledRefresh, isAdminRole]);

    useEffect(() => {
        if ((!isLockdownRestricted && !notificationCenterOpen && !securityCenterOpen && !selectedNotification && !selectedSecurityAlert) || typeof document === 'undefined') return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [isLockdownRestricted, notificationCenterOpen, securityCenterOpen, selectedNotification, selectedSecurityAlert]);

    useEffect(() => {
        if (!notificationsOpen) return;

        const handleDocumentClick = (event: globalThis.MouseEvent) => {
            const target = event.target as HTMLElement | null;
            if (!target) return;
            if (notificationsMenuRef.current?.contains(target as Node)) return;
            // Keep dropdown open when interacting with detail / center overlays
            // opened from the list (X button, backdrop, actions all live outside
            // notificationsMenuRef, so without this the list would close).
            try {
                if (typeof target.closest === 'function') {
                    if (target.closest(`.${styles.notificationDetailOverlay}`)) return;
                    if (target.closest(`.${styles.notificationCenterOverlay}`)) return;
                }
            } catch {
                // Ignore selector errors and fall through to close.
            }
            setNotificationsOpen(false);
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                // Let the detail modal consume Escape first — keep the list open.
                if (selectedNotification || selectedSecurityAlert) return;
                setNotificationsOpen(false);
            }
        };

        document.addEventListener('mousedown', handleDocumentClick);
        window.addEventListener('keydown', handleEscape);
        return () => {
            document.removeEventListener('mousedown', handleDocumentClick);
            window.removeEventListener('keydown', handleEscape);
        };
    }, [notificationsOpen, selectedNotification, selectedSecurityAlert]);

    useEffect(() => {
        if (!notificationCenterOpen) return;

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setNotificationCenterOpen(false);
            }
        };

        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [notificationCenterOpen]);

    useEffect(() => {
        if (!securityCenterOpen) return;

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSecurityCenterOpen(false);
            }
        };

        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [securityCenterOpen]);

    useEffect(() => {
        if (!selectedNotification) return;

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSelectedNotification(null);
            }
        };

        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [selectedNotification]);

    useEffect(() => {
        return () => {
            if (notificationClickTimerRef.current) {
                clearTimeout(notificationClickTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        if (!selectedSecurityAlert) return;

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                setSelectedSecurityAlert(null);
            }
        };

        window.addEventListener('keydown', handleEscape);
        return () => {
            window.removeEventListener('keydown', handleEscape);
        };
    }, [selectedSecurityAlert]);

    const handleStaySignedIn = () => {
        if (isIdleAutoLoggingOut) return;
        lastResetAtRef.current = 0;
        setIdleWarningCountdown(idleWarningSeconds);
        setIdleWarningOpen(false);
        resetIdleTimerRef.current?.();
    };

    const toggleSidebar = () => {
        if (isMobileViewport) {
            setMobileSidebarOpen((prev) => !prev);
            return;
        }

        const next = !sidebarCollapsed;
        try {
            window.localStorage.setItem(sidebarStorageKey, next ? '1' : '0');
        } catch {
            // Ignore storage access failures.
        }
        setSidebarCollapsed(next);
    };

    const closeMobileSidebar = useCallback(() => {
        setMobileSidebarOpen(false);
    }, []);

    useEffect(() => {
        if (isMobileViewport) {
            setMobileSidebarOpen(false);
        }
    }, [isMobileViewport, router.asPath]);

    const handleRefreshCurrentPage = (event: MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        if (isPageRefreshing) return;

        setIsPageRefreshing(true);
        setNotificationsOpen(false);
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        closeUserDropdown();
        router.reload();
    };

    const handleOpenNotificationCenter = () => {
        setNotificationsOpen(false);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        setSelectedNotification(null);
        setNotificationCenterPage(1);
        setNotificationCenterTypeFilter('all');
        setNotificationCenterSeverityFilter('all');
        setNotificationCenterDateFilter('all');
        setNotificationCenterReadFilter('all');
        setNotificationCenterUserRoleFilter('all');
        setNotificationCenterSearch('');
        closeUserDropdown();
        setNotificationCenterOpen(true);
    };

    const handleCloseNotificationCenter = () => {
        setNotificationCenterOpen(false);
    };

    const handleOpenSecurityCenter = () => {
        setNotificationsOpen(false);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        setSelectedNotification(null);
        setSecurityCenterPage(1);
        setSecurityCenterSearch('');
        setSecurityCenterSeverityFilter('all');
        setSecurityCenterUserRoleFilter('all');
        closeUserDropdown();
        setSecurityCenterOpen(true);
    };

    const handleCloseSecurityCenter = () => {
        setSecurityCenterOpen(false);
    };

    const handleMarkAllNotificationsAsRead = useCallback((itemsOverride?: AppNotification[]) => {
        markNotificationsAsRead(itemsOverride ?? notificationsRef.current);
    }, [markNotificationsAsRead]);

    const handleOpenNotificationLink = (destination: string) => {
        setNotificationsOpen(false);
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        closeUserDropdown();
        void router.push(destination);
    };

    const handleOpenNotificationDetail = useCallback((notification: AppNotification) => {
        // Keep the notification dropdown open when previewing an item —
        // only explicit navigation / center open / outside click / Escape closes it.
        markNotificationsAsRead([notification]);
        setSelectedNotification(notification);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        closeUserDropdown();
    }, [closeUserDropdown, markNotificationsAsRead]);

    const handleNotificationPreviewClick = useCallback((notification: AppNotification) => {
        if (notificationClickTimerRef.current) {
            clearTimeout(notificationClickTimerRef.current);
        }

        notificationClickTimerRef.current = setTimeout(() => {
            handleOpenNotificationDetail(notification);
            notificationClickTimerRef.current = null;
        }, 220);
    }, [handleOpenNotificationDetail]);

    const handleNotificationPreviewDoubleClick = useCallback((notification: AppNotification) => {
        if (notificationClickTimerRef.current) {
            clearTimeout(notificationClickTimerRef.current);
            notificationClickTimerRef.current = null;
        }

        markNotificationsAsUnread([notification]);
    }, [markNotificationsAsUnread]);

    const handleOpenSecuritySettings = () => {
        setNotificationsOpen(false);
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(null);
        closeUserDropdown();
        void router.push('/settings');
    };

    const openPasswordChangeModal = (nextReason: 'manual' | 'expired' | 'first_login' = 'manual') => {
        closeUserDropdown();
        setNotificationsOpen(false);
        setSecurityAlertsOpen(false);
        setPasswordChangeReason(nextReason);
        setPasswordChangeOpen(true);
    };

    const handleOpenSecurityAlertDetail = (alert: SecurityAlert) => {
        markSecurityAlertsAsRead([alert]);
        // Keep the notification dropdown open when previewing an item.
        setNotificationCenterOpen(false);
        setSelectedNotification(null);
        setSecurityAlertsOpen(false);
        setSelectedSecurityAlert(alert);
        closeUserDropdown();
    };

    const getSeverityTagStyle = (severity?: SecurityAlert['severity'] | string) => {
        const normalizedSeverity = String(severity || '').toLowerCase();

        if (normalizedSeverity === 'high') {
            return { background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b' };
        }

        if (normalizedSeverity === 'medium') {
            return { background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e' };
        }

        if (normalizedSeverity === 'low') {
            return { background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#166534' };
        }

        return { background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155' };
    };

    const getNotificationSeverityTagStyle = (severity?: AppNotification['severity']) => {
        const normalizedSeverity = String(severity || '').toLowerCase();

        if (normalizedSeverity === 'high') {
            return { background: '#fff1f2', border: '1px solid #fecdd3', color: '#be123c' };
        }

        if (normalizedSeverity === 'medium') {
            return { background: '#fff7ed', border: '1px solid #fed7aa', color: '#c2410c' };
        }

        if (normalizedSeverity === 'success') {
            return { background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#166534' };
        }

        if (normalizedSeverity === 'info') {
            return { background: '#fff1f2', border: '1px solid #fecdd3', color: '#be123c' };
        }

        return { background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155' };
    };

    const formatNotificationType = (value: string) => {
        const normalized = String(value || 'general').replace(/_/g, ' ').trim();
        if (!normalized) return 'General';
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    };

    const getTaskAssignmentMeta = useCallback((notification: AppNotification | null | undefined) => {
        const assignment = notification?.meta?.assignment;
        if (!assignment || typeof assignment !== 'object') {
            return null;
        }
        const taskTitle = String(assignment.task_title || '').trim();
        const assignedBy = String(assignment.assigned_by_name || '').trim();
        if (taskTitle === '' && assignedBy === '') {
            return null;
        }
        return assignment as TaskAssignmentNotificationMeta;
    }, []);

    const formatAssignerRoleLabel = useCallback((value: string | undefined) => {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized === 'manager') return 'Manager';
        if (normalized === 'administrator' || normalized === 'admin') return 'Administrator';
        if (!normalized) return 'Administrator';
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }, []);

    const renderAssignmentMetaPanel = useCallback((notification: AppNotification, compact = false) => {
        const assignment = getTaskAssignmentMeta(notification);
        if (!assignment) return null;

        const assignedByName = String(assignment.assigned_by_name || '').trim() || 'Administrator';
        const assignedByRole = formatAssignerRoleLabel(assignment.assigned_by_role);
        const assignmentKind = String(assignment.kind || '').toLowerCase() === 'reassigned' ? 'Reassigned' : 'Assigned';
        const projectName = String(assignment.project_name || '').trim();
        const clientName = String(assignment.client_name || '').trim();
        const priority = String(assignment.priority || '').trim();
        const dueDate = String(assignment.due_date || '').trim();

        return (
            <div className={`${styles.notificationAssignmentPanel} ${compact ? styles.notificationAssignmentPanelCompact : ''}`}>
                <div className={styles.notificationAssignmentHeader}>
                    <span className={styles.notificationAssignmentBadge}>{assignmentKind}</span>
                    <span className={styles.notificationAssignmentBy}>
                        Assigned by {assignedByName} ({assignedByRole})
                    </span>
                </div>
                <div className={styles.notificationAssignmentGrid}>
                    {projectName && (
                        <span className={styles.notificationAssignmentPill}>
                            Project: {projectName}
                        </span>
                    )}
                    {clientName && (
                        <span className={styles.notificationAssignmentPill}>
                            Client: {clientName}
                        </span>
                    )}
                    {priority && (
                        <span className={styles.notificationAssignmentPill}>
                            Priority: {priority}
                        </span>
                    )}
                    {dueDate && (
                        <span className={styles.notificationAssignmentPill}>
                            Due: {dueDate}
                        </span>
                    )}
                </div>
            </div>
        );
    }, [formatAssignerRoleLabel, getTaskAssignmentMeta]);

    const matchesNotificationDateFilter = useCallback((occurredAt: unknown, filterValue: string) => {
        if (filterValue === 'all') return true;
        const raw = String(occurredAt || '').trim();
        if (!raw) return false;
        const occurred = new Date(raw);
        if (Number.isNaN(occurred.getTime())) return false;

        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfToday = new Date(startOfToday);
        endOfToday.setDate(endOfToday.getDate() + 1);

        if (filterValue === 'today') {
            return occurred >= startOfToday && occurred < endOfToday;
        }
        if (filterValue === 'yesterday') {
            const startOfYesterday = new Date(startOfToday);
            startOfYesterday.setDate(startOfYesterday.getDate() - 1);
            return occurred >= startOfYesterday && occurred < startOfToday;
        }
        if (filterValue === 'last_7_days') {
            const start = new Date(startOfToday);
            start.setDate(start.getDate() - 6);
            return occurred >= start && occurred < endOfToday;
        }
        if (filterValue === 'last_30_days') {
            const start = new Date(startOfToday);
            start.setDate(start.getDate() - 29);
            return occurred >= start && occurred < endOfToday;
        }
        return true;
    }, []);

    const visibleNotifications = useMemo(() => {
        const term = notificationCenterSearch.trim().toLowerCase();
        return notifications.filter((item) => {
            if (notificationCenterTypeFilter !== 'all' && String(item.type) !== notificationCenterTypeFilter) return false;
            if (notificationCenterSeverityFilter !== 'all' && String(item.severity) !== notificationCenterSeverityFilter) return false;
            if (!matchesNotificationDateFilter(item.occurred_at, notificationCenterDateFilter)) return false;

            const isRead = isReadNotification(item);
            if (notificationCenterReadFilter === 'unread' && isRead) return false;
            if (notificationCenterReadFilter === 'read' && !isRead) return false;

            if (notificationCenterUserRoleFilter !== 'all') {
                const itemRole = String(item.user_role || item.meta?.assignment?.assigned_by_role || '').toLowerCase();
                if (itemRole !== notificationCenterUserRoleFilter) return false;
            }

            if (term) {
                const haystack = [
                    item.title || '',
                    item.message || '',
                    item.type || '',
                    item.severity || '',
                ].join(' ').toLowerCase();
                if (!haystack.includes(term)) return false;
            }
            return true;
        });
    }, [
        isReadNotification,
        matchesNotificationDateFilter,
        notificationCenterDateFilter,
        notificationCenterReadFilter,
        notificationCenterSearch,
        notificationCenterSeverityFilter,
        notificationCenterTypeFilter,
        notificationCenterUserRoleFilter,
        notifications,
    ]);

    const visibleNotificationsUnreadCount = useMemo(() => {
        return deriveUnseenNotificationCount(visibleNotifications);
    }, [deriveUnseenNotificationCount, visibleNotifications]);

    // Reset page when filters change — derive a stable filter key, reset page when it changes
    const nextFilterKey = `${notificationCenterDateFilter}|${notificationCenterReadFilter}|${notificationCenterSearch}|${notificationCenterSeverityFilter}|${notificationCenterTypeFilter}|${notificationCenterUserRoleFilter}`;
    if (nextFilterKey !== notificationCenterFilterKey) {
        setNotificationCenterFilterKey(nextFilterKey);
        setNotificationCenterPage(1);
    }
    // Clamp page within bounds inline — no effect needed
    const totalPages = Math.max(1, Math.ceil(visibleNotifications.length / NOTIFICATION_CENTER_ITEMS_PER_PAGE));
    const effectivePage = notificationCenterPage > totalPages ? totalPages : notificationCenterPage;

    const paginatedNotifications = useMemo(() => {
        const startIndex = (effectivePage - 1) * NOTIFICATION_CENTER_ITEMS_PER_PAGE;
        return visibleNotifications.slice(startIndex, startIndex + NOTIFICATION_CENTER_ITEMS_PER_PAGE);
    }, [effectivePage, visibleNotifications]);

    const SECURITY_CENTER_ITEMS_PER_PAGE = 8;
    const visibleSecurityAlerts = useMemo(() => {
        const term = securityCenterSearch.trim().toLowerCase();
        return securityAlerts.filter((alert) => {
            if (securityCenterSeverityFilter !== 'all' && String(alert.severity) !== securityCenterSeverityFilter) return false;
            if (securityCenterUserRoleFilter !== 'all' && String(alert.user_role || '').toLowerCase() !== securityCenterUserRoleFilter) return false;
            if (term) {
                const haystack = [alert.title || '', alert.message || '', alert.user || '', alert.username || '', alert.email || '', alert.ip_address || '', alert.action || '', alert.user_role || ''].join(' ').toLowerCase();
                if (!haystack.includes(term)) return false;
            }
            return true;
        });
    }, [securityAlerts, securityCenterSearch, securityCenterSeverityFilter, securityCenterUserRoleFilter]);

    const nextSecurityFilterKey = `${securityCenterSearch}|${securityCenterSeverityFilter}|${securityCenterUserRoleFilter}`;
    if (nextSecurityFilterKey !== securityCenterFilterKey) {
        setSecurityCenterFilterKey(nextSecurityFilterKey);
        setSecurityCenterPage(1);
    }
    const securityTotalPages = Math.max(1, Math.ceil(visibleSecurityAlerts.length / SECURITY_CENTER_ITEMS_PER_PAGE));
    const effectiveSecurityPage = securityCenterPage > securityTotalPages ? securityTotalPages : securityCenterPage;
    const paginatedSecurityAlerts = useMemo(() => {
        const start = (effectiveSecurityPage - 1) * SECURITY_CENTER_ITEMS_PER_PAGE;
        return visibleSecurityAlerts.slice(start, start + SECURITY_CENTER_ITEMS_PER_PAGE);
    }, [effectiveSecurityPage, visibleSecurityAlerts]);

    return (
        <div className={styles.container}>
            <Sidebar
                collapsed={sidebarCollapsed}
                role={role}
                featureAccess={(user?.role_feature_access || null) as RoleFeatureAccessMap | null}
                mobile={isMobileViewport}
                mobileOpen={mobileSidebarOpen}
                onNavigate={closeMobileSidebar}
            />

            {isMobileViewport && mobileSidebarOpen && (
                <button
                    type="button"
                    className={styles.sidebarBackdrop}
                    aria-label="Close navigation menu"
                    onClick={closeMobileSidebar}
                />
            )}

            <div className={`${styles.mainContent} ${isMobileViewport ? styles.mainContentMobile : (sidebarCollapsed ? styles.mainContentCollapsed : styles.mainContentExpanded)}`}>
                <header className={styles.header}>
                    <button
                        type="button"
                        className={styles.toggleButton}
                        onClick={toggleSidebar}
                        aria-label={isMobileViewport ? (mobileSidebarOpen ? 'Close navigation menu' : 'Open navigation menu') : (sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar')}
                        aria-expanded={isMobileViewport ? mobileSidebarOpen : !sidebarCollapsed}
                    >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="3" y1="12" x2="21" y2="12"></line>
                            <line x1="3" y1="6" x2="21" y2="6"></line>
                            <line x1="3" y1="18" x2="21" y2="18"></line>
                        </svg>
                    </button>

                    <div className={styles.headerMeta}>
                        <nav className={styles.breadcrumbNav} aria-label="Breadcrumb">
                            <ol className={styles.breadcrumbList}>
                                {routeBreadcrumbs.map((breadcrumb, index) => {
                                    const isCurrent = index === routeBreadcrumbs.length - 1;

                                    return (
                                        <li key={`${breadcrumb.href}-${breadcrumb.label}`} className={styles.breadcrumbItem}>
                                            {isCurrent ? (
                                                <span className={styles.breadcrumbCurrent} aria-current="page">
                                                    {breadcrumb.label}
                                                </span>
                                            ) : (
                                                <Link href={breadcrumb.href} className={styles.breadcrumbLink}>
                                                    {breadcrumb.label}
                                                </Link>
                                            )}

                                            {!isCurrent && <span className={styles.breadcrumbSeparator} aria-hidden="true">&gt;</span>}
                                        </li>
                                    );
                                })}
                            </ol>
                        </nav>
                    </div>

                    {/* ── Today's calendar event ticker ───────────────────── */}
                    {todayCalendarEvents?.managementDots && todayCalendarEvents.managementDots.length > 0 && (() => {
                        const dots = todayCalendarEvents.managementDots!;
                        // Build ticker text: join all today's event labels
                        const items = dots.map(d => ({ label: d.label, color: d.color, kind: d.kind }));
                        const tickerText = items.map(i => i.label).join('  ·  ');
                        // Pick dominant color: holiday > birthday > first event color
                        const dominantItem = items.find(i => i.kind === 'holiday') ?? items.find(i => i.kind === 'birthday') ?? items[0];
                        const accentColor = dominantItem?.color ?? '#3b82f6';
                        // Kind → emoji
                        const kindIcon = (k?: string) => k === 'holiday' ? '🎉' : k === 'birthday' ? '🎂' : '📅';
                        const icon = kindIcon(dominantItem?.kind);

                        const bannerStyle: CSSProperties = {
                            flex: '1 1 0',
                            minWidth: 0,
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            background: `${accentColor}18`,
                            border: `1px solid ${accentColor}44`,
                            borderRadius: 6,
                            padding: '2px 8px 2px 6px',
                            maxWidth: 420,
                        };
                        return (
                            <button
                                type="button"
                                onClick={() => setTodayEventModalOpen(true)}
                                title="Click to see today's events"
                                style={{ ...bannerStyle, cursor: 'pointer', border: `1px solid ${accentColor}66` }}
                                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}28`; }}
                                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = `${accentColor}18`; }}
                            >
                                <span style={{ fontSize: 12, flexShrink: 0 }}>{icon}</span>
                                <div className={styles.todayEventsTicker}>
                                    <span className={styles.todayEventsTickerInner} style={{ '--ticker-color': accentColor } as CSSProperties}>
                                        {tickerText}&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;{tickerText}
                                    </span>
                                </div>
                                <span style={{ fontSize: 9, color: accentColor, fontWeight: 700, flexShrink: 0, opacity: 0.75 }}>▸</span>
                            </button>
                        );
                    })()}

                    <div className={styles.headerActions}>
                        <button
                            type="button"
                            className={`${styles.headerIconButton} ${isPageRefreshing ? styles.headerIconButtonActive : ''}`}
                            aria-label="Refresh current page"
                            title={isPageRefreshing ? 'Refreshing page...' : 'Refresh current page'}
                            onClick={handleRefreshCurrentPage}
                            disabled={isPageRefreshing}
                        >
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="23 4 23 10 17 10" />
                                <polyline points="1 20 1 14 7 14" />
                                <path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10" />
                                <path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14" />
                            </svg>
                        </button>

                        <div className={styles.notificationArea} ref={notificationsMenuRef}>
                            <button
                                ref={notificationBellRef}
                                type="button"
                                className={`${styles.notificationBellButton} ${notificationsOpen ? styles.notificationBellButtonOpen : ''}`}
                                aria-label="Notifications"
                                title="Notifications"
                                onClick={(event) => {
                                    event.stopPropagation();
                                    closeUserDropdown();
                                    setSecurityAlertsOpen(false);
                                    const nextOpen = !notificationsOpen;
                                    setNotificationsOpen(nextOpen);
                                }}
                            >
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                                    <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                                </svg>
                                {(notificationsUnseenCount + (isAdminRole ? securityAlertsUnseenCount : 0)) > 0 && (
                                    <span className={styles.notificationCountBadge}>
                                        {(notificationsUnseenCount + (isAdminRole ? securityAlertsUnseenCount : 0)) > 9 ? '9+' : (notificationsUnseenCount + (isAdminRole ? securityAlertsUnseenCount : 0))}
                                    </span>
                                )}
                            </button>

                            {notificationsOpen && (
                                <div
                                    className={`${styles.notificationDropdown} app-anim-menu${notificationFlipUp ? ' app-flip-up' : ''}`}
                                    style={notificationFlipUp ? { top: 'auto', bottom: 'calc(100% + 10px)' } : undefined}
                                >
                                    <div className={styles.notificationHeader}>
                                        <div style={{ minWidth: 0 }}>
                                            <div className={styles.notificationHeaderTitle}>Notifications</div>
                                            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>System flows &amp; security activity</div>
                                        </div>
                                        <div className={styles.notificationHeaderActions}>
                                            <button
                                                type="button"
                                                className={styles.notificationRefreshButton}
                                                disabled={(notifications.length === 0 || notificationsUnseenCount === 0) && (!isAdminRole || securityAlerts.length === 0 || securityAlertsUnseenCount === 0)}
                                                onClick={() => {
                                                    handleMarkAllNotificationsAsRead(notifications);
                                                    if (isAdminRole) markSecurityAlertsAsRead(securityAlerts);
                                                }}
                                            >
                                                Read all
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.notificationRefreshButton}
                                                onClick={() => {
                                                    void fetchNotifications({ silent: false });
                                                    if (isAdminRole) void fetchSecurityAlerts({ silent: false });
                                                }}
                                            >
                                                {(notificationsLoading || securityAlertsLoading) ? 'Refreshing...' : 'Refresh'}
                                            </button>
                                        </div>
                                    </div>

                                    {(() => {
                                        const unifiedFeed: Array<{ key: string; ts: number; kind: 'notification' | 'security'; notification?: AppNotification; alert?: SecurityAlert }> = [
                                            ...notifications.map((item) => ({ key: `notif-${item.id}`, ts: parseAlertTimestamp(item.occurred_at) || 0, kind: 'notification' as const, notification: item })),
                                            ...(isAdminRole ? securityAlerts.map((item) => ({ key: `sec-${item.id}`, ts: parseAlertTimestamp(item.occurred_at) || 0, kind: 'security' as const, alert: item })) : []),
                                        ].sort((a, b) => b.ts - a.ts);
                                        if (unifiedFeed.length === 0) {
                                            return (
                                                <div className={styles.notificationList}>
                                                    <div className={styles.notificationEmptyState}>No notifications — you&apos;re all caught up.</div>
                                                </div>
                                            );
                                        }
                                        return (
                                        <div className={styles.notificationList}>
                                        {unifiedFeed.map((entry) => {
                                            const notification = entry.notification;
                                            if (entry.kind === 'notification' && notification) {
                                                const notificationIsRead = isReadNotification(notification);
                                                return (
                                                    <button
                                                        key={notification.id}
                                                        type="button"
                                                        className={`${styles.notificationItem} ${styles.notificationItemStick} ${notificationIsRead ? styles.notificationItemRead : styles.notificationItemUnread}`}
                                                        onClick={() => handleNotificationPreviewClick(notification)}
                                                        onDoubleClick={() => handleNotificationPreviewDoubleClick(notification)}
                                                        aria-label={`Open notification: ${notification.title}`}
                                                        title={notificationIsRead ? 'Double-click to mark as unread.' : 'Click to open and mark as read.'}
                                                        style={{
                                                            backgroundColor: notificationIsRead ? '#ffffff' : '#fff7f8',
                                                            border: notificationIsRead ? '1px solid #e5e7eb' : '1px solid #fecdd3',
                                                            color: '#0f172a',
                                                        }}
                                                    >
                                                        <div className={styles.notificationAvatar} aria-hidden="true">
                                                            <span>{String(notification.title || notification.type || 'N').trim().charAt(0).toUpperCase() || 'N'}</span>
                                                        </div>
                                                        <div className={styles.notificationItemContent}>
                                                            <div className={styles.notificationItemText}>
                                                                <span className={`${styles.notificationItemTitle} llb-ellipsis`} title={notification.title}>{notification.title}</span>
                                                                <span className={`${styles.notificationItemMessage} llb-ellipsis`} title={notification.message}>{notification.message}</span>
                                                            </div>
                                                            <div className={styles.notificationItemMetaLine}>
                                                                <span className={styles.notificationItemTimestamp}>
                                                                    {formatAlertTimestamp(notification.occurred_at)}
                                                                </span>
                                                                <span className={styles.notificationReadStatus}>
                                                                    {notificationIsRead ? 'Read' : 'Unread'}
                                                                </span>
                                                            </div>
                                                        </div>
                                                        {!notificationIsRead && <span className={styles.notificationUnreadDot} aria-hidden="true" />}
                                                    </button>
                                                );
                                            }
                                            const alert = entry.alert;
                                            if (entry.kind === 'security' && alert) {
                                                        const severityStyle = getSeverityTagStyle(alert.severity);
                                                        const initial = String(alert.title || alert.severity || 'S').trim().charAt(0).toUpperCase() || 'S';
                                                        const sevColor = String(alert.severity || 'low').toLowerCase() === 'high' ? '#fecdd3' : String(alert.severity).toLowerCase() === 'medium' ? '#fde68a' : '#bbf7d0';
                                                        return (
                                                            <button
                                                                key={alert.id}
                                                                type="button"
                                                                className={`${styles.notificationItem} ${styles.notificationItemStick} ${isSecurityAlertRead(alert) ? styles.notificationItemRead : styles.notificationItemUnread}`}
                                                                onClick={() => handleOpenSecurityAlertDetail(alert)}
                                                                aria-label={`Open ${isSecurityAlertRead(alert) ? 'read' : 'unread'} security alert: ${alert.title}`}
                                                                style={{
                                                                    background: '#ffffff',
                                                                    border: '1px solid #e5e7eb',
                                                                    color: '#0f172a',
                                                                    padding: '10px 12px',
                                                                    gap: 10,
                                                                }}
                                                            >
                                                                <div className={styles.notificationAvatar} aria-hidden="true" style={{ width: 32, height: 32, fontSize: 11, background: '#f8fafc', border: `1px solid ${sevColor}`, color: '#334155', flex: '0 0 32px' }}>
                                                                    <span>{initial}</span>
                                                                </div>
                                                                <div className={styles.notificationItemContent} style={{ minWidth: 0, flex: 1, gap: 4, display: 'flex', flexDirection: 'column' }}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                                                        <span className={`${styles.notificationItemTitle} llb-ellipsis`} title={alert.title} style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, lineHeight: 1.3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{alert.title}</span>
                                                                        <span style={{ ...severityStyle, borderRadius: 999, padding: '2px 7px', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>{alert.severity}</span>
                                                                    </div>
                                                                    <span className={styles.notificationItemMessage} style={{ fontSize: 12, lineHeight: 1.4, color: '#334155', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word', whiteSpace: 'normal' }}>{alert.message}</span>
                                                                    <div className={styles.notificationItemMetaLine} style={{ fontSize: 10, gap: 4, flexWrap: 'wrap', alignItems: 'center', color: '#64748b', lineHeight: 1.3 }}>
                                                                        <span style={{ color: '#334155', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 140 }} title={alert.user || alert.username || ''}>👤 {alert.user || alert.username || (alert.email ? alert.email : 'Unknown user')}</span>
                                                                        <span style={{ color: '#cbd5e1', flexShrink: 0 }}>•</span>
                                                                        <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>IP: {alert.ip_address || 'unknown'}</span>
                                                                        <span style={{ color: '#cbd5e1', flexShrink: 0 }}>•</span>
                                                                        <span style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>{formatAlertTimestamp(alert.occurred_at)}</span>
                                                                        <span className={styles.notificationReadStatus}>{isSecurityAlertRead(alert) ? 'Read' : 'Unread'}</span>
                                                                    </div>
                                                                </div>
                                                                {!isSecurityAlertRead(alert) && <span className={styles.notificationUnreadDot} aria-hidden="true" />}
                                                            </button>
                                                );
                                            }
                                            return null;
                                        })}
                                            </div>
                                        );
                                    })()}

                                    <div className={styles.notificationFooter}>
                                        <div className={styles.notificationFooterHint}>
                                            Double-click any notification to mark it as unread.
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                            <button
                                                type="button"
                                                className={styles.notificationFooterButton}
                                                onClick={handleOpenNotificationCenter}
                                            >
                                                Open Notification Center
                                            </button>
                                            {isAdminRole && (
                                                <button
                                                    type="button"
                                                    className={styles.notificationFooterButton}
                                                    onClick={handleOpenSecurityCenter}
                                                >
                                                    Open Security Center
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div
                            className={styles.profileArea}
                            onClick={() => setSidebarCollapsed((prev) => prev)}
                        >
                            {/* Toggle Dropdown on click — Rule 1: obvious 48px trigger, clear caret, hover feedback */}
                            <div
                                ref={profileTriggerRef}
                                role="button"
                                tabIndex={0}
                                aria-haspopup="menu"
                                aria-expanded={profileMenuOpen}
                                data-open={profileMenuOpen ? 'true' : 'false'}
                                className="app-profile-trigger"
                                style={{ display: 'flex', alignItems: 'center', gap: '6px', width: '100%', borderRadius: 8, padding: '2px 6px', cursor: 'pointer' }}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setNotificationsOpen(false);
                                    setSecurityAlertsOpen(false);
                                    if (typeof document === 'undefined') return;
                                    const dropdown = document.getElementById('userDropdown');
                                    const nextOpen = !profileMenuOpen;
                                    // Rule 2 — flip upward when the menu would hit the viewport bottom.
                                    if (nextOpen) setProfileFlipUp(getFlipForTrigger(profileTriggerRef.current, 280));
                                    setProfileMenuOpen(nextOpen);
                                    if (dropdown) {
                                        dropdown.classList.toggle(styles.open, nextOpen);
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        (e.currentTarget as HTMLDivElement).click();
                                    }
                                }}
                            >
                                <div className={styles.profileIdentity}>
                                    <div style={{ fontSize: '12px', lineHeight: 1.2, color: '#666' }}>
                                        {user?.full_name || user?.username}
                                    </div>
                                    <div style={{ fontSize: '10px', lineHeight: 1.2, color: '#999' }}>
                                        Logout?
                                    </div>
                                </div>
                                <div style={{ width: '28px', height: '28px', background: '#ddd', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#555', fontWeight: 'bold', overflow: 'hidden', position: 'relative', flexShrink: 0 }}>
                                    <span>{user?.username?.[0]?.toUpperCase()}</span>
                                    {photoUrl && (
                                        <img
                                            src={photoUrl}
                                            alt="Profile"
                                            style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', inset: 0 }}
                                            onError={(e) => { (e.currentTarget as HTMLImageElement).style.opacity = '0'; }}
                                        />
                                    )}
                                </div>
                                {/* Rule 1 — clear caret icon, rotates when open */}
                                <span aria-hidden="true" style={{ display: 'inline-flex', color: '#64748b', transform: profileMenuOpen ? 'rotate(180deg)' : 'none', transition: 'transform 150ms cubic-bezier(0.23, 1, 0.32, 1)' }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="6 9 12 15 18 9" />
                                    </svg>
                                </span>
                            </div>

                            {/* Dropdown Menu — Rules 2 + 4: flips on edge, animates 150ms in/out */}
                            <div
                                id="userDropdown"
                                className={`${styles.profileDropdown}${profileFlipUp ? ' app-flip-up' : ''} app-anim-menu`}
                                style={profileFlipUp ? { top: 'auto', bottom: 'calc(100% + 8px)', marginTop: 0, marginBottom: 0 } : undefined}
                            >
                            {(role === 'staff' || role === 'manager') && (
                                <div
                                    className={styles.dropdownItem}
                                    data-static-hover="true"
                                    onClick={() => {
                                        closeUserDropdown();
                                        router.push('/profile');
                                    }}
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px', color: '#1e3a8a' }}>
                                        <path d="M20 21a8 8 0 1 0-16 0"></path>
                                        <circle cx="12" cy="7" r="4"></circle>
                                    </svg>
                                    <span style={{ color: '#1e3a8a' }}>My Profile</span>
                                </div>
                            )}
                            <div
                                className={styles.dropdownItem}
                                onClick={() => openPasswordChangeModal(passwordChangeReasonForUser)}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px', color: passwordRequiresChange ? '#b91c1c' : '#1e3a8a' }}>
                                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                    <path d="M9 12h6"></path>
                                    <path d="M12 9v6"></path>
                                </svg>
                                <span style={{ display: 'grid', gap: 1, color: passwordRequiresChange ? '#b91c1c' : '#1e3a8a' }}>
                                    <span>{passwordRequiresChange ? 'Change Required Password' : 'Change Password'}</span>
                                    {!passwordRequiresChange && <span style={{ fontSize: 10, color: '#64748b', fontWeight: 600 }}>{passwordExpiresLabel}</span>}
                                </span>
                            </div>
                            {passwordRequiresChange && (
                                <div style={{ padding: '8px 12px 10px', fontSize: 11, color: '#b91c1c', background: '#fef2f2', borderTop: '1px solid #fee2e2' }}>
                                    Your password must be changed before continuing.
                                </div>
                            )}
                             {role === 'admin' && (
                                <>
                                    <div className={styles.dropdownDivider}></div>
                                    <div
                                        className={styles.dropdownItem}
                                        onClick={() => {
                                            closeUserDropdown();
                                            void router.push('/settings');
                                        }}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px', color: '#1e3a8a' }}>
                                            <circle cx="12" cy="12" r="3"></circle>
                                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9z"></path>
                                        </svg>
                                        <span style={{ color: '#1e3a8a' }}>Settings</span>
                                    </div>
                                    <div
                                        className={styles.dropdownItem}
                                        onClick={() => {
                                            closeUserDropdown();
                                            void router.push('/settings/password-policy');
                                        }}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px', color: '#0f766e' }}>
                                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                                            <path d="M9 12h6"></path>
                                            <path d="M12 9v6"></path>
                                            <path d="M8 16l-1 4 4-2 4 2-1-4"></path>
                                        </svg>
                                        <span style={{ color: '#0f766e' }}>Password Policy</span>
                                    </div>
                                </>
                            )}
                            <div className={styles.dropdownDivider}></div>
                            <div
                                className={styles.dropdownItem}
                                data-static-hover="true"
                                role="button"
                                aria-label="Logout"
                                title={lockdownEnabled ? 'Logout disabled while lockdown mode is active.' : 'Logout'}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (isLogoutDisabled) return;
                                    handleLogoutClick();
                                }}
                                style={lockdownEnabled ? { opacity: 0.5, cursor: 'not-allowed' } : undefined}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '10px', color: '#b91c1c' }}>
                                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                                    <polyline points="16 17 21 12 16 7"></polyline>
                                    <line x1="21" y1="12" x2="9" y2="12"></line>
                                </svg>
                                <span style={{ color: '#b91c1c', fontWeight: 700 }}>
                                    {lockdownEnabled ? 'Logout Disabled' : 'Logout'}
                                </span>
                            </div>
                            </div>
                        </div>
                    </div>
                </header>

                {/* ── Today's event detail modal ───────────────────────────── */}
                {todayEventModalOpen && todayCalendarEvents?.managementDots && (
                    <div
                        onClick={() => setTodayEventModalOpen(false)}
                        style={{
                            position: 'fixed', inset: 0,
                            background: 'rgba(15,23,42,0.4)',
                            zIndex: 99500,
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            padding: 20,
                            backdropFilter: 'blur(4px)',
                            WebkitBackdropFilter: 'blur(4px)',
                        }}
                    >
                        <div
                            onClick={e => e.stopPropagation()}
                            style={{
                                background: '#ffffff',
                                border: '1px solid #e5e7eb',
                                borderRadius: 16,
                                width: '100%',
                                maxWidth: 400,
                                maxHeight: '80vh',
                                overflowY: 'auto',
                                boxShadow: '0 20px 60px rgba(15,23,42,0.18)',
                                position: 'relative',
                            }}
                        >
                            {/* coloured top bar — uses dominant event colour */}
                            {(() => {
                                const dots = todayCalendarEvents.managementDots!;
                                const dom = dots.find(d => d.kind === 'holiday') ?? dots.find(d => d.kind === 'birthday') ?? dots[0];
                                return (
                                    <div style={{
                                        background: dom.color,
                                        borderRadius: '16px 16px 0 0',
                                        padding: '14px 18px 12px',
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                                    }}>
                                        <div>
                                            <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.75)', marginBottom: 2 }}>
                                                Today&rsquo;s Events
                                            </div>
                                            <div style={{ fontSize: 15, fontWeight: 800, color: '#ffffff', lineHeight: 1.2 }}>
                                                {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => setTodayEventModalOpen(false)}
                                            style={{
                                                flexShrink: 0,
                                                width: 28, height: 28,
                                                background: '#ffffff',
                                                color: '#1e293b',
                                                border: 'none',
                                                borderRadius: 7, cursor: 'pointer',
                                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                fontSize: 13, padding: 0, fontWeight: 900,
                                            }}
                                        >✕</button>
                                    </div>
                                );
                            })()}

                            {/* event list */}
                            <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                                {todayCalendarEvents.managementDots.map((dot, i) => {
                                    const kindLabel = dot.kind === 'holiday' ? 'Holiday' : dot.kind === 'birthday' ? 'Birthday' : 'Event';
                                    const kindIcon  = dot.kind === 'holiday' ? '🎉' : dot.kind === 'birthday' ? '🎂' : '📅';
                                    return (
                                        <div key={i} style={{
                                            display: 'flex', alignItems: 'center', gap: 12,
                                            background: '#f8fafc',
                                            border: '1px solid #e5e7eb',
                                            borderRadius: 10,
                                            padding: '11px 14px',
                                        }}>
                                            <span style={{ fontSize: 22, lineHeight: 1, flexShrink: 0 }}>{kindIcon}</span>
                                            <div style={{ flex: 1, minWidth: 0 }}>
                                                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', lineHeight: 1.3 }}>{dot.label}</div>
                                                <div style={{ marginTop: 4 }}>
                                                    <span style={{
                                                        display: 'inline-block',
                                                        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em',
                                                        background: dot.color, color: '#fff',
                                                        borderRadius: 5, padding: '2px 7px',
                                                    }}>{kindLabel}</span>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                )}

                <main className="live-sync-fade" style={{ padding: '10px' }}>
                    {children}
                </main>
            </div>

            <PasswordChangeModal
                key={passwordChangeOpen ? `pcm-${passwordChangeReason}` : 'pcm-closed'}
                open={passwordChangeOpen}
                user={user ?? null}
                reason={passwordChangeReason}
                allowClose={!passwordRequiresChange}
                onClose={() => {
                    setPasswordChangeOpen(false);
                }}
                onPasswordChanged={() => {
                    setPasswordChangeOpen(false);
                    window.location.reload();
                }}
            />

            {idleWarningOpen && shouldTrackIdleTimeout && (
                <div className={styles.idleWarningOverlay} role="dialog" aria-modal="true" aria-labelledby="idle-warning-title">
                    <div className={styles.idleWarningCard}>
                        <h3 id="idle-warning-title" className={styles.idleWarningTitle}>Logging Out Soon</h3>
                        <p className={styles.idleWarningText}>
                            Logging out in <strong className={styles.idleWarningCountdown}>{idleWarningCountdown}s</strong>
                        </p>
                        <div className={styles.idleWarningActions}>
                            <button
                                type="button"
                                className={styles.idleContinueButton}
                                onClick={handleStaySignedIn}
                                disabled={isIdleAutoLoggingOut}
                            >
                                Stay Signed In
                            </button>
                            <button
                                type="button"
                                className={styles.idleLogoutButton}
                                onClick={() => { void executeIdleAutoLogout(); }}
                                disabled={isIdleAutoLoggingOut}
                            >
                                {isIdleAutoLoggingOut ? 'Logging out...' : 'Logout Now'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {notificationCenterOpen && (
                <div
                    className={styles.notificationCenterOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="notification-center-title"
                    onClick={handleCloseNotificationCenter}
                >
                    <div
                        className={styles.notificationCenterCard}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className={styles.notificationCenterHeader}>
                            <div className={styles.notificationCenterHeaderTop}>
                                <div className={styles.notificationCenterContentRail}>
                                    <div className={styles.notificationCenterEyebrow}>System Flows</div>
                                    <h3 id="notification-center-title" className={styles.notificationCenterTitle}>
                                        Success Notifications
                                    </h3>
                                    <p className={styles.notificationCenterText}>
                                        {visibleNotifications.length} matching · {visibleNotificationsUnreadCount} unread
                                    </p>
                                </div>
                                <div className={styles.notificationCenterHeaderActions}>
                                    {/* Search sits left of the action buttons */}
                                    <input
                                        type="search"
                                        value={notificationCenterSearch}
                                        onChange={(event) => setNotificationCenterSearch(event.target.value)}
                                        placeholder="Search title or message..."
                                        className={styles.notificationCenterSearchInput}
                                        style={{ width: 200, flexShrink: 1 }}
                                        aria-label="Search notifications"
                                    />
                                    <button
                                        type="button"
                                        className={styles.notificationRefreshButton}
                                        disabled={visibleNotifications.length === 0 || visibleNotificationsUnreadCount === 0}
                                        onClick={() => handleMarkAllNotificationsAsRead(visibleNotifications)}
                                    >
                                        Read all
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.notificationRefreshButton}
                                        onClick={() => { void fetchNotifications({ silent: false }); }}
                                    >
                                        {notificationsLoading ? 'Refreshing...' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.notificationIconButton}
                                        aria-label="Close notification center"
                                        onClick={handleCloseNotificationCenter}
                                    >
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18" />
                                            <line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            {/* Filter row — 5 equal dropdowns */}
                            <div className={styles.notificationCenterControls}>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>User Type</span>
                                    <select
                                        value={notificationCenterUserRoleFilter}
                                        onChange={(event) => setNotificationCenterUserRoleFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Roles</option>
                                        <option value="admin">Admin</option>
                                        <option value="manager">Manager</option>
                                        <option value="staff">Staff</option>
                                    </select>
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Type</span>
                                    <select
                                        value={notificationCenterTypeFilter}
                                        onChange={(event) => setNotificationCenterTypeFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Types</option>
                                        <option value="activity">Activity</option>
                                        <option value="task">Task</option>
                                        <option value="client">Client</option>
                                        <option value="leave">Leave</option>
                                        <option value="payroll">Payroll</option>
                                        <option value="shift">Shift</option>
                                        <option value="approval">Approval</option>
                                    </select>
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Severity</span>
                                    <select
                                        value={notificationCenterSeverityFilter}
                                        onChange={(event) => setNotificationCenterSeverityFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Severity</option>
                                        <option value="high">High</option>
                                        <option value="medium">Medium</option>
                                        <option value="info">Info</option>
                                        <option value="success">Success</option>
                                    </select>
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Date</span>
                                    <select
                                        value={notificationCenterDateFilter}
                                        onChange={(event) => setNotificationCenterDateFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Dates</option>
                                        <option value="today">Today</option>
                                        <option value="yesterday">Yesterday</option>
                                        <option value="last_7_days">Last 7 Days</option>
                                        <option value="last_30_days">Last 30 Days</option>
                                    </select>
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Status</span>
                                    <select
                                        value={notificationCenterReadFilter}
                                        onChange={(event) => setNotificationCenterReadFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Status</option>
                                        <option value="unread">Unread</option>
                                        <option value="read">Read</option>
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div className={styles.notificationCenterBody}>
                            {visibleNotifications.length === 0 ? (
                                <div className={styles.notificationCenterEmpty}>
                                    No notifications match your current filters.
                                </div>
                            ) : (
                                <div style={{ overflowX: 'auto' }}>
                                <table className="llb-table llb-pin-first" style={{ width: '100%' }}>
                                    <thead>
                                        <tr>
                                            <th style={{ textAlign: 'left' }}>Title</th>
                                            <th style={{ textAlign: 'left' }}>Message</th>
                                            <th style={{ textAlign: 'right' }}>Status / Time</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                    {paginatedNotifications.map((notification) => {
                                        const notificationIsRead = isReadNotification(notification);
                                        return (
                                            <tr
                                                key={notification.id}
                                                className={notificationIsRead ? undefined : 'llb-unread'}
                                                onClick={() => handleNotificationPreviewClick(notification)}
                                                onDoubleClick={() => handleNotificationPreviewDoubleClick(notification)}
                                                onKeyDown={(event) => {
                                                    if (event.key === 'Enter') handleNotificationPreviewClick(notification);
                                                }}
                                                tabIndex={0}
                                                title={notificationIsRead ? `${notification.title} - ${notification.message} (double-click to mark as unread)` : `${notification.title} - ${notification.message} (click to open and mark as read)`}
                                                style={{
                                                    cursor: 'pointer',
                                                    color: '#0f172a',
                                                    outline: 'none',
                                                }}
                                            >
                                                <td className="llb-trunc" title={notification.title} style={{ fontWeight: notificationIsRead ? 600 : 800, maxWidth: 220 }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, maxWidth: '100%' }}>
                                                        {!notificationIsRead && <span className={styles.notificationUnreadDot} aria-hidden="true" style={{ flexShrink: 0 }} />}
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{notification.title}</span>
                                                    </span>
                                                </td>
                                                <td className="llb-trunc" title={notification.message} style={{ color: '#475569', maxWidth: 420 }}>{notification.message}</td>
                                                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                                                    <span className={styles.notificationReadStatus} style={{ marginRight: 8 }}>
                                                        {notificationIsRead ? 'Read' : 'Unread'}
                                                    </span>
                                                    <span style={{ color: '#64748b', fontSize: 12 }}>{formatAlertTimestamp(notification.occurred_at)}</span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                    </tbody>
                                </table>
                                </div>
                            )}
                        </div>
                        {visibleNotifications.length > 0 && (
                            <div className={styles.notificationCenterPagination}>
                                <Pagination
                                    currentPage={effectivePage}
                                    totalItems={visibleNotifications.length}
                                    itemsPerPage={NOTIFICATION_CENTER_ITEMS_PER_PAGE}
                                    onPageChange={setNotificationCenterPage}
                                    label="notifications"
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {securityCenterOpen && (
                <div
                    className={styles.notificationCenterOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="security-center-title"
                    onClick={handleCloseSecurityCenter}
                >
                    <div
                        className={styles.notificationCenterCard}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className={styles.notificationCenterHeader}>
                            <div className={styles.notificationCenterHeaderTop}>
                                <div className={styles.notificationCenterContentRail}>
                                    <div className={styles.notificationCenterEyebrow}>Suspicious Activity — Security Center</div>
                                    <h3 id="security-center-title" className={styles.notificationCenterTitle}>
                                        Security Alerts
                                    </h3>
                                    <p className={styles.notificationCenterText}>
                                        {visibleSecurityAlerts.length} matching · {securityAlerts.length} total
                                    </p>
                                </div>
                                <div className={styles.notificationCenterHeaderActions}>
                                    <button
                                        type="button"
                                        className={styles.notificationRefreshButton}
                                        onClick={() => { void fetchSecurityAlerts({ silent: false }); }}
                                    >
                                        {securityAlertsLoading ? 'Refreshing...' : 'Refresh'}
                                    </button>
                                    <button
                                        type="button"
                                        className={styles.notificationIconButton}
                                        aria-label="Close security center"
                                        onClick={handleCloseSecurityCenter}
                                    >
                                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <line x1="18" y1="6" x2="6" y2="18" />
                                            <line x1="6" y1="6" x2="18" y2="18" />
                                        </svg>
                                    </button>
                                </div>
                            </div>
                            <div className={styles.notificationCenterControls}>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Search</span>
                                    <input
                                        type="search"
                                        value={securityCenterSearch}
                                        onChange={(event) => setSecurityCenterSearch(event.target.value)}
                                        placeholder="Search user, IP or message..."
                                        className={styles.notificationCenterSearchInput}
                                    />
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>Severity</span>
                                    <select
                                        value={securityCenterSeverityFilter}
                                        onChange={(event) => setSecurityCenterSeverityFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Severity</option>
                                        <option value="high">High</option>
                                        <option value="medium">Medium</option>
                                        <option value="low">Low</option>
                                    </select>
                                </label>
                                <label className={styles.notificationCenterFilterField}>
                                    <span className={styles.notificationCenterFilterLabel}>User Type</span>
                                    <select
                                        value={securityCenterUserRoleFilter}
                                        onChange={(event) => setSecurityCenterUserRoleFilter(event.target.value)}
                                        className={styles.notificationCenterSelect}
                                    >
                                        <option value="all">All Roles</option>
                                        <option value="admin">Admin</option>
                                        <option value="manager">Manager</option>
                                        <option value="staff">Staff</option>
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div className={styles.notificationCenterBody}>
                            {paginatedSecurityAlerts.length > 0 && (
                                <div className={styles.securityAlertColHeadRow}>
                                    <span className={styles.securityAlertColHead}>User Type</span>
                                    <span className={styles.securityAlertColHead}>Event</span>
                                    <span className={styles.securityAlertColHead}>Description</span>
                                </div>
                            )}
                            {paginatedSecurityAlerts.length === 0 ? (
                                <div className={styles.notificationCenterEmpty}>
                                    No security alerts match your current filters.
                                </div>
                            ) : (
                                paginatedSecurityAlerts.map((alert) => {
                                    const sevStyle = getSeverityTagStyle(alert.severity);
                                    const sevColor = String(alert.severity || 'low').toLowerCase() === 'high' ? '#fecdd3' : String(alert.severity).toLowerCase() === 'medium' ? '#fde68a' : '#bbf7d0';
                                    return (
                                        <button
                                            key={alert.id}
                                            type="button"
                                            className={`${styles.notificationCenterItem} ${isSecurityAlertRead(alert) ? styles.notificationCenterItemRead : styles.notificationCenterItemUnread}`}
                                            onClick={() => handleOpenSecurityAlertDetail(alert)}
                                            style={{ border: `1px solid ${sevColor}` }}
                                        >
                                            <div className={styles.securityAlertGrid}>
                                                {/* Col 1 — User / IP / Time */}
                                                <div className={styles.securityAlertMeta} style={{ alignItems: 'flex-start' }}>
                                                    <span className={styles.securityAlertMetaUser} title={alert.user || alert.username || ''}>👤 {alert.user || alert.username || (alert.email ? alert.email : 'Unknown user')}</span>
                                                    <span className={styles.securityAlertMetaLine}>IP: {alert.ip_address || 'unknown'}</span>
                                                    <span className={styles.securityAlertMetaLine}>{formatAlertTimestamp(alert.occurred_at)}</span>
                                                </div>
                                                {/* Col 2 — Event title + severity badge */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                                                    <span className={styles.securityAlertTitle} title={alert.title}>{alert.title}</span>
                                                    <span style={{ ...sevStyle, borderRadius: 999, padding: '2px 7px', fontSize: 9, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>{alert.severity}</span>
                                                </div>
                                                {/* Col 3 — Description */}
                                                <div className={styles.securityAlertMessage} title={alert.message}>{alert.message}</div>
                                            </div>
                                        </button>
                                    );
                                })
                            )}
                        </div>
                        {visibleSecurityAlerts.length > 0 && (
                            <div className={styles.notificationCenterPagination}>
                                <Pagination
                                    currentPage={effectiveSecurityPage}
                                    totalItems={visibleSecurityAlerts.length}
                                    itemsPerPage={SECURITY_CENTER_ITEMS_PER_PAGE}
                                    onPageChange={setSecurityCenterPage}
                                    label="security alerts"
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}

            {selectedNotification && (
                <div
                    className={styles.notificationDetailOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="notification-detail-title"
                    onClick={() => setSelectedNotification(null)}
                >
                    <div
                        className={styles.notificationDetailCard}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className={styles.notificationDetailCloseButton}
                            aria-label="Close notification details"
                            onClick={() => setSelectedNotification(null)}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>

                        <div className={styles.notificationDetailHeader}>
                            <div className={styles.notificationDetailEyebrow}>System Notification</div>
                            <div className={styles.notificationDetailBadgeRow}>
                                <span style={{
                                    ...getNotificationSeverityTagStyle(selectedNotification.severity),
                                    borderRadius: 999,
                                    padding: '5px 10px',
                                    fontSize: 11,
                                    fontWeight: 800,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                }}>
                                    {String(selectedNotification.severity || 'info')}
                                </span>
                                <span className={styles.notificationTypeTag}>
                                    {formatNotificationType(selectedNotification.type)}
                                </span>
                            </div>
                            <h3 id="notification-detail-title" className={styles.notificationDetailTitle}>
                                {selectedNotification.title}
                            </h3>
                            <p className={styles.notificationDetailText}>
                                {selectedNotification.message}
                            </p>
                            {renderAssignmentMetaPanel(selectedNotification)}
                        </div>

                        <div className={styles.notificationDetailGrid}>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Notification Type</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {formatNotificationType(selectedNotification.type)}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Received At</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {formatAlertTimestamp(selectedNotification.occurred_at)}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Severity</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {String(selectedNotification.severity || 'info').toUpperCase()}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Linked Page</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {formatRouteLabel(selectedNotification.link)}
                                </span>
                            </div>
                        </div>

                        <div className={styles.notificationDetailActions}>
                            <button
                                type="button"
                                className={styles.notificationDetailSecondaryButton}
                                onClick={() => setSelectedNotification(null)}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                className={styles.notificationDetailSecondaryButton}
                                onClick={() => {
                                    markNotificationsAsUnread([selectedNotification]);
                                    setSelectedNotification(null);
                                }}
                            >
                                Mark as unread
                            </button>
                            <button
                                type="button"
                                className={styles.notificationDetailSecondaryButton}
                                onClick={handleOpenNotificationCenter}
                            >
                                Open Maximized Center
                            </button>
                            {selectedNotification.link && (
                                <button
                                    type="button"
                                    className={styles.notificationDetailPrimaryButton}
                                    onClick={() => handleOpenNotificationLink(selectedNotification.link as string)}
                                >
                                    Open Related Page
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {selectedSecurityAlert && (
                <div
                    className={styles.notificationDetailOverlay}
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="security-alert-detail-title"
                    onClick={() => setSelectedSecurityAlert(null)}
                >
                    <div
                        className={styles.notificationDetailCard}
                        onClick={(event) => event.stopPropagation()}
                    >
                        <button
                            type="button"
                            className={styles.notificationDetailCloseButton}
                            aria-label="Close security alert details"
                            onClick={() => setSelectedSecurityAlert(null)}
                        >
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>

                        <div className={styles.notificationDetailHeader}>
                            <div className={styles.notificationDetailEyebrow}>Security Notification</div>
                            <div className={styles.notificationDetailBadgeRow}>
                                <span style={{
                                    ...getSeverityTagStyle(selectedSecurityAlert.severity),
                                    borderRadius: 999,
                                    padding: '5px 10px',
                                    fontSize: 11,
                                    fontWeight: 800,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                }}>
                                    {selectedSecurityAlert.severity}
                                </span>
                                <span className={styles.notificationDirectionTag}>
                                    {selectedSecurityAlert.direction}
                                </span>
                            </div>
                            <h3 id="security-alert-detail-title" className={styles.notificationDetailTitle}>
                                {selectedSecurityAlert.title}
                            </h3>
                            <p className={styles.notificationDetailText}>
                                {selectedSecurityAlert.message}
                            </p>
                        </div>

                        <div className={styles.notificationDetailGrid}>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>User</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {selectedSecurityAlert.user || selectedSecurityAlert.username || selectedSecurityAlert.email || 'Unknown user'}{selectedSecurityAlert.user_role ? ` (${selectedSecurityAlert.user_role})` : ''}{selectedSecurityAlert.user_id ? ` • ID: ${selectedSecurityAlert.user_id}` : ''}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>IP Address</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {selectedSecurityAlert.ip_address || 'Unknown'}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Detected At</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {formatAlertTimestamp(selectedSecurityAlert.occurred_at)}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Alert Type</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {selectedSecurityAlert.activity_type || selectedSecurityAlert.kind || 'Unknown'}
                                </span>
                            </div>
                            <div className={styles.notificationDetailField}>
                                <span className={styles.notificationDetailFieldLabel}>Suggested Action</span>
                                <span className={styles.notificationDetailFieldValue}>
                                    {selectedSecurityAlert.action || 'Review the source IP and tighten security controls if needed.'}
                                </span>
                            </div>
                            {selectedSecurityAlert.email && (
                                <div className={styles.notificationDetailField}>
                                    <span className={styles.notificationDetailFieldLabel}>Email</span>
                                    <span className={styles.notificationDetailFieldValue}>{selectedSecurityAlert.email}</span>
                                </div>
                            )}
                        </div>

                        <div className={styles.notificationDetailActions}>
                            <button
                                type="button"
                                className={styles.notificationDetailSecondaryButton}
                                onClick={() => setSelectedSecurityAlert(null)}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                className={styles.notificationDetailPrimaryButton}
                                onClick={handleOpenSecuritySettings}
                            >
                                Open Security Settings
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isLockdownRestricted && (
                <div className={styles.lockdownOverlay} role="alertdialog" aria-modal="true" aria-live="assertive">
                    <div className={styles.lockdownCard}>
                        <div className={styles.lockdownHeader}>
                            <div className={styles.lockdownIcon} aria-hidden="true">
                                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M12 2 2 20h20L12 2z" />
                                    <line x1="12" y1="9" x2="12" y2="13" />
                                    <circle cx="12" cy="17" r="1" />
                                </svg>
                            </div>
                            <div className={styles.lockdownHeaderCopy}>
                                <div className={styles.lockdownEyebrow}>Emergency Lockdown</div>
                                <h3 className={styles.lockdownTitle}>System activity is temporarily paused.</h3>
                            </div>
                        </div>
                        <p className={styles.lockdownText}>
                            Please remain on this screen until the lockdown is lifted.
                        </p>
                        {displayLockdownReason && (
                            <div className={styles.lockdownReasonText}>{displayLockdownReason}</div>
                        )}
                        {lockdownUpdatedAt && (
                            <div className={styles.lockdownMeta}>Updated {lockdownUpdatedAt}</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
