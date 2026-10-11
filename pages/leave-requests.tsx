import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
    Calendar,
    CalendarDays,
    Check,
    CheckCircle2,
    ChevronDown,
    ChevronLeft,
    Clock3,
    Filter,
    HeartPulse,
    Layers,
    Plus,
    RefreshCw,
    ShieldCheck,
    Users,
    X,
} from 'lucide-react';

import Layout from '@/components/Layout';
import Pagination from '@/components/Pagination';
import SearchBar from '@/components/SearchBar';
import ZeroResults from '@/components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { getBackendBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE_URL = getBackendBaseUrl();

type SessionUser = {
    id?: number;
    role?: string;
    employee_id?: number;
    full_name?: string;
    username?: string;
    photo?: string | null;
    [key: string]: unknown;
};

type LeaveRequestRow = {
    leave_request_id: number;
    employee_id: number;
    employee_name?: string;
    employee_role?: string | null;
    position?: string | null;
    leave_type: string;
    start_date: string;
    end_date: string;
    reason?: string | null;
    status: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'archived' | string;
    created_at?: string;
    approved_at?: string | null;
    comment_count?: number;
};

type LeaveTypeRow = {
    leave_type_id: number;
    type_key: string;
    type_name: string;
    default_days?: number | null;
    is_active?: number | boolean | null;
};

type EmployeeRow = {
    employee_id: number;
    first_name: string;
    last_name: string;
    position?: string | null;
    photo?: string | null;
    linked_user_role?: string | null;
};

type LeaveBalanceRow = {
    leave_balance_id?: number;
    employee_id: number;
    employee_name?: string;
    position?: string | null;
    leave_type: string;
    total_days: number;
    used_days: number;
    remaining_days: number;
    year?: number;
};

type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    data?: T;
    errors?: {
        code?: string;
        field?: string;
        fields?: string[];
        [key: string]: unknown;
    } | null;
};

type LeaveStats = {
    pending_count: number;
    approved_this_month: number;
    employees_on_leave: number;
    upcoming_leaves: number;
    pending_trend: number;
    approved_trend: number;
    on_leave_trend: number;
    upcoming_trend: number;
};

type LeaveTypeMeta = {
    key: string;
    label: string;
    color: string;
    soft: string;
    border: string;
};

const LEAVE_TYPE_META: Record<string, LeaveTypeMeta> = {
    annual: { key: 'annual', label: 'Annual Leave', color: '#3b82f6', soft: '#dbeafe', border: '#93c5fd' },
    vacation: { key: 'vacation', label: 'Annual Leave', color: '#3b82f6', soft: '#dbeafe', border: '#93c5fd' },
    sick: { key: 'sick', label: 'Sick Leave', color: '#10b981', soft: '#d1fae5', border: '#6ee7b7' },
    personal: { key: 'personal', label: 'Personal Leave', color: '#a78bfa', soft: '#ede9fe', border: '#c4b5fd' },
    emergency: { key: 'emergency', label: 'Personal Leave', color: '#a78bfa', soft: '#ede9fe', border: '#c4b5fd' },
    maternity: { key: 'maternity', label: 'Maternity Leave', color: '#ec4899', soft: '#fce7f3', border: '#f9a8d4' },
    paternity: { key: 'paternity', label: 'Paternity Leave', color: '#8b5cf6', soft: '#ede9fe', border: '#c4b5fd' },
    remote: { key: 'remote', label: 'Work From Home Leave', color: '#f59e0b', soft: '#ffedd5', border: '#fdba74' },
    unpaid: { key: 'unpaid', label: 'Unpaid Leave', color: '#64748b', soft: '#f1f5f9', border: '#cbd5e1' },
};

const DEFAULT_ALLOCATIONS: Record<string, number> = {
    annual: 12,
    vacation: 12,
    sick: 10,
    personal: 5,
    emergency: 5,
    maternity: 60,
    paternity: 7,
    remote: 10,
    unpaid: 0,
};

function getLeaveMeta(leaveType: string): LeaveTypeMeta {
    const key = String(leaveType || '').toLowerCase().trim();
    if (LEAVE_TYPE_META[key]) return LEAVE_TYPE_META[key];
    return {
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Leave',
        color: '#6b7280',
        soft: '#f3f4f6',
        border: '#d1d5db',
    };
}

// Vacation accrues with annual, emergency with personal — one column each,
// matching the legend and the balance-analytics filters.
function collapseBalanceKey(leaveType: string): string {
    const key = String(leaveType || '').toLowerCase().trim();
    if (key === 'vacation') return 'annual';
    if (key === 'emergency') return 'personal';
    return key;
}

function parseDateOnly(value: string): Date {
    const [year, month, day] = String(value || '').split('-').map(Number);
    return new Date(year || 1970, (month || 1) - 1, day || 1);
}

function formatDateRangeLong(startValue: string, endValue: string): string {
    const start = parseDateOnly(startValue);
    const end = parseDateOnly(endValue);
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const endLabel = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    if (startValue === endValue) return startLabel;
    return `${startLabel.replace(`, ${start.getFullYear()}`, '')} – ${endLabel}`;
}

function formatPlannerDateRange(startValue: string, endValue: string): string {
    const start = parseDateOnly(startValue);
    const end = parseDateOnly(endValue);
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    const startLabel = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endLabel = end.toLocaleDateString('en-US', sameMonth ? { day: 'numeric' } : { month: 'short', day: 'numeric' });
    return `${startLabel} – ${endLabel}`;
}

function countLeaveDays(startValue: string, endValue: string): number {
    const start = parseDateOnly(startValue);
    const end = parseDateOnly(endValue);
    if (end < start) return 0;
    let workingDays = 0;
    const cursor = new Date(start);
    while (cursor <= end) {
        const weekday = cursor.getDay();
        if (weekday !== 0 && weekday !== 6) workingDays += 1;
        cursor.setDate(cursor.getDate() + 1);
    }
    return workingDays;
}

