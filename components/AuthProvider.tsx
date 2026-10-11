import {
    createContext,
    type ReactNode,
    type SetStateAction,
    startTransition,
    use,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { useRouter } from 'next/router';
import { getApiBaseUrl } from '@/utils/network';
import {
    BROWSER_ALIVE_BEAT_MS,
    isFreshBrowserRun,
    markBrowserAlive,
    markBrowserUnloading,
} from '@/utils/browserRun';
import type { RoleFeatureAccessMap } from '@/utils/roleFeatureAccess';

export type SessionUser = {
    id?: number;
    role?: string;
    username?: string;
    full_name?: string;
    first_name?: string;
    last_name?: string;
    photo?: string | null;
    must_reset_password?: number | string;
    password_change_reason?: string;
    password_status?: {
        expired?: boolean;
        requires_change?: boolean;
        reason?: string;
        days_remaining?: number | null;
        password_expires_at?: string | null;
    } | null;
    dashboard_path?: string;
    role_feature_access?: RoleFeatureAccessMap;
    [key: string]: unknown;
};

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated';

type RefreshSessionOptions = {
    force?: boolean;
};

type UseProtectedPageOptions = {
    allowedRoles?: string[];
    unauthenticatedRedirect?: string;
    unauthorizedRedirect?: string;
    includeNext?: boolean;
};

type AuthContextValue = {
    user: SessionUser | null;
    status: AuthStatus;
    isAuthenticated: boolean;
    refreshSession: (options?: RefreshSessionOptions) => Promise<SessionUser | null>;
    logout: () => Promise<void>;
    setSessionUser: (nextUser: SetStateAction<SessionUser | null>) => void;
};

const SESSION_TAKEOVER_POLL_MS = 20000;
const SESSION_TAKEOVER_FOCUS_THROTTLE_MS = 10000;
const AuthContext = createContext<AuthContextValue | null>(null);

// Lazily resolved per call (never captured at module load): the base URL
// depends on window.location, so a module-time constant bakes in the wrong
// host when the bundle is evaluated outside the browser (SSR) or before the
// first navigation. A stale absolute base sends session/logout checks
// straight at Apache (:80) instead of the same-origin dev rewrite (:3000),
// which drops cookies cross-host and leaves every page logged-out.
function getApiBase() {
    return getApiBaseUrl();
}

function buildSessionUrl(force = false) {
    return force ? `${getApiBase()}/auth.php?action=session` : `${getApiBase()}/auth.php`;
}

function normalizeRole(value: unknown) {
    return String(value || '').trim().toLowerCase();
}

export function AuthProvider({ children }: { children: ReactNode }) {
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [status, setStatus] = useState<AuthStatus>('loading');
    const inFlightRef = useRef<Promise<SessionUser | null> | null>(null);
    const lastTakeoverFocusCheckRef = useRef(0);
    const supersededLogoutRef = useRef(false);
    // Captured once per tab at boot: a fresh run with a live session means the
    // browser restored the session cookie after a full close -> destroy it.
    const freshRunRef = useRef<boolean>(false);

    const setSessionUser = (nextUser: SetStateAction<SessionUser | null>) => {
        const resolvedUser = typeof nextUser === 'function'
            ? (nextUser as (previous: SessionUser | null) => SessionUser | null)(user)
            : nextUser;

        setUser(resolvedUser);
        setStatus(resolvedUser ? 'authenticated' : 'unauthenticated');
    };

    const refreshSession = useCallback(async (options?: RefreshSessionOptions) => {
        const force = !!options?.force;

        if (!force && inFlightRef.current) {
            return inFlightRef.current;
        }

        if (force) {
            setStatus((prev) => (prev === 'unauthenticated' ? 'loading' : prev));
        }

        const runRequest = async (): Promise<SessionUser | null> => {
            let result: SessionUser | null = null;
            try {
                const response = await fetch(buildSessionUrl(force), {
                    credentials: 'include',
                    cache: force ? 'no-store' : 'default',
                });
                const payload = await response.json();

                if (payload?.success) {
                    const nextUser = (payload.data || {}) as SessionUser;
                    setUser(nextUser);
                    setStatus('authenticated');
                    result = nextUser;
                } else {
                    setUser(null);
                    setStatus('unauthenticated');
                }
            } catch {
                setUser(null);
                setStatus('unauthenticated');
            }
            inFlightRef.current = null;
            return result;
        };

        const request = runRequest();

        if (!force) {
            inFlightRef.current = request;
        }

        return request;
    }, []);

    const logout = useCallback(async () => {
        setUser(null);
        setStatus('unauthenticated');
        supersededLogoutRef.current = false;
        startTransition(() => {
            void router.push('/');
        });

        void fetch(`${getApiBase()}/auth.php?action=logout`, {
            method: 'POST',
            credentials: 'include',
        }).catch(() => undefined);
    }, [router]);

    // ── Single-session rule: only 1 active session per account ──────────────
    // If this account signs in on another browser/device, this session is
    // directly logged out — no warning prompt.
    const checkSingleSession = useCallback(async () => {
        if (supersededLogoutRef.current) return;
        try {
            const response = await fetch(`${getApiBase()}/auth.php?action=session_status`, {
                credentials: 'include',
                cache: 'no-store',
            });
            if (response.status === 401) {
                void refreshSession({ force: true });
                return;
            }
            const payload = await response.json();
            if (payload?.success && payload?.data?.superseded) {
                supersededLogoutRef.current = true;
                await logout();
            }
        } catch {
            // Transient network failure — retry on the next poll.
        }
    }, [logout, refreshSession]);

    useEffect(() => {
        if (status !== 'authenticated') return;
        void checkSingleSession();
        const timer = window.setInterval(() => {
            void checkSingleSession();
        }, SESSION_TAKEOVER_POLL_MS);
        const onFocus = () => {
            const now = Date.now();
            if (now - lastTakeoverFocusCheckRef.current < SESSION_TAKEOVER_FOCUS_THROTTLE_MS) return;
            lastTakeoverFocusCheckRef.current = now;
            void checkSingleSession();
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') onFocus();
        };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVisibility);
        return () => {
            window.clearInterval(timer);
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [status, checkSingleSession]);

    useEffect(() => {
        // ── Browser close = logout, tab close = stay logged in ──────────────
        // Every open tab heartbeats so a continuing run always looks alive.
        // Boot order matters: read staleness BEFORE marking alive, so tabs
        // restored together after a browser close all agree it is a fresh run.
        freshRunRef.current = isFreshBrowserRun();
        markBrowserAlive();
        const beat = window.setInterval(() => {
            markBrowserAlive();
        }, BROWSER_ALIVE_BEAT_MS);
        // Continuity mark for same-tab full loads: without it, the heartbeat
        // alone goes stale while `npm run dev` compiles the next page, and
        // the fresh-run check above would destroy the session on arrival.
        const handlePageHide = () => {
            markBrowserUnloading();
        };
        window.addEventListener('pagehide', handlePageHide);

        const timer = window.setTimeout(() => {
            void refreshSession().then((sessionUser) => {
                // Fresh browser run but the session cookie survived (browser
                // session-restore): this is a restored session from before the
                // browser closed -> log out everywhere. Same-run reloads and
                // reopened tabs always see a recent heartbeat and skip this.
                if (sessionUser && freshRunRef.current) {
                    void logout();
                }
            });
        }, 0);

        return () => {
            window.clearTimeout(timer);
            window.clearInterval(beat);
            window.removeEventListener('pagehide', handlePageHide);
        };
    }, [refreshSession, logout]);

    useEffect(() => {
        if (!router.isReady || status !== 'authenticated' || !user) return;
        const mustChangePassword = Number(user.must_reset_password ?? 0) === 1 || Boolean(user.password_status?.requires_change);
        if (!mustChangePassword) return;

        const currentPath = router.asPath || router.pathname || '';
        if (currentPath.startsWith('/reset-password') || currentPath.startsWith('/change-password')) return;

        const reason = String(user.password_change_reason || user.password_status?.reason || 'expired');
        const nextPath = reason === 'first_login'
            ? '/reset-password?mode=first_login'
            : `/change-password?reason=${reason === 'expired' ? 'expired' : 'manual'}`;
        startTransition(() => {
            void router.replace(nextPath);
        });
    }, [router, status, user]);

    const value: AuthContextValue = {
        user,
        status,
        isAuthenticated: status === 'authenticated',
        refreshSession,
        logout,
        setSessionUser,
    };

    return (
        <AuthContext.Provider value={value}>
            {children}
        </AuthContext.Provider>
    );
}

export function useAuth() {
    const context = use(AuthContext);
    if (!context) {
        throw new Error('useAuth must be used within an AuthProvider.');
    }
    return context;
}

export function useProtectedPage(options?: UseProtectedPageOptions) {
    const {
        allowedRoles = [],
        unauthenticatedRedirect = '/',
        unauthorizedRedirect = '/403',
        includeNext = true,
    } = options || {};
    const auth = useAuth();
    const router = useRouter();
    const forcedRefreshAttemptedRef = useRef(false);

    const normalizedAllowedRoles = useMemo(
        () => allowedRoles.map((role) => normalizeRole(role)).filter(Boolean),
        [allowedRoles],
    );
    const currentRole = normalizeRole(auth.user?.role);
    const roleAllowed = normalizedAllowedRoles.length === 0 || normalizedAllowedRoles.includes(currentRole);
    const currentPath = router.asPath || router.pathname || '/';

    useEffect(() => {
        if (!router.isReady) return;

        if (auth.status === 'loading') {
            return;
        }

        if (auth.status === 'unauthenticated' && !forcedRefreshAttemptedRef.current) {
            forcedRefreshAttemptedRef.current = true;
            void auth.refreshSession({ force: true });
            return;
        }

        if (auth.status === 'unauthenticated') {
            if (unauthenticatedRedirect === '/' && includeNext) {
                startTransition(() => {
                    void router.replace({
                        pathname: '/',
                        query: currentPath && currentPath !== '/'
                            ? { next: currentPath }
                            : {},
                    });
                });
                return;
            }

            startTransition(() => {
                void router.replace(unauthenticatedRedirect);
            });
            return;
        }

        if (!roleAllowed) {
            startTransition(() => {
                void router.replace(unauthorizedRedirect);
            });
        }
    }, [
        auth,
        currentPath,
        includeNext,
        roleAllowed,
        router,
        unauthenticatedRedirect,
        unauthorizedRedirect,
    ]);

    const loading = !router.isReady
        || auth.status === 'loading'
        || auth.status === 'unauthenticated'
        || !roleAllowed;

    return {
        user: auth.user,
        loading,
        logout: auth.logout,
        refreshSession: auth.refreshSession,
        setSessionUser: auth.setSessionUser,
        status: auth.status,
    };
}
