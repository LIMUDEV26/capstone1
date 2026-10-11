import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { invalidatePaginationCache } from '@/utils/usePaginationSetting';

const API_BASE = getApiBaseUrl();

const clampItemsPerPage = (value: number) => {
    if (Number.isNaN(value)) return 10;
    return Math.max(1, Math.min(100, Math.trunc(value)));
};

export default function PaginationSettings() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [itemsPerPage, setItemsPerPage] = useState(10);
    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [reloading, setReloading] = useState(false);
    const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    useEffect(() => () => {
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch(`${API_BASE}/settings_api.php?keys=pagination_items_per_page`, { credentials: 'include', cache: 'no-store' });
            const data = await res.json();
            const storedValue = data?.data?.pagination_items_per_page;
            if (!res.ok || !data.success || storedValue === undefined || storedValue === null) {
                throw new Error(data?.message || 'Pagination setting is unavailable.');
            }
            setItemsPerPage(clampItemsPerPage(Number(storedValue)));
        } catch (error) {
            setErr(error instanceof Error ? error.message : 'Unable to load the pagination setting.');
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

    const persistItemsPerPage = async (value: number, showConfirmation = true) => {
        setSaving(true);
        setErr(null);

        const sanitized = clampItemsPerPage(value);
        setItemsPerPage(sanitized);

        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        pagination_items_per_page: sanitized,
                    },
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                invalidatePaginationCache();
                if (showConfirmation) setMsg('Pagination setting saved.');
            } else {
                setErr(data.message || 'Failed to save pagination setting.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleSave = async () => {
        if (autoSaveTimerRef.current) {
            clearTimeout(autoSaveTimerRef.current);
            autoSaveTimerRef.current = null;
        }
        setMsg(null);
        await persistItemsPerPage(itemsPerPage);
    };

    const handleItemsPerPageChange = (value: number) => {
        const sanitized = clampItemsPerPage(value);
        setItemsPerPage(sanitized);
        if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = setTimeout(() => {
            autoSaveTimerRef.current = null;
            void persistItemsPerPage(sanitized, false);
        }, 400);
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="pagination" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="pagination" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Pagination Settings" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload settings" />
            </div>

            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 12 }}>
                    <h2 style={{ margin: '0 0 4px 0', fontSize: 13, fontWeight: 700, color: '#111827' }}>System Pagination</h2>
                    <p style={{ margin: '0 0 6px 0', fontSize: 11, color: '#6b7280' }}>Rows per page.</p>

                    <div style={{ display: 'grid', gap: 4, maxWidth: 260 }}>
                        <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Items Per Page</label>
                        <input
                            type="number"
                            min={1}
                            max={100}
                            value={itemsPerPage}
                            onChange={(e) => handleItemsPerPageChange(Number(e.target.value))}
                            onBlur={() => void handleSave()}
                            style={{ padding: '7px 10px', borderRadius: 10, border: '1px solid #d1d5db', fontSize: 13, color: '#111' }}
                        />
                        <span style={{ fontSize: 11, color: '#9ca3af' }}>1–100</span>
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                        <button
                            onClick={handleSave}
                            disabled={saving}
                            title="Save Settings"
                            aria-label="Save pagination settings"
                            style={{
                                background: 'transparent', color: '#1e3a8a', border: 'none', padding: '4px 0',
                                cursor: 'pointer', fontWeight: 600, fontSize: 13, opacity: saving ? 0.5 : 1, textDecoration: 'underline',
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            }}
                        >
                            {saving ? 'Saving...' : 'Save Now'}
                        </button>
                    </div>
            </div>
        </SettingsLayout>
    );
}