function formatDateInputValue(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function isWeekendDate(value: string): boolean {
    if (!value) return false;
    const weekday = parseDateOnly(value).getDay();
    return weekday === 0 || weekday === 6;
}

function getEarliestLeaveStartDate(): string {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    let workingDays = 0;
    while (workingDays < 5) {
        date.setDate(date.getDate() + 1);
        if (date.getDay() !== 0 && date.getDay() !== 6) workingDays += 1;
    }
    return formatDateInputValue(date);
}

function formatRelativeTime(value?: string): string {
    if (!value) return 'Recently';
    const created = new Date(value);
    if (Number.isNaN(created.getTime())) return 'Recently';
    const now = Date.now();
    const diffMs = Math.max(0, now - created.getTime());
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'Requested just now';
    if (mins < 60) return `Requested ${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `Requested ${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'Requested 1d ago';
    if (days < 30) return `Requested ${days}d ago`;
    return `Requested ${created.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function getInitials(name?: string): string {
    const parts = String(name || 'NA').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return 'NA';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return `${parts[0][0] || ''}${parts[1][0] || ''}`.toUpperCase();
}

function avatarGradient(seed: string): string {
    const colors = [
        ['#60a5fa', '#2563eb'],
        ['#34d399', '#059669'],
        ['#f472b6', '#db2777'],
        ['#a78bfa', '#7c3aed'],
        ['#fbbf24', '#d97706'],
        ['#38bdf8', '#0284c7'],
    ];
    let hash = 0;
    for (let i = 0; i < seed.length; i += 1) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
    const [from, to] = colors[hash % colors.length];
    return `linear-gradient(135deg, ${from}, ${to})`;
}

function percentChange(current: number, previous: number): number {
    if (previous <= 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 1000) / 10;
}

export default function LeaveRequestsPage() {
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [loading, setLoading] = useState(true);
    const [leaveRequests, setLeaveRequests] = useState<LeaveRequestRow[]>([]);
    const [leaveTypes, setLeaveTypes] = useState<LeaveTypeRow[]>([]);
    const [employees, setEmployees] = useState<EmployeeRow[]>([]);
    const [balances, setBalances] = useState<LeaveBalanceRow[]>([]);
    const [stats, setStats] = useState<LeaveStats>({
        pending_count: 0,
        approved_this_month: 0,
        employees_on_leave: 0,
        upcoming_leaves: 0,
        pending_trend: 0,
        approved_trend: 0,
        on_leave_trend: 0,
        upcoming_trend: 0,
    });
    const [selectedMonth, setSelectedMonth] = useState<Date>(() => {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth(), 1);
    });
    const [plannerView, setPlannerView] = useState<'month' | 'week'>('month');
    const [plannerFilterType, setPlannerFilterType] = useState('all');
    const [showPlannerFilter, setShowPlannerFilter] = useState(false);
    const [showBalanceModal, setShowBalanceModal] = useState(false);
    const [showBalanceTotalsModal, setShowBalanceTotalsModal] = useState(false);
    const [showMyBalanceModal, setShowMyBalanceModal] = useState(false);
    const [balanceFilterEmployee, setBalanceFilterEmployee] = useState('all');
    const [balanceFilterLeaveType, setBalanceFilterLeaveType] = useState('all');
    const [balanceSearchTerm, setBalanceSearchTerm] = useState('');
    const [showLeavePlannerModal, setShowLeavePlannerModal] = useState(false);
    const [plannerFilterEmployee, setPlannerFilterEmployee] = useState('all');
    const [plannerSearchTerm, setPlannerSearchTerm] = useState('');
    const [plannerPage, setPlannerPage] = useState(1);
    const [plannerTotalEmployees, setPlannerTotalEmployees] = useState(0);
    // Planner rows per page comes from Settings → Pagination, same as every other list.
    const PLANNER_PAGE_SIZE = usePaginationSetting();
    const [showArchiveModal, setShowArchiveModal] = useState(false);
    const [archiveFilterEmployee, setArchiveFilterEmployee] = useState('all');
    const [archiveFilterLeaveType, setArchiveFilterLeaveType] = useState('all');
    const [archiveSearchTerm, setArchiveSearchTerm] = useState('');
    const [showApprovalQueueModal, setShowApprovalQueueModal] = useState(false);
    const [showAllApprovalRequests, setShowAllApprovalRequests] = useState(false);
    const [selectedApprovalRequest, setSelectedApprovalRequest] = useState<LeaveRequestRow | null>(null);
    const [showUpcomingModal, setShowUpcomingModal] = useState(false);
    const [showPoliciesModal, setShowPoliciesModal] = useState(false);
    const [approvingLeaveId, setApprovingLeaveId] = useState<number | null>(null);
    const [rejectingLeaveId, setRejectingLeaveId] = useState<number | null>(null);
    const [showNewRequestModal, setShowNewRequestModal] = useState(false);
    const [newRequestForm, setNewRequestForm] = useState({
        employee_id: '',
        leave_type: '',
        start_date: '',
        end_date: '',
        reason: '',
        request_own: false,
    });
    const [submittingRequest, setSubmittingRequest] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    // Inline (labeled) form error for the New Leave Request modal.
    // Rendered inside the modal on purpose — never via SweetAlert.
    const [newRequestError, setNewRequestError] = useState('');
    const [newRequestErrorFields, setNewRequestErrorFields] = useState<string[]>([]);

    const closeNewRequestModal = () => {
        if (submittingRequest) return;
        setShowNewRequestModal(false);
        setNewRequestError('');
        setNewRequestErrorFields([]);
    };

    const role = String(user?.role || '').toLowerCase();
    const canApprove = role === 'admin' || role === 'manager';
    const selectedMonthTitle = selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const earliestLeaveStartDate = getEarliestLeaveStartDate();

    const openNewRequestModal = () => {
        setNewRequestError('');
        setNewRequestErrorFields([]);
        setNewRequestForm((current) => ({
            ...current,
            start_date: earliestLeaveStartDate,
            end_date: earliestLeaveStartDate,
        }));
        setShowNewRequestModal(true);
    };

    const changeSelectedMonth = (offset: number) => {
        setSelectedMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
    };

    const resetSelectedMonth = () => {
        const today = new Date();
        setSelectedMonth(new Date(today.getFullYear(), today.getMonth(), 1));
    };

    const calculateStats = useCallback((requests: LeaveRequestRow[]) => {
        const now = new Date();
        const currentMonth = now.getMonth();
        const currentYear = now.getFullYear();
        const prevMonthDate = new Date(currentYear, currentMonth - 1, 1);
        const prevMonth = prevMonthDate.getMonth();
        const prevYear = prevMonthDate.getFullYear();

        const inMonth = (dateValue: string | undefined, month: number, year: number) => {
            if (!dateValue) return false;
            const d = new Date(dateValue);
            return !Number.isNaN(d.getTime()) && d.getMonth() === month && d.getFullYear() === year;
        };

        const pending = requests.filter((r) => String(r.status || '').toLowerCase() === 'pending');
        const pendingThisMonth = pending.filter((r) => inMonth(r.created_at, currentMonth, currentYear)).length;
        const pendingPrevMonth = pending.filter((r) => inMonth(r.created_at, prevMonth, prevYear)).length
            || requests.filter((r) => String(r.status || '').toLowerCase() === 'pending' && inMonth(r.created_at, prevMonth, prevYear)).length;

        const approvedThisMonth = requests.filter((r) => {
            const status = String(r.status || '').toLowerCase();
            const dateValue = r.approved_at || r.created_at;
            return status === 'approved' && inMonth(dateValue, currentMonth, currentYear);
        }).length;

        const approvedPrevMonth = requests.filter((r) => {
            const status = String(r.status || '').toLowerCase();
            const dateValue = r.approved_at || r.created_at;
            return status === 'approved' && inMonth(dateValue, prevMonth, prevYear);
        }).length;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const onLeaveIds = new Set(
            requests
                .filter((r) => {
                    if (String(r.status || '').toLowerCase() !== 'approved') return false;
                    const start = parseDateOnly(r.start_date);
                    const end = parseDateOnly(r.end_date);
                    return start <= today && end >= today;
                })
                .map((r) => Number(r.employee_id))
        );

        // Upcoming = approved leave that has not started yet (start_date >= today)
        const upcoming = requests.filter((r) => {
            if (String(r.status || '').toLowerCase() !== 'approved') return false;
            return parseDateOnly(r.start_date) >= today;
        });

        // Trend: approved leaves starting this month vs last month
        const startingThisMonth = requests.filter((r) => {
            if (String(r.status || '').toLowerCase() !== 'approved') return false;
            return inMonth(r.start_date, currentMonth, currentYear);
        }).length;

        const startingPrevMonth = requests.filter((r) => {
            if (String(r.status || '').toLowerCase() !== 'approved') return false;
            return inMonth(r.start_date, prevMonth, prevYear);
        }).length;

        // On-leave trend: employees on leave today vs same day last month (approx via overlapping leave last month)
        const lastMonthRef = new Date(prevYear, prevMonth, Math.min(today.getDate(), 28));
        lastMonthRef.setHours(0, 0, 0, 0);
        const onLeavePrevIds = new Set(
            requests
                .filter((r) => {
                    if (String(r.status || '').toLowerCase() !== 'approved') return false;
                    const start = parseDateOnly(r.start_date);
                    const end = parseDateOnly(r.end_date);
                    return start <= lastMonthRef && end >= lastMonthRef;
                })
                .map((r) => Number(r.employee_id))
        );

        setStats({
            pending_count: pending.length,
            approved_this_month: approvedThisMonth,
            employees_on_leave: onLeaveIds.size,
            upcoming_leaves: upcoming.length,
            pending_trend: percentChange(pendingThisMonth || pending.length, pendingPrevMonth || 0),
            approved_trend: percentChange(approvedThisMonth, approvedPrevMonth),
            on_leave_trend: percentChange(onLeaveIds.size, onLeavePrevIds.size),
            upcoming_trend: percentChange(startingThisMonth, startingPrevMonth),
        });
    }, []);

    const fetchLeaveRequests = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/leave-requests.php`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<LeaveRequestRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setLeaveRequests(data.data);
                calculateStats(data.data);
            }
        } catch {
            void notifyError('Failed to load leave requests.');
        }
    }, [calculateStats]);

    const fetchLeaveTypes = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/leave-types.php`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<LeaveTypeRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setLeaveTypes(data.data.filter((lt) => Boolean(Number(lt.is_active ?? 1))));
            }
        } catch {
            void notifyError('Failed to load leave types.');
        }
    }, []);

    const fetchEmployees = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/employees.php?status=active`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<EmployeeRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setEmployees(data.data);
            }
        } catch {
            // Staff may not have employee list access; fall back to names from leave requests.
        }
    }, []);

    const fetchBalances = useCallback(async () => {
        try {
            const year = new Date().getFullYear();
            const res = await fetch(`${API_BASE_URL}/api/leave-requests.php?balances=1&year=${year}`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<LeaveBalanceRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setBalances(data.data);
            }
        } catch {
            // Balances optional; UI can derive from approved leave if empty.
        }
    }, []);

    const refreshAll = useCallback(async () => {
        setRefreshing(true);
        try {
            await Promise.all([fetchLeaveRequests(), fetchLeaveTypes(), fetchEmployees(), fetchBalances()]);
        } finally {
            setRefreshing(false);
        }
    }, [fetchLeaveRequests, fetchLeaveTypes, fetchEmployees, fetchBalances]);

    // Live-sync: silently re-fetch leave data in background (no spinner).
    const silentRefreshLeave = useCallback(async () => {
        if (!user) return;
        await Promise.all([fetchLeaveRequests(), fetchLeaveTypes(), fetchEmployees(), fetchBalances()]);
    }, [fetchLeaveRequests, fetchLeaveTypes, fetchEmployees, fetchBalances, user]);

    useLiveSync(silentRefreshLeave);

    useEffect(() => {
        const init = async () => {
            try {
                const [sessionRes] = await Promise.all([
                    fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' }),
                    fetchLeaveRequests(),
                    fetchLeaveTypes(),
                    fetchEmployees(),
                    fetchBalances(),
                ]);
                const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
                if (!sessionData.success || !sessionData.data) {
                    router.push('/');
                    return;
                }
                setUser(sessionData.data);
            } catch {
                router.push('/');
            } finally {
                setLoading(false);
            }
        };
        void init();
    }, [router, fetchLeaveRequests, fetchLeaveTypes, fetchEmployees, fetchBalances]);

    // Reset planner pagination when filters / month / view change
    useEffect(() => {
        setPlannerPage(1);
    }, [selectedMonth, plannerView, plannerFilterType, plannerFilterEmployee, plannerSearchTerm, showLeavePlannerModal, PLANNER_PAGE_SIZE]);

    const getLeaveTypeLabel = useCallback((key: string): string => {
        const found = leaveTypes.find((lt) => lt.type_key === key);
        if (found?.type_name) {
            const name = found.type_name.trim();
            if (/leave$/i.test(name)) return name;
            return `${name} Leave`;
        }
        return getLeaveMeta(key).label;
    }, [leaveTypes]);

    const legendTypes = useMemo(() => {
        const preferred = ['annual', 'vacation', 'sick', 'personal', 'emergency', 'maternity', 'remote', 'paternity', 'unpaid'];
        const activeKeys = leaveTypes.map((lt) => lt.type_key);
        const keys = (activeKeys.length > 0 ? activeKeys : preferred).slice();
        keys.sort((a, b) => preferred.indexOf(a) - preferred.indexOf(b));
        const seen = new Set<string>();
        return keys
            .map((key) => {
                const meta = getLeaveMeta(key);
                const label = getLeaveTypeLabel(key);
                // Collapse vacation->annual and emergency->personal for legend display
                const displayKey = key === 'vacation' ? 'annual' : key === 'emergency' ? 'personal' : key;
                if (seen.has(displayKey)) return null;
                seen.add(displayKey);
                return { key, displayKey, label, color: meta.color };
            })
            .filter(Boolean) as Array<{ key: string; displayKey: string; label: string; color: string }>;
    }, [leaveTypes, getLeaveTypeLabel]);

    const employeeNameMap = useMemo(() => {
        // Normalize keys: employees API returns numbers while request/balance
        // rows arrive as strings — without this the same person gets two
        // entries (and React duplicate keys).
        const map = new Map<number, { name: string; position: string; photo?: string | null }>();
        employees.forEach((emp) => {
            map.set(Number(emp.employee_id), {
                name: `${emp.first_name} ${emp.last_name}`.trim(),
                position: emp.position || 'Employee',
                photo: emp.photo,
            });
        });
        leaveRequests.forEach((req) => {
            if (!map.has(Number(req.employee_id))) {
                map.set(Number(req.employee_id), {
                    name: req.employee_name || 'Employee',
                    position: req.position || 'Employee',
                });
            }
        });
        return map;
    }, [employees, leaveRequests]);

    const approvalQueue = useMemo(() => {
        return leaveRequests
            .filter((r) => String(r.status || '').toLowerCase() === 'pending')
            .sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
    }, [leaveRequests]);

    const upcomingLeaves = useMemo(() => {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        return leaveRequests
            .filter((r) => {
                if (String(r.status || '').toLowerCase() !== 'approved') return false;
                return parseDateOnly(r.start_date) >= now;
            })
            .sort((a, b) => parseDateOnly(a.start_date).getTime() - parseDateOnly(b.start_date).getTime());
    }, [leaveRequests]);

    // Display columns for balances: vacation folds into annual and emergency
    // into personal (same as the legend), so every active type is visible.
    const balanceTypeColumns = useMemo(() => {
        const preferred = ['annual', 'sick', 'personal', 'maternity', 'paternity', 'remote', 'unpaid'];
        const activeKeys = leaveTypes.map((lt) => collapseBalanceKey(lt.type_key));
        const source = activeKeys.length > 0 ? activeKeys : preferred;
        const seen = new Set<string>();
        const ordered = source.filter((key) => {
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        ordered.sort((a, b) => {
            const ai = preferred.indexOf(a);
            const bi = preferred.indexOf(b);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
        return ordered.map((key) => {
            const meta = getLeaveMeta(key);
            return { key, label: getLeaveTypeLabel(key), color: meta.color };
        });
    }, [leaveTypes, getLeaveTypeLabel]);

    const leaveBalanceOverview = useMemo(() => {
        type BalanceCell = { total: number; remaining: number; used: number };
        type BalanceItem = {
            employee_id: number;
            name: string;
            position: string;
            photo?: string | null;
            byType: Record<string, BalanceCell>;
        };

        const configuredAllocations = new Map<string, number>();
        leaveTypes.forEach((leaveType) => {
            const key = collapseBalanceKey(leaveType.type_key);
            const configured = Number(leaveType.default_days);
            if (Number.isFinite(configured)) configuredAllocations.set(key, configured);
        });

        const allocationFor = (key: string): number => configuredAllocations.get(key) ?? DEFAULT_ALLOCATIONS[key] ?? 10;

        const blankCells = (): Record<string, BalanceCell> => {
            const cells: Record<string, BalanceCell> = {};
            balanceTypeColumns.forEach((col) => {
                cells[col.key] = { total: 0, remaining: 0, used: 0 };
            });
            return cells;
        };

        const defaultCells = (): Record<string, BalanceCell> => {
            const cells: Record<string, BalanceCell> = {};
            balanceTypeColumns.forEach((col) => {
                const total = allocationFor(col.key);
                cells[col.key] = { total, remaining: total, used: 0 };
            });
            return cells;
        };

        const byEmployee = new Map<number, BalanceItem>();

        const ensure = (employeeId: number | string, name?: string, position?: string, photo?: string | null, withDefaults = false) => {
            // Normalize: balance rows carry string ids, employee rows numbers.
            // Without this the same person gets two rows → duplicate React keys.
            const id = Number(employeeId);
            if (!byEmployee.has(id)) {
                const info = employeeNameMap.get(id);
                byEmployee.set(id, {
                    employee_id: id,
                    name: name || info?.name || 'Employee',
                    position: position || info?.position || 'Employee',
                    photo: photo || info?.photo,
                    byType: withDefaults ? defaultCells() : blankCells(),
                });
            }
            return byEmployee.get(id)!;
        };

        if (balances.length > 0) {
            balances.forEach((row) => {
                const item = ensure(row.employee_id, row.employee_name, row.position || undefined);
                const key = collapseBalanceKey(row.leave_type);
                if (!item.byType[key]) item.byType[key] = { total: 0, remaining: 0, used: 0 };
                const cell = item.byType[key];
                cell.total += Number(row.total_days) || 0;
                cell.used += Number(row.used_days) || 0;
                const storedRemaining = Number(row.remaining_days);
                cell.remaining += Number.isFinite(storedRemaining) ? storedRemaining : Math.max(0, cell.total - cell.used);
            });
        } else {
            // Derive from employees + approved leaves when balance rows are missing
            const sourceEmployees = employees.length > 0
                ? employees
                : Array.from(employeeNameMap.entries()).map(([id, info]) => ({
                    employee_id: id,
                    first_name: info.name.split(' ')[0] || '',
                    last_name: info.name.split(' ').slice(1).join(' ') || '',
                    position: info.position,
                    photo: info.photo,
                }));

            sourceEmployees.forEach((emp) => {
                ensure(emp.employee_id, `${emp.first_name} ${emp.last_name}`.trim(), emp.position || undefined, emp.photo, true);
            });

            leaveRequests
                .filter((r) => String(r.status || '').toLowerCase() === 'approved')
                .forEach((req) => {
                    const item = ensure(req.employee_id, req.employee_name, req.position || undefined, undefined, true);
                    const days = countLeaveDays(req.start_date, req.end_date);
                    const key = collapseBalanceKey(req.leave_type);
                    if (!item.byType[key]) {
                        const total = allocationFor(key);
                        item.byType[key] = { total, remaining: total, used: 0 };
                    }
                    const cell = item.byType[key];
                    cell.used += days;
                    cell.remaining = Math.max(0, cell.total - cell.used);
                });
        }

        return Array.from(byEmployee.values()).sort((a, b) => a.name.localeCompare(b.name));
    }, [balances, employees, employeeNameMap, leaveRequests, balanceTypeColumns, leaveTypes]);

    // Own row for the signed-in employee (staff, managers, admins with a link).
    const myLeaveBalance = useMemo(() => {
        const ownId = Number(user?.employee_id || 0);
        if (!ownId) return null;
        return leaveBalanceOverview.find((item) => Number(item.employee_id) === ownId) || null;
    }, [leaveBalanceOverview, user?.employee_id]);

    // Leave Balance Analytics modal: columns follow the type filter, rows follow
    // the employee filter, footer totals sum the visible rows per type.
    // NOTE: all hooks must stay above the `if (loading)` early return below.
    const balanceModalColumns = useMemo(() => {
        if (balanceFilterLeaveType === 'all') return balanceTypeColumns;
        const key = collapseBalanceKey(balanceFilterLeaveType);
        const found = balanceTypeColumns.filter((col) => col.key === key);
        return found.length > 0 ? found : balanceTypeColumns;
    }, [balanceFilterLeaveType, balanceTypeColumns]);

    const balanceModalRows = useMemo(() => {
        const query = balanceSearchTerm.trim().toLowerCase();

        return leaveBalanceOverview.filter((item) => {
            if (balanceFilterEmployee !== 'all' && item.employee_id !== Number(balanceFilterEmployee)) return false;
            if (!query) return true;

            return [item.name, item.position].some((value) => String(value || '').toLowerCase().includes(query));
        });
    }, [leaveBalanceOverview, balanceFilterEmployee, balanceSearchTerm]);

    const balanceModalTotals = useMemo(() => {
        const totals: Record<string, { total: number; remaining: number; used: number }> = {};
        balanceModalColumns.forEach((col) => {
            totals[col.key] = { total: 0, remaining: 0, used: 0 };
        });
        balanceModalRows.forEach((row) => {
            balanceModalColumns.forEach((col) => {
                const cell = row.byType[col.key] || { total: 0, remaining: 0, used: 0 };
                totals[col.key].total += cell.total;
                totals[col.key].remaining += cell.remaining;
                totals[col.key].used += cell.used;
            });
        });
        return totals;
    }, [balanceModalRows, balanceModalColumns]);

    // Live quota preview inside the New Request modal: remaining balance for
    // the chosen type + target employee, incl. whether the picked dates fit.
    const newRequestBalancePreview = useMemo(() => {
        const typeKey = collapseBalanceKey(newRequestForm.leave_type);
        if (!typeKey) return null;
        let targetId = 0;
        if (role === 'staff' || newRequestForm.request_own) {
            targetId = Number(user?.employee_id || 0);
        } else {
            targetId = Number(newRequestForm.employee_id || 0);
        }
        if (!targetId) return null;
        const row = leaveBalanceOverview.find((item) => Number(item.employee_id) === targetId);
        if (!row) return null;
        const col = balanceTypeColumns.find((c) => c.key === typeKey);
        const cell = row.byType[typeKey] || { total: 0, remaining: 0, used: 0 };
        const requestedDays = newRequestForm.start_date && newRequestForm.end_date
            ? countLeaveDays(newRequestForm.start_date, newRequestForm.end_date)
            : 0;
        return {
            name: row.name,
            label: col?.label || getLeaveTypeLabel(typeKey),
            color: col?.color || '#64748b',
            total: cell.total,
            remaining: cell.remaining,
            requestedDays,
        };
    }, [newRequestForm, role, user?.employee_id, leaveBalanceOverview, balanceTypeColumns, getLeaveTypeLabel]);

    const policySnapshot = useMemo(() => {
        const annual = leaveTypes.find((lt) => ['annual', 'vacation'].includes(lt.type_key));
        const sick = leaveTypes.find((lt) => lt.type_key === 'sick');
        return {
            annualDays: Number(annual?.default_days ?? 12),
            sickDays: Number(sick?.default_days ?? 10),
            carryoverLabel: 'Unlimited',
            approvalLevels: 2,
            approvalLabel: 'manager + HR',
        };
    }, [leaveTypes]);

    const handleApproveLeave = async (leaveId: number) => {
        if (!canApprove) {
            void notifyError('Only managers or admins can approve leave requests.');
            return;
        }
        setApprovingLeaveId(leaveId);
        try {
            const response = await fetch(`${API_BASE_URL}/api/leave-requests.php`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leave_request_id: leaveId, action: 'approve' }),
            });
            const data = (await response.json()) as ApiResponse<unknown>;
            if (data.success) {
                void notifySuccess(data.message || 'Leave request approved');
                await Promise.all([fetchLeaveRequests(), fetchBalances()]);
            } else {
                void notifyError(data.message || 'Failed to approve leave request');
            }
        } catch {
            void notifyError('Error approving leave request');
        } finally {
            setApprovingLeaveId(null);
        }
    };

    const handleRejectLeave = async (leaveId: number) => {
        if (!canApprove) {
            void notifyError('Only managers or admins can reject leave requests.');
            return;
        }
        setRejectingLeaveId(leaveId);
        try {
            const response = await fetch(`${API_BASE_URL}/api/leave-requests.php`, {
                method: 'PUT',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ leave_request_id: leaveId, action: 'reject' }),
            });
            const data = (await response.json()) as ApiResponse<unknown>;
            if (data.success) {
                void notifySuccess(data.message || 'Leave request rejected');
                await Promise.all([fetchLeaveRequests(), fetchBalances()]);
            } else {
                void notifyError(data.message || 'Failed to reject leave request');
            }
        } catch {
            void notifyError('Error rejecting leave request');
        } finally {
            setRejectingLeaveId(null);
        }
    };

    const handleSubmitNewRequest = async () => {
        if (submittingRequest) return;
        setNewRequestError('');
        setNewRequestErrorFields([]);
        if (!newRequestForm.leave_type || !newRequestForm.start_date || !newRequestForm.end_date) {
            setNewRequestError('Please fill in all required fields: Leave Type, Start Date, and End Date.');
            setNewRequestErrorFields(['leave_type', 'start_date', 'end_date']);
            return;
        }

        if (parseDateOnly(newRequestForm.end_date) < parseDateOnly(newRequestForm.start_date)) {
            setNewRequestError('End Date cannot be earlier than Start Date.');
            setNewRequestErrorFields(['start_date', 'end_date']);
            return;
        }

        if (newRequestForm.start_date < earliestLeaveStartDate) {
            setNewRequestError(`Leave must be filed at least 5 working days in advance. The earliest available date is ${earliestLeaveStartDate}.`);
            setNewRequestErrorFields(['start_date']);
            return;
        }

        if (isWeekendDate(newRequestForm.start_date) || isWeekendDate(newRequestForm.end_date)) {
            setNewRequestError('Start Date and End Date must be Monday through Friday. Weekend days inside the range are skipped automatically.');
            setNewRequestErrorFields(['start_date', 'end_date']);
            return;
        }

        if (countLeaveDays(newRequestForm.start_date, newRequestForm.end_date) < 1) {
            setNewRequestError('The selected range contains no working days. Saturday and Sunday are not counted as leave.');
            setNewRequestErrorFields(['start_date', 'end_date']);
            return;
        }

        if (role !== 'staff' && !newRequestForm.request_own && !newRequestForm.employee_id) {
            setNewRequestError('Please select an employee or check "Request Own".');
            setNewRequestErrorFields(['employee_id']);
            return;
        }

        setSubmittingRequest(true);
        try {
            const payload: {
                leave_type: string;
                start_date: string;
                end_date: string;
                reason: string;
                employee_id?: number;
            } = {
                leave_type: newRequestForm.leave_type,
                start_date: newRequestForm.start_date,
                end_date: newRequestForm.end_date,
                reason: newRequestForm.reason,
            };

            if (role !== 'staff') {
                if (newRequestForm.request_own) {
                    const ownId = Number(user?.employee_id || 0);
                    if (ownId > 0) payload.employee_id = ownId;
                    else {
                        setNewRequestError('Your account is not linked to an employee record.');
                        setNewRequestErrorFields(['employee_id']);
                        setSubmittingRequest(false);
                        return;
                    }
                } else if (newRequestForm.employee_id) {
                    payload.employee_id = Number(newRequestForm.employee_id);
                }
            }

            // X-No-Toast: form errors render inline (labeled) below — never as SweetAlert.
            const response = await fetch(`${API_BASE_URL}/api/leave-requests.php`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-No-Toast': '1' },
                body: JSON.stringify(payload),
            });

            const data = (await response.json()) as ApiResponse<unknown>;
            if (data.success) {
                void notifySuccess(data.message || 'Leave request submitted');
                await Promise.all([fetchLeaveRequests(), fetchBalances()]);
                setShowNewRequestModal(false);
                setNewRequestError('');
                setNewRequestErrorFields([]);
                setNewRequestForm({
                    employee_id: '',
                    leave_type: '',
                    start_date: '',
                    end_date: '',
                    reason: '',
                    request_own: false,
                });
            } else {
                // Show the accurate backend message inline, labeled to the conflicting field(s).
                setNewRequestError(data.message || 'Failed to create leave request');
                const fields = Array.isArray(data.errors?.fields) && data.errors.fields.length > 0
                    ? data.errors.fields.filter((f): f is string => typeof f === 'string')
                    : (typeof data.errors?.field === 'string' ? [data.errors.field] : []);
                setNewRequestErrorFields(fields);
            }
        } catch {
            setNewRequestError('Network error. Please check your connection and try again.');
            setNewRequestErrorFields([]);
        } finally {
            setSubmittingRequest(false);
        }
    };

    const handleLogout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    if (loading) {
        return (
            <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>
                <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Loading leave management...</div>
            </Layout>
        );
    }

    const visibleApprovalQueue = approvalQueue.slice(0, 3);
    const visibleUpcoming = upcomingLeaves.slice(0, 4);
    const visibleBalances = leaveBalanceOverview.slice(0, 5);
    const modalApprovalRequests = showAllApprovalRequests ? approvalQueue : approvalQueue.slice(0, 10);

    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head><title>Leave Management</title></Head>
            <div style={pageStyle}>
                {/* Header */}
                <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    <div>
                        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 750, color: '#0f172a', letterSpacing: '-0.02em' }}>
                            Leave Management
                        </h1>
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                        <button type="button" onClick={() => setShowMyBalanceModal(true)} style={secondaryBtnStyle}>
                            <CalendarDays size={15} /> My Balance
                        </button>
                        <button type="button" onClick={() => setShowBalanceModal(true)} style={secondaryBtnStyle}>
                            <Users size={15} /> Balance Overview
                        </button>
                        <button
                            type="button"
                            onClick={() => void refreshAll()}
                            style={secondaryBtnStyle}
                            title="Refresh"
                        >
                            <RefreshCw size={15} style={{ animation: refreshing ? 'spin 1s linear infinite' : undefined }} />
                        </button>
                        <button
                            type="button"
                            onClick={openNewRequestModal}
                            className="app-action-btn app-action-btn-primary page-primary-action-btn"
                            style={primaryBtnStyle}
                            title="Add New Request"
                            aria-label="Add New Request"
                        >
                            <Plus size={16} />
                            Add New Request
                        </button>

                    </div>
                </div>

                {/* Stats Cards */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 14 }}>
                    <StatCard
                        icon={<CalendarDays size={20} color="#1d4ed8" />}
                        iconBg="#eff6ff"
                        iconBorder="#bfdbfe"
                        label="Pending Requests"
                        value={stats.pending_count}
                        trend={`${stats.pending_trend >= 0 ? '+' : ''}${stats.pending_trend}% from last month`}
                        trendType={stats.pending_trend >= 0 ? 'up-warn' : 'down-good'}
                        accent="#2563eb"
                    />
                    <StatCard
                        icon={<CheckCircle2 size={20} color="#059669" />}
                        iconBg="#ecfdf5"
                        iconBorder="#a7f3d0"
                        label="Approved This Month"
                        value={stats.approved_this_month}
                        trend={`${stats.approved_trend >= 0 ? '+' : ''}${stats.approved_trend}% from last month`}
                        trendType={stats.approved_trend >= 0 ? 'up-good' : 'down-warn'}
                        accent="#059669"
                    />
                    <StatCard
                        icon={<Users size={20} color="#7c3aed" />}
                        iconBg="#f5f3ff"
                        iconBorder="#ddd6fe"
                        label="Employees On Leave"
                        value={stats.employees_on_leave}
                        trend={`${stats.on_leave_trend >= 0 ? '+' : ''}${stats.on_leave_trend}% from last month`}
                        trendType={stats.on_leave_trend >= 0 ? 'up-info' : 'down-good'}
                        accent="#7c3aed"
                    />
                    <StatCard
                        icon={<Clock3 size={20} color="#d97706" />}
                        iconBg="#fffbeb"
                        iconBorder="#fde68a"
                        label="Upcoming Leaves"
                        value={stats.upcoming_leaves}
                        trend={`${stats.upcoming_trend >= 0 ? '+' : ''}${stats.upcoming_trend}% from last month`}
                        trendType={stats.upcoming_trend >= 0 ? 'up-info' : 'down-good'}
                        accent="#d97706"
                    />

                </div>

                {/* Main content: planner + right column */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 14, marginBottom: 14 }}>
                    {/* Leave Planner */}
                    <div style={cardStyle}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <h2 style={sectionTitleStyle}>Leave Planner</h2>
                                <div style={{ display: 'flex', gap: 6 }}>
                                    <button type="button" onClick={() => changeSelectedMonth(-1)} style={iconNavBtnStyle} aria-label="Previous month">
                                        <ChevronLeft size={16} />
                                    </button>
                                    <button type="button" onClick={resetSelectedMonth} style={navButtonStyle}>Today</button>
                                </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 18, fontWeight: 700, color: '#0f172a' }}>
                                {selectedMonthTitle}
                                <ChevronDown size={16} color="#94a3b8" />
                            </div>

                            <div style={{ display: 'flex', gap: 8, alignItems: 'center', position: 'relative' }}>
                                <div style={selectPillStyle}>
                                    <select
                                        value={plannerView}
                                        onChange={(e) => setPlannerView(e.target.value as 'month' | 'week')}
                                        style={hiddenSelectStyle}
                                    >
                                        <option value="month">Month</option>
                                        <option value="week">Week</option>
                                    </select>
                                    <span>{plannerView === 'month' ? 'Month' : 'Week'}</span>
                                    <ChevronDown size={14} color="#64748b" />
                                </div>
                                <button
                                    type="button"
                                    onClick={() => setShowPlannerFilter((v) => !v)}
                                    style={{ ...iconNavBtnStyle, background: plannerFilterType !== 'all' ? '#eff6ff' : '#fff', borderColor: plannerFilterType !== 'all' ? '#93c5fd' : '#e2e8f0' }}
                                    aria-label="Filter leave types"
                                >
                                    <Filter size={15} color={plannerFilterType !== 'all' ? '#2563eb' : '#64748b'} />
                                </button>
                                {showPlannerFilter && (
                                    <div style={filterDropdownStyle}>
                                        <button type="button" style={filterOptionStyle(plannerFilterType === 'all')} onClick={() => { setPlannerFilterType('all'); setShowPlannerFilter(false); }}>
                                            All types
                                        </button>
                                        {legendTypes.map((lt) => (
                                            <button
                                                key={lt.key}
                                                type="button"
                                                style={filterOptionStyle(plannerFilterType === lt.key)}
                                                onClick={() => { setPlannerFilterType(lt.key); setShowPlannerFilter(false); }}
                                            >
                                                <span style={{ width: 8, height: 8, borderRadius: 999, background: lt.color }} />
                                                {lt.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <CompactLeaveCalendar
                            leaveRequests={leaveRequests}
                            employeeNameMap={employeeNameMap}
                            selectedMonth={selectedMonth}
                            getLeaveTypeLabel={getLeaveTypeLabel}
                            leaveTypeFilter={plannerFilterType}
                            maxRows={5}
                            viewMode={plannerView}
                        />

                        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <button type="button" onClick={() => setShowArchiveModal(true)} style={linkBtnStyle}>
                                Archive
                            </button>
                            <button type="button" onClick={() => setShowLeavePlannerModal(true)} style={linkBtnStyle}>
                                View full calendar →
                            </button>
                        </div>
                    </div>

                    {/* Right column */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, alignContent: 'start' }}>
                        {/* Approval Queue */}
                        <div style={cardStyle}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <h2 style={sectionTitleStyle}>Approval Queue</h2>
                                    <span style={countBadgeStyle}>{approvalQueue.length}</span>
                                </div>
                                <button type="button" onClick={() => { setShowAllApprovalRequests(false); setShowApprovalQueueModal(true); }} style={linkBtnStyle}>
                                    View all
                                </button>
                            </div>

                            {visibleApprovalQueue.length === 0 ? (
                                <div style={emptyStateStyle}>No pending requests</div>
                            ) : (
                                <div style={{ display: 'grid', gap: 12 }}>
                                    {visibleApprovalQueue.map((req) => {
                                        const meta = getLeaveMeta(req.leave_type);
                                        const info = employeeNameMap.get(Number(req.employee_id));
                                        const name = info?.name || req.employee_name || 'Employee';
                                        const days = countLeaveDays(req.start_date, req.end_date);
                                        const busy = approvingLeaveId === req.leave_request_id || rejectingLeaveId === req.leave_request_id;
                                        return (
                                            <div key={req.leave_request_id} style={queueItemStyle}>
                                                <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                                                    <Avatar name={name} photo={info?.photo} size={40} />
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                                                            <span style={{ fontWeight: 600, fontSize: 13, color: '#0f172a' }}>{name}</span>
                                                            <span style={typePillStyle(meta)}>{getLeaveTypeLabel(req.leave_type)}</span>
                                                        </div>
                                                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 4 }}>
                                                            {formatDateRangeLong(req.start_date, req.end_date)}
                                                            <span style={{ margin: '0 6px', color: '#cbd5e1' }}>•</span>
                                                            {days} day{days === 1 ? '' : 's'}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                                                    <button
                                                        type="button"
                                                        onClick={() => setSelectedApprovalRequest(req)}
                                                        style={viewOutlineBtnStyle}
                                                    >
                                                        View
                                                    </button>
                                                    {canApprove ? (
                                                        <>
                                                            <button
                                                                type="button"
                                                                disabled={busy}
                                                                onClick={() => void handleApproveLeave(req.leave_request_id)}
                                                                style={approveOutlineBtnStyle}
                                                            >
                                                                <Check size={13} />
                                                                {approvingLeaveId === req.leave_request_id ? '...' : 'Approve'}
                                                            </button>
                                                            <button
                                                                type="button"
                                                                disabled={busy}
                                                                onClick={() => void handleRejectLeave(req.leave_request_id)}
                                                                style={rejectOutlineBtnStyle}
                                                            >
                                                                <X size={13} />
                                                                {rejectingLeaveId === req.leave_request_id ? '...' : 'Reject'}
                                                            </button>
                                                        </>
                                                    ) : (
                                                        <span style={{ fontSize: 11, color: '#94a3b8' }}>Pending review</span>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            {approvalQueue.length > 3 && (
                                <button type="button" onClick={() => { setShowAllApprovalRequests(false); setShowApprovalQueueModal(true); }} style={{ ...linkBtnStyle, marginTop: 12 }}>
                                    View all requests →
                                </button>
                            )}
                        </div>

                        {/* Upcoming Absences */}
                        <div style={cardStyle}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                                <h2 style={sectionTitleStyle}>Upcoming Absences</h2>
                            </div>
                            {visibleUpcoming.length === 0 ? (
                                <div style={emptyStateStyle}>No upcoming leaves</div>
                            ) : (
                                <div style={{ display: 'grid', gap: 10 }}>
                                    {visibleUpcoming.map((leave) => {
                                        const meta = getLeaveMeta(leave.leave_type);
                                        const info = employeeNameMap.get(Number(leave.employee_id));
                                        const name = info?.name || leave.employee_name || 'Employee';
                                        return (
                                            <div key={leave.leave_request_id} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 10, alignItems: 'center' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 12, minWidth: 110 }}>
                                                    <Calendar size={13} />
                                                    <span>{formatPlannerDateRange(leave.start_date, leave.end_date)}</span>
                                                </div>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                                    <Avatar name={name} photo={info?.photo} size={28} />
                                                    <span style={{ fontSize: 13, color: '#0f172a', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                        {name}
                                                    </span>
                                                </div>
                                                <span style={typePillStyle(meta)}>{getLeaveTypeLabel(leave.leave_type)}</span>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            <button type="button" onClick={() => setShowUpcomingModal(true)} style={{ ...linkBtnStyle, marginTop: 14 }}>
                                View full calendar →
                            </button>
                        </div>
                    </div>
                </div>

                {/* My balance — every linked employee sees their own current balances here. */}
                {myLeaveBalance && (
                    <div aria-hidden="true" style={{ display: 'none' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                            <Avatar name={myLeaveBalance.name} photo={myLeaveBalance.photo} size={36} />
                            <div>
                                <h2 style={{ ...sectionTitleStyle, margin: 0 }}>My Leave Balance</h2>
                                <div style={{ fontSize: 12, color: '#64748b' }}>{myLeaveBalance.position} · current year</div>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginTop: 12 }}>
                            {balanceTypeColumns.map((col) => {
                                const cell = myLeaveBalance.byType[col.key] || { total: 0, remaining: 0, used: 0 };
                                return (
                                    <div key={col.key} style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#f8fafc' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                            <span style={{ width: 10, height: 10, borderRadius: '50%', background: col.color, flexShrink: 0 }} />
                                            <span style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{col.label}</span>
                                        </div>
                                        <BalanceBar remaining={cell.remaining} total={cell.total} color={col.color} />
                                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>Used {cell.used} day{cell.used === 1 ? '' : 's'}</div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {/* Bottom row: balances + policy */}
                {false && (<div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: 20 }}>
                    {/* Leave Balance Overview */}
                    <div style={cardStyle}>
                        <h2 style={{ ...sectionTitleStyle, marginBottom: 16 }}>Leave Balance Overview</h2>
                        <div style={{ overflowX: 'auto' }}>
                            <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead>
                                    <tr style={{ borderBottom: '1px solid #e2e8f0' }}>
                                        <th style={thStyle}>Employee</th>
                                        {balanceTypeColumns.map((col) => (
                                            <th key={col.key} style={{ ...thStyle, textAlign: 'left', minWidth: 150 }}>{col.label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleBalances.map((item) => (
                                        <tr key={item.employee_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                            <td style={{ padding: '12px 8px 12px 0' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <Avatar name={item.name} photo={item.photo} size={32} />
                                                    <span style={{ fontWeight: 600, color: '#0f172a' }}>{item.name}</span>
                                                </div>
                                            </td>
                                            {balanceTypeColumns.map((col) => {
                                                const cell = item.byType[col.key] || { total: 0, remaining: 0, used: 0 };
                                                return (
                                                    <td key={col.key} style={{ padding: '12px 8px' }}>
                                                        <BalanceBar
                                                            remaining={cell.remaining}
                                                            total={cell.total}
                                                            color={col.color}
                                                        />
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                    {visibleBalances.length === 0 && (
                                        <tr>
                                            <td colSpan={1 + balanceTypeColumns.length} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                                                No balance data available
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <button type="button" onClick={() => setShowBalanceModal(true)} style={{ ...linkBtnStyle, marginTop: 12 }}>
                            View all balances →
                        </button>
                    </div>

                    {/* Policy Snapshot */}
                    <div style={cardStyle}>
                        <h2 style={{ ...sectionTitleStyle, marginBottom: 16 }}>Policy Snapshot</h2>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                            <PolicyTile
                                icon={<CalendarDays size={18} color="#2563eb" />}
                                iconBg="#eff6ff"
                                title="Annual Leave"
                                value={`${policySnapshot.annualDays} days`}
                                subtitle="per year allocation"
                            />
                            <PolicyTile
                                icon={<HeartPulse size={18} color="#059669" />}
                                iconBg="#ecfdf5"
                                title="Sick Leave"
                                value={`${policySnapshot.sickDays} days`}
                                subtitle="per year allocation"
                            />
                            <PolicyTile
                                icon={<Clock3 size={18} color="#2563eb" />}
                                iconBg="#eff6ff"
                                title="Carryover"
                                value={policySnapshot.carryoverLabel}
                                subtitle="unused credits do not expire"
                            />
                            <PolicyTile
                                icon={<Layers size={18} color="#64748b" />}
                                iconBg="#f8fafc"
                                title="Approval Levels"
                                value={String(policySnapshot.approvalLevels)}
                                subtitle={policySnapshot.approvalLabel}
                            />
                        </div>
                        <button type="button" onClick={() => setShowPoliciesModal(true)} style={{ ...linkBtnStyle, marginTop: 16 }}>
                            View all policies →
                        </button>
                    </div>
                </div>)}

                {/* Security note */}
                {false && (<div style={securityNoteStyle}>
                    <div style={securityIconWrapStyle}>
                        <ShieldCheck size={16} color="#1d4ed8" />
                    </div>
                    <div>
                        <div style={{ fontWeight: 700, color: '#1e3a8a', marginBottom: 2 }}>Your data is secure</div>
                        <div style={{ color: '#64748b' }}>We keep leave balances and approvals safe with full audit history.</div>
                    </div>
                </div>)}


                {/* ===== MODALS ===== */}

                {/* Personal balance — available to every user type. */}
                {showMyBalanceModal && (
                    <Modal title="My Leave Balance" onClose={() => setShowMyBalanceModal(false)} width="min(720px, 95vw)">
                        {myLeaveBalance ? (
                            <>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
                                    <Avatar name={myLeaveBalance.name} photo={myLeaveBalance.photo} size={34} />
                                    <div>
                                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{myLeaveBalance.name}</div>
                                        <div style={{ fontSize: 11, color: '#64748b' }}>{new Date().getFullYear()} balance</div>
                                    </div>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 8 }}>
                                    {balanceTypeColumns.map((col) => {
                                        const cell = myLeaveBalance.byType[col.key] || { total: 0, remaining: 0, used: 0 };
                                        return (
                                            <div key={col.key} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: 10, background: '#fff' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 7 }}>
                                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: col.color }} />
                                                    <span style={{ fontSize: 11, fontWeight: 700, color: '#334155' }}>{col.label}</span>
                                                </div>
                                                <BalanceBar remaining={cell.remaining} total={cell.total} color={col.color} />
                                                <div style={{ marginTop: 5, fontSize: 10, color: '#94a3b8' }}>{cell.used} used</div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </>
                        ) : (
                            <div style={emptyStateStyle}>No employee profile is linked to this account.</div>
                        )}
                    </Modal>
                )}

                {/* Balance Modal */}
                {showBalanceModal && (
                    <Modal
                        title="Leave Balance Overview"
                        onClose={() => {
                            setShowBalanceTotalsModal(false);
                            setShowBalanceModal(false);
                        }}
                        width="min(1000px, 95vw)"
                    >
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12, marginBottom: 20 }}>
                            <div>
                                <label style={labelStyle}>Filter by Employee</label>
                                <select value={balanceFilterEmployee} onChange={(e) => setBalanceFilterEmployee(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Employees</option>
                                    {leaveBalanceOverview.map((item) => (
                                        <option key={item.employee_id} value={String(item.employee_id)}>{item.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Filter by Leave Type</label>
                                <select value={balanceFilterLeaveType} onChange={(e) => setBalanceFilterLeaveType(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Types</option>
                                    {balanceTypeColumns.map((col) => (
                                        <option key={col.key} value={col.key}>{col.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Search</label>
                                <SearchBar
                                    storageKey="leave:balance-overview"
                                    placeholder="Search name or position..."
                                    ariaLabel="Search leave balances by employee name or position"
                                    value={balanceSearchTerm}
                                    onChange={setBalanceSearchTerm}
                                    suggestions={collectSearchTerms(leaveBalanceOverview, [
                                        (item: any) => item?.name,
                                        (item: any) => item?.position,
                                    ])}
                                    inputStyle={{ ...filterSelectStyle, width: '100%' }}
                                />
                            </div>
                        </div>

                        <div style={{ overflowY: 'auto', maxHeight: 420 }}>
                            <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                                <thead style={{ position: 'sticky', top: 0, background: '#fff' }}>
                                    <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                                        <th style={thStyle}>Employee</th>
                                        {balanceModalColumns.map((col) => (
                                            <th key={col.key} style={{ ...thStyle, textAlign: 'left' }}>{col.label}</th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {balanceModalRows.map((item) => (
                                        <tr key={item.employee_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                            <td style={{ padding: '12px 8px 12px 0' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <Avatar name={item.name} photo={item.photo} size={30} />
                                                    <div>
                                                        <div style={{ fontWeight: 600 }}>{item.name}</div>
                                                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{item.position}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            {balanceModalColumns.map((col) => {
                                                const cell = item.byType[col.key] || { total: 0, remaining: 0, used: 0 };
                                                return (
                                                    <td key={col.key} style={{ padding: 12 }}>
                                                        <BalanceBar remaining={cell.remaining} total={cell.total} color={col.color} />
                                                    </td>
                                                );
                                            })}
                                        </tr>
                                    ))}
                                    {balanceModalRows.length === 0 && (
                                        <tr>
                                            <td colSpan={1 + balanceModalColumns.length} style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>
                                                No balance data for this filter
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
                            <button
                                type="button"
                                onClick={() => setShowBalanceTotalsModal(true)}
                                disabled={balanceModalRows.length === 0}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 7,
                                    padding: '8px 14px',
                                    border: '1px solid #2563eb',
                                    borderRadius: 8,
                                    background: balanceModalRows.length === 0 ? '#e2e8f0' : '#2563eb',
                                    color: balanceModalRows.length === 0 ? '#94a3b8' : '#ffffff',
                                    fontSize: 13,
                                    fontWeight: 700,
                                    cursor: balanceModalRows.length === 0 ? 'not-allowed' : 'pointer',
                                }}
                            >
                                <Layers size={15} />
                                View Totals ({balanceModalRows.length})
                            </button>
                        </div>
                    </Modal>
                )}

                {showBalanceModal && showBalanceTotalsModal && (
                    <Modal title="Leave Balance Totals" onClose={() => setShowBalanceTotalsModal(false)} width="min(720px, 94vw)">
                        <div style={{ marginBottom: 14, fontSize: 13, color: '#64748b' }}>
                            Summary for {balanceModalRows.length} visible employee{balanceModalRows.length === 1 ? '' : 's'} using the current filters.
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 12 }}>
                            {balanceModalColumns.map((col) => {
                                const total = balanceModalTotals[col.key];
                                return (
                                    <div
                                        key={col.key}
                                        style={{
                                            padding: 14,
                                            border: '1px solid #e2e8f0',
                                            borderTop: `4px solid ${col.color}`,
                                            borderRadius: 10,
                                            background: '#ffffff',
                                        }}
                                    >
                                        <div style={{ marginBottom: 10, fontSize: 12, fontWeight: 800, color: '#475569' }}>{col.label}</div>
                                        <div style={{ fontSize: 22, lineHeight: 1.1, fontWeight: 800, color: '#0f172a' }}>{total.remaining}</div>
                                        <div style={{ marginTop: 3, fontSize: 12, color: '#64748b' }}>days remaining</div>
                                        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid #f1f5f9', display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                                            <span style={{ color: '#64748b' }}>Allowance <strong style={{ color: '#334155' }}>{total.total}</strong></span>
                                            <span style={{ color: '#64748b' }}>Used <strong style={{ color: '#334155' }}>{total.used}</strong></span>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </Modal>
                )}

                {/* Leave Planner Full Modal */}
                {showLeavePlannerModal && (
                    <Modal
                        title={`Leave Planner — ${selectedMonthTitle}`}
                        onClose={() => setShowLeavePlannerModal(false)}
                        width="min(1300px, 96vw)"
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button type="button" onClick={() => changeSelectedMonth(-1)} style={navButtonStyle}>Prev</button>
                                <button type="button" onClick={resetSelectedMonth} style={navButtonStyle}>Today</button>
                                <button type="button" onClick={() => changeSelectedMonth(1)} style={navButtonStyle}>Next</button>
                            </div>
                            <div style={{ fontSize: 16, fontWeight: 700 }}>{selectedMonthTitle}</div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                            <div>
                                <label style={labelStyle}>Filter by Employee</label>
                                <select value={plannerFilterEmployee} onChange={(e) => setPlannerFilterEmployee(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Employees</option>
                                    {Array.from(employeeNameMap.entries()).map(([id, info]) => (
                                        <option key={id} value={String(id)}>{info.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Filter by Leave Type</label>
                                <select value={plannerFilterType} onChange={(e) => setPlannerFilterType(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Types</option>
                                    {legendTypes.map((lt) => (
                                        <option key={lt.key} value={lt.key}>{lt.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Search</label>
                                <SearchBar
                                    storageKey="leave:planner"
                                    placeholder="Search by name..."
                                    ariaLabel="Search planner by name"
                                    value={plannerSearchTerm}
                                    onChange={setPlannerSearchTerm}
                                    suggestions={collectSearchTerms(Array.from(employeeNameMap.values()), [
                                        (e: any) => e?.name,
                                    ])}
                                    inputStyle={{ ...filterSelectStyle, width: '100%' }}
                                />
                            </div>
                        </div>
                        <div style={{ maxHeight: 520, overflow: 'auto' }}>
                            <CompactLeaveCalendar
                                leaveRequests={leaveRequests}
                                employeeNameMap={employeeNameMap}
                                selectedMonth={selectedMonth}
                                getLeaveTypeLabel={getLeaveTypeLabel}
                                leaveTypeFilter={plannerFilterType}
                                employeeFilter={plannerFilterEmployee}
                                searchTerm={plannerSearchTerm}
                                onSearchChange={setPlannerSearchTerm}
                                viewMode={plannerView}
                                page={plannerPage}
                                pageSize={PLANNER_PAGE_SIZE}
                                onTotalCountChange={setPlannerTotalEmployees}
                            />
                        </div>
                        <Pagination
                            currentPage={plannerPage}
                            totalItems={plannerTotalEmployees}
                            itemsPerPage={PLANNER_PAGE_SIZE}
                            onPageChange={setPlannerPage}
                            label="employees"
                        />
                    </Modal>
                )}

                {/* Approval Queue Modal */}
                {showApprovalQueueModal && (
                    <Modal title={`Approval Queue (${approvalQueue.length})`} onClose={() => { setShowApprovalQueueModal(false); setShowAllApprovalRequests(false); }} width={showAllApprovalRequests ? 'min(1040px, 96vw)' : 'min(760px, 95vw)'}>
                        {approvalQueue.length === 0 ? (
                            <div style={emptyStateStyle}>No pending requests</div>
                        ) : (
                            <div style={{ display: 'grid', gap: 12, maxHeight: 520, overflowY: 'auto' }}>
                                {modalApprovalRequests.map((req) => {
                                    const meta = getLeaveMeta(req.leave_type);
                                    const info = employeeNameMap.get(Number(req.employee_id));
                                    const name = info?.name || req.employee_name || 'Employee';
                                    const days = countLeaveDays(req.start_date, req.end_date);
                                    const busy = approvingLeaveId === req.leave_request_id || rejectingLeaveId === req.leave_request_id;
                                    return (
                                        <div key={req.leave_request_id} style={queueItemStyle}>
                                            <div style={{ display: 'flex', gap: 10, minWidth: 0 }}>
                                                <Avatar name={name} photo={info?.photo} size={40} />
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                                                        <span style={{ fontWeight: 600, fontSize: 13 }}>{name}</span>
                                                        <span style={typePillStyle(meta)}>{getLeaveTypeLabel(req.leave_type)}</span>
                                                    </div>
                                                    <div style={{ fontSize: 12, color: '#64748b' }}>
                                                        {formatDateRangeLong(req.start_date, req.end_date)} • {days} day{days === 1 ? '' : 's'}
                                                    </div>
                                                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>{req.reason || 'No reason provided'}</div>
                                                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>{formatRelativeTime(req.created_at)}</div>
                                                </div>
                                            </div>
                                            {canApprove && (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                                    <button type="button" onClick={() => setSelectedApprovalRequest(req)} style={viewOutlineBtnStyle}>
                                                        View
                                                    </button>
                                                    <button type="button" disabled={busy} onClick={() => void handleApproveLeave(req.leave_request_id)} style={approveOutlineBtnStyle}>
                                                        <Check size={13} /> Approve
                                                    </button>
                                                    <button type="button" disabled={busy} onClick={() => void handleRejectLeave(req.leave_request_id)} style={rejectOutlineBtnStyle}>
                                                        <X size={13} /> Reject
                                                    </button>
                                                </div>
                                            )}
                                            {!canApprove && (
                                                <button type="button" onClick={() => setSelectedApprovalRequest(req)} style={viewOutlineBtnStyle}>
                                                    View
                                                </button>
                                            )}
                                        </div>
                                    );
                                })}
                                {approvalQueue.length > 10 && (
                                    <button
                                        type="button"
                                        onClick={() => setShowAllApprovalRequests((current) => !current)}
                                        style={{ ...secondaryBtnStyle, justifySelf: 'center', marginTop: 4 }}
                                    >
                                        {showAllApprovalRequests ? 'Show first 10' : `See more (${approvalQueue.length - 10})`}
                                    </button>
                                )}
                            </div>
                        )}
                    </Modal>
                )}

                {/* Approval request details */}
                {selectedApprovalRequest && (() => {
                    const request = selectedApprovalRequest;
                    const employee = employeeNameMap.get(Number(request.employee_id));
                    const employeeName = employee?.name || request.employee_name || 'Employee';
                    const workingDays = countLeaveDays(request.start_date, request.end_date);
                    const balanceRow = leaveBalanceOverview.find((item) => Number(item.employee_id) === Number(request.employee_id));
                    const balance = balanceRow?.byType[collapseBalanceKey(request.leave_type)];
                    const busy = approvingLeaveId === request.leave_request_id || rejectingLeaveId === request.leave_request_id;
                    return (
                        <Modal title="Leave Request Details" onClose={() => setSelectedApprovalRequest(null)} width="min(620px, 95vw)">
                            <div style={{ display: 'grid', gap: 14 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 11, paddingBottom: 12, borderBottom: '1px solid #e2e8f0' }}>
                                    <Avatar name={employeeName} photo={employee?.photo} size={42} />
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ fontSize: 15, fontWeight: 750, color: '#0f172a' }}>{employeeName}</div>
                                        <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{request.position || employee?.position || request.employee_role || 'Employee'}</div>
                                    </div>
                                    <span style={{ ...typePillStyle(getLeaveMeta(request.leave_type)), textTransform: 'capitalize' }}>{request.status}</span>
                                </div>

                                <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
                                    <div className="leave-request-detail-item"><dt>Leave type</dt><dd>{getLeaveTypeLabel(request.leave_type)}</dd></div>
                                    <div className="leave-request-detail-item"><dt>Working days</dt><dd>{workingDays} day{workingDays === 1 ? '' : 's'}</dd></div>
                                    <div className="leave-request-detail-item"><dt>Start date</dt><dd>{formatDateRangeLong(request.start_date, request.start_date)}</dd></div>
                                    <div className="leave-request-detail-item"><dt>End date</dt><dd>{formatDateRangeLong(request.end_date, request.end_date)}</dd></div>
                                    <div className="leave-request-detail-item"><dt>Filed</dt><dd>{request.created_at ? new Date(request.created_at).toLocaleString() : '—'}</dd></div>
                                    <div className="leave-request-detail-item"><dt>Available balance</dt><dd>{balance ? `${balance.remaining} of ${balance.total} days` : 'Not available'}</dd></div>
                                </dl>

                                <div style={{ padding: 12, border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 }}>Reason</div>
                                    <div style={{ color: '#334155', fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{request.reason || 'No reason provided.'}</div>
                                </div>

                                {canApprove && (
                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 2 }}>
                                        <button type="button" disabled={busy} onClick={() => void handleRejectLeave(request.leave_request_id).then(() => setSelectedApprovalRequest(null))} style={rejectOutlineBtnStyle}>
                                            <X size={13} /> Reject
                                        </button>
                                        <button type="button" disabled={busy} onClick={() => void handleApproveLeave(request.leave_request_id).then(() => setSelectedApprovalRequest(null))} style={approveOutlineBtnStyle}>
                                            <Check size={13} /> Approve
                                        </button>
                                    </div>
                                )}
                            </div>
                        </Modal>
                    );
                })()}

                {/* Upcoming Modal */}
                {showUpcomingModal && (
                    <Modal title="Upcoming Absences" onClose={() => setShowUpcomingModal(false)} width="min(720px, 95vw)">
                        {upcomingLeaves.length === 0 ? (
                            <div style={emptyStateStyle}>No upcoming leaves</div>
                        ) : (
                            <div style={{ display: 'grid', gap: 10, maxHeight: 480, overflowY: 'auto' }}>
                                {upcomingLeaves.map((leave) => {
                                    const meta = getLeaveMeta(leave.leave_type);
                                    const info = employeeNameMap.get(Number(leave.employee_id));
                                    const name = info?.name || leave.employee_name || 'Employee';
                                    return (
                                        <div key={leave.leave_request_id} style={{ display: 'grid', gridTemplateColumns: '140px 1fr auto', gap: 12, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #f1f5f9' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 12 }}>
                                                <Calendar size={13} />
                                                {formatPlannerDateRange(leave.start_date, leave.end_date)}
                                            </div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <Avatar name={name} photo={info?.photo} size={28} />
                                                <span style={{ fontSize: 13, fontWeight: 500 }}>{name}</span>
                                            </div>
                                            <span style={typePillStyle(meta)}>{getLeaveTypeLabel(leave.leave_type)}</span>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </Modal>
                )}

                {/* Policies Modal */}
                {showPoliciesModal && (
                    <Modal title="Leave Policies" onClose={() => setShowPoliciesModal(false)} width="min(640px, 95vw)">
                        <div style={{ display: 'grid', gap: 12 }}>
                            {(leaveTypes.length > 0 ? leaveTypes : [
                                { leave_type_id: 1, type_key: 'annual', type_name: 'Annual' },
                                { leave_type_id: 2, type_key: 'sick', type_name: 'Sick' },
                                { leave_type_id: 3, type_key: 'personal', type_name: 'Personal' },
                                { leave_type_id: 4, type_key: 'maternity', type_name: 'Maternity' },
                                { leave_type_id: 5, type_key: 'remote', type_name: 'Work From Home Leave', default_days: 10 },
                            ]).map((lt) => {
                                const meta = getLeaveMeta(lt.type_key);
                                const allocation = Number(lt.default_days ?? DEFAULT_ALLOCATIONS[lt.type_key] ?? 10);
                                return (
                                    <div key={lt.type_key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 14, border: '1px solid #e2e8f0', borderRadius: 10 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                            <span style={{ width: 10, height: 10, borderRadius: 999, background: meta.color }} />
                                            <div>
                                                <div style={{ fontWeight: 600, fontSize: 13 }}>{getLeaveTypeLabel(lt.type_key)}</div>
                                                <div style={{ fontSize: 12, color: '#94a3b8' }}>Yearly allocation</div>
                                            </div>
                                        </div>
                                        <div style={{ fontWeight: 700, color: '#0f172a' }}>{allocation} days</div>
                                    </div>
                                );
                            })}
                            <div style={{ marginTop: 8, padding: 14, background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
                                <div style={{ fontWeight: 600, marginBottom: 6 }}>Approval workflow</div>
                                <div style={{ fontSize: 13, color: '#64748b', lineHeight: 1.5 }}>
                                    Staff leave requests require manager approval. Manager leave requests require admin approval.
                                    Every leave type earns its configured allocation yearly. Unused credits carry forward without a cap. Saturday and Sunday are excluded from charged leave days.
                                </div>
                            </div>
                        </div>
                    </Modal>
                )}

                {/* New Leave Request Modal */}
                {showNewRequestModal && (
                    <Modal title="New Leave Request" onClose={closeNewRequestModal} width="min(600px, 95vw)">
                        <div style={{ display: 'grid', gap: 16 }}>
                            {newRequestError && (
                                <div
                                    role="alert"
                                    aria-live="assertive"
                                    style={{
                                        border: '1px solid #fca5a5',
                                        background: '#fef2f2',
                                        borderRadius: 10,
                                        padding: '10px 12px',
                                    }}
                                >
                                    <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c', marginBottom: 4 }}>
                                        {newRequestErrorFields.length > 0 ? 'Duplicate request — Start Date / End Date' : 'Cannot submit request'}
                                    </div>
                                    <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.5 }}>{newRequestError}</div>
                                </div>
                            )}
                            {role !== 'staff' && (
                                <>
                                    <div>
                                        <label style={labelStyle} htmlFor="new-leave-employee">
                                            Employee <span style={{ color: '#ef4444' }}>*</span>
                                        </label>
                                        <select
                                            id="new-leave-employee"
                                            value={newRequestForm.employee_id}
                                            onChange={(e) => {
                                                setNewRequestForm({ ...newRequestForm, employee_id: e.target.value });
                                                if (newRequestError) { setNewRequestError(''); setNewRequestErrorFields([]); }
                                            }}
                                            required
                                            aria-required="true"
                                            aria-invalid={newRequestErrorFields.includes('employee_id')}
                                            style={{
                                                ...filterSelectStyle,
                                                fontSize: 14,
                                                padding: '10px 12px',
                                                borderColor: newRequestErrorFields.includes('employee_id') ? '#ef4444' : undefined,
                                                borderWidth: newRequestErrorFields.includes('employee_id') ? 2 : undefined,
                                            }}
                                            disabled={newRequestForm.request_own}
                                        >
                                            <option value="">Select Employee</option>
                                            {employees.map((emp) => (
                                                <option key={emp.employee_id} value={emp.employee_id}>
                                                    {emp.first_name} {emp.last_name}{emp.position ? ` — ${emp.position}` : ''}
                                                </option>
                                            ))}
                                        </select>
                                        {newRequestError && newRequestErrorFields.includes('employee_id') && (
                                            <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                                        )}
                                    </div>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#475569', cursor: 'pointer' }}>
                                        <input
                                            type="checkbox"
                                            checked={newRequestForm.request_own}
                                            onChange={(e) => {
                                                const isChecked = e.target.checked;
                                                setNewRequestForm({
                                                    ...newRequestForm,
                                                    request_own: isChecked,
                                                    employee_id: isChecked ? '' : newRequestForm.employee_id,
                                                });
                                            }}
                                            style={{ width: 16, height: 16, accentColor: '#2563eb' }}
                                        />
                                        Request Own
                                    </label>
                                </>
                            )}

                            <div>
                                <label style={labelStyle} htmlFor="new-leave-type">
                                    Leave Type <span style={{ color: '#ef4444' }}>*</span>
                                </label>
                                <select
                                    id="new-leave-type"
                                    value={newRequestForm.leave_type}
                                    onChange={(e) => {
                                        setNewRequestForm({ ...newRequestForm, leave_type: e.target.value });
                                        if (newRequestError) { setNewRequestError(''); setNewRequestErrorFields([]); }
                                    }}
                                    required
                                    aria-required="true"
                                    aria-invalid={newRequestErrorFields.includes('leave_type')}
                                    style={{
                                        ...filterSelectStyle,
                                        fontSize: 14,
                                        padding: '10px 12px',
                                        borderColor: newRequestErrorFields.includes('leave_type') ? '#ef4444' : undefined,
                                        borderWidth: newRequestErrorFields.includes('leave_type') ? 2 : undefined,
                                    }}
                                >
                                    <option value="">Select Leave Type</option>
                                    {leaveTypes.map((lt) => (
                                        <option key={lt.type_key} value={lt.type_key}>
                                            {getLeaveTypeLabel(lt.type_key)}
                                        </option>
                                    ))}
                                </select>
                                {newRequestError && newRequestErrorFields.includes('leave_type') && (
                                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                                )}
                                {newRequestBalancePreview && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#f8fafc', border: '1px solid #e2e8f0', fontSize: 12, color: '#475569' }}>
                                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: newRequestBalancePreview.color, flexShrink: 0 }} />
                                        <span>
                                            <strong style={{ color: '#0f172a' }}>{newRequestBalancePreview.name}</strong>
                                            {' '}has <strong style={{ color: '#0f172a' }}>{newRequestBalancePreview.remaining} / {newRequestBalancePreview.total} days</strong>
                                            {' '}of {newRequestBalancePreview.label} left
                                            {newRequestBalancePreview.requestedDays > 0 && (
                                                newRequestBalancePreview.remaining >= newRequestBalancePreview.requestedDays
                                                    ? <span style={{ color: '#15803d', fontWeight: 700 }}> — {newRequestBalancePreview.requestedDays} day{newRequestBalancePreview.requestedDays === 1 ? '' : 's'} requested ✓</span>
                                                    : <span style={{ color: '#b91c1c', fontWeight: 700 }}> — needs {newRequestBalancePreview.requestedDays} days (insufficient)</span>
                                            )}
                                        </span>
                                    </div>
                                )}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div>
                                    <label style={labelStyle} htmlFor="new-leave-start-date">
                                        Start Date <span style={{ color: '#ef4444' }}>*</span>
                                    </label>
                                    <input
                                        id="new-leave-start-date"
                                        type="date"
                                        min={earliestLeaveStartDate}
                                        value={newRequestForm.start_date}
                                        onChange={(e) => {
                                            const selected = e.target.value;
                                            if (isWeekendDate(selected)) {
                                                setNewRequestError('Leave cannot start on Saturday or Sunday. Select a weekday.');
                                                setNewRequestErrorFields(['start_date']);
                                                return;
                                            }
                                            const startDate = selected < earliestLeaveStartDate ? earliestLeaveStartDate : selected;
                                            setNewRequestForm((current) => ({
                                                ...current,
                                                start_date: startDate,
                                                end_date: !current.end_date || current.end_date < startDate ? startDate : current.end_date,
                                            }));
                                            if (newRequestError) { setNewRequestError(''); setNewRequestErrorFields([]); }
                                        }}
                                        required
                                        aria-required="true"
                                        aria-invalid={newRequestErrorFields.includes('start_date')}
                                        aria-describedby={newRequestError ? 'new-leave-form-error' : undefined}
                                        style={{
                                            ...filterSelectStyle,
                                            fontSize: 14,
                                            padding: '10px 12px',
                                            borderColor: newRequestErrorFields.includes('start_date') ? '#ef4444' : undefined,
                                            borderWidth: newRequestErrorFields.includes('start_date') ? 2 : undefined,
                                        }}
                                    />
                                    {newRequestError && newRequestErrorFields.includes('start_date') && (
                                        <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>
                                            {newRequestForm.start_date ? newRequestError : 'Required.'}
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <label style={labelStyle} htmlFor="new-leave-end-date">
                                        End Date <span style={{ color: '#ef4444' }}>*</span>
                                    </label>
                                    <input
                                        id="new-leave-end-date"
                                        type="date"
                                        min={newRequestForm.start_date || earliestLeaveStartDate}
                                        value={newRequestForm.end_date}
                                        onChange={(e) => {
                                            const selected = e.target.value;
                                            if (isWeekendDate(selected)) {
                                                setNewRequestError('Leave cannot end on Saturday or Sunday. Select a weekday.');
                                                setNewRequestErrorFields(['end_date']);
                                                return;
                                            }
                                            setNewRequestForm((current) => ({ ...current, end_date: selected }));
                                            if (newRequestError) { setNewRequestError(''); setNewRequestErrorFields([]); }
                                        }}
                                        required
                                        aria-required="true"
                                        aria-invalid={newRequestErrorFields.includes('end_date')}
                                        aria-describedby={newRequestError ? 'new-leave-form-error' : undefined}
                                        style={{
                                            ...filterSelectStyle,
                                            fontSize: 14,
                                            padding: '10px 12px',
                                            borderColor: newRequestErrorFields.includes('end_date') ? '#ef4444' : undefined,
                                            borderWidth: newRequestErrorFields.includes('end_date') ? 2 : undefined,
                                        }}
                                    />
                                    {newRequestError && newRequestErrorFields.includes('end_date') && (
                                        <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>
                                            {newRequestForm.end_date ? newRequestError : 'Required.'}
                                        </div>
                                    )}
                                </div>
                            </div>
                            <div style={{ marginTop: -8, fontSize: 12, color: '#64748b' }}>
                                File at least 5 working days ahead. Saturday and Sunday cannot be selected and are skipped from the leave total.
                            </div>
                            {newRequestError && <span id="new-leave-form-error" style={{ display: 'none' }}>{newRequestError}</span>}

                            <div>
                                <label style={labelStyle}>Reason (Optional)</label>
                                <textarea
                                    value={newRequestForm.reason}
                                    onChange={(e) => setNewRequestForm({ ...newRequestForm, reason: e.target.value })}
                                    placeholder="Enter reason for leave request..."
                                    rows={4}
                                    style={{
                                        ...filterSelectStyle,
                                        fontSize: 14,
                                        padding: '10px 12px',
                                        resize: 'vertical',
                                        fontFamily: 'inherit',
                                        minHeight: 96,
                                    }}
                                />
                            </div>

                            <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
                                <button type="button" onClick={closeNewRequestModal} style={secondaryBtnStyle}>
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleSubmitNewRequest()}
                                    disabled={submittingRequest}
                                    className="app-action-btn app-action-btn-primary"
                                    style={{ ...primaryBtnStyle, opacity: submittingRequest ? 0.7 : 1 }}
                                >
                                    {submittingRequest ? 'Submitting...' : 'Submit Request'}
                                </button>

                            </div>
                        </div>
                    </Modal>
                )}

                {/* Archive Modal */}
                {showArchiveModal && (
                    <Modal
                        title={`Archive — Rejected Leaves (${leaveRequests.filter((r) => String(r.status).toLowerCase() === 'rejected').length})`}
                        onClose={() => setShowArchiveModal(false)}
                        width="min(1100px, 96vw)"
                    >
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                            <div>
                                <label style={labelStyle}>Filter by Employee</label>
                                <select value={archiveFilterEmployee} onChange={(e) => setArchiveFilterEmployee(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Employees</option>
                                    {Array.from(employeeNameMap.entries()).map(([id, info]) => (
                                        <option key={id} value={String(id)}>{info.name}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Filter by Leave Type</label>
                                <select value={archiveFilterLeaveType} onChange={(e) => setArchiveFilterLeaveType(e.target.value)} style={filterSelectStyle}>
                                    <option value="all">All Types</option>
                                    {legendTypes.map((lt) => (
                                        <option key={lt.key} value={lt.key}>{lt.label}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label style={labelStyle}>Search</label>
                                <SearchBar
                                    storageKey="leave:archive"
                                    placeholder="Search..."
                                    ariaLabel="Search rejected leaves"
                                    value={archiveSearchTerm}
                                    onChange={setArchiveSearchTerm}
                                    suggestions={collectSearchTerms(leaveRequests, [
                                        (r: any) => r.employee_name,
                                        (r: any) => r.reason,
                                    ])}
                                    inputStyle={{ ...filterSelectStyle, width: '100%' }}
                                />
                            </div>
                        </div>
                        <div style={{ overflowY: 'auto', maxHeight: 480 }}>
                            <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                                <thead style={{ position: 'sticky', top: 0, background: '#f8fafc' }}>
                                    <tr style={{ borderBottom: '2px solid #e2e8f0' }}>
                                        <th style={thStyle}>Employee</th>
                                        <th style={thStyle}>Leave Type</th>
                                        <th style={thStyle}>Duration</th>
                                        <th style={thStyle}>Reason</th>
                                        <th style={{ ...thStyle, textAlign: 'center' }}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {leaveRequests
                                        .filter((r) => String(r.status).toLowerCase() === 'rejected')
                                        .filter((r) => archiveFilterEmployee === 'all' || r.employee_id === Number(archiveFilterEmployee))
                                        .filter((r) => archiveFilterLeaveType === 'all' || r.leave_type === archiveFilterLeaveType)
                                        .filter((r) => {
                                            const q = archiveSearchTerm.trim().toLowerCase();
                                            if (!q) return true;
                                            return String(r.employee_name || '').toLowerCase().includes(q)
                                                || String(r.reason || '').toLowerCase().includes(q)
                                                || String(r.leave_type || '').toLowerCase().includes(q);
                                        })
                                        .map((leave) => {
                                            const meta = getLeaveMeta(leave.leave_type);
                                            return (
                                                <tr key={leave.leave_request_id} style={{ borderBottom: '1px solid #e2e8f0' }}>
                                                    <td style={{ padding: 12, fontWeight: 500 }} className="llb-trunc" title={leave.employee_name}>{leave.employee_name}</td>
                                                    <td style={{ padding: 12 }}>
                                                        <span style={typePillStyle(meta)}>{getLeaveTypeLabel(leave.leave_type)}</span>
                                                    </td>
                                                    <td style={{ padding: 12, color: '#64748b' }}>
                                                        {leave.start_date} to {leave.end_date}
                                                    </td>
                                                    <td style={{ padding: 12, color: '#64748b', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={leave.reason || ''}>
                                                        {leave.reason || '-'}
                                                    </td>
                                                    <td style={{ padding: 12, textAlign: 'center' }}>
                                                        <span style={{ background: '#fecaca', color: '#991b1b', padding: '4px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                                                            Rejected
                                                        </span>
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                </tbody>
                            </table>
                            {(() => {
                                const rejected = leaveRequests.filter((r) => String(r.status).toLowerCase() === 'rejected');
                                if (rejected.length === 0) {
                                    return <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8' }}>No rejected leaves found</div>;
                                }
                                const searched = rejected
                                    .filter((r) => archiveFilterEmployee === 'all' || r.employee_id === Number(archiveFilterEmployee))
                                    .filter((r) => archiveFilterLeaveType === 'all' || r.leave_type === archiveFilterLeaveType)
                                    .filter((r) => {
                                        const q = archiveSearchTerm.trim().toLowerCase();
                                        if (!q) return true;
                                        return String(r.employee_name || '').toLowerCase().includes(q)
                                            || String(r.reason || '').toLowerCase().includes(q)
                                            || String(r.leave_type || '').toLowerCase().includes(q);
                                    });
                                if (searched.length > 0) return null;
                                return (
                                    <div style={{ padding: 8, textAlign: 'center' }}>
                                        <ZeroResults
                                            query={archiveSearchTerm}
                                            itemLabel="rejected leaves"
                                            alternatives={getAlternativeSuggestions(archiveSearchTerm, collectSearchTerms(rejected, [
                                                (r: any) => r.employee_name,
                                                (r: any) => r.reason,
                                            ]))}
                                            onPickAlternative={(term) => setArchiveSearchTerm(term)}
                                            onClear={() => setArchiveSearchTerm('')}
                                        />
                                    </div>
                                );
                            })()}
                        </div>
                    </Modal>
                )}
            </div>

            <style>{`
                @keyframes spin {
                    from { transform: rotate(0deg); }
                    to { transform: rotate(360deg); }
                }
                .leave-planner-scroll {
                    scrollbar-width: auto;
                    scrollbar-color: #94a3b8 #e2e8f0;
                }
                .leave-planner-scroll::-webkit-scrollbar {
                    height: 12px;
                }
                .leave-planner-scroll::-webkit-scrollbar-track {
                    background: #e2e8f0;
                    border-radius: 999px;
                }
                .leave-planner-scroll::-webkit-scrollbar-thumb {
                    background: #94a3b8;
                    border: 3px solid #e2e8f0;
                    border-radius: 999px;
                }
                .leave-planner-scroll::-webkit-scrollbar-thumb:hover {
                    background: #64748b;
                }
                .leave-request-detail-item {
                    min-width: 0;
                    padding: 10px;
                    border: 1px solid #e2e8f0;
                    border-radius: 8px;
                    background: #fff;
                }
                .leave-request-detail-item dt {
                    margin: 0 0 4px;
                    color: #94a3b8;
                    font-size: 10px;
                    font-weight: 800;
                    letter-spacing: .05em;
                    text-transform: uppercase;
                }
                .leave-request-detail-item dd {
                    margin: 0;
                    color: #1e293b;
                    font-size: 12px;
                    font-weight: 650;
                    overflow-wrap: anywhere;
                }
            `}</style>
        </Layout>
    );
}


/* ========== Helper Components ========== */

function Avatar({ name, photo, size = 36 }: { name: string; photo?: string | null; size?: number }) {
    const src = photo ? resolveBackendAssetUrl(photo) : '';
    if (src) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img
                src={src}
                alt={name}
                style={{
                    width: size,
                    height: size,
                    borderRadius: '50%',
                    objectFit: 'cover',
                    flexShrink: 0,
                    border: '1px solid #e2e8f0',
                }}
            />
        );
    }
    return (
        <div
            style={{
                width: size,
                height: size,
                borderRadius: '50%',
                background: avatarGradient(name),
                color: '#fff',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: Math.max(10, size * 0.32),
                fontWeight: 700,
                flexShrink: 0,
                letterSpacing: '0.02em',
            }}
        >
            {getInitials(name)}
        </div>
    );
}

function StatCard({
    icon,
    iconBg = '#eff6ff',
    iconBorder = '#bfdbfe',
    label,
    value,
    trend,
    trendType,
    accent = '#2563eb',
}: {
    icon: ReactNode;
    iconBg?: string;
    iconBorder?: string;
    label: string;
    value: number | string;
    trend: string;
    trendType: 'up-good' | 'up-warn' | 'up-info' | 'down-good' | 'down-warn';
    accent?: string;
}) {

    const trendColor =
        trendType === 'up-good' || trendType === 'down-good'
            ? '#059669'
            : trendType === 'up-info'
                ? '#2563eb'
                : '#d97706';
    const arrow = trendType.startsWith('up') ? '↗' : '↘';

    return (
        <div style={{ ...statCardStyle, borderTop: `2px solid ${accent}` }} title={trend} data-trend={trendType}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <div>
                    <div style={{ fontSize: 24, fontWeight: 800, color: '#0f172a', lineHeight: 1 }}>{value}</div>
                    <div style={{ fontSize: 11, color: '#64748b', fontWeight: 600, marginTop: 5 }}>{label}</div>
                </div>
                <div style={{ color: accent, opacity: .75 }}>{icon}</div>
            </div>
        </div>
    );
}


function BalanceBar({ remaining, total, color }: { remaining: number; total: number; color: string }) {
    const safeTotal = total > 0 ? total : 1;
    const safeRemaining = Math.max(0, remaining);
    const pct = Math.min(100, Math.max(0, (safeRemaining / safeTotal) * 100));
    return (
        <div>
            <div style={{ fontSize: 12, color: '#475569', marginBottom: 6, fontWeight: 500 }}>
                {safeRemaining} / {total} days
            </div>
            <div style={{ width: '100%', maxWidth: 140, height: 6, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 999 }} />
            </div>
        </div>
    );
}

function PolicyTile({
    icon,
    iconBg,
    title,
    value,
    subtitle,
}: {
    icon: ReactNode;
    iconBg: string;
    title: string;
    value: string;
    subtitle: string;
}) {

    return (
        <div style={{ padding: '4px 0' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{
                    width: 40,
                    height: 40,
                    borderRadius: '50%',
                    background: iconBg,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                }}>
                    {icon}
                </div>
                <div>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 2 }}>{title}</div>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#0f172a', lineHeight: 1.2 }}>{value}</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{subtitle}</div>
                </div>
            </div>
        </div>
    );
}

function Modal({
    title,
    onClose,
    children,
    width = 'min(900px, 95vw)',
}: {
    title: string;
    onClose: () => void;
    children: ReactNode;
    width?: string;
}) {

    return (
        <div style={modalOverlayStyle} onClick={onClose}>
            <div style={{ ...balanceModalStyle, width }} onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                    <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: '#0f172a' }}>{title}</h2>
                    <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#64748b', padding: 4 }}>
                        <X size={20} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

interface CompactLeaveCalendarProps {
    leaveRequests: LeaveRequestRow[];
    employeeNameMap: Map<number, { name: string; position: string; photo?: string | null }>;
    selectedMonth: Date;
    getLeaveTypeLabel: (key: string) => string;
    maxRows?: number;
    employeeFilter?: string;
    leaveTypeFilter?: string;
    searchTerm?: string;
    onSearchChange?: (value: string) => void;
    viewMode?: 'month' | 'week';
    page?: number;
    pageSize?: number;
    onTotalCountChange?: (total: number) => void;
}

function CompactLeaveCalendar({
    leaveRequests,
    employeeNameMap,
    selectedMonth,
    getLeaveTypeLabel,
    maxRows,
    employeeFilter = 'all',
    leaveTypeFilter = 'all',
    searchTerm = '',
    onSearchChange,
    viewMode = 'month',
    page,
    pageSize,
    onTotalCountChange,
}: CompactLeaveCalendarProps) {
    const monthStart = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
    const monthEnd = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0);

    let rangeStart = monthStart;
    let rangeEnd = monthEnd;

    if (viewMode === 'week') {
        const today = new Date();
        const base = (today.getFullYear() === selectedMonth.getFullYear() && today.getMonth() === selectedMonth.getMonth())
            ? today
            : monthStart;
        const day = base.getDay();
        rangeStart = new Date(base);
        rangeStart.setDate(base.getDate() - day);
        rangeEnd = new Date(rangeStart);
        rangeEnd.setDate(rangeStart.getDate() + 14); // show ~2 weeks like the mock's partial month
    }

    const days: Date[] = [];
    const cursor = new Date(rangeStart);
    while (cursor <= rangeEnd) {
        days.push(new Date(cursor));
        cursor.setDate(cursor.getDate() + 1);
    }

    // Show every day in the selected month (or week range).
    const visibleDays = days;
    const dayColumnWidth = viewMode === 'month' ? 42 : 52;
    const employeeColumnWidth = 180;
    const timelineWidth = visibleDays.length * dayColumnWidth;

    const search = searchTerm.trim().toLowerCase();

    const approvedLeaves = leaveRequests.filter((r) => {
        if (String(r.status || '').toLowerCase() !== 'approved') return false;
        if (leaveTypeFilter !== 'all') {
            const filter = leaveTypeFilter.toLowerCase();
            const type = String(r.leave_type || '').toLowerCase();
            const aliases: Record<string, string[]> = {
                annual: ['annual', 'vacation'],
                vacation: ['annual', 'vacation'],
                personal: ['personal', 'emergency'],
                emergency: ['personal', 'emergency'],
            };
            const allowed = aliases[filter] || [filter];
            if (!allowed.includes(type)) return false;
        }
        const start = parseDateOnly(r.start_date);
        const end = parseDateOnly(r.end_date);
        return start <= rangeEnd && end >= rangeStart;
    });

    const employeeIds = Array.from(
        new Set([
            ...Array.from(employeeNameMap.keys()),
            ...approvedLeaves.map((leave) => Number(leave.employee_id)),
        ])
    );

    const employeesWithLeaves = employeeIds
        .filter((id) => employeeFilter === 'all' || Number(id) === Number(employeeFilter))
        .filter((id) => {
            const info = employeeNameMap.get(Number(id));
            const name = (info?.name || '').toLowerCase();
            const position = (info?.position || '').toLowerCase();
            return !search || name.includes(search) || position.includes(search);
        })
        .filter((id) => approvedLeaves.some((leave) => Number(leave.employee_id) === Number(id)))
        .map((id) => {
            const info = employeeNameMap.get(Number(id));
            return {
                employee_id: Number(id),
                name: info?.name || 'Employee',
                position: info?.position || 'Employee',
                photo: info?.photo,
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    // Notify parent of total filtered employees (for modal pagination)
    useEffect(() => {
        onTotalCountChange?.(employeesWithLeaves.length);
    }, [employeesWithLeaves.length, onTotalCountChange]);

    let displayedEmployees = employeesWithLeaves;
    if (typeof pageSize === 'number' && pageSize > 0 && typeof page === 'number') {
        const safePage = Math.max(1, page);
        const start = (safePage - 1) * pageSize;
        displayedEmployees = employeesWithLeaves.slice(start, start + pageSize);
    } else if (typeof maxRows === 'number') {
        displayedEmployees = employeesWithLeaves.slice(0, maxRows);
    }

    if (displayedEmployees.length === 0) {
        const searched = searchTerm.trim();
        const nameCorpus = collectSearchTerms(Array.from(employeeNameMap.values()), [(e: any) => e?.name]);
        return (
            <div style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 13, border: '1px solid #e2e8f0', borderRadius: 10 }}>
                {searched && onSearchChange ? (
                    <ZeroResults
                        query={searchTerm}
                        itemLabel="employees on leave"
                        alternatives={getAlternativeSuggestions(searchTerm, nameCorpus)}
                        onPickAlternative={(term) => onSearchChange(term)}
                        onClear={() => onSearchChange('')}
                    />
                ) : (
                    'No approved leaves for this period'
                )}
            </div>
        );
    }

    const firstVisible = visibleDays[0];
    const lastVisible = visibleDays[visibleDays.length - 1];

    return (
        <div className="leave-planner-scroll" style={{ maxWidth: '100%', minWidth: 0, overflowX: 'scroll', overflowY: 'hidden', border: '1px solid #e2e8f0', borderRadius: 10, scrollbarGutter: 'stable' }}>
            <div style={{ minWidth: employeeColumnWidth + timelineWidth }}>
                {/* Header */}
                <div style={{ display: 'grid', gridTemplateColumns: `${employeeColumnWidth}px ${timelineWidth}px`, borderBottom: '1px solid #e2e8f0', background: '#fafbfc' }}>
                    <div style={{ padding: '12px 14px', fontSize: 12, color: '#64748b', fontWeight: 600, borderRight: '1px solid #e2e8f0' }}>
                        Employee
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${visibleDays.length}, ${dayColumnWidth}px)` }}>
                        {visibleDays.map((date) => {
                            const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                            return (
                                <div
                                    key={date.toISOString()}
                                    style={{
                                        minHeight: 48,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        gap: 2,
                                        fontSize: 11,
                                        color: isWeekend ? '#94a3b8' : '#475569',
                                        fontWeight: 600,
                                        borderLeft: '1px solid #f1f5f9',
                                    }}
                                >
                                    <span style={{ fontSize: 10, fontWeight: 500 }}>
                                        {date.toLocaleDateString('en-US', { weekday: 'short' })}
                                    </span>
                                    <span style={{ fontSize: 13, fontWeight: 700, color: isWeekend ? '#94a3b8' : '#0f172a' }}>
                                        {date.getDate()}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Rows */}
                {displayedEmployees.map((emp) => {
                    const leaves = approvedLeaves.filter((leave) => Number(leave.employee_id) === Number(emp.employee_id));
                    return (
                        <div
                            key={emp.employee_id}
                            style={{
                                display: 'grid',
                                gridTemplateColumns: `${employeeColumnWidth}px ${timelineWidth}px`,
                                minHeight: 58,
                                borderBottom: '1px solid #f1f5f9',
                            }}
                        >
                            <div style={{ padding: '10px 14px', borderRight: '1px solid #e2e8f0', display: 'flex', alignItems: 'center', gap: 10 }}>
                                <Avatar name={emp.name} photo={emp.photo} size={32} />
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {emp.name}
                                    </div>
                                    <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {emp.position}
                                    </div>
                                </div>
                            </div>
                            <div style={{ position: 'relative', display: 'grid', gridTemplateColumns: `repeat(${visibleDays.length}, ${dayColumnWidth}px)` }}>
                                {visibleDays.map((date) => {
                                    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                                    return (
                                        <div
                                            key={date.toISOString()}
                                            style={{ borderLeft: '1px solid #f1f5f9', background: isWeekend ? '#fafbfc' : '#fff' }}
                                        />
                                    );
                                })}
                                <div style={{ position: 'absolute', inset: '10px 0', display: 'grid', gridTemplateColumns: `repeat(${visibleDays.length}, ${dayColumnWidth}px)`, pointerEvents: 'none' }}>
                                    {leaves.map((leave, index) => {
                                        const startDate = parseDateOnly(leave.start_date);
                                        const endDate = parseDateOnly(leave.end_date);
                                        if (endDate < firstVisible || startDate > lastVisible) return null;

                                        const startIdx = Math.max(0, Math.round((Math.max(startDate.getTime(), firstVisible.getTime()) - firstVisible.getTime()) / (1000 * 60 * 60 * 24)));
                                        const endIdx = Math.min(visibleDays.length - 1, Math.round((Math.min(endDate.getTime(), lastVisible.getTime()) - firstVisible.getTime()) / (1000 * 60 * 60 * 24)));
                                        const span = Math.max(1, endIdx - startIdx + 1);
                                        const meta = getLeaveMeta(leave.leave_type);
                                        const typeName = getLeaveTypeLabel(leave.leave_type);
                                        const laneOffset = leaves.length > 1 ? index * 2 : 0;

                                        return (
                                            <div
                                                key={leave.leave_request_id}
                                                title={`${emp.name}: ${typeName}, ${leave.start_date} to ${leave.end_date}`}
                                                style={{
                                                    gridColumn: `${startIdx + 1} / span ${span}`,
                                                    alignSelf: 'center',
                                                    height: 34,
                                                    margin: `${laneOffset}px 3px 0`,
                                                    borderRadius: 8,
                                                    border: `1px solid ${meta.border}`,
                                                    background: meta.soft,
                                                    color: meta.color,
                                                    padding: '3px 8px',
                                                    fontSize: 11,
                                                    fontWeight: 700,
                                                    overflow: 'hidden',
                                                    whiteSpace: 'nowrap',
                                                    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)',
                                                    pointerEvents: 'auto',
                                                    display: 'flex',
                                                    flexDirection: 'column',
                                                    justifyContent: 'center',
                                                }}
                                            >
                                                <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.15 }}>{typeName}</div>
                                                <div style={{ fontSize: 10, color: '#64748b', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.15 }}>
                                                    {formatPlannerDateRange(leave.start_date, leave.end_date)}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {typeof maxRows === 'number' && typeof pageSize !== 'number' && employeesWithLeaves.length > maxRows && (
                    <div style={{ padding: '10px 14px', fontSize: 12, color: '#2563eb', fontWeight: 600, textAlign: 'center', background: '#f8fafc' }}>
                        +{employeesWithLeaves.length - maxRows} more employee{employeesWithLeaves.length - maxRows === 1 ? '' : 's'}
                    </div>
                )}
            </div>
        </div>
    );
}

/* ========== Styles ========== */

const pageStyle: CSSProperties = {
    padding: '8px 4px 20px',
    width: '100%',
    maxWidth: 1480,
    minWidth: 0,
    margin: '0 auto',
    minHeight: '100%',
    overflowX: 'hidden',
    boxSizing: 'border-box',
    background: '#f8fafc',
};

const cardStyle: CSSProperties = {
    background: '#ffffff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: 14,
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
};

const statCardStyle: CSSProperties = {
    ...cardStyle,
    padding: '11px 13px',
};

const statIconWrapStyle: CSSProperties = {
    width: 44,
    height: 44,
    borderRadius: 12,
    background: '#eff6ff',
    border: '1px solid #bfdbfe',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
};

const sectionTitleStyle: CSSProperties = {
    margin: 0,
    fontSize: 16,
    fontWeight: 800,
    color: '#1e3a8a',
};


const primaryBtnStyle: CSSProperties = {
    background: '#1e3a8a',
    color: '#fff',
    border: '1px solid #1e3a8a',
    borderRadius: 8,
    padding: '10px 16px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    boxShadow: '0 1px 2px rgba(30, 58, 138, 0.25)',
};


const secondaryBtnStyle: CSSProperties = {
    background: '#eff6ff',
    color: '#1e3a8a',
    border: '1px solid #bfdbfe',
    borderRadius: 8,
    padding: '10px 14px',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
};

const navButtonStyle: CSSProperties = {
    background: '#eff6ff',
    border: '1px solid #bfdbfe',
    borderRadius: 8,
    padding: '6px 12px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    color: '#1e3a8a',
};


const iconNavBtnStyle: CSSProperties = {
    ...navButtonStyle,
    padding: 7,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
};

const selectPillStyle: CSSProperties = {
    ...navButtonStyle,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    position: 'relative',
    paddingRight: 10,
};

const hiddenSelectStyle: CSSProperties = {
    position: 'absolute',
    inset: 0,
    opacity: 0,
    cursor: 'pointer',
    width: '100%',
};

const linkBtnStyle: CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: '#1d4ed8',
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 700,
    padding: 0,
};

const countBadgeStyle: CSSProperties = {
    background: '#dbeafe',
    color: '#1e3a8a',
    borderRadius: 999,
    padding: '1px 8px',
    fontSize: 12,
    fontWeight: 800,
};

const emptyStateStyle: CSSProperties = {
    padding: 20,
    textAlign: 'center',
    color: '#64748b',
    fontSize: 13,
    background: '#f8fbff',
    border: '1px dashed #bfdbfe',
    borderRadius: 10,
};

const queueItemStyle: CSSProperties = {
    padding: 12,
    border: '1px solid #dbeafe',
    borderRadius: 12,
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    alignItems: 'flex-start',
    background: 'linear-gradient(180deg, #ffffff 0%, #f8fbff 100%)',
};

const approveOutlineBtnStyle: CSSProperties = {
    background: '#f0fdf4',
    color: '#15803d',
    border: '1px solid #bbf7d0',
    borderRadius: 8,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
};

const viewOutlineBtnStyle: CSSProperties = {
    background: '#eff6ff',
    color: '#1d4ed8',
    border: '1px solid #bfdbfe',
    borderRadius: 8,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
};

const rejectOutlineBtnStyle: CSSProperties = {
    background: '#fef2f2',
    color: '#b91c1c',
    border: '1px solid #fecaca',
    borderRadius: 8,
    padding: '5px 10px',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    whiteSpace: 'nowrap',
};

const securityNoteStyle: CSSProperties = {
    marginTop: 20,
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    fontSize: 12,
    padding: '12px 14px',
    borderRadius: 12,
    border: '1px solid #bfdbfe',
    background: 'linear-gradient(135deg, #eff6ff 0%, #f8fbff 100%)',
};

const securityIconWrapStyle: CSSProperties = {
    width: 36,
    height: 36,
    borderRadius: 10,
    background: '#dbeafe',
    border: '1px solid #93c5fd',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
};


const typePillStyle = (meta: LeaveTypeMeta): CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    background: meta.soft,
    color: meta.color,
    border: `1px solid ${meta.border}`,
    padding: '2px 8px',
    borderRadius: 999,
    fontSize: 11,
    fontWeight: 600,
    whiteSpace: 'nowrap',
});

const thStyle: CSSProperties = {
    textAlign: 'left',
    padding: '10px 8px',
    fontWeight: 600,
    color: '#64748b',
    fontSize: 12,
};

const labelStyle: CSSProperties = {
    display: 'block',
    fontSize: 12,
    fontWeight: 600,
    color: '#475569',
    marginBottom: 6,
};

const filterSelectStyle: CSSProperties = {
    width: '100%',
    padding: '8px 12px',
    border: '1px solid #e2e8f0',
    borderRadius: 8,
    fontSize: 13,
    background: '#fff',
    color: '#0f172a',
    boxSizing: 'border-box',
};

const modalOverlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    zIndex: 50000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
};

const balanceModalStyle: CSSProperties = {
    maxHeight: '90vh',
    overflowY: 'auto',
    background: '#ffffff',
    border: '1px solid #dbe3ed',
    borderRadius: 10,
    padding: 18,
    boxShadow: '0 20px 60px rgba(15, 23, 42, 0.22)',
};


const filterDropdownStyle: CSSProperties = {
    position: 'absolute',
    top: '110%',
    right: 0,
    zIndex: 20,
    background: '#fff',
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    boxShadow: '0 10px 30px rgba(15, 23, 42, 0.12)',
    minWidth: 180,
    padding: 6,
    display: 'grid',
    gap: 2,
};

const filterOptionStyle = (active: boolean): CSSProperties => ({
    background: active ? '#dbeafe' : 'transparent',
    border: 'none',
    borderRadius: 8,
    padding: '8px 10px',
    textAlign: 'left',
    cursor: 'pointer',
    fontSize: 12,
    fontWeight: active ? 800 : 500,
    color: active ? '#1e3a8a' : '#475569',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
});

