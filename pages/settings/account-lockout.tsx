import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Pagination from '../../components/Pagination';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE = getApiBaseUrl();

interface LockedUser {
    id: number;
    first_name: string;
    last_name: string;
    email: string;
    role: string;
    reset_request_count: number;
    lockout_cooldown_until?: string | null;
}

interface PolicyState {
    lockoutEnabled: boolean;
    thresholdManager: number;
    thresholdStaff: number;
    windowHours: number;
    cooldownStartAttempt: number;
    retryDelayValue: number;
    retryDelayUnit: 'seconds' | 'minutes';
    maxCooldownAttempts: number;
}

function PolicyRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
    return (
        <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '9px 0', borderBottom: '1px solid #f3f4f6',
        }}>
            <span style={{ fontSize: 12, color: '#6b7280', fontWeight: 500 }}>{label}</span>
            <span style={{
                fontSize: 12, fontWeight: 700,
                color: highlight ? '#dc2626' : '#111827',
                background: highlight ? '#fef2f2' : '#f3f4f6',
                padding: '3px 10px', borderRadius: 20,
                border: `1px solid ${highlight ? '#fca5a5' : '#e5e7eb'}`,
            }}>{value}</span>
        </div>
    );
}

export default function AccountLockoutSettings() {
    const router = useRouter();
    const embedded = true;
    const ITEMS_PER_PAGE = usePaginationSetting();
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);

    // Policy display / edit
    const [policy, setPolicy] = useState<PolicyState>({
        lockoutEnabled: true,
        thresholdManager: 3,
        thresholdStaff: 3,
        windowHours: 24,
        cooldownStartAttempt: 2,
        retryDelayValue: 30,
        retryDelayUnit: 'seconds',
        maxCooldownAttempts: 3,
    });
    const [editMode, setEditMode] = useState(false);
    const [draft, setDraft] = useState<PolicyState>(policy);
    const [saving, setSaving] = useState(false);

    // Locked users
    const [lockedUsers, setLockedUsers] = useState<LockedUser[]>([]);
    const [unlocking, setUnlocking] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [listReloading, setListReloading] = useState(false);

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
                await Promise.all([fetchSettings(), fetchLockedUsers()]);
            } finally {
                if (active) setPageLoading(false);
            }
        };
        void loadPage();
        return () => { active = false; };
    }, [authLoading, userId]);

    const fetchSettings = async () => {
        try {
            const res = await fetch(
                `${API_BASE}/settings_api.php?keys=lockout_enabled,lockout_threshold_manager,lockout_threshold_staff,lockout_window_hours,lockout_cooldown_start_attempt,lockout_retry_delay_value,lockout_retry_delay_unit,lockout_max_cooldown_attempts`,
                { credentials: 'include', cache: 'no-store' }
            );
            const data = await res.json();
            if (data.success && data.data) {
                const p: PolicyState = {
                    lockoutEnabled: data.data.lockout_enabled ?? true,
                    thresholdManager: data.data.lockout_threshold_manager ?? 3,
                    thresholdStaff: data.data.lockout_threshold_staff ?? 3,
                    windowHours: data.data.lockout_window_hours ?? 24,
                    cooldownStartAttempt: data.data.lockout_cooldown_start_attempt ?? 2,
                    retryDelayValue: data.data.lockout_retry_delay_value ?? 30,
                    retryDelayUnit: data.data.lockout_retry_delay_unit === 'minutes' ? 'minutes' : 'seconds',
                    maxCooldownAttempts: data.data.lockout_max_cooldown_attempts ?? 3,
                };
                setPolicy(p);
                setDraft(p);
            }
        } catch (e) { console.error(e); }
    };

    const fetchLockedUsers = async () => {
        try {
            const res = await fetch(`${API_BASE}/users.php?action=locked`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                setLockedUsers(Array.isArray(data.data) ? data.data as LockedUser[] : []);
            }
        } catch (e) { console.error(e); }
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        lockout_enabled: draft.lockoutEnabled,
                        lockout_threshold_manager: draft.thresholdManager,
                        lockout_threshold_staff: draft.thresholdStaff,
                        lockout_window_hours: draft.windowHours,
                        lockout_cooldown_start_attempt: draft.cooldownStartAttempt,
                        lockout_retry_delay_value: draft.retryDelayValue,
                        lockout_retry_delay_unit: draft.retryDelayUnit,
                        lockout_max_cooldown_attempts: draft.maxCooldownAttempts,
                    }
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSettings();
                setEditMode(false);
                void notifySuccess('Lockout policy saved.');
            } else {
                void notifyError(data.message || 'Failed to save settings.');
            }
        } catch {
            void notifyError('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleUnlock = async (userId: number) => {
        setUnlocking(userId);
        try {
            const res = await fetch(`${API_BASE}/users.php?action=unlock&id=${userId}`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (data.success) {
                setLockedUsers(prev => prev.filter(u => u.id !== userId));
                void notifySuccess('Account unlocked.');
            } else {
                void notifyError(data.message || 'Failed to unlock user.');
            }
        } catch {
            void notifyError('Network error.');
        } finally {
            setUnlocking(null);
        }
    };

    const handleReloadList = async () => {
        setListReloading(true);
        try {
            await Promise.all([fetchSettings(), fetchLockedUsers()]);
        } finally {
            setListReloading(false);
        }
    };

    const paginatedLockedUsers = lockedUsers.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(lockedUsers.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [lockedUsers.length, currentPage]);

    if (authLoading) {
        return (
            <SettingsLayout activeSection="account-lockout" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    const waitLabel = `${policy.retryDelayValue} ${policy.retryDelayUnit === 'seconds' ? 'sec' : 'min'}`;

    return (
        <SettingsLayout activeSection="account-lockout" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Account Lockout" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReloadList} loading={listReloading} title="Reload account lockout settings" />
            </div>

            {/* Policy Card */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14, marginBottom: 12 }}>
                {/* Header row */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>Lockout Policy</h2>
                        <span style={{
                            fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 20,
                            background: policy.lockoutEnabled ? '#dcfce7' : '#f3f4f6',
                            color: policy.lockoutEnabled ? '#16a34a' : '#6b7280',
                            border: `1px solid ${policy.lockoutEnabled ? '#86efac' : '#d1d5db'}`,
                        }}>
                            {policy.lockoutEnabled ? '● Active' : '○ Disabled'}
                        </span>
                    </div>
                    {!editMode && (
                        <button
                            onClick={() => { setDraft(policy); setEditMode(true); }}
                            style={{ background: 'transparent', color: '#1e3a8a', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                        >
                            Edit
                        </button>
                    )}
                </div>

                {!editMode ? (
                    /* ── Read-only display ── */
                    <div>
                        <PolicyRow label="Enable lockout" value={policy.lockoutEnabled ? 'On' : 'Off'} />
                        <PolicyRow label="Manager — wrong attempts before lockout" value={String(policy.thresholdManager)} />
                        <PolicyRow label="Staff — wrong attempts before lockout" value={String(policy.thresholdStaff)} />
                        <PolicyRow label="Attempt window" value={`${policy.windowHours}h`} />
                        <PolicyRow label="Cooldown starts after attempt #" value={String(policy.cooldownStartAttempt)} />
                        <PolicyRow label="Cooldown wait" value={waitLabel} highlight />
                        <PolicyRow label="Max cooldown cycles before hard lock" value={String(policy.maxCooldownAttempts)} />

                        {/* Cooldown explanation */}
                        <div style={{
                            marginTop: 12, padding: '10px 14px', borderRadius: 8,
                            background: '#fffbeb', border: '1px solid #fde68a', fontSize: 11, color: '#92400e', lineHeight: 1.6,
                        }}>
                            <strong>How it works:</strong> After <strong>{policy.cooldownStartAttempt}</strong> wrong attempt{policy.cooldownStartAttempt !== 1 ? 's' : ''}, login is blocked for <strong>{waitLabel}</strong> — and the wait keeps growing with every further wrong attempt (2×, 3×, …).
                            After <strong>{policy.maxCooldownAttempts}</strong> cooldown cycle{policy.maxCooldownAttempts !== 1 ? 's' : ''} the account is fully locked and requires admin unlock.
                            All attempts are tracked within a <strong>{policy.windowHours}h</strong> window.
                        </div>
                    </div>
                ) : (
                    /* ── Edit mode ── */
                    <div>
                        {/* Enable toggle */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                            <label style={{ fontSize: 12, color: '#374151', fontWeight: 600, minWidth: 180 }}>Enable lockout</label>
                            <SettingsToggle checked={draft.lockoutEnabled} onChange={v => setDraft(d => ({ ...d, lockoutEnabled: v }))} disabled={saving} showStatus />
                        </div>

                        {draft.lockoutEnabled && (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
                                {/* Manager threshold */}
                                <EditField
                                    label="Manager — wrong attempts before lockout"
                                    hint="Attempts before account locks (managers)"
                                    value={draft.thresholdManager}
                                    min={1} max={50}
                                    onChange={v => setDraft(d => ({ ...d, thresholdManager: v }))}
                                    disabled={saving}
                                />
                                {/* Staff threshold */}
                                <EditField
                                    label="Staff — wrong attempts before lockout"
                                    hint="Attempts before account locks (staff)"
                                    value={draft.thresholdStaff}
                                    min={1} max={50}
                                    onChange={v => setDraft(d => ({ ...d, thresholdStaff: v }))}
                                    disabled={saving}
                                />
                                {/* Window */}
                                <EditField
                                    label="Attempt window (hours)"
                                    hint="Failed attempts are counted within this window"
                                    value={draft.windowHours}
                                    min={1} max={720}
                                    onChange={v => setDraft(d => ({ ...d, windowHours: v }))}
                                    disabled={saving}
                                />
                                {/* Cooldown start */}
                                <EditField
                                    label="Cooldown starts after attempt #"
                                    hint="Wrong attempts that trigger the cooldown timer"
                                    value={draft.cooldownStartAttempt}
                                    min={1} max={50}
                                    onChange={v => setDraft(d => ({ ...d, cooldownStartAttempt: v }))}
                                    disabled={saving}
                                />
                                {/* Max cooldown */}
                                <EditField
                                    label="Max cooldown cycles before hard lock"
                                    hint="How many cooldowns before the account is fully locked"
                                    value={draft.maxCooldownAttempts}
                                    min={1} max={10}
                                    onChange={v => setDraft(d => ({ ...d, maxCooldownAttempts: Math.min(10, v) }))}
                                    disabled={saving}
                                />
                                {/* Wait */}
                                <div style={{ display: 'grid', gap: 4 }}>
                                    <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>Cooldown wait duration</label>
                                    <span style={{ fontSize: 10, color: '#9ca3af', marginBottom: 2 }}>Time the user must wait before retrying</span>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                        <input
                                            type="number" min={1} max={86400}
                                            value={draft.retryDelayValue}
                                            disabled={saving}
                                            onChange={e => setDraft(d => ({ ...d, retryDelayValue: Math.max(1, parseInt(e.target.value) || 1) }))}
                                            style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111827', background: '#fff', flex: 1, minWidth: 0 }}
                                        />
                                        <select
                                            value={draft.retryDelayUnit}
                                            disabled={saving}
                                            onChange={e => setDraft(d => ({ ...d, retryDelayUnit: e.target.value === 'minutes' ? 'minutes' : 'seconds' }))}
                                            style={{ padding: '7px 8px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 12, color: '#111827', background: '#fff', flex: '0 0 80px' }}
                                        >
                                            <option value="seconds">Sec</option>
                                            <option value="minutes">Min</option>
                                        </select>
                                    </div>
                                </div>
                            </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
                            <button
                                onClick={() => { setDraft(policy); setEditMode(false); }}
                                disabled={saving}
                                style={{ background: 'transparent', color: '#6b7280', border: '1px solid #d1d5db', padding: '6px 14px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleSave}
                                disabled={saving}
                                style={{ background: '#1e3a8a', color: '#fff', border: 'none', padding: '6px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, opacity: saving ? 0.6 : 1 }}
                            >
                                {saving ? 'Saving…' : 'Save'}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* Locked Accounts Card */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <h2 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#111827' }}>Locked Accounts</h2>
                    <span style={{
                        display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12,
                        fontWeight: 700, background: lockedUsers.length > 0 ? '#fef2f2' : '#f0fdf4',
                        color: lockedUsers.length > 0 ? '#dc2626' : '#16a34a',
                        border: `1px solid ${lockedUsers.length > 0 ? '#fca5a5' : '#86efac'}`,
                    }}>
                        {lockedUsers.length}
                    </span>
                    <TinyReloadButton onClick={handleReloadList} loading={listReloading} title="Reload locked accounts" />
                </div>

                {lockedUsers.length === 0 ? (
                    <div style={{ padding: '28px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 8px', display: 'block' }}>
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        <p style={{ margin: 0 }}>No locked accounts</p>
                    </div>
                ) : (
                    <>
                        <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead>
                                <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                                    <th style={{ padding: '9px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>User</th>
                                    <th style={{ padding: '9px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Role</th>
                                    <th style={{ padding: '9px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }} className="llb-num">Failed Attempts</th>
                                    <th style={{ padding: '9px 12px', textAlign: 'left', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Status</th>
                                    <th className="llb-actions-heading" style={{ padding: '9px 12px', textAlign: 'center', color: '#6b7280', fontSize: 12, fontWeight: 700 }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {paginatedLockedUsers.map(u => {
                                    const cooldownUntil = u.lockout_cooldown_until ? new Date(u.lockout_cooldown_until) : null;
                                    const inCooldown = cooldownUntil && cooldownUntil > new Date();
                                    const statusLabel = inCooldown ? 'Cooldown' : 'Locked';
                                    const statusColor = inCooldown ? '#d97706' : '#dc2626';
                                    const statusBg = inCooldown ? '#fef3c7' : '#fef2f2';
                                    const statusBorder = inCooldown ? '#fde68a' : '#fca5a5';
                                    return (
                                        <tr key={u.id} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                            <td style={{ padding: '11px 12px', color: '#111827', fontSize: 13 }}>
                                                <div style={{ fontWeight: 600 }}>{u.first_name} {u.last_name}</div>
                                                <div style={{ fontSize: 11, color: '#9ca3af' }}>{u.email}</div>
                                            </td>
                                            <td style={{ padding: '11px 12px' }}>
                                                <span style={{
                                                    padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                                    background: u.role === 'manager' ? '#fef3c7' : '#dcfce7',
                                                    color: u.role === 'manager' ? '#d97706' : '#15803d',
                                                    textTransform: 'capitalize',
                                                }}>{u.role}</span>
                                            </td>
                                            <td style={{ padding: '11px 12px', color: '#dc2626', fontWeight: 700, fontSize: 13 }} className="llb-num">
                                                {u.reset_request_count}
                                            </td>
                                            <td style={{ padding: '11px 12px' }}>
                                                <span style={{
                                                    padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700,
                                                    background: statusBg, color: statusColor, border: `1px solid ${statusBorder}`,
                                                }}>
                                                    {statusLabel}
                                                    {inCooldown && cooldownUntil && (
                                                        <span style={{ fontWeight: 400, marginLeft: 4, fontSize: 10 }}>
                                                            until {cooldownUntil.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                                        </span>
                                                    )}
                                                </span>
                                            </td>
                                            <td style={{ padding: '11px 12px', textAlign: 'center' }} className="llb-actions">
                                                <button
                                                    onClick={() => handleUnlock(u.id)}
                                                    disabled={unlocking === u.id}
                                                    style={{
                                                        background: '#16a34a', color: '#fff', border: 'none',
                                                        padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
                                                        fontSize: 12, fontWeight: 700, opacity: unlocking === u.id ? 0.6 : 1,
                                                    }}
                                                >
                                                    {unlocking === u.id ? 'Unlocking…' : '🔓 Unlock'}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        <Pagination
                            currentPage={currentPage}
                            totalItems={lockedUsers.length}
                            itemsPerPage={ITEMS_PER_PAGE}
                            onPageChange={setCurrentPage}
                            label="locked accounts"
                        />
                    </>
                )}
            </div>
        </SettingsLayout>
    );
}

// ── Small helper component for edit-mode fields ──────────────────────────────
function EditField({
    label, hint, value, min, max, onChange, disabled,
}: {
    label: string; hint: string; value: number; min: number; max: number;
    onChange: (v: number) => void; disabled: boolean;
}) {
    return (
        <div style={{ display: 'grid', gap: 3 }}>
            <label style={{ fontSize: 11, color: '#374151', fontWeight: 600 }}>{label}</label>
            <span style={{ fontSize: 10, color: '#9ca3af' }}>{hint}</span>
            <input
                type="number" min={min} max={max} value={value} disabled={disabled}
                onChange={e => onChange(Math.max(min, Math.min(max, parseInt(e.target.value) || min)))}
                style={{ padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111827', background: '#fff' }}
            />
        </div>
    );
}
