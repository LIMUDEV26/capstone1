import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

export default function PasswordPolicySettings() {
    const router = useRouter();
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [maxAgeDays, setMaxAgeDays] = useState(90);
    const [historyCount, setHistoryCount] = useState(5);
    const [saving, setSaving] = useState(false);
    const [reloading, setReloading] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const fetchPolicy = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/auth.php?action=password_policy`, { credentials: 'include', cache: 'no-store' });
            const data = await res.json();
            if (data.success && data.data) {
                setMaxAgeDays(data.data.max_age_days ?? 90);
                setHistoryCount(data.data.history_count ?? 5);
            }
        } catch {
            // keep defaults
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
        const load = async () => {
            try {
                await fetchPolicy();
            } finally {
                if (active) setPageLoading(false);
            }
        };
        void load();
        return () => { active = false; };
    }, [authLoading, fetchPolicy, userId]);

    const handleReload = async () => {
        setReloading(true);
        try {
            await fetchPolicy();
        } finally {
            setReloading(false);
        }
    };

    const handleSave = async () => {
        setErr(null);
        const days = Math.max(1, Math.min(365, Math.trunc(maxAgeDays)));
        const history = Math.max(1, Math.min(50, Math.trunc(historyCount)));
        setMaxAgeDays(days);
        setHistoryCount(history);
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/auth.php?action=update_password_policy`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ max_age_days: days, history_count: history }),
            });
            const data = await res.json();
            if (data.success) {
                if (data.data) {
                    setMaxAgeDays(data.data.max_age_days ?? days);
                    setHistoryCount(data.data.history_count ?? history);
                }
                notifySuccess('Password policy updated');
            } else {
                setErr(data.message || 'Failed to update policy');
            }
        } catch {
            setErr('Network error');
        } finally {
            setSaving(false);
        }
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="password-policy" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="password-policy" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, maxWidth: 600 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Policy Settings</div>
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload policy" />
            </div>
            <div style={{ maxWidth: 600 }}>
                <div style={{ background: '#ffffff', borderRadius: 10, border: '1px solid #e2e8f0', padding: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.04)' }}>
                    <h3 style={{ margin: '0 0 2px', fontSize: 13, color: '#1c2537' }}>Password Expiration & History</h3>
                    <p style={{ margin: '0 0 10px', fontSize: 11, color: '#6b7280' }}>
                        Expiry and reuse limits.
                    </p>

                    {err && (
                        <div style={{ padding: '7px 10px', borderRadius: 8, background: '#fee2e2', color: '#b91c1c', fontSize: 11, marginBottom: 10, border: '1px solid #fecaca' }}>
                            {err}
                        </div>
                    )}

                    <div style={{ display: 'grid', gap: 10 }}>
                        <div>
                            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Max Password Age (days)</label>
                            <input
                                type="number"
                                min={1}
                                max={365}
                                value={maxAgeDays}
                                onChange={(e) => setMaxAgeDays(Number(e.target.value))}
                                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                            />
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                                Expires every {maxAgeDays} day{maxAgeDays !== 1 ? 's' : ''}.
                            </div>
                        </div>

                        <div>
                            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#374151', marginBottom: 4 }}>Password History Count</label>
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={historyCount}
                                onChange={(e) => setHistoryCount(Number(e.target.value))}
                                style={{ width: '100%', padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, boxSizing: 'border-box' }}
                            />
                            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 3 }}>
                                Blocks last {historyCount} password{historyCount !== 1 ? 's' : ''}.
                            </div>
                        </div>
                    </div>

                    <div style={{
                        marginTop: 16,
                        paddingTop: 12,
                        borderTop: '1px solid #e5e7eb',
                        display: 'flex',
                        justifyContent: 'flex-end',
                    }}>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            style={{
                                background: saving ? '#93c5fd' : '#1e3a8a',
                                color: '#fff',
                                border: 'none',
                                padding: '7px 20px',
                                borderRadius: 8,
                                fontSize: 13,
                                fontWeight: 700,
                                cursor: saving ? 'default' : 'pointer',
                                opacity: saving ? 0.7 : 1,
                                transition: 'background 0.15s',
                            }}
                        >
                            {saving ? 'Saving…' : 'Save Policy'}
                        </button>
                    </div>
                </div>
            </div>
        </SettingsLayout>
    );
}
