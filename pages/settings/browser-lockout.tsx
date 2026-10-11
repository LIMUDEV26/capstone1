import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import Pagination from '../../components/Pagination';
import SettingsToggle from '../../components/SettingsToggle';

const API_BASE = getApiBaseUrl();
const DEFAULT_THRESHOLD = 10;

interface BrowserLockoutRow {
    id: number;
    browser_key: string;
    ip_address: string;
    attempt_count: number;
    is_blocked: boolean;
    blocked_at: string | null;
    last_attempt: string;
    notes: string | null;
    created_at: string;
}

export default function BrowserLockoutSettings() {
    const router = useRouter();
    const embedded = true;
    const ITEMS_PER_PAGE = usePaginationSetting();
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);

    // ── Policy state ──────────────────────────────────────────────────────────
    const [enabled, setEnabled] = useState(true);
    const [togglingEnabled, setTogglingEnabled] = useState(false);
    const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD);
    const [editMode, setEditMode] = useState(false);
    const [draftThreshold, setDraftThreshold] = useState(DEFAULT_THRESHOLD);
    const [saving, setSaving] = useState(false);

    // ── List state ────────────────────────────────────────────────────────────
    const [rows, setRows] = useState<BrowserLockoutRow[]>([]);
    const [listReloading, setListReloading] = useState(false);
    const [unlocking, setUnlocking] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [showAll, setShowAll] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);

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
                await Promise.all([fetchSettings(), fetchRows()]);
            } finally {
                if (active) setPageLoading(false);
            }
        };
        void load();
        return () => { active = false; };
    }, [authLoading, userId]);

    // ── Fetch policy ──────────────────────────────────────────────────────────
    const fetchSettings = async () => {
        try {
            const res = await fetch(`${API_BASE}/browser-lockout.php?action=settings`, {
                credentials: 'include', cache: 'no-store',
            });
            const data = await res.json() as { success?: boolean; data?: { browser_lockout_threshold?: number; browser_lockout_enabled?: boolean } };
            if (data.success && data.data) {
                const t = Number(data.data.browser_lockout_threshold ?? DEFAULT_THRESHOLD);
                setThreshold(t);
                setDraftThreshold(t);
                setEnabled(data.data.browser_lockout_enabled !== false);
            }
        } catch { /* ignore */ }
    };

    // ── Toggle enabled ────────────────────────────────────────────────────────
    const handleToggleEnabled = async (next: boolean) => {
        setTogglingEnabled(true);
        try {
            const res = await fetch(`${API_BASE}/browser-lockout.php?action=save_settings`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: next }),
            });
            const data = await res.json() as { success?: boolean; message?: string };
            if (data.success) {
                setEnabled(next);
                notifySuccess(next ? 'Browser lockout enabled.' : 'Browser lockout disabled.');
            } else {
                notifyError(data.message || 'Failed to update setting.');
            }
        } catch {
            notifyError('Network error while updating setting.');
        } finally {
            setTogglingEnabled(false);
        }
    };

    // ── Save policy ───────────────────────────────────────────────────────────
    const handleSave = async () => {
        if (draftThreshold < 1 || draftThreshold > 50) {
            notifyError('Threshold must be between 1 and 50.');
            return;
        }
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/browser-lockout.php?action=save_settings`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threshold: draftThreshold }),
            });
            const data = await res.json() as { success?: boolean; message?: string };
            if (data.success) {
                setThreshold(draftThreshold);
                setEditMode(false);
                notifySuccess(data.message || 'Settings saved.');
            } else {
                notifyError(data.message || 'Failed to save settings.');
            }
        } catch {
            notifyError('Network error while saving settings.');
        } finally {
            setSaving(false);
        }
    };

    // ── List helpers ──────────────────────────────────────────────────────────
    const fetchRows = async (reloading = false) => {
        if (reloading) setListReloading(true);
        try {
            const url = showAll
                ? `${API_BASE}/browser-lockout.php?action=list`
                : `${API_BASE}/browser-lockout.php?action=list&blocked_only=1`;
            const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
            const data = await res.json() as { success?: boolean; data?: BrowserLockoutRow[] };
            if (data.success && Array.isArray(data.data)) {
                setRows(data.data);
                setCurrentPage(1);
            } else {
                notifyError('Failed to load browser lockouts.');
            }
        } catch {
            notifyError('Network error loading browser lockouts.');
        } finally {
            setListReloading(false);
        }
    };

    const handleUnblock = async (id: number) => {
        if (unlocking !== null) return;
        setUnlocking(id);
        try {
            const res = await fetch(`${API_BASE}/browser-lockout.php?action=unblock`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
            });
            const data = await res.json() as { success?: boolean; message?: string };
            if (data.success) {
                notifySuccess(data.message || 'Browser unblocked.');
                await fetchRows(true);
            } else {
                notifyError(data.message || 'Failed to unblock browser.');
            }
        } catch {
            notifyError('Network error while unblocking browser.');
        } finally {
            setUnlocking(null);
        }
    };

    const toggleShowAll = () => {
        setShowAll((prev) => {
            const next = !prev;
            setTimeout(() => void fetchRowsWithFlag(next), 0);
            return next;
        });
    };

    const fetchRowsWithFlag = async (all: boolean) => {
        setListReloading(true);
        try {
            const url = all
                ? `${API_BASE}/browser-lockout.php?action=list`
                : `${API_BASE}/browser-lockout.php?action=list&blocked_only=1`;
            const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
            const data = await res.json() as { success?: boolean; data?: BrowserLockoutRow[] };
            if (data.success && Array.isArray(data.data)) {
                setRows(data.data);
                setCurrentPage(1);
            }
        } catch { /* ignore */ }
        finally { setListReloading(false); }
    };

    const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
    const paged = rows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
    const blockedCount = rows.filter((r) => r.is_blocked).length;

    if (authLoading) {
        return (
            <SettingsLayout activeSection="browser-lockout" user={user} onLogout={logout}>
                <div style={{ padding: 24, color: '#6b7280', fontSize: 13 }}>Loading…</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="browser-lockout" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader
                    embedded={embedded}
                    title="Browser / Intruder Lockout"
                    onBack={() => void router.push('/settings')}
                />
            </div>
            <p style={{ margin: '0 0 18px', fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
                Browsers that exceed the configured failed-attempt threshold are automatically blocked.
                Admins can adjust the threshold, review blocked browsers, and unblock them here.
            </p>

            {/* ── Policy card ─────────────────────────────────────────────── */}
            <div style={{
                background: '#fff',
                border: `1px solid ${enabled ? '#e5e7eb' : '#fcd34d'}`,
                borderRadius: 10,
                padding: 14,
                marginBottom: 16,
                opacity: togglingEnabled ? 0.7 : 1,
                transition: 'opacity 0.2s',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: editMode ? 14 : 0 }}>
                    <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>Lockout Policy</h2>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <SettingsToggle
                            checked={enabled}
                            onChange={(next) => void handleToggleEnabled(next)}
                            disabled={togglingEnabled}
                            size="small"
                            showStatus
                            statusOnLabel="Enabled"
                            statusOffLabel="Disabled"
                            ariaLabel="Enable or disable browser lockout"
                        />
                        {!editMode && (
                            <button
                                onClick={() => { setDraftThreshold(threshold); setEditMode(true); }}
                                style={{ background: 'transparent', color: '#1e3a8a', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                            >
                                Edit
                            </button>
                        )}
                    </div>
                </div>
                {!enabled && (
                    <div style={{ margin: '8px 0 4px', padding: '7px 12px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fcd34d', fontSize: 11.5, color: '#92400e' }}>
                        ⚠️ Browser lockout is currently <strong>disabled</strong>. Failed login attempts will not be tracked or blocked.
                    </div>
                )}

                {!editMode ? (
                    /* Read-only */
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', borderTop: '1px solid #f3f4f6', marginTop: 10 }}>
                        <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>
                            Failed attempts before browser is blocked
                        </span>
                        <span style={{
                            fontSize: 12, fontWeight: 700,
                            color: '#dc2626',
                            background: '#fef2f2',
                            padding: '3px 12px', borderRadius: 20,
                            border: '1px solid #fca5a5',
                        }}>
                            {threshold}
                        </span>
                    </div>
                ) : (
                    /* Edit mode */
                    <div>
                        <div style={{ marginBottom: 14 }}>
                            <label style={{ display: 'block', fontSize: 12, color: '#374151', fontWeight: 600, marginBottom: 6 }}>
                                Failed attempts before browser is blocked
                                <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 6 }}>(1 – 50, default {DEFAULT_THRESHOLD})</span>
                            </label>
                            <input
                                type="number"
                                min={1}
                                max={50}
                                value={draftThreshold}
                                onChange={(e) => setDraftThreshold(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                                disabled={saving}
                                style={{
                                    width: 100,
                                    height: 36,
                                    borderRadius: 8,
                                    border: '1px solid #d1d5db',
                                    padding: '0 10px',
                                    fontSize: 14,
                                    fontWeight: 700,
                                    color: '#111827',
                                    outline: 'none',
                                    boxSizing: 'border-box',
                                }}
                            />
                        </div>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button
                                onClick={() => void handleSave()}
                                disabled={saving}
                                style={{
                                    padding: '7px 18px', borderRadius: 8,
                                    border: 'none', background: '#1e3a8a', color: '#fff',
                                    fontWeight: 700, fontSize: 12, cursor: saving ? 'not-allowed' : 'pointer',
                                    opacity: saving ? 0.7 : 1,
                                }}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                            <button
                                onClick={() => { setDraftThreshold(threshold); setEditMode(false); }}
                                disabled={saving}
                                style={{
                                    padding: '7px 14px', borderRadius: 8,
                                    border: '1px solid #e5e7eb', background: '#f9fafb', color: '#374151',
                                    fontWeight: 600, fontSize: 12, cursor: 'pointer',
                                }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Summary cards ────────────────────────────────────────────── */}
            <div style={{ display: 'flex', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
                <SummaryCard label="Blocked Browsers" value={String(blockedCount)} highlight={blockedCount > 0} />
                <SummaryCard label="Total Tracked" value={String(rows.length)} />
                <SummaryCard label="Block Threshold" value={`${threshold} attempts`} />
            </div>

            {/* ── Controls ─────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} style={{ padding: '7px 11px', border: filtersOpen ? '1px solid #1d4ed8' : '1px solid #cbd5e1', borderRadius: 8, background: filtersOpen ? '#1d4ed8' : '#fff', color: filtersOpen ? '#fff' : '#334155', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                    {filtersOpen ? 'Hide Filters' : `Filters${showAll ? ' (1)' : ''}`}
                </button>
                <TinyReloadButton
                    onClick={() => void fetchRows(true)}
                    loading={listReloading}
                    title="Refresh browser lockout list"
                />
            </div>
            {filtersOpen && (
                <div style={{ margin: '-6px 0 16px', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#374151', cursor: 'pointer', fontWeight: 500 }}>
                        <input type="checkbox" checked={showAll} onChange={toggleShowAll} style={{ width: 14, height: 14, accentColor: '#2166a5' }} />
                        Show all attempts (including unblocked)
                    </label>
                </div>
            )}

            {/* ── Table ────────────────────────────────────────────────────── */}
            <div style={{ background: '#ffffff', borderRadius: 12, border: '1px solid #e5e7eb', overflow: 'hidden' }}>
                <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr style={{ background: '#f9fafb', borderBottom: '1px solid #e5e7eb' }}>
                            {['#', 'IP Address', 'Browser Key', 'Attempts', 'Status', 'Last Attempt', 'Blocked At', 'Actions'].map((h) => (
                                <th key={h} className={h === 'Actions' ? 'llb-actions-heading' : h === '#' || h === 'Attempts' ? 'llb-num' : undefined} style={{ padding: '10px 12px', textAlign: 'left', fontWeight: 600, color: '#374151', fontSize: 11, letterSpacing: 0.3 }}>{h}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {paged.length === 0 ? (
                            <tr>
                                <td colSpan={8} style={{ padding: '28px 16px', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                                    {showAll ? 'No browser attempts recorded.' : 'No blocked browsers found.'}
                                </td>
                            </tr>
                        ) : paged.map((row, idx) => (
                            <tr
                                key={row.id}
                                style={{
                                    borderBottom: '1px solid #f3f4f6',
                                    background: row.is_blocked ? 'rgba(254,226,226,0.30)' : idx % 2 === 0 ? '#ffffff' : '#fafafa',
                                }}
                            >
                                <td style={{ padding: '9px 12px', color: '#9ca3af' }} className="llb-num">{(currentPage - 1) * ITEMS_PER_PAGE + idx + 1}</td>
                                <td style={{ padding: '9px 12px', fontWeight: 600, color: '#111827', fontFamily: 'monospace', fontSize: 11 }}>
                                    {row.ip_address || '—'}
                                </td>
                                <td style={{ padding: '9px 12px', color: '#6b7280', fontFamily: 'monospace', fontSize: 10 }} className="llb-trunc" title={row.browser_key}>
                                    {row.browser_key.substring(0, 16)}…
                                </td>
                                <td style={{ padding: '9px 12px' }} className="llb-num">
                                    <span style={{
                                        fontWeight: 700, fontSize: 12,
                                        color: row.attempt_count >= threshold ? '#dc2626' : row.attempt_count >= Math.ceil(threshold / 2) ? '#d97706' : '#111827',
                                        background: row.attempt_count >= threshold ? '#fef2f2' : row.attempt_count >= Math.ceil(threshold / 2) ? '#fffbeb' : '#f3f4f6',
                                        padding: '2px 8px', borderRadius: 99,
                                        border: `1px solid ${row.attempt_count >= threshold ? '#fca5a5' : row.attempt_count >= Math.ceil(threshold / 2) ? '#fcd34d' : '#e5e7eb'}`,
                                    }}>
                                        {row.attempt_count}
                                    </span>
                                </td>
                                <td style={{ padding: '9px 12px' }}>
                                    <span style={{
                                        fontWeight: 700, fontSize: 11,
                                        color: row.is_blocked ? '#dc2626' : '#16a34a',
                                        background: row.is_blocked ? '#fef2f2' : '#f0fdf4',
                                        padding: '3px 9px', borderRadius: 99,
                                        border: `1px solid ${row.is_blocked ? '#fca5a5' : '#86efac'}`,
                                        letterSpacing: 0.3,
                                    }}>
                                        {row.is_blocked ? '🚫 Blocked' : '✓ Clear'}
                                    </span>
                                </td>
                                <td style={{ padding: '9px 12px', color: '#6b7280', fontSize: 11 }}>
                                    {row.last_attempt ? new Date(row.last_attempt).toLocaleString() : '—'}
                                </td>
                                <td style={{ padding: '9px 12px', color: row.blocked_at ? '#dc2626' : '#9ca3af', fontSize: 11 }}>
                                    {row.blocked_at ? new Date(row.blocked_at).toLocaleString() : '—'}
                                </td>
                                <td style={{ padding: '9px 12px' }} className="llb-actions">
                                    {row.is_blocked && (
                                        <button
                                            onClick={() => void handleUnblock(row.id)}
                                            disabled={unlocking !== null}
                                            style={{
                                                padding: '5px 12px', borderRadius: 8,
                                                border: '1px solid #d1fae5', background: '#ecfdf5',
                                                color: '#065f46', fontWeight: 600, fontSize: 11,
                                                cursor: unlocking !== null ? 'not-allowed' : 'pointer',
                                                opacity: unlocking === row.id ? 0.6 : 1,
                                                transition: 'all 0.2s',
                                            }}
                                        >
                                            {unlocking === row.id ? 'Unblocking…' : 'Unblock'}
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {totalPages > 1 && (
                <div style={{ marginTop: 16 }}>
                    <Pagination
                        currentPage={currentPage}
                        totalItems={rows.length}
                        itemsPerPage={ITEMS_PER_PAGE}
                        onPageChange={setCurrentPage}
                    />
                </div>
            )}

            {/* Info note */}
            <div style={{
                marginTop: 20, padding: '12px 16px', borderRadius: 10,
                background: '#fff7ed', border: '1px solid #fed7aa',
                fontSize: 12, color: '#92400e', lineHeight: 1.6,
            }}>
                <strong>How it works:</strong> Each browser&apos;s fingerprint (IP + User-Agent) is tracked across failed login attempts.
                After <strong>{threshold} consecutive failures</strong>, the browser is blocked and an &quot;Intruder blocked&quot; security alert is sent
                to all admin users via system notifications. An admin can unblock a browser from this page.
            </div>
        </SettingsLayout>
    );
}

function SummaryCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
    return (
        <div style={{
            flex: '1 1 140px', minWidth: 120,
            padding: '14px 18px', borderRadius: 10,
            border: `1px solid ${highlight ? '#fca5a5' : '#e5e7eb'}`,
            background: highlight ? '#fef2f2' : '#f9fafb',
        }}>
            <div style={{ fontSize: 11, color: '#6b7280', fontWeight: 500, marginBottom: 4 }}>{label}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: highlight ? '#dc2626' : '#111827' }}>{value}</div>
        </div>
    );
}
