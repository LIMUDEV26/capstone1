import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import styles from '../../styles/ShiftSchedules.module.css';
import { confirmAction, notifyError } from '@/utils/notify';
import { getBackendBaseUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API_BASE_URL = getBackendBaseUrl();

type ShiftType = 'morning' | 'afternoon' | 'night' | 'flexible';
type ShiftStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';

interface SessionUser {
    role?: string;
    [key: string]: unknown;
}

interface Employee {
    employee_id: number;
    first_name: string;
    last_name: string;
    status?: string | null;
}

interface ShiftRow {
    shift_schedule_id: number;
    employee_id: number;
    employee_name?: string | null;
    position?: string | null;
    branch_name?: string | null;
    shift_date: string;
    shift_start: string;
    shift_end: string;
    shift_type: ShiftType | string;
    status: ShiftStatus | string;
    notes?: string | null;
}

interface ApiResponse<T> {
    success?: boolean;
    data?: T;
    message?: string;
    error?: string;
}

interface ShiftForm {
    employee_id: string;
    shift_date: string;
    shift_start: string;
    shift_end: string;
    shift_type: ShiftType;
    status: ShiftStatus;
    notes: string;
}

const SHIFT_TYPES: Array<{ value: ShiftType; label: string }> = [
    { value: 'morning', label: 'Morning' },
    { value: 'afternoon', label: 'Afternoon' },
    { value: 'night', label: 'Night' },
    { value: 'flexible', label: 'Flexible' },
];

const SHIFT_STATUSES: Array<{ value: ShiftStatus; label: string }> = [
    { value: 'scheduled', label: 'Scheduled' },
    { value: 'completed', label: 'Completed' },
    { value: 'cancelled', label: 'Cancelled' },
    { value: 'no_show', label: 'No Show' },
];

const toInputDate = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
        date.getDate()
    ).padStart(2, '0')}`;

const getCurrentMonthRange = () => {
    const now = new Date();
    return {
        from: toInputDate(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: toInputDate(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
    };
};

const getToday = () => toInputDate(new Date());
const toInputTime = (value: string) => (value || '').slice(0, 5);
const formatDate = (value: string) => new Date(`${value}T00:00:00`).toLocaleDateString();
const formatTime = (value: string) =>
    new Date(`2000-01-01T${toInputTime(value)}:00`).toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
    });

const shiftHours = (start: string, end: string) => {
    const [sh, sm] = toInputTime(start).split(':').map(Number);
    const [eh, em] = toInputTime(end).split(':').map(Number);
    if ([sh, sm, eh, em].some(Number.isNaN)) return 0;
    const startMinutes = sh * 60 + sm;
    let endMinutes = eh * 60 + em;
    if (endMinutes <= startMinutes) endMinutes += 24 * 60;
    return Number(((endMinutes - startMinutes) / 60).toFixed(2));
};

const initialForm = (): ShiftForm => ({
    employee_id: '',
    shift_date: getToday(),
    shift_start: '09:00',
    shift_end: '18:00',
    shift_type: 'morning',
    status: 'scheduled',
    notes: '',
});

const getMessage = (payload: ApiResponse<unknown>, fallback: string) =>
    String(payload.message || payload.error || fallback);

export default function ShiftSchedulesPage() {
    const router = useRouter();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const range = useMemo(() => getCurrentMonthRange(), []);

    const [user, setUser] = useState<SessionUser | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [rows, setRows] = useState<ShiftRow[]>([]);

    const [search, setSearch] = useState('');
    const [employeeFilter, setEmployeeFilter] = useState('all');
    const [branchFilter, setBranchFilter] = useState('all');
    const [typeFilter, setTypeFilter] = useState<'all' | ShiftType>('all');
    const [statusFilter, setStatusFilter] = useState<'all' | ShiftStatus>('all');
    const [dateFrom, setDateFrom] = useState(range.from);
    const [dateTo, setDateTo] = useState(range.to);

    const [showModal, setShowModal] = useState(false);
    const [editing, setEditing] = useState<ShiftRow | null>(null);
    const [form, setForm] = useState<ShiftForm>(initialForm());
    const [formError, setFormError] = useState('');
    const [saving, setSaving] = useState(false);
    // Inline per-field "Required" messages for the shift form.
    const [shiftFieldErrors, setShiftFieldErrors] = useState<Record<string, string>>({});

    const clearShiftFieldError = (name: string) => {
        setShiftFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const [activeMenu, setActiveMenu] = useState<number | null>(null);
    const [busyId, setBusyId] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState(1);

    const canManage = user?.role === 'admin' || user?.role === 'manager';

    const employeeLookup = useMemo(() => {
        const map = new Map<number, string>();
        employees.forEach((employee) => {
            map.set(employee.employee_id, `${employee.first_name} ${employee.last_name}`.trim());
        });
        return map;
    }, [employees]);

    const fetchEmployees = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/employees.php`, { credentials: 'include' });
            const payload = (await response.json()) as ApiResponse<Employee[]>;
            if (!payload.success || !Array.isArray(payload.data)) return;
            setEmployees(
                payload.data
                    .filter((employee) => !['inactive', 'terminated'].includes(String(employee.status || '').toLowerCase()))
                    .sort((left, right) =>
                        `${left.first_name} ${left.last_name}`.localeCompare(`${right.first_name} ${right.last_name}`)
                    )
            );
        } catch {
            setEmployees([]);
        }
    }, []);

    const fetchRows = useCallback(async () => {
        const params = new URLSearchParams();
        if (employeeFilter !== 'all') params.set('employee_id', employeeFilter);
        if (typeFilter !== 'all') params.set('shift_type', typeFilter);
        if (statusFilter !== 'all') params.set('status', statusFilter);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);
        const query = params.toString();
        const endpoint = `${API_BASE_URL}/api/shift-schedules.php${query ? `?${query}` : ''}`;

        try {
            setError('');
            const response = await fetch(endpoint, { credentials: 'include' });
            const payload = (await response.json()) as ApiResponse<ShiftRow[]>;
            if (payload.success && Array.isArray(payload.data)) {
                setRows(payload.data);
                return;
            }
            setRows([]);
            setError(getMessage(payload, 'Failed to load shift schedules.'));
        } catch {
            setRows([]);
            setError('Network error while loading shift schedules.');
        }
    }, [dateFrom, dateTo, employeeFilter, statusFilter, typeFilter]);

    const checkSession = useCallback(async () => {
        try {
            const response = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
            const payload = (await response.json()) as ApiResponse<SessionUser>;
            if (!payload.success || !payload.data) {
                router.push('/');
                return;
            }
            const role = String(payload.data.role || '').toLowerCase();
            if (!['admin', 'manager'].includes(role)) {
                router.push('/dashboard');
                return;
            }
            setUser(payload.data);
            await fetchEmployees();
        } catch {
            router.push('/');
        } finally {
            setLoading(false);
        }
    }, [fetchEmployees, router]);

    // Live-sync: silently refresh shift schedules in background.
    useLiveSync(async () => {
        if (!user) return;
        await fetchRows();
    });

    useEffect(() => {
        void checkSession();
    }, [checkSession]);

    useEffect(() => {
        if (user) void fetchRows();
    }, [fetchRows, user]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    useEffect(() => {
        if (!formError) return;
        void notifyError(formError);
        setFormError('');
    }, [formError]);

    useEffect(() => {
        const close = () => setActiveMenu(null);
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, []);

    const visibleRows = useMemo(() => {
        const term = search.trim().toLowerCase();
        return rows.filter((row) => {
            const branch = row.branch_name || 'Unassigned';
            const name = row.employee_name || employeeLookup.get(Number(row.employee_id)) || `Employee #${row.employee_id}`;
            if (branchFilter !== 'all' && branch !== branchFilter) return false;
            if (!term) return true;
            return [name, row.position || '', branch, row.notes || '', row.status, row.shift_type].join(' ').toLowerCase().includes(term);
        });
    }, [branchFilter, employeeLookup, rows, search]);
    const paginatedRows = visibleRows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    const branchOptions = useMemo(() => {
        const values = new Set<string>();
        rows.forEach((row) => values.add(row.branch_name || 'Unassigned'));
        return Array.from(values).sort((a, b) => a.localeCompare(b));
    }, [rows]);

    const total = visibleRows.length;
    const today = getToday();
    const todayCount = visibleRows.filter((row) => row.shift_date === today).length;
    const completed = visibleRows.filter((row) => row.status === 'completed').length;
    const attention = visibleRows.filter((row) => ['cancelled', 'no_show'].includes(String(row.status))).length;
    const hours = visibleRows.reduce((sum, row) => sum + shiftHours(row.shift_start, row.shift_end), 0);

    useEffect(() => {
        setCurrentPage(1);
    }, [search, employeeFilter, branchFilter, typeFilter, statusFilter, dateFrom, dateTo]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(visibleRows.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [visibleRows.length, currentPage]);

    const logout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const resetFilters = () => {
        const month = getCurrentMonthRange();
        setSearch('');
        setEmployeeFilter('all');
        setBranchFilter('all');
        setTypeFilter('all');
        setStatusFilter('all');
        setDateFrom(month.from);
        setDateTo(month.to);
    };

    const openCreate = () => {
        setEditing(null);
        setForm(initialForm());
        setFormError('');
        setShiftFieldErrors({});
        setShowModal(true);
    };

    const openEdit = (row: ShiftRow) => {
        setEditing(row);
        setForm({
            employee_id: String(row.employee_id),
            shift_date: row.shift_date,
            shift_start: toInputTime(row.shift_start),
            shift_end: toInputTime(row.shift_end),
            shift_type: String(row.shift_type) as ShiftType,
            status: String(row.status) as ShiftStatus,
            notes: row.notes || '',
        });
        setFormError('');
        setShiftFieldErrors({});
        setShowModal(true);
        setActiveMenu(null);
    };

    const closeModal = () => {
        if (saving) return;
        setShowModal(false);
    };

    const handleFormChange = (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const { name, value } = event.target;
        setForm((current) => ({ ...current, [name]: value }));
        clearShiftFieldError(name);
    };

    const submitForm = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        // Required-field check with inline per-field messages.
        const shiftMissing: Record<string, string> = {};
        if (!form.employee_id) shiftMissing.employee_id = 'Required.';
        if (!form.shift_date) shiftMissing.shift_date = 'Required.';
        if (!form.shift_start) shiftMissing.shift_start = 'Required.';
        if (!form.shift_end) shiftMissing.shift_end = 'Required.';
        if (Object.keys(shiftMissing).length > 0) {
            setShiftFieldErrors(shiftMissing);
            return;
        }
        setShiftFieldErrors({});
        if (form.shift_start === form.shift_end) {
            setFormError('Shift start and end cannot be the same.');
            return;
        }

        setSaving(true);
        setFormError('');

        const payload: Record<string, unknown> = { ...form, employee_id: Number(form.employee_id), notes: form.notes.trim() };
        if (editing) payload.shift_schedule_id = editing.shift_schedule_id;

        try {
            const response = await fetch(`${API_BASE_URL}/api/shift-schedules.php`, {
                method: editing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const api = (await response.json()) as ApiResponse<unknown>;
            if (api.success) {
                setShowModal(false);
                // Always re-fetch so the table shows the canonical DB values
                // (avoids type mismatches between form strings and DB datetime format).
                await fetchRows();
            } else {
                setFormError(getMessage(api, 'Failed to save shift schedule.'));
            }
        } catch {
            setFormError('Network error while saving shift schedule.');
        } finally {
            setSaving(false);
        }
    };

    if (loading) {

      return (

        <Layout role={user?.role} user={user} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }
    if (!user) return null;

    return (
        <Layout role={user.role} user={user} onLogout={logout}>
            <Head><title>Shift Schedule</title></Head>
            <div className={styles.page}>
                <section className={styles.hero}>
                    <div className={`${styles.heroTop} pageHeaderInline`}>
                        <div className="pageHeaderText">
                            <h1 className={styles.title}>Shift Schedule</h1>
                            <p className={styles.subtitle}>Plan, assign, and monitor shift coverage per employee and branch.</p>
                            <div className={styles.chips}>
                                <span className={styles.chip}>Period: {formatDate(dateFrom)} - {formatDate(dateTo)}</span>
                                <span className={styles.chip}>Records: {total}</span>
                            </div>
                        </div>
                        <div className={`${styles.heroActions} pageInlineFilters`}>
                            <label><span>Search</span>
                                <SearchBar
                                    storageKey="shifts:list"
                                    placeholder="Employee, notes, status"
                                    ariaLabel="Search shift schedules"
                                    value={search}
                                    onChange={setSearch}
                                    suggestions={collectSearchTerms(rows, [
                                        (r: any) => r.employee_name || employeeLookup.get(Number(r.employee_id)),
                                        (r: any) => r.branch_name,
                                        (r: any) => r.status,
                                        (r: any) => r.shift_type,
                                    ])}
                                    inputClassName={styles.input}
                                />
                            </label>
                            <label><span>Employee</span><select value={employeeFilter} onChange={(e) => setEmployeeFilter(e.target.value)} className={styles.input}><option value="all">All</option>{employees.map((employee) => <option key={employee.employee_id} value={employee.employee_id}>{employee.first_name} {employee.last_name}</option>)}</select></label>
                            <label><span>Branch</span><select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} className={styles.input}><option value="all">All</option>{branchOptions.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</select></label>
                            <label><span>Shift Type</span><select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as 'all' | ShiftType)} className={styles.input}><option value="all">All</option>{SHIFT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
                            <label><span>Status</span><select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | ShiftStatus)} className={styles.input}><option value="all">All</option>{SHIFT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
                            <label><span>Date From</span><input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className={styles.input} /></label>
                            <label><span>Date To</span><input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className={styles.input} /></label>
                            <button type="button" className={styles.ghostButton} onClick={resetFilters}>Reset</button>
                            <button type="button" className={styles.secondaryButton} onClick={() => void fetchRows()}>Refresh</button>
                            {canManage && <button type="button" className={styles.primaryButton} onClick={openCreate} title="Add Shift" aria-label="Add Shift">Add Shift</button>}
                        </div>
                    </div>
                </section>

                <section className={styles.stats}>
                    <article className={styles.statCard}><p>Total</p><h3>{total}</h3></article>
                    <article className={styles.statCard}><p>Today</p><h3>{todayCount}</h3></article>
                    <article className={styles.statCard}><p>Completed</p><h3>{completed}</h3></article>
                    <article className={styles.statCard}><p>Needs Attention</p><h3>{attention}</h3></article>
                    <article className={styles.statCard}><p>Total Hours</p><h3>{hours.toFixed(1)}</h3></article>
                </section>
                <section className={styles.panel}>
                    <div className={styles.panelHead}><h2>Shift Assignments</h2><p>{visibleRows.length} record(s)</p></div>
                    <div className={styles.tableWrap}>
                        <table className={`${styles.table} llb-table llb-pin-first`}>
                            <thead><tr><th>Employee</th><th>Branch</th><th>Date</th><th>Time</th><th>Type</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead>
                            <tbody>
                                {visibleRows.length === 0 ? <tr><td colSpan={8} className={styles.empty}>
                                    <ZeroResults
                                        query={search}
                                        itemLabel="shift schedules"
                                        alternatives={getAlternativeSuggestions(search, collectSearchTerms(rows, [
                                            (r: any) => r.employee_name || employeeLookup.get(Number(r.employee_id)),
                                            (r: any) => r.branch_name,
                                            (r: any) => r.status,
                                        ]))}
                                        onPickAlternative={(term) => setSearch(term)}
                                        onClear={() => setSearch('')}
                                    />
                                </td></tr> : paginatedRows.map((row) => {
                                    const id = row.shift_schedule_id;
                                    const name = row.employee_name || employeeLookup.get(Number(row.employee_id)) || `Employee #${row.employee_id}`;
                                    const statusClass = row.status === 'completed' ? styles.statusOk : row.status === 'scheduled' ? styles.statusPending : styles.statusAlert;
                                    const typeClass = row.shift_type === 'morning' ? styles.typeMorning : row.shift_type === 'afternoon' ? styles.typeAfternoon : row.shift_type === 'night' ? styles.typeNight : styles.typeFlexible;
                                    return (
                                        <tr key={id}>
                                            <td><div className={styles.emp}><strong>{name}</strong><span>{row.position || 'No position'}</span></div></td>
                                            <td>{row.branch_name || 'Unassigned'}</td>
                                            <td>{formatDate(row.shift_date)}</td>
                                            <td><div className={styles.time}><span>{formatTime(row.shift_start)} - {formatTime(row.shift_end)}</span><small>{shiftHours(row.shift_start, row.shift_end)} hrs</small></div></td>
                                            <td><span className={`${styles.badge} ${typeClass}`}>{String(row.shift_type).replace('_', ' ')}</span></td>
                                            <td><span className={`${styles.badge} ${statusClass}`}>{String(row.status).replace('_', ' ')}</span></td>
                                            <td className={`${styles.notes} llb-trunc`} title={row.notes || ''}>{row.notes || '-'}</td>
                                            <td className={`${styles.actions} llb-actions`}>
                                                {canManage ? (
                                                    <div className={styles.menu}>
                                                        <button type="button" className={styles.menuBtn} onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === id ? null : id); }} disabled={busyId === id}>⋮</button>
                                                        {activeMenu === id && (
                                                            <div className={styles.menuPanel}>
                                                                <button type="button" onClick={() => openEdit(row)} title="Edit" aria-label={`Edit shift for ${name}`}><CrudActionIcon action="edit" /> Edit</button>
                                                                {row.status !== 'completed' && <button type="button" onClick={async () => {
                                                                    setBusyId(id);
                                                                    setActiveMenu(null);
                                                                    try {
                                                                        const res = await fetch(`${API_BASE_URL}/api/shift-schedules.php`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ shift_schedule_id: id, status: 'completed' }) });
                                                                        const api = (await res.json()) as ApiResponse<unknown>;
                                                                        if (api.success) setRows(prev => prev.map(r => r.shift_schedule_id === id ? { ...r, status: 'completed' } : r)); else setError(getMessage(api, 'Failed to update shift.'));
                                                                    } catch { setError('Network error while updating shift.'); } finally { setBusyId(null); }
                                                                }} title="Mark Completed" aria-label={`Mark shift for ${name} as completed`}><CrudActionIcon action="update" /> Mark Completed</button>}
                                                                {row.status !== 'no_show' && <button type="button" onClick={async () => {
                                                                    if (!(await confirmAction({ title: 'Mark as no show?', confirmButtonText: 'Confirm', icon: 'warning' }))) return;
                                                                    setBusyId(id);
                                                                    setActiveMenu(null);
                                                                    try {
                                                                        const res = await fetch(`${API_BASE_URL}/api/shift-schedules.php`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ shift_schedule_id: id, status: 'no_show' }) });
                                                                        const api = (await res.json()) as ApiResponse<unknown>;
                                                                        if (api.success) setRows(prev => prev.map(r => r.shift_schedule_id === id ? { ...r, status: 'no_show' } : r)); else setError(getMessage(api, 'Failed to update shift.'));
                                                                    } catch { setError('Network error while updating shift.'); } finally { setBusyId(null); }
                                                                }} title="Mark No Show" aria-label={`Mark shift for ${name} as no show`}><CrudActionIcon action="update" /> Mark No Show</button>}
                                                                {row.status !== 'cancelled' ? (
                                                                    <button type="button" className={styles.danger} onClick={async () => {
                                                                        if (!(await confirmAction({ title: 'Cancel this shift?', text: 'This marks the shift as cancelled.', confirmButtonText: 'Cancel Shift', icon: 'warning', danger: true }))) return;
                                                                        setBusyId(id);
                                                                        setActiveMenu(null);
                                                                        try {
                                                                            const url = `${API_BASE_URL}/api/shift-schedules.php?id=${id}`;
                                                                            const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
                                                                            const api = (await res.json()) as ApiResponse<unknown>;
                                                                            if (api.success) setRows(prev => prev.map(r => r.shift_schedule_id === id ? { ...r, status: 'cancelled' } : r)); else setError(getMessage(api, 'Failed to update shift.'));
                                                                        } catch { setError('Network error while updating shift.'); } finally { setBusyId(null); }
                                                                    }} title="Cancel Shift" aria-label={`Cancel shift for ${name}`}><CrudActionIcon action="archive" /> Cancel Shift</button>
                                                                ) : (
                                                                    <button type="button" onClick={async () => {
                                                                        setBusyId(id);
                                                                        setActiveMenu(null);
                                                                        try {
                                                                            const res = await fetch(`${API_BASE_URL}/api/shift-schedules.php`, {
                                                                                method: 'PUT',
                                                                                headers: { 'Content-Type': 'application/json' },
                                                                                credentials: 'include',
                                                                                body: JSON.stringify({ shift_schedule_id: id, status: 'scheduled' }),
                                                                            });
                                                                            const api = (await res.json()) as ApiResponse<unknown>;
                                                                            if (api.success) setRows(prev => prev.map(r => r.shift_schedule_id === id ? { ...r, status: 'scheduled' } : r)); else setError(getMessage(api, 'Failed to restore shift.'));
                                                                        } catch { setError('Network error while restoring shift.'); } finally { setBusyId(null); }
                                                                    }} title="Restore Shift" aria-label={`Restore shift for ${name}`}><CrudActionIcon action="restore" /> Restore Shift</button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </div>
                                                ) : '-'}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <Pagination
                        currentPage={currentPage}
                        totalItems={visibleRows.length}
                        itemsPerPage={ITEMS_PER_PAGE}
                        onPageChange={setCurrentPage}
                        label="shift schedules"
                    />
                </section>
            </div>

            {showModal && (
                <div className={styles.modalBackdrop} onClick={closeModal}>
                    <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
                        <div className={styles.modalHead}>
                            <h3>{editing ? 'Edit Shift Schedule' : 'Create Shift Schedule'}</h3>
                            <button type="button" onClick={closeModal}>×</button>
                        </div>
                        <form onSubmit={submitForm} noValidate className={styles.modalForm}>
                            <div className={styles.modalGrid}>
                                <label><span>Employee *</span><select name="employee_id" value={form.employee_id} onChange={handleFormChange} className={styles.input} required aria-required="true" aria-invalid={shiftFieldErrors.employee_id ? true : undefined} style={shiftFieldErrors.employee_id ? { border: '2px solid #ef4444' } : undefined}><option value="">Select</option>{employees.map((employee) => <option key={employee.employee_id} value={employee.employee_id}>{employee.first_name} {employee.last_name}</option>)}</select>{shiftFieldErrors.employee_id && <span style={{ fontSize: 12, color: '#b91c1c' }}>{shiftFieldErrors.employee_id}</span>}</label>
                                <label><span>Date *</span><input type="date" name="shift_date" value={form.shift_date} onChange={handleFormChange} className={styles.input} required aria-required="true" aria-invalid={shiftFieldErrors.shift_date ? true : undefined} style={shiftFieldErrors.shift_date ? { border: '2px solid #ef4444' } : undefined} />{shiftFieldErrors.shift_date && <span style={{ fontSize: 12, color: '#b91c1c' }}>{shiftFieldErrors.shift_date}</span>}</label>
                                <label><span>Start *</span><input type="time" name="shift_start" value={form.shift_start} onChange={handleFormChange} className={styles.input} required aria-required="true" aria-invalid={shiftFieldErrors.shift_start ? true : undefined} style={shiftFieldErrors.shift_start ? { border: '2px solid #ef4444' } : undefined} />{shiftFieldErrors.shift_start && <span style={{ fontSize: 12, color: '#b91c1c' }}>{shiftFieldErrors.shift_start}</span>}</label>
                                <label><span>End *</span><input type="time" name="shift_end" value={form.shift_end} onChange={handleFormChange} className={styles.input} required aria-required="true" aria-invalid={shiftFieldErrors.shift_end ? true : undefined} style={shiftFieldErrors.shift_end ? { border: '2px solid #ef4444' } : undefined} />{shiftFieldErrors.shift_end && <span style={{ fontSize: 12, color: '#b91c1c' }}>{shiftFieldErrors.shift_end}</span>}</label>
                                <label><span>Type</span><select name="shift_type" value={form.shift_type} onChange={handleFormChange} className={styles.input}>{SHIFT_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}</select></label>
                                <label><span>Status</span><select name="status" value={form.status} onChange={handleFormChange} className={styles.input}>{SHIFT_STATUSES.map((status) => <option key={status.value} value={status.value}>{status.label}</option>)}</select></label>
                            </div>
                            <label><span>Notes</span><textarea name="notes" value={form.notes} onChange={handleFormChange} className={styles.textarea} placeholder="Optional notes" /></label>
                            <div className={styles.modalActions} style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, alignItems: 'center' }}>
                                <button 
                                    type="button" 
                                    onClick={closeModal}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        padding: 0,
                                        cursor: 'pointer',
                                        color: '#64748b',
                                        fontWeight: 600,
                                        fontSize: 14
                                    }}
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit" 
                                    disabled={saving} 
                                    title={editing ? 'Save Changes' : 'Create Shift'} 
                                    aria-label={editing ? 'Save Changes' : 'Create Shift'}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        padding: 0,
                                        cursor: saving ? 'not-allowed' : 'pointer',
                                        color: saving ? '#94a3b8' : '#2563eb',
                                        fontWeight: 600,
                                        fontSize: 14,
                                        opacity: saving ? 0.6 : 1
                                    }}
                                >
                                    {saving ? 'Saving...' : (editing ? 'Update' : 'Save')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </Layout>
    );
}
