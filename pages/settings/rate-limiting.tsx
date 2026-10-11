import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

type RateLimitWindowUnit = 'seconds' | 'minutes' | 'hours';

const DEFAULT_RATE_LIMIT_ENABLED = true;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 180;
const DEFAULT_RATE_LIMIT_WINDOW_SECONDS = 60;
const DEFAULT_RATE_LIMIT_WINDOW_UNIT: RateLimitWindowUnit = 'minutes';

const clampMaxRequests = (value: number) => {
    if (Number.isNaN(value)) return DEFAULT_RATE_LIMIT_MAX_REQUESTS;
    return Math.max(10, Math.min(5000, Math.trunc(value)));
};

const clampWindowSeconds = (value: number) => {
    if (Number.isNaN(value)) return DEFAULT_RATE_LIMIT_WINDOW_SECONDS;
    return Math.max(10, Math.min(86400, Math.trunc(value)));
};

const windowValueToSeconds = (value: number, unit: RateLimitWindowUnit, fallbackSeconds = 60) => {
    const raw = Number.isFinite(value) ? value : fallbackSeconds;
    let seconds = raw;

    if (unit === 'minutes') {
        seconds = raw * 60;
    } else if (unit === 'hours') {
        seconds = raw * 3600;
    }

    return clampWindowSeconds(Math.round(seconds));
};

const secondsToWindowValue = (seconds: number, unit: RateLimitWindowUnit) => {
    const safeSeconds = clampWindowSeconds(seconds);
    if (unit === 'hours') {
        return Number((safeSeconds / 3600).toFixed(3));
    }
    if (unit === 'minutes') {
        return Number((safeSeconds / 60).toFixed(2));
    }
    return safeSeconds;
};

