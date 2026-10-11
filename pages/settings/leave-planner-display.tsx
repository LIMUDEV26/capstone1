import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

export default function LeavePlannerDisplaySettings() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [showNames, setShowNames] = useState(false);
    const [saving, setSaving] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
    const [settingsErr, setSettingsErr] = useState<string | null>(null);

    useEffect(() => {
        if (!settingsMsg) return;
        void notifySuccess(settingsMsg);
        setSettingsMsg(null);
    }, [settingsMsg]);

    useEffect(() => {
        if (!settingsErr) return;
        void notifyError(settingsErr);
        setSettingsErr(null);
    }, [settingsErr]);

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

    const fetchSettings = async () => {
        try {
            const res = await fetch(
                `${API_BASE}/settings_api.php?keys=leave_planner_show_names`,
                { credentials: 'include', cache: 'no-store' }
            );
            const data = await res.json();
            if (data.success && data.data) {
                setShowNames(data.data.leave_planner_show_names ?? false);
            }
        } catch (e) {
            console.error(e);
            setSettingsErr('Failed to load settings');
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
        setSettingsMsg(null);
        setSettingsErr(null);
        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        leave_planner_show_names: showNames,
                    }
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSettings();
                setSettingsMsg('Leave Planner display settings saved successfully.');
            } else {
                setSettingsErr(data.message || 'Failed to save settings.');
            }
        } catch {
            setSettingsErr('Network error.');
        } finally {
            setSaving(false);
        }
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="leave-planner-display" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="leave-planner-display" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Leave Planner Display Settings" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload settings" />
            </div>

            {/* Settings Card */}
            <div style={{
                background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12, marginBottom: 24,
            }}>
                <div>
                    <h2 style={{ margin: '0 0 6px 0', fontSize: 13, fontWeight: 700, color: '#111827' }}>Employee Name Display</h2>
                    <p style={{ margin: '0 0 8px 0', fontSize: 11, color: '#6b7280' }}>
                        Control whether employee names are displayed in the Leave Planner tracker. By default, names are hidden for privacy.
                    </p>

                    {/* Toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
                        <label style={{ fontSize: 14, color: '#374151', fontWeight: 600, minWidth: 200 }}>Show Employee Names</label>
                        <SettingsToggle
                            checked={showNames}
                            onChange={setShowNames}
                            disabled={saving}
                            showStatus
                            statusOnLabel="Enabled"
                            statusOffLabel="Disabled"
                        />
                    </div>

                    <div style={{ background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 8, padding: 12, marginBottom: 10 }}>
                        <p style={{ margin: 0, fontSize: 12, color: '#374151' }}>
                            <strong>When Disabled (Default):</strong> Employee names will not be displayed in the Leave Planner tracker to protect privacy.
                        </p>
                        <p style={{ margin: '8px 0 0 0', fontSize: 12, color: '#374151' }}>
                            <strong>When Enabled:</strong> Employee names will be visible in the Leave Planner, Approval Queue, Upcoming Absences, and other planner views.
                        </p>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            title="Save Settings"
                            aria-label="Save leave planner display settings"
                            style={{
                                background: 'transparent', color: '#1e3a8a', border: 'none', padding: '4px 0',
                                cursor: 'pointer', fontWeight: 600, fontSize: 14,
                                opacity: saving ? 0.5 : 1, textDecoration: 'underline',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            }}
                        >
                            {saving ? 'Saving...' : 'Submit'}
                        </button>
                    </div>
                </div>
            </div>
        </SettingsLayout>
    );
}
