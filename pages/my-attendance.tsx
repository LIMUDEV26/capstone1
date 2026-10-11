import { type CSSProperties, useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import Pagination from '../components/Pagination';
import { getBackendBaseUrl } from '@/utils/network';
import { notifyError } from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE_URL = getBackendBaseUrl();

type SessionUser = {
    id?: number;
    role?: string;
    employee_id?: number;
    first_name?: string;
    [key: string]: unknown;
};

type ShiftRow = {
    shift_schedule_id: number;
    employee_id: number;
    employee_name?: string | null;
    shift_date: string;
    shift_start: string;
    shift_end: string;
    shift_type?: string;
    status: 'scheduled' | 'completed' | 'cancelled' | 'no_show' | string;
    notes?: string | null;
};

type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    data?: T;
};

function todayDateValue() {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${now.getFullYear()}-${month}-${day}`;
}

export default function MyAttendancePage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [rows, setRows] = useState<ShiftRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [dateFrom, setDateFrom] = useState(todayDateValue().slice(0, 8) + '01');
    const [dateTo, setDateTo] = useState(todayDateValue());
    const [currentPage, setCurrentPage] = useState(1);
    const [savingId, setSavingId] = useState<number | null>(null);
    const role = String(user?.role || '').toLowerCase();
    const isLimitedAttendanceView = role === 'staff' || role === 'manager';

    const statusOptions = useMemo(() => (
        isLimitedAttendanceView
            ? [
                { value: 'all', label: 'All Status' },
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'completed', label: 'Completed' },
            ]
            : [
                { value: 'all', label: 'All Status' },
                { value: 'scheduled', label: 'Scheduled' },
                { value: 'completed', label: 'Completed' },
                { value: 'no_show', label: 'No Show' },
                { value: 'cancelled', label: 'Cancelled' },
            ]
    ), [isLimitedAttendanceView]);

    useEffect(() => {
        const init = async () => {
            try {
                const sessionRes = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
                const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
                if (!sessionData.success || !sessionData.data) {
                    router.push('/');
                    return;
                }

                const role = String(sessionData.data.role || '').toLowerCase();
                if (role === 'staff' || role === 'manager') {
                    router.replace('/calendar');
                    return;
                }

                if (role !== 'admin') {
                    router.push('/dashboard');
                    return;
                }

                setUser(sessionData.data);
            } catch {
                router.push('/');
            } finally {
                setLoading(false);
            }
        };

        init();
    }, [router]);

    const fetchRows = useCallback(async (employeeId?: number) => {
        if (!employeeId) {
            setRows([]);
            setError('Your account is not linked to an employee record.');
            return;
        }

        setError('');
        const params = new URLSearchParams({
            employee_id: String(employeeId),
            date_from: dateFrom,
            date_to: dateTo,
        });
        if (statusFilter !== 'all') {
            params.set('status', statusFilter);
        }

        try {
            const res = await fetch(`${API_BASE_URL}/api/shift-schedules.php?${params.toString()}`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<ShiftRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setRows(data.data);
            } else {
                setRows([]);
                setError(data.message || 'Failed to load attendance.');
            }
        } catch {
            setRows([]);
            setError('Failed to load attendance.');
        }
    }, [dateFrom, dateTo, statusFilter]);

    useEffect(() => {
        if (user?.employee_id) {
            fetchRows(user.employee_id);
        }
    }, [fetchRows, user?.employee_id]);

    useEffect(() => {
        if (isLimitedAttendanceView && (statusFilter === 'no_show' || statusFilter === 'cancelled')) {
            setStatusFilter('all');
        }
    }, [isLimitedAttendanceView, statusFilter]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    const handleLogout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const markCompleted = async (row: ShiftRow) => {
        setSavingId(row.shift_schedule_id);
        setError('');
        try {
            const res = await fetch(`${API_BASE_URL}/api/shift-schedules.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    shift_schedule_id: row.shift_schedule_id,
                    status: 'completed',
                }),
            });
            const data = (await res.json()) as ApiResponse<null>;
            if (!data.success) {
                setError(data.message || 'Failed to update attendance status.');
                return;
            }
            setRows((prev) => prev.map((r) => (r.shift_schedule_id === row.shift_schedule_id ? { ...r, status: 'completed' } : r)));
        } catch {
            setError('Failed to update attendance status.');
        } finally {
            setSavingId(null);
        }
    };

    const summary = useMemo(() => {
        return rows.reduce(
            (acc, row) => {
                if (row.status === 'scheduled') acc.scheduled += 1;
                if (row.status === 'completed') acc.completed += 1;
                if (row.status === 'no_show') acc.noShow += 1;
                if (row.status === 'cancelled') acc.cancelled += 1;
                return acc;
            },
            { scheduled: 0, completed: 0, noShow: 0, cancelled: 0 }
        );
    }, [rows]);

    const paginatedRows = rows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        setCurrentPage(1);
    }, [rows.length, statusFilter, dateFrom, dateTo]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [rows.length, currentPage]);

    if (loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head><title>My Attendance</title></Head>
            <div style={{ padding: 16, maxWidth: 1160, margin: '0 auto' }}>
                <div className="pageHeaderInline">
                    <div className="pageHeaderText">
                        <h1 style={{ margin: '0 0 6px 0', fontSize: 14, color: '#1f2937' }}>My Attendance</h1>
                        <p style={{ margin: 0, color: '#64748b', fontSize: 13 }}>
                            View your assigned shift schedules and mark them as completed once done.
                        </p>
                    </div>
                    <div className="pageInlineFilters">
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }}>
                            {statusOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                    {option.label}
                                </option>
                            ))}
                        </select>
                        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} />
                        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} style={{ padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1' }} />
                        <button
                            onClick={() => fetchRows(user?.employee_id)}
                            style={{ padding: '10px 14px', borderRadius: 8, border: '1px solid #1e3a8a', background: '#1e3a8a', color: '#fff', cursor: 'pointer' }}
                        >
                            Refresh
                        </button>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
                    <MiniStat label="Scheduled" value={summary.scheduled} color="#1d4ed8" background="#dbeafe" />
                    <MiniStat label="Completed" value={summary.completed} color="#166534" background="#dcfce7" />
                    {!isLimitedAttendanceView && <MiniStat label="No Show" value={summary.noShow} color="#b91c1c" background="#fee2e2" />}
                    {!isLimitedAttendanceView && <MiniStat label="Cancelled" value={summary.cancelled} color="#6b7280" background="#e5e7eb" />}
                </div>

                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
                    <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#f8fafc' }}>
                            <tr>
                                <th style={thStyle}>Date</th>
                                <th style={thStyle}>Shift Time</th>
                                <th style={thStyle}>Type</th>
                                <th style={thStyle}>Status</th>
                                <th style={thStyle}>Notes</th>
                                <th style={thStyle}>Action</th>
                            </tr>
                        </thead>
                        <tbody>
                            {rows.length === 0 ? (
                                <tr><td colSpan={6} style={{ padding: 22, textAlign: 'center', color: '#64748b' }}>No shift schedules found.</td></tr>
                            ) : (
                                paginatedRows.map((row) => (
                                    <tr key={row.shift_schedule_id} style={{ borderTop: '1px solid #eef2f7' }}>
                                        <td style={tdStyle}>{new Date(`${row.shift_date}T00:00:00`).toLocaleDateString()}</td>
                                        <td style={tdStyle}>{(row.shift_start || '').slice(0, 5)} - {(row.shift_end || '').slice(0, 5)}</td>
                                        <td style={tdStyle}>{row.shift_type || '-'}</td>
                                        <td style={tdStyle}>
                                            <span style={statusBadge(row.status)}>{String(row.status).replace('_', ' ')}</span>
                                        </td>
                                        <td className="llb-trunc" title={row.notes || '-'} style={tdStyle}>{row.notes || '-'}</td>
                                        <td className="llb-actions" style={tdStyle}>
                                            {row.status === 'scheduled' ? (
                                                <button
                                                    disabled={savingId === row.shift_schedule_id}
                                                    onClick={() => markCompleted(row)}
                                                    style={{
                                                        padding: '6px 10px',
                                                        borderRadius: 7,
                                                        border: 'none',
                                                        background: '#1e3a8a',
                                                        color: '#fff',
                                                        cursor: savingId === row.shift_schedule_id ? 'not-allowed' : 'pointer',
                                                        opacity: savingId === row.shift_schedule_id ? 0.65 : 1,
                                                    }}
                                                >
                                                    {savingId === row.shift_schedule_id ? 'Updating...' : 'Mark Completed'}
                                                </button>
                                            ) : (
                                                <span style={{ color: '#64748b', fontSize: 12 }}>-</span>
                                            )}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>

                <Pagination
                    currentPage={currentPage}
                    totalItems={rows.length}
                    itemsPerPage={ITEMS_PER_PAGE}
                    onPageChange={setCurrentPage}
                    label="shift schedules"
                />
            </div>
        </Layout>
    );
}

function MiniStat({ label, value, color, background }: { label: string; value: number; color: string; background: string }) {
    return (
        <div style={{ background, border: '1px solid rgba(15,23,42,0.06)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color }}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
        </div>
    );
}

const thStyle: CSSProperties = {
    padding: '12px 14px',
    textAlign: 'left',
    color: '#475569',
    fontSize: 13,
    fontWeight: 700,
};

const tdStyle: CSSProperties = {
    padding: '12px 14px',
    color: '#334155',
    fontSize: 13,
};

function statusBadge(status: string): CSSProperties {
    const value = String(status).toLowerCase();
    if (value === 'completed') {
        return { background: '#dcfce7', color: '#166534', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
    }
    if (value === 'no_show') {
        return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
    }
    if (value === 'cancelled') {
        return { background: '#e5e7eb', color: '#4b5563', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
    }
    return { background: '#dbeafe', color: '#1d4ed8', borderRadius: 999, padding: '3px 10px', fontSize: 12, fontWeight: 700, textTransform: 'capitalize' };
}

