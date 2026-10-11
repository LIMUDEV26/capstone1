import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import { useProtectedPage } from '@/components/AuthProvider';
import { getBackendBaseUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';
import { formatPhoneDisplay } from '@/utils/phone';
import { getProfileEditFieldLabels } from '@/utils/profileEditFields';
import { useLiveSync } from '@/utils/liveSync';
const API_BASE_URL = getBackendBaseUrl();

type EditRequestRow = {
    request_id: number;
    user_id: number;
    requester_name: string;
    requester_role: string;
    email?: string | null;
    branch_name?: string | null;
    request_reason?: string | null;
    status: string;
    created_at: string;
    approved_at?: string | null;
    access_granted_until?: string | null;
    used_at?: string | null;
    archived_at?: string | null;
    approved_by_name?: string | null;
    archived_by_name?: string | null;
    request_snapshot?: Record<string, unknown> | null;
    requested_fields?: string[] | null;
    updated_fields?: string[] | null;
    can_approve?: boolean;
    can_revoke?: boolean;
    can_archive?: boolean;
};

type RequestsPayload = {
    summary: {
        pending: number;
        approved: number;
        used: number;
        archived: number;
    };
    active_items: EditRequestRow[];
    archived_items: EditRequestRow[];
};

type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    data?: T;
};

const emptyPayload: RequestsPayload = {
    summary: { pending: 0, approved: 0, used: 0, archived: 0 },
    active_items: [],
    archived_items: [],
};

const snapshotFieldLabels: Array<{ key: string; label: string }> = [
    { key: 'display_name', label: 'Full Name' },
    { key: 'email', label: 'Email' },
    { key: 'mobile_number', label: 'Mobile Number' },
    { key: 'role', label: 'Role' },
    { key: 'status', label: 'Status' },
    { key: 'branch_name', label: 'Branch' },
    { key: 'date_of_birth', label: 'Birthdate' },
    { key: 'sss_number', label: 'SSS Number' },
    { key: 'pagibig_number', label: 'Pag-IBIG Number' },
    { key: 'philhealth_number', label: 'PhilHealth Number' },
    { key: 'tin_number', label: 'TIN Number' },
    { key: 'salary', label: 'Salary' },
];

const formatDateTime = (value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return 'N/A';
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString();
};

const formatStatusLabel = (row: EditRequestRow) => {
    const status = String(row.status || '').trim().toLowerCase();
    if (row.archived_at) {
        if (status === 'approved' && !row.used_at) return 'revoked';
        if (status === 'rejected' || status === 'pending') return 'rejected';
        if (status === 'used') return 'used (archived)';
        return `${status || 'archived'} (archived)`;
    }
    if (status === 'used') return 'used for update';
    return status || 'pending';
};

const statusBadgeStyle = (row: EditRequestRow) => {
    const label = formatStatusLabel(row);
    if (label.includes('archived')) {
        return { background: '#e5e7eb', color: '#374151' };
    }
    if (label === 'pending') {
        return { background: '#fef3c7', color: '#b45309' };
    }
    if (label === 'approved') {
        return { background: '#dcfce7', color: '#166534' };
    }
    if (label === 'rejected' || label === 'revoked') {
        return { background: '#fee2e2', color: '#b91c1c' };
    }
    return { background: '#dbeafe', color: '#1d4ed8' };
};