export default function RateLimitingSettings() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [rateLimitEnabled, setRateLimitEnabled] = useState(DEFAULT_RATE_LIMIT_ENABLED);
    const [maxRequests, setMaxRequests] = useState(DEFAULT_RATE_LIMIT_MAX_REQUESTS);
    const [windowUnit, setWindowUnit] = useState<RateLimitWindowUnit>(DEFAULT_RATE_LIMIT_WINDOW_UNIT);
    const [windowValue, setWindowValue] = useState(secondsToWindowValue(DEFAULT_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMIT_WINDOW_UNIT));
    const [saving, setSaving] = useState(false);
    const [resetting, setResetting] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);

    const windowSeconds = useMemo(
        () => windowValueToSeconds(windowValue, windowUnit, DEFAULT_RATE_LIMIT_WINDOW_SECONDS),
        [windowUnit, windowValue]
    );

    // Render the page shell immediately after auth resolves; data loads in
    // the background. Never trap on full-page "Loading..." for data fetch.
    const userId = user?.id;
    useEffect(() => {
        if (authLoading) return;
        if (!userId) {
            setPageLoading(false);
            return;
        }

        let active = true;
        const loadPage = async () => {
            try {
                await fetchSettings();
            } finally {
                if (active) {
                    setPageLoading(false);
                }
            }
        };

        void loadPage();
        return () => {
            active = false;
        };
    }, [authLoading, userId]);

    useEffect(() => {
        if (!msg) return;
        void notifySuccess(msg);
        setMsg(null);
    }, [msg]);

    useEffect(() => {
        if (!err) return;
        void notifyError(err);
        setErr(null);
    }, [err]);

    const effectiveRequestsPerMinute = useMemo(() => {
        return Math.max(1, Math.round((maxRequests / Math.max(1, windowSeconds)) * 60));
    }, [maxRequests, windowSeconds]);

    const fetchSettings = async () => {
        try {
            const res = await fetch(
                `${API_BASE}/settings_api.php?keys=rate_limit_enabled,rate_limit_max_requests,rate_limit_window_seconds`,
                { credentials: 'include', cache: 'no-store' }
            );
            const data = await res.json();
            if (data.success && data.data) {
                setRateLimitEnabled(Boolean(data.data.rate_limit_enabled ?? DEFAULT_RATE_LIMIT_ENABLED));
                setMaxRequests(clampMaxRequests(Number(data.data.rate_limit_max_requests ?? DEFAULT_RATE_LIMIT_MAX_REQUESTS)));
                const safeSeconds = clampWindowSeconds(Number(data.data.rate_limit_window_seconds ?? DEFAULT_RATE_LIMIT_WINDOW_SECONDS));
                const nextWindowUnit: RateLimitWindowUnit = safeSeconds % 3600 === 0
                    ? 'hours'
                    : safeSeconds % 60 === 0
                        ? 'minutes'
                        : 'seconds';
                setWindowUnit(nextWindowUnit);
                setWindowValue(secondsToWindowValue(safeSeconds, nextWindowUnit));
            }
        } catch {
            // Keep defaults when settings are unavailable.
        }
    };

    const handleReload = async () => {
        setReloading(true);
        try {
            await fetchSettings();
        } finally {
            setReloading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setMsg(null);
        setErr(null);

        const nextMaxRequests = clampMaxRequests(maxRequests);
        const nextWindowSeconds = windowValueToSeconds(windowValue, windowUnit, DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
        setMaxRequests(nextMaxRequests);
        setWindowValue(secondsToWindowValue(nextWindowSeconds, windowUnit));

        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        rate_limit_enabled: rateLimitEnabled,
                        rate_limit_max_requests: nextMaxRequests,
                        rate_limit_window_seconds: nextWindowSeconds,
                    },
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSettings();
                setMsg('Rate limiting settings saved.');
            } else {
                setErr(data.message || 'Failed to save rate limiting settings.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleResetToDefault = async () => {
        const shouldReset = await confirmAction({
            title: 'Restore rate limiting defaults?',
            text: 'Restore the recommended default rate limiting baseline of 180 requests every 60 seconds and enable protection now?',
            confirmButtonText: 'Restore Default',
            icon: 'warning',
            danger: true,
        });
        if (!shouldReset) return;

        setResetting(true);
        setMsg(null);
        setErr(null);

        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        rate_limit_enabled: DEFAULT_RATE_LIMIT_ENABLED,
                        rate_limit_max_requests: DEFAULT_RATE_LIMIT_MAX_REQUESTS,
                        rate_limit_window_seconds: DEFAULT_RATE_LIMIT_WINDOW_SECONDS,
                    },
                }),
            });
            const data = await res.json();
            if (data.success) {
                setRateLimitEnabled(DEFAULT_RATE_LIMIT_ENABLED);
                setMaxRequests(DEFAULT_RATE_LIMIT_MAX_REQUESTS);
                setWindowUnit(DEFAULT_RATE_LIMIT_WINDOW_UNIT);
                setWindowValue(secondsToWindowValue(DEFAULT_RATE_LIMIT_WINDOW_SECONDS, DEFAULT_RATE_LIMIT_WINDOW_UNIT));
                await fetchSettings();
                setMsg('Rate limiting was reset to the recommended default.');
            } else {
                setErr(data.message || 'Failed to reset rate limiting to default.');
            }
        } catch {
            setErr('Network error while resetting defaults.');
        } finally {
            setResetting(false);
        }
    };

    const handleWindowUnitChange = (nextUnit: RateLimitWindowUnit) => {
        if (nextUnit === windowUnit) return;
        const seconds = windowValueToSeconds(windowValue, windowUnit, DEFAULT_RATE_LIMIT_WINDOW_SECONDS);
        setWindowUnit(nextUnit);
        setWindowValue(secondsToWindowValue(seconds, nextUnit));
    };

    const windowInputMin = windowUnit === 'hours' ? 0.003 : windowUnit === 'minutes' ? 0.17 : 10;
    const windowInputMax = windowUnit === 'hours' ? 24 : windowUnit === 'minutes' ? 1440 : 86400;
    const windowInputStep = windowUnit === 'hours' ? 0.001 : windowUnit === 'minutes' ? 0.01 : 10;
    const windowRangeText = windowUnit === 'hours'
        ? 'Range: 0.003–24h'
        : windowUnit === 'minutes'
            ? 'Range: 0.17–1440m'
            : 'Range: 10–86400s';

    if (authLoading) {
        return (
            <SettingsLayout activeSection="rate-limiting" user={user} onLogout={logout}>
                <div style={{ padding: 12, fontSize: 12 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="rate-limiting" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Rate Limiting" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload settings" />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
                <h2 style={{ margin: '0 0 4px 0', fontSize: 13, fontWeight: 700, color: '#111827' }}>System-Wide Request Throttling</h2>
                <p style={{ margin: '0 0 6px 0', fontSize: 11, color: '#6b7280' }}>
                    Caps requests per window to block abusive floods.
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <label style={{ fontSize: 11, color: '#374151', fontWeight: 600, minWidth: 130 }}>Enable Rate Limiting</label>
                    <SettingsToggle
                        checked={rateLimitEnabled}
                        onChange={setRateLimitEnabled}
                        showStatus
                    />
                </div>

                {rateLimitEnabled && (
                    <>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                            <div style={{ display: 'grid', gap: 4 }}>
                                <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Max Requests</label>
                                <input
                                    type="number"
                                    min={10}
                                    max={5000}
                                    value={maxRequests}
                                    onChange={(e) => setMaxRequests(clampMaxRequests(Number(e.target.value)))}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                                />
                                <span style={{ fontSize: 10, color: '#9ca3af' }}>10 to 5000 requests.</span>
                            </div>

                            <div style={{ display: 'grid', gap: 4 }}>
                                <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Window</label>
                                <select
                                    value={windowUnit}
                                    onChange={(e) => handleWindowUnitChange(e.target.value as RateLimitWindowUnit)}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, color: '#334155', background: '#f8fafc' }}
                                >
                                    <option value="seconds">Second/s</option>
                                    <option value="minutes">Minute/s</option>
                                    <option value="hours">Hour/s</option>
                                </select>
                                <input
                                    type="number"
                                    min={windowInputMin}
                                    max={windowInputMax}
                                    step={windowInputStep}
                                    value={windowValue}
                                    onChange={(e) => setWindowValue(secondsToWindowValue(
                                        windowValueToSeconds(Number(e.target.value), windowUnit, 60),
                                        windowUnit
                                    ))}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                                />
                                <span style={{ fontSize: 10, color: '#9ca3af' }}>{windowRangeText}</span>
                            </div>
                        </div>

                        <div style={{
                            marginTop: 10,
                            padding: '7px 10px',
                            borderRadius: 8,
                            border: '1px solid #bae6fd',
                            background: '#f0f9ff',
                            color: '#0f172a',
                            fontSize: 11,
                            lineHeight: 1.4,
                        }}>
                            Effective: <strong>{effectiveRequestsPerMinute}</strong>/min — {maxRequests} per {windowSeconds}s.
                        </div>

                        <div style={{
                            marginTop: 8,
                            padding: '7px 10px',
                            borderRadius: 8,
                            border: '1px solid #bbf7d0',
                            background: '#f0fdf4',
                            color: '#14532d',
                            fontSize: 11,
                            lineHeight: 1.4,
                        }}>
                            Default: <strong>180 / 60s</strong> — large DDoS needs WAF/proxy.
                        </div>
                    </>
                )}

                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                    <button
                        type="button"
                        onClick={handleResetToDefault}
                        disabled={resetting}
                        style={{
                            background: '#f8fafc', color: '#334155', border: '1px solid #cbd5e1', padding: '7px 12px',
                            borderRadius: 8, cursor: resetting ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 12,
                            opacity: resetting ? 0.7 : 1,
                        }}
                    >
                        {resetting ? 'Resetting...' : 'Reset to Default'}
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={saving || resetting}
                        title="Save Settings"
                        aria-label="Save rate limiting settings"
                        style={{
                            background: '#0f766e', color: '#fff', border: 'none', padding: '7px 14px',
                            borderRadius: 8, cursor: 'pointer', fontWeight: 600, fontSize: 12,
                            opacity: saving || resetting ? 0.7 : 1,
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        }}
                    >
                        {saving ? 'Saving...' : 'Submit'}
                    </button>
                </div>
            </div>
        </SettingsLayout>
    );
}
