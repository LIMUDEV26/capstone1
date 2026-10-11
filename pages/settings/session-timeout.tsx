import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

type TimeoutUnit = 'minutes' | 'hours';
const clampTimeoutMinutes = (value: number) => {
    if (Number.isNaN(value)) return 30;
    return Math.max(1, Math.min(1440, Math.trunc(value)));
};

const timeoutValueToMinutes = (value: number, unit: TimeoutUnit, fallbackMinutes = 30) => {
    const raw = Number.isFinite(value) ? value : fallbackMinutes;
    const minutes = unit === 'hours'
        ? Math.round(raw * 60)
        : Math.round(raw);
    return clampTimeoutMinutes(minutes);
};

const minutesToTimeoutValue = (minutes: number, unit: TimeoutUnit) => {
    const safeMinutes = clampTimeoutMinutes(minutes);
    if (unit === 'hours') {
        return Number((safeMinutes / 60).toFixed(2));
    }
    return safeMinutes;
};

export default function SessionTimeoutSettings() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [timeoutEnabled, setTimeoutEnabled] = useState(true);
    const [managerUnit, setManagerUnit] = useState<TimeoutUnit>('minutes');
    const [staffUnit, setStaffUnit] = useState<TimeoutUnit>('minutes');
    const [adminUnit, setAdminUnit] = useState<TimeoutUnit>('minutes');
    const [managerTimeoutValue, setManagerTimeoutValue] = useState(30);
    const [staffTimeoutValue, setStaffTimeoutValue] = useState(30);
    // Phase 1.5: admin previously had no idle timeout at all. Default 60 min.
    const [adminTimeoutValue, setAdminTimeoutValue] = useState(60);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [reloading, setReloading] = useState(false);

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch(
                `${API_BASE}/settings_api.php?keys=session_timeout_enabled,session_timeout_manager_minutes,session_timeout_staff_minutes,session_timeout_admin_minutes`,
                { credentials: 'include', cache: 'no-store' }
            );
            const data = await res.json();
            if (data.success && data.data) {
                setTimeoutEnabled(Boolean(data.data.session_timeout_enabled ?? true));
                const managerMinutes = clampTimeoutMinutes(Number(data.data.session_timeout_manager_minutes ?? 30));
                const staffMinutes = clampTimeoutMinutes(Number(data.data.session_timeout_staff_minutes ?? 30));
                const adminMinutes = clampTimeoutMinutes(Number(data.data.session_timeout_admin_minutes ?? 60));
                setManagerUnit('minutes');
                setStaffUnit('minutes');
                setAdminUnit('minutes');
                setManagerTimeoutValue(managerMinutes);
                setStaffTimeoutValue(staffMinutes);
                setAdminTimeoutValue(adminMinutes);
            }
        } catch {
            // Keep defaults when settings are unavailable.
        }
    }, []);

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
    }, [authLoading, fetchSettings, userId]);

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

    const handleSave = async () => {
        setSaving(true);
        setMsg(null);
        setErr(null);

        const managerValue = timeoutValueToMinutes(managerTimeoutValue, managerUnit, 30);
        const staffValue = timeoutValueToMinutes(staffTimeoutValue, staffUnit, 30);
        const adminValue = timeoutValueToMinutes(adminTimeoutValue, adminUnit, 60);
        setManagerTimeoutValue(minutesToTimeoutValue(managerValue, managerUnit));
        setStaffTimeoutValue(minutesToTimeoutValue(staffValue, staffUnit));
        setAdminTimeoutValue(minutesToTimeoutValue(adminValue, adminUnit));

        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        session_timeout_enabled: timeoutEnabled,
                        session_timeout_manager_minutes: managerValue,
                        session_timeout_staff_minutes: staffValue,
                        session_timeout_admin_minutes: adminValue,
                    },
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSettings();
                setMsg('Session timeout settings saved.');
            } else {
                setErr(data.message || 'Failed to save session timeout settings.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleManagerUnitChange = (nextUnit: TimeoutUnit) => {
        if (nextUnit === managerUnit) return;
        const minutes = timeoutValueToMinutes(managerTimeoutValue, managerUnit, 30);
        setManagerUnit(nextUnit);
        setManagerTimeoutValue(minutesToTimeoutValue(minutes, nextUnit));
    };

    const handleStaffUnitChange = (nextUnit: TimeoutUnit) => {
        if (nextUnit === staffUnit) return;
        const minutes = timeoutValueToMinutes(staffTimeoutValue, staffUnit, 30);
        setStaffUnit(nextUnit);
        setStaffTimeoutValue(minutesToTimeoutValue(minutes, nextUnit));
    };

    const handleAdminUnitChange = (nextUnit: TimeoutUnit) => {
        if (nextUnit === adminUnit) return;
        const minutes = timeoutValueToMinutes(adminTimeoutValue, adminUnit, 60);
        setAdminUnit(nextUnit);
        setAdminTimeoutValue(minutesToTimeoutValue(minutes, nextUnit));
    };

    const handleReload = async () => {
        setReloading(true);
        try {
            await fetchSettings();
        } finally {
            setReloading(false);
        }
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="session-timeout" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="session-timeout" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Session Timeout" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload settings" />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
                    <h2 style={{ margin: '0 0 4px 0', fontSize: 13, fontWeight: 700, color: '#111827' }}>Inactivity Timeout</h2>
                    <p style={{ margin: '0 0 6px 0', fontSize: 11, color: '#6b7280', lineHeight: 1.4 }}>
                        Auto-logout after inactivity. Applies to admin, manager, and staff.
                    </p>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                        <label style={{ fontSize: 11, color: '#374151', fontWeight: 600, minWidth: 110 }}>Enable Timeout</label>
                        <SettingsToggle
                            checked={timeoutEnabled}
                            onChange={setTimeoutEnabled}
                            showStatus
                        />
                    </div>

                    {timeoutEnabled && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                            <div style={{ display: 'grid', gap: 5 }}>
                                <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Manager Timeout</label>
                                <select
                                    value={managerUnit}
                                    onChange={(e) => handleManagerUnitChange(e.target.value as TimeoutUnit)}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, color: '#334155', background: '#f8fafc' }}
                                >
                                    <option value="minutes">Minute/s</option>
                                    <option value="hours">Hour/s</option>
                                </select>
                                <input
                                    type="number"
                                    min={managerUnit === 'hours' ? 0.25 : 1}
                                    max={managerUnit === 'hours' ? 24 : 1440}
                                    step={managerUnit === 'hours' ? 0.25 : 1}
                                    value={managerTimeoutValue}
                                    onChange={(e) => setManagerTimeoutValue(minutesToTimeoutValue(
                                        timeoutValueToMinutes(Number(e.target.value), managerUnit, 30),
                                        managerUnit
                                    ))}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                                />
                                <span style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.2 }}>
                                    {managerUnit === 'hours' ? '0.25–24 hrs' : '1–1440 mins'}
                                </span>
                            </div>

                            <div style={{ display: 'grid', gap: 5 }}>
                                <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Staff Timeout</label>
                                <select
                                    value={staffUnit}
                                    onChange={(e) => handleStaffUnitChange(e.target.value as TimeoutUnit)}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, color: '#334155', background: '#f8fafc' }}
                                >
                                    <option value="minutes">Minute/s</option>
                                    <option value="hours">Hour/s</option>
                                </select>
                                <input
                                    type="number"
                                    min={staffUnit === 'hours' ? 0.25 : 1}
                                    max={staffUnit === 'hours' ? 24 : 1440}
                                    step={staffUnit === 'hours' ? 0.25 : 1}
                                    value={staffTimeoutValue}
                                    onChange={(e) => setStaffTimeoutValue(minutesToTimeoutValue(
                                        timeoutValueToMinutes(Number(e.target.value), staffUnit, 30),
                                        staffUnit
                                    ))}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                                />
                                <span style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.2 }}>
                                    {staffUnit === 'hours' ? '0.25–24 hrs' : '1–1440 mins'}
                                </span>
                            </div>

                            <div style={{ display: 'grid', gap: 5 }}>
                                <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Admin Timeout</label>
                                <select
                                    value={adminUnit}
                                    onChange={(e) => handleAdminUnitChange(e.target.value as TimeoutUnit)}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, color: '#334155', background: '#f8fafc' }}
                                >
                                    <option value="minutes">Minute/s</option>
                                    <option value="hours">Hour/s</option>
                                </select>
                                <input
                                    type="number"
                                    min={adminUnit === 'hours' ? 0.25 : 1}
                                    max={adminUnit === 'hours' ? 24 : 1440}
                                    step={adminUnit === 'hours' ? 0.25 : 1}
                                    value={adminTimeoutValue}
                                    onChange={(e) => setAdminTimeoutValue(minutesToTimeoutValue(
                                        timeoutValueToMinutes(Number(e.target.value), adminUnit, 60),
                                        adminUnit
                                    ))}
                                    style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                                />
                                <span style={{ fontSize: 10, color: '#9ca3af', lineHeight: 1.2 }}>
                                    {adminUnit === 'hours' ? '0.25–24 hrs' : '1–1440 mins'}
                                </span>
                            </div>
                        </div>
                    )}

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            title="Save Settings"
                            aria-label="Save session timeout settings"
                            style={{
                                background: 'transparent', color: '#1e3a8a', border: 'none', padding: '4px 0',
                                cursor: 'pointer', fontWeight: 600, fontSize: 13,
                                opacity: saving ? 0.5 : 1,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                textDecoration: 'underline',
                            }}
                        >
                            {saving ? 'Saving...' : 'Submit'}
                        </button>
                    </div>
            </div>
        </SettingsLayout>
    );
}