export default function EditRequestsPage() {
    const router = useRouter();
    const { user, loading: authLoading, logout } = useProtectedPage({
        allowedRoles: ['admin'],
        unauthorizedRedirect: '/403',
    });

    const [loading, setLoading] = useState(true);
    const [payload, setPayload] = useState<RequestsPayload>(emptyPayload);
    const [showArchived, setShowArchived] = useState(false);
    const [activeRequest, setActiveRequest] = useState<EditRequestRow | null>(null);
    const [actingRequestId, setActingRequestId] = useState<number | null>(null);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');

    const normalizedRole = String(user?.role || '').toLowerCase();
    const canAccessPage = normalizedRole === 'admin';

    // Live-sync: silently refresh edit requests in background.
    useLiveSync(async () => {
        if (!canAccessPage) return;
        try {
            const res = await fetch(`${API_BASE_URL}/api/edit-requests.php`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<RequestsPayload>;
            if (data.success && data.data) setPayload(data.data);
        } catch {
            // Silently ignore background refresh errors.
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    const visibleRows = useMemo(
        () => (showArchived ? payload.archived_items : payload.active_items),
        [payload, showArchived]
    );

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    useEffect(() => {
        if (!success) return;
        void notifySuccess(success);
        setSuccess('');
    }, [success]);

    useEffect(() => {
        if (authLoading) return;
        if (!canAccessPage) {
            void router.replace(normalizedRole === 'manager' ? '/manager/dashboard' : '/dashboard');
        }
    }, [authLoading, canAccessPage, normalizedRole, router]);

    useEffect(() => {
        if (authLoading || !user || !canAccessPage) return;

        let active = true;
        const load = async () => {
            setLoading(true);
            try {
                const res = await fetch(`${API_BASE_URL}/api/edit-requests.php`, { credentials: 'include' });
                const data = (await res.json()) as ApiResponse<RequestsPayload>;
                if (!active) return;
                if (!data.success || !data.data) {
                    setPayload(emptyPayload);
                    setError(data.message || 'Failed to load edit requests.');
                    return;
                }
                setPayload(data.data);
            } catch {
                if (active) {
                    setPayload(emptyPayload);
                    setError('Failed to load edit requests.');
                }
            } finally {
                if (active) setLoading(false);
            }
        };

        void load();

        return () => {
            active = false;
        };
    }, [authLoading, canAccessPage, user]);

    useEffect(() => {
        if (!activeRequest) return;
        const previousOverflow = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.body.style.overflow = previousOverflow;
        };
    }, [activeRequest]);

    const refreshRequests = async () => {
        const res = await fetch(`${API_BASE_URL}/api/edit-requests.php`, { credentials: 'include' });
        const data = (await res.json()) as ApiResponse<RequestsPayload>;
        if (!data.success || !data.data) {
            throw new Error(data.message || 'Failed to load edit requests.');
        }
        setPayload(data.data);
        return data.data;
    };

    const runAction = async (requestId: number, action: 'approve' | 'reject' | 'revoke' | 'archive') => {
        setActingRequestId(requestId);
        try {
            const res = await fetch(`${API_BASE_URL}/api/edit-requests.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ request_id: requestId, action }),
            });
            const data = (await res.json()) as ApiResponse<{ email_sent?: boolean }>;
            if (!data.success) {
                setError(data.message || 'Failed to update edit request.');
                return;
            }

            setSuccess(data.message || 'Edit request updated successfully.');
            setPayload(prev => {
                if (action === 'archive') {
                    const idx = prev.active_items.findIndex(r => r.request_id === requestId);
                    if (idx === -1) return prev;
                    const moved = { ...prev.active_items[idx], status: 'archived' as const };
                    return { ...prev, active_items: prev.active_items.filter(r => r.request_id !== requestId), archived_items: [moved, ...prev.archived_items] };
                }
                const statusMap: Record<string, string> = { approve: 'approved', reject: 'rejected', revoke: 'revoked' };
                return { ...prev, active_items: prev.active_items.map(r => r.request_id === requestId ? { ...r, status: statusMap[action] ?? r.status } : r) };
            });
            if (activeRequest?.request_id === requestId) {
                if (action === 'reject' || action === 'revoke' || action === 'archive') {
                    setActiveRequest(null);
                } else {
                    setActiveRequest(prev => prev ? { ...prev, status: 'approved' } : null);
                }
            }
        } catch {
            setError('Failed to update edit request.');
        } finally {
            setActingRequestId(null);
        }
    };

    if (authLoading || loading) {
        return (
            <Layout role={String(user?.role || '')} user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </Layout>
        );
    }

    return (
        <Layout role={String(user?.role || '')} user={user} onLogout={logout}>
            <Head>
                <title>Edit Request</title>
            </Head>

            <div style={{ maxWidth: 1180, margin: '0 auto', padding: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
                    <div>
                        <h1 style={{ margin: 0, fontSize: 14, color: '#0f172a' }}>Edit Request</h1>
                        <p style={{ margin: '6px 0 0 0', fontSize: 13, color: '#64748b' }}>
                            Review pending profile edit access requests, approve them, reject them into archive, or revoke approved access when needed.
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => setShowArchived(false)} style={showArchived ? secondaryButtonStyle : primaryButtonStyle}>Active Queue</button>
                        <button type="button" onClick={() => setShowArchived(true)} style={showArchived ? primaryButtonStyle : secondaryButtonStyle}>Archive</button>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                    {[
                        ['Pending', payload.summary.pending],
                        ['Approved', payload.summary.approved],
                        ['Used', payload.summary.used],
                        ['Archived', payload.summary.archived],
                    ].map(([label, value]) => (
                        <div key={label} style={summaryCardStyle}>
                            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>{label}</div>
                            <div style={{ color: '#0f172a', fontSize: 14, fontWeight: 700 }}>{value}</div>
                        </div>
                    ))}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 14, overflow: 'hidden' }}>
                    {visibleRows.length === 0 ? (
                        <div style={{ padding: 22, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                            {showArchived ? 'No archived edit requests found.' : 'No active edit requests found.'}
                        </div>
                    ) : (
                        <div style={{ overflowX: 'auto' }}>
                            <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead>
                                    <tr style={{ background: '#f8fafc', color: '#475569', fontSize: 12, textAlign: 'left' }}>
                                        <th style={tableHeadStyle}>Requester</th>
                                        <th style={tableHeadStyle}>Role</th>
                                        <th style={tableHeadStyle}>Branch</th>
                                        <th style={tableHeadStyle}>Requested Details</th>
                                        <th style={tableHeadStyle}>Requested</th>
                                        <th style={tableHeadStyle}>Status</th>
                                        <th style={tableHeadStyle}>Access Until</th>
                                        <th style={tableHeadStyle}>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleRows.map((row) => {
                                        const badgeStyle = statusBadgeStyle(row);
                                        const busy = actingRequestId === row.request_id;
                                        return (
                                            <tr key={row.request_id} style={{ borderTop: '1px solid #e2e8f0' }}>
                                                <td style={tableCellStyle}>
                                                    <div style={{ fontWeight: 600, color: '#0f172a', fontSize: 13 }}>{row.requester_name}</div>
                                                    <div style={{ color: '#64748b', fontSize: 12 }}>{row.email || 'No email'}</div>
                                                </td>
                                                <td style={tableCellStyle}><span style={{ textTransform: 'capitalize' }}>{row.requester_role || 'N/A'}</span></td>
                                                <td style={tableCellStyle}>{row.branch_name || 'No branch'}</td>
                                                <td style={{ ...tableCellStyle, minWidth: 190 }}>
                                                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                                        {getProfileEditFieldLabels(row.requested_fields).map((label) => (
                                                            <span key={label} style={{ ...pillStyle, background: '#eff6ff', color: '#1d4ed8' }}>{label}</span>
                                                        ))}
                                                    </div>
                                                </td>
                                                <td style={tableCellStyle}>{formatDateTime(row.created_at)}</td>
                                                <td style={tableCellStyle}>
                                                    <span style={{ ...pillStyle, ...badgeStyle }}>{formatStatusLabel(row)}</span>
                                                </td>
                                                <td style={tableCellStyle}>{formatDateTime(row.access_granted_until)}</td>
                                                <td className="llb-actions" style={tableCellStyle}>
                                                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                        <button type="button" onClick={() => setActiveRequest(row)} style={secondaryActionButtonStyle}>View</button>
                                                        {!showArchived && row.can_approve && (
                                                            <button type="button" disabled={busy} onClick={() => void runAction(row.request_id, 'approve')} style={approveButtonStyle(busy)}>
                                                                {busy ? 'Working...' : 'Approve'}
                                                            </button>
                                                        )}
                                                        {!showArchived && row.status === 'pending' && row.can_archive && (
                                                            <button type="button" disabled={busy} onClick={() => void runAction(row.request_id, 'reject')} style={rejectButtonStyle(busy)}>
                                                                {busy ? 'Working...' : 'Reject'}
                                                            </button>
                                                        )}
                                                        {!showArchived && row.can_revoke && (
                                                            <button type="button" disabled={busy} onClick={() => void runAction(row.request_id, 'revoke')} style={revokeButtonStyle(busy)}>
                                                                {busy ? 'Working...' : 'Revoke'}
                                                            </button>
                                                        )}
                                                        {!showArchived && row.status !== 'pending' && row.can_archive && (
                                                            <button type="button" disabled={busy} onClick={() => void runAction(row.request_id, 'archive')} style={archiveButtonStyle(busy)}>
                                                                {busy ? 'Working...' : 'Archive'}
                                                            </button>
                                                        )}
                                                    </div>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            {activeRequest && (
                <div style={modalOverlayStyle}>
                    <div style={modalCardStyle}>
                        <div style={modalHeaderStyle}>
                            <div>
                                <h2 style={{ margin: 0, fontSize: 14, color: '#0f172a' }}>Edit Request Details</h2>
                                <p style={{ margin: '6px 0 0 0', fontSize: 13, color: '#64748b' }}>
                                    Review the request details and the profile snapshot captured when access was requested.
                                </p>
                            </div>
                            <button type="button" onClick={() => setActiveRequest(null)} style={closeButtonStyle}>X</button>
                        </div>

                        <div style={{ padding: 24, overflowY: 'auto' }}>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 16 }}>
                                {[
                                    ['Requester', activeRequest.requester_name],
                                    ['Role', activeRequest.requester_role],
                                    ['Email', activeRequest.email || 'No email'],
                                    ['Branch', activeRequest.branch_name || 'No branch'],
                                    ['Requested At', formatDateTime(activeRequest.created_at)],
                                    ['Approved At', formatDateTime(activeRequest.approved_at)],
                                    ['Access Until', formatDateTime(activeRequest.access_granted_until)],
                                    ['Archived At', formatDateTime(activeRequest.archived_at)],
                                    ['Approved By', activeRequest.approved_by_name || 'N/A'],
                                    ['Archived By', activeRequest.archived_by_name || 'N/A'],
                                ].map(([label, value]) => (
                                    <div key={String(label)} style={detailCardStyle}>
                                        <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>{label}</div>
                                        <div style={{ color: '#0f172a', fontSize: 13, fontWeight: 600, textTransform: label === 'Role' ? 'capitalize' : 'none' }}>{value}</div>
                                    </div>
                                ))}
                            </div>

                            <div style={{ ...detailCardStyle, marginBottom: 16 }}>
                                <div style={{ color: '#64748b', fontSize: 12, marginBottom: 8 }}>Requested Details</div>
                                <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
                                    {getProfileEditFieldLabels(activeRequest.requested_fields).map((label) => (
                                        <span key={label} style={{ ...pillStyle, background: '#eff6ff', color: '#1d4ed8' }}>{label}</span>
                                    ))}
                                </div>
                            </div>

                            <div style={{ ...detailCardStyle, marginBottom: 16 }}>
                                <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>Reason</div>
                                <div style={{ color: '#0f172a', fontSize: 13, lineHeight: 1.6 }}>
                                    {activeRequest.request_reason?.trim() || 'No reason was provided.'}
                                </div>
                            </div>

                            <div style={{ ...detailCardStyle, marginBottom: 16 }}>
                                <div style={{ color: '#64748b', fontSize: 12, marginBottom: 10 }}>Profile Snapshot</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10 }}>
                                    {snapshotFieldLabels.map(({ key, label }) => (
                                        <div key={key} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#fff' }}>
                                            <div style={{ color: '#64748b', fontSize: 12, marginBottom: 4 }}>{label}</div>
                                            <div style={{ color: '#0f172a', fontSize: 13, fontWeight: 600 }}>
                                                {key === 'mobile_number'
                                                    ? (formatPhoneDisplay(activeRequest.request_snapshot?.[key]) || 'N/A')
                                                    : String(activeRequest.request_snapshot?.[key] ?? 'N/A')}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div style={detailCardStyle}>
                                <div style={{ color: '#64748b', fontSize: 12, marginBottom: 6 }}>Updated Fields</div>
                                <div style={{ color: '#0f172a', fontSize: 13, lineHeight: 1.6 }}>
                                    {Array.isArray(activeRequest.updated_fields) && activeRequest.updated_fields.length > 0
                                        ? activeRequest.updated_fields.join(', ')
                                        : 'No completed profile update is linked to this request yet.'}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}

const primaryButtonStyle: CSSProperties = {
    padding: '10px 14px',
    borderRadius: 10,
    border: '1px solid #1d4ed8',
    background: '#1d4ed8',
    color: '#fff',
    fontWeight: 700,
    cursor: 'pointer',
};

const secondaryButtonStyle: CSSProperties = {
    ...primaryButtonStyle,
    background: '#eff6ff',
    color: '#1d4ed8',
    borderColor: '#bfdbfe',
};

const summaryCardStyle: CSSProperties = {
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 14,
    padding: 14,
    boxShadow: '0 4px 14px rgba(15, 23, 42, 0.07), 0 1px 3px rgba(15, 23, 42, 0.04)',
};

const tableHeadStyle: CSSProperties = {
    padding: '12px 14px',
    whiteSpace: 'nowrap',
};

const tableCellStyle: CSSProperties = {
    padding: '12px 14px',
    color: '#334155',
    fontSize: 13,
    verticalAlign: 'top',
};

const pillStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    padding: '4px 10px',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'capitalize',
};

const secondaryActionButtonStyle: CSSProperties = {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#334155',
    fontWeight: 600,
    cursor: 'pointer',
};

const approveButtonStyle = (disabled: boolean): CSSProperties => ({
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #16a34a',
    background: '#16a34a',
    color: '#fff',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
});

const rejectButtonStyle = (disabled: boolean): CSSProperties => ({
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #dc2626',
    background: '#dc2626',
    color: '#fff',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
});

const revokeButtonStyle = (disabled: boolean): CSSProperties => ({
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #b45309',
    background: '#f59e0b',
    color: '#fff',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
});

const archiveButtonStyle = (disabled: boolean): CSSProperties => ({
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid #94a3b8',
    background: '#f8fafc',
    color: '#334155',
    fontWeight: 700,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.7 : 1,
});

const modalOverlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.56)',
    backdropFilter: 'blur(4px)',
    zIndex: 20000,
    padding: 24,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
};

const modalCardStyle: CSSProperties = {
    width: 'min(1120px, 100%)',
    maxHeight: 'calc(100vh - 48px)',
    background: '#fff',
    borderRadius: 20,
    border: '1px solid rgba(148, 163, 184, 0.28)',
    boxShadow: '0 30px 80px rgba(15, 23, 42, 0.28)',
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
};

const modalHeaderStyle: CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 16,
    alignItems: 'flex-start',
    padding: '20px 24px',
    borderBottom: '1px solid #e2e8f0',
    background: 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
};

const closeButtonStyle: CSSProperties = {
    width: 40,
    height: 40,
    borderRadius: 999,
    border: '1px solid #cbd5e1',
    background: '#fff',
    color: '#475569',
    cursor: 'pointer',
    fontSize: 14,
    lineHeight: 1,
};

const detailCardStyle: CSSProperties = {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 14,
    padding: 14,
};
