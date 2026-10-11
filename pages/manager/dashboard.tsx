/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import ActivityLogsPanel from '@/components/ActivityLogsPanel';
import { DashboardClock, DashboardCalendarOverlay, type DashboardCalendarEventMap, fetchManagementCalendarMaps, mergeDashboardCalendarMaps } from '../../components/DashboardCalendar';
import styles from '../../styles/Layout.module.css';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import { Chart as ChartJS, ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Doughnut, Line } from 'react-chartjs-2';
import { getProfileDocumentSummary, type ProfileDocumentStatusRecord } from '@/utils/profileDocuments';
import { useLiveSync } from '@/utils/liveSync';

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, PointElement, LineElement, Filler, ChartDataLabels);
const API_BASE = getApiBaseUrl();

function getBannerWelcomeName(user: { first_name?: unknown; last_name?: unknown; full_name?: unknown; username?: unknown; role?: unknown } | null | undefined, fallback = 'Manager') {
    const fullName = `${String(user?.first_name || '').trim()} ${String(user?.last_name || '').trim()}`.trim();
    const displayName = fullName || String(user?.full_name || user?.username || user?.role || fallback).trim() || fallback;
    return displayName;
}

interface AnalyticsCounts {
    total_users: number;
    total_projects: number;
    total_clients: number;
    tasks_total: number;
    tasks_pending: number;
    tasks_in_progress: number;
    tasks_completed: number;
    payroll_pending: number;
}

interface TrendPoint { date: string; created: number; completed: number }

interface TaskDistribution { pending: number; in_progress: number; completed: number; total: number }

const EMPTY_DISTRIBUTION: TaskDistribution = { pending: 0, in_progress: 0, completed: 0, total: 0 };

type ChartPeriod = 'week' | 'month' | 'year';

function formatTrendLabel(value: string, period: ChartPeriod): string {
    // Monthly buckets arrive as 'Y-m'; daily buckets as 'Y-m-d'.
    if (/^\d{4}-\d{2}$/.test(value)) {
        const parsed = new Date(`${value}-01T00:00:00`);
        if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString(undefined, { month: 'short' });
        return value;
    }
    const parsed = new Date(`${value}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return value;
    if (period === 'month') return parsed.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return parsed.toLocaleDateString(undefined, { weekday: 'short' });
}

function currentYearMonth(): string {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function lastTwelveMonths(): Array<{ value: string; label: string; short: string }> {
    const out: Array<{ value: string; label: string; short: string }> = [];
    const cursor = new Date();
    cursor.setDate(1);
    for (let i = 0; i < 12; i++) {
        const value = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
        out.push({
            value,
            label: cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
            short: cursor.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
        });
        cursor.setMonth(cursor.getMonth() - 1);
    }
    return out;
}

function recentYears(count = 6): string[] {
    const current = new Date().getFullYear();
    return Array.from({ length: count }, (_, i) => String(current - i));
}

function periodHintText(period: ChartPeriod, month: string, year: string): string {
    if (period === 'month') {
        const parsed = new Date(`${month}-01T00:00:00`);
        if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        return 'Selected Month';
    }
    if (period === 'year') return year;
    return 'Last 7 Days';
}

interface TaskCommentRow {
    comment_id: number;
    task_id: number;
    comment_text: string | null;
    attachment_name?: string | null;
    attachment_path?: string | null;
    commenter_name?: string | null;
    commenter_role?: string | null;
    created_at?: string | null;
}

// Calendar utils
function buildMonth(year: number, month: number) {
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    const startDay = first.getDay();
    const daysInMonth = last.getDate();
    const cells: (number | null)[] = [];
    for (let i = 0; i < startDay; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks: (number | null)[][] = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function CalendarMini({
    events = {},
    onDayClick,
}: {
    events?: Record<string, { start?: boolean; end?: boolean; projectIds: number[] }>;
    onDayClick?: (date: string) => void;
}) {
    const today = new Date();
    const [y, setY] = useState(today.getFullYear());
    const [m, setM] = useState(today.getMonth());
    const weeks = buildMonth(y, m);
    const monthName = new Date(y, m, 1).toLocaleString(undefined, { month: 'long', year: 'numeric' });
    const isToday = (d: number | null) => d !== null && y === today.getFullYear() && m === today.getMonth() && d === today.getDate();

    const prevMonth = () => { const nm = m - 1; if (nm < 0) { setM(11); setY(y - 1); } else { setM(nm); } };
    const nextMonth = () => { const nm = m + 1; if (nm > 11) { setM(0); setY(y + 1); } else { setM(nm); } };
    const prevYear = () => setY(y - 1);
    const nextYear = () => setY(y + 1);

    const dayCell = (d: number | null, i: number) => {
        const dateStr = d ? `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
        const ev = dateStr ? (events as any)[dateStr] : undefined;
        const clickable = !!(ev && ev.projectIds && ev.projectIds.length);
        return (
            <div key={i}
                onClick={() => clickable && onDayClick && onDayClick(dateStr)}
                style={{ textAlign: 'center', padding: '4px 0', borderRadius: 4, background: isToday(d) ? 'rgba(0,0,0,0.06)' : 'transparent', fontWeight: isToday(d) ? 700 as any : 400 as any, cursor: clickable ? 'pointer' : 'default', position: 'relative' }}>
                {d ?? ''}
                {ev && (
                    <div style={{ position: 'absolute', left: '50%', bottom: 2, transform: 'translateX(-50%)', display: 'flex', gap: 3 }}>
                        {ev.start && <span style={{ width: 6, height: 6, background: '#22c55e', borderRadius: '50%' }} />}
                        {ev.end && <span style={{ width: 6, height: 6, background: '#ef4444', borderRadius: '50%' }} />}
                    </div>
                )}
            </div>
        );
    };

    return (
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', color: '#111827', borderRadius: 8, padding: 8 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button onClick={prevYear} title="Prev Year" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 4, padding: '0 4px', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>«</button>
                    <button onClick={prevMonth} title="Prev Month" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 4, padding: '0 4px', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>‹</button>
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, textAlign: 'center', minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{monthName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                    <button onClick={nextMonth} title="Next Month" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 4, padding: '0 4px', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>›</button>
                    <button onClick={nextYear} title="Next Year" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 4, padding: '0 4px', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>»</button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, fontSize: 10 }}>
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (<div key={i} style={{ textAlign: 'center', opacity: 0.8 }}>{d}</div>))}
                {weeks.flat().map((d, i) => dayCell(d, i))}
            </div>
        </div>
    );
}

export default function ManagerDashboard() {
    const router = useRouter();
    const { user, loading: authLoading, logout } = useProtectedPage({
        allowedRoles: ['manager'],
        unauthorizedRedirect: '/403',
    });
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [loading, setLoading] = useState(true);
    const [counts, setCounts] = useState<AnalyticsCounts | null>(null);
    const [trend, setTrend] = useState<TrendPoint[]>([]);
    const [distribution, setDistribution] = useState<TaskDistribution>(EMPTY_DISTRIBUTION);
    // Each analytics card has its own independent window: changing one card
    // never touches the other.
    const [trendPeriod, setTrendPeriod] = useState<ChartPeriod>('week');
    const [trendMonth, setTrendMonth] = useState<string>(() => currentYearMonth());
    const [trendYear, setTrendYear] = useState<string>(() => String(new Date().getFullYear()));
    const [distPeriod, setDistPeriod] = useState<ChartPeriod>('week');
    const [distMonth, setDistMonth] = useState<string>(() => currentYearMonth());
    const [distYear, setDistYear] = useState<string>(() => String(new Date().getFullYear()));
    const initialLoadRef = useRef(true);
    const monthOptions = useMemo(() => lastTwelveMonths(), []);
    const yearOptions = useMemo(() => recentYears(6), []);
    const trendHint = periodHintText(trendPeriod, trendMonth, trendYear);
    const distHint = periodHintText(distPeriod, distMonth, distYear);

    const buildWindowQuery = (period: ChartPeriod, month: string, year: string) =>
        period === 'month'
            ? `?month=${month}`
            : period === 'year'
                ? `?year=${year}`
                : '?period=week';

    const trendQuery = buildWindowQuery(trendPeriod, trendMonth, trendYear);
    const distQuery = buildWindowQuery(distPeriod, distMonth, distYear);

    // Compact one-line window control. Month/Year are always-visible dropdowns
    // (short labels to fit one line) — picking one switches the card to it.
    const renderWindowControls = (
        period: ChartPeriod,
        month: string,
        year: string,
        onPeriod: (p: ChartPeriod) => void,
        onMonth: (m: string) => void,
        onYear: (y: string) => void,
    ) => (
        <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
            <button
                key="week"
                type="button"
                title="Last 7 Days"
                onClick={() => onPeriod('week')}
                style={{
                    padding: '4px 10px',
                    borderRadius: 8,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    border: period === 'week' ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                    background: period === 'week' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc',
                    color: period === 'week' ? '#1d4ed8' : '#64748b',
                    transition: 'all 0.2s ease',
                }}
            >
                7 Days
            </button>
            <select
                aria-label="Select month"
                title="Filter by month"
                value={period === 'month' ? month : ''}
                onChange={(e) => { onMonth(e.target.value); onPeriod('month'); }}
                style={{ padding: '4px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, maxWidth: 92, color: period === 'month' ? '#1d4ed8' : '#64748b', border: period === 'month' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: period === 'month' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
            >
                <option value="" disabled>Month</option>
                {monthOptions.map((m) => (
                    <option key={m.value} value={m.value}>{m.short}</option>
                ))}
            </select>
            <select
                aria-label="Select year"
                title="Filter by year"
                value={period === 'year' ? year : ''}
                onChange={(e) => { onYear(e.target.value); onPeriod('year'); }}
                style={{ padding: '4px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, maxWidth: 70, color: period === 'year' ? '#1d4ed8' : '#64748b', border: period === 'year' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: period === 'year' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
            >
                <option value="" disabled>Year</option>
                {yearOptions.map((y) => (
                    <option key={y} value={y}>{y}</option>
                ))}
            </select>
        </span>
    );
    const [lineTrendAnimated, setLineTrendAnimated] = useState(false);
    const [projects, setProjects] = useState<any[]>([]);
    const [services, setServices] = useState<any[]>([]);
    const [dateEvents, setDateEvents] = useState<DashboardCalendarEventMap>({});
    const [calendarOpen, setCalendarOpen] = useState(false);
    const [dateModalOpen, setDateModalOpen] = useState(false);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [dateTasks, setDateTasks] = useState<any[]>([]);
    const [loadingTasks, setLoadingTasks] = useState(false);
    const [dateTasksPage, setDateTasksPage] = useState(1);
    const [staff, setStaff] = useState<any[]>([]);
    const bannerWelcomeName = getBannerWelcomeName(user);

    const [documentSummary, setDocumentSummary] = useState(() => getProfileDocumentSummary(null));
    const [documentsLoaded, setDocumentsLoaded] = useState(false);

    const fetchWindowAnalytics = async (query: string) => {
        try {
            const res = await fetch(`${API_BASE}/analytics.php${query}`, { credentials: 'include' });
            const d = await res.json();
            if (d?.success) return d;
        } catch { /* silently ignored – background refresh */ }
        return null;
    };

    // Refresh both cards' windows (used by focus/sync handlers).
    const refreshWindowAnalytics = async () => {
        const [trendRes, distRes] = await Promise.all([
            fetchWindowAnalytics(trendQuery),
            fetchWindowAnalytics(distQuery),
        ]);
        if (trendRes) {
            setCounts(trendRes.data.counts);
            setTrend(trendRes.data.trend || []);
        }
        if (distRes) {
            setDistribution({ ...EMPTY_DISTRIBUTION, ...(distRes.data.distribution || {}) });
        }
    };

    // Silent background refresh for live-sync.
    const silentRefreshManager = useCallback(async () => {
        if (String(user?.role || '').toLowerCase() !== 'manager') return;
        const [trendRes, distRes] = await Promise.all([
            fetchWindowAnalytics(trendQuery),
            fetchWindowAnalytics(distQuery),
        ]);
        if (trendRes) {
            setCounts(trendRes.data.counts);
            setTrend(trendRes.data.trend || []);
        }
        if (distRes) {
            setDistribution({ ...EMPTY_DISTRIBUTION, ...(distRes.data.distribution || {}) });
        }
        await Promise.all([
            fetchProjectsAndServices(),
            fetchStaff(),
        ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.role, trendQuery, distQuery]);

    useLiveSync(silentRefreshManager);

    // The dashboard bootstrap is intentionally keyed to session readiness.
    useEffect(() => {
        if (String(user?.role || '').toLowerCase() !== 'manager') {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }

        let active = true;

        const loadDashboard = async () => {
            // Full-page spinner only on the very first load — switching windows
            // refreshes the charts live in the background instead.
            if (initialLoadRef.current) setLoading(true);
            try {
                await Promise.all([
                    fetchWindowAnalytics(trendQuery).then((d) => {
                        if (d) {
                            setCounts(d.data.counts);
                            setTrend(d.data.trend || []);
                        }
                    }),
                    fetchWindowAnalytics(distQuery).then((d) => {
                        if (d) setDistribution({ ...EMPTY_DISTRIBUTION, ...(d.data.distribution || {}) });
                    }),
                    fetchProjectsAndServices(),
                    fetchProfileDocumentSummary(Number(user?.id || 0)),
                    fetchStaff(),
                ]);
            } finally {
                if (active) {
                    setLoading(false);
                    initialLoadRef.current = false;
                }
            }
        };

        void loadDashboard();

        return () => {
            active = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authLoading, user?.id, user?.role]);

    // Analytics-only live refresh for each card's own window. Never touches
    // the page spinner, so switching windows updates the charts in place.
    useEffect(() => {
        if (String(user?.role || '').toLowerCase() !== 'manager') return;
        let active = true;
        fetchWindowAnalytics(trendQuery).then((d) => {
            if (!active || !d) return;
            setCounts(d.data.counts);
            setTrend(d.data.trend || []);
        });
        fetchWindowAnalytics(distQuery).then((d) => {
            if (!active || !d) return;
            setDistribution({ ...EMPTY_DISTRIBUTION, ...(d.data.distribution || {}) });
        });
        return () => {
            active = false;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [trendQuery, distQuery, user?.role]);

    const buildEventsFromProjects = async (list: any[]) => {
        const map: DashboardCalendarEventMap = {};
        const activeList = list.filter((p: any) => p.status !== 'archived');
        for (const p of activeList) {
            if (p.start_date) {
                const sd = new Date(p.start_date);
                const k = `${sd.getFullYear()}-${String(sd.getMonth() + 1).padStart(2, '0')}-${String(sd.getDate()).padStart(2, '0')}`;
                map[k] = map[k] || { projectIds: [] };
                map[k].start = true;
                if (!map[k].projectIds.includes(p.id)) map[k].projectIds.push(p.id);
            }
            if (p.end_date) {
                const ed = new Date(p.end_date);
                const k2 = `${ed.getFullYear()}-${String(ed.getMonth() + 1).padStart(2, '0')}-${String(ed.getDate()).padStart(2, '0')}`;
                map[k2] = map[k2] || { projectIds: [] };
                map[k2].end = true;
                if (!map[k2].projectIds.includes(p.id)) map[k2].projectIds.push(p.id);
            }
        }
        try {
            const mgmt = await fetchManagementCalendarMaps(getApiBaseUrl());
            setDateEvents(mergeDashboardCalendarMaps(map, mgmt));
        } catch {
            setDateEvents(map);
        }
    };

    const fetchProjectsAndServices = async () => {
        try {
            const [pRes, sRes] = await Promise.all([
                fetch(`${API_BASE}/projects.php`, { credentials: 'include' }),
                fetch(`${API_BASE}/services.php?checklists=1`, { credentials: 'include' })
            ]);
            const p = await pRes.json();
            const s = await sRes.json();
            if (p.success) { setProjects(p.data); void buildEventsFromProjects(p.data); }
            if (s.success) setServices(s.data);
        } catch (e) { /* noop */ }
    };

    const fetchStaff = async () => {
        try {
            const res = await fetch(`${API_BASE}/users.php`, { credentials: 'include' });
            const d = await res.json();
            if (d.success) setStaff(d.data);
        } catch { /* noop */ }
    };

    const fetchProfileDocumentSummary = async (userId: number) => {
        if (userId <= 0) {
            setDocumentSummary(getProfileDocumentSummary(null));
            setDocumentsLoaded(false);
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/users.php?id=${userId}`, { credentials: 'include' });
            const d = await res.json();
            if (!res.ok || !d.success) {
                setDocumentSummary(getProfileDocumentSummary(null));
                setDocumentsLoaded(false);
                return;
            }

            setDocumentSummary(getProfileDocumentSummary((d.data || null) as ProfileDocumentStatusRecord | null));
            setDocumentsLoaded(true);
        } catch {
            setDocumentSummary(getProfileDocumentSummary(null));
            setDocumentsLoaded(false);
        }
    };

    const normalizeAssignableRole = (candidate: any) => String(candidate?.role || '').trim().toLowerCase();
    const dedupeAssignableUsers = (items: any[]) => items.filter((candidate: any, index: number, arr: any[]) => {
        return arr.findIndex((entry: any) => String(entry?.id) === String(candidate?.id)) === index;
    });
    const managerBranchId = Number(user?.branch_id || 0);
    const assignableStaffOptions = staff.filter((candidate: any) => {
        return normalizeAssignableRole(candidate) === 'staff'
            && managerBranchId > 0
            && Number(candidate?.branch_id || 0) === managerBranchId;
    });
    const resolveTaskAssigneeOptions = (selectedUserId?: string | number | null) => {
        const options = [...assignableStaffOptions];
        const selectedKey = String(selectedUserId || '').trim();
        if (selectedKey && !options.some((candidate: any) => String(candidate?.id) === selectedKey)) {
            const legacyAssignee = staff.find((candidate: any) => String(candidate?.id) === selectedKey)
                || { id: selectedKey, first_name: 'Current', last_name: `assignee #${selectedKey}`, role: 'staff' };
            options.unshift(legacyAssignee);
        }
        return dedupeAssignableUsers(options);
    };

    const formatTaskLabel = (t: any) => {
        if (!t?.title) return '';
        try {
            for (const sv of services) {
                if (sv.checklists) {
                    const found = sv.checklists.find((cl: any) => cl.task_name === t.title);
                    if (found) return `${sv.service_name}: ${found.task_name}`;
                }
            }
        } catch { /* ignore */ }
        return t.title;
    };

    const openTasksForDate = async (dateStr: string) => {
        setSelectedDate(dateStr);
        const ev = dateEvents[dateStr];
        const hasMgmt = !!((ev?.managementDots?.length || 0) > 0);
        const hasProj = !!((ev?.projectIds?.length || 0) > 0);
        if (!ev || (!hasProj && !hasMgmt)) { setDateTasks([]); setDateModalOpen(true); return; }
        if (!hasProj) { setDateTasks([]); setDateModalOpen(true); return; }
        setLoadingTasks(true);
        try {
            const results = await Promise.all(ev.projectIds.map((pid) => fetch(`${API_BASE}/tasks.php?project_id=${pid}`, { credentials: 'include' }).then(r => r.json())));
            const tasks = results.filter(r => r.success).flatMap(r => r.data || []);
            setDateTasks(tasks);
        } catch { setDateTasks([]); }
        finally { setLoadingTasks(false); setDateModalOpen(true); }
    };

    const paginatedDateTasks = dateTasks.slice((dateTasksPage - 1) * ITEMS_PER_PAGE, dateTasksPage * ITEMS_PER_PAGE);

    useEffect(() => {
        const refresh = () => {
            void refreshWindowAnalytics();
            fetchProjectsAndServices();
            fetchProfileDocumentSummary(Number(user?.id || 0));
        };
        const onFocus = () => { refresh(); };
        const onVis = () => { if (!document.hidden) refresh(); };
        window.addEventListener('focus', onFocus);
        document.addEventListener('visibilitychange', onVis);
        return () => {
            window.removeEventListener('focus', onFocus);
            document.removeEventListener('visibilitychange', onVis);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]);

    useEffect(() => {
        setDateTasksPage(1);
    }, [selectedDate, dateModalOpen]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(dateTasks.length / ITEMS_PER_PAGE));
        if (dateTasksPage > totalPages) setDateTasksPage(totalPages);
    }, [dateTasks.length, dateTasksPage]);

    // Live-sync task list/calendar when documents auto-complete tasks.
    useEffect(() => {
        const syncTaskViews = () => {
            void refreshWindowAnalytics();
            fetchProjectsAndServices();
            fetchProfileDocumentSummary(Number(user?.id || 0));
            if (dateModalOpen && selectedDate) {
                openTasksForDate(selectedDate);
            }
        };

        const onCustomSync = () => syncTaskViews();
        const onStorageSync = (event: StorageEvent) => {
            if (event.key === 'capstone_tasks_sync') {
                syncTaskViews();
            }
        };

        window.addEventListener('capstone:tasks-sync', onCustomSync as EventListener);
        window.addEventListener('storage', onStorageSync);

        return () => {
            window.removeEventListener('capstone:tasks-sync', onCustomSync as EventListener);
            window.removeEventListener('storage', onStorageSync);
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [dateModalOpen, selectedDate, user?.id]);

    const trendPointCount = Math.max(1, trend.length);
    const snakePointDelay = Math.max(80, Math.floor(900 / trendPointCount));
    const shouldAnimateTrendLine = trend.length > 0 && !lineTrendAnimated;

    if (authLoading || loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role="manager" user={user} onLogout={logout}>
            <Head>
                <title>Manager Dashboard</title>
            </Head>

            <div style={{ display: 'grid', gap: 10, padding: '12px 16px', maxWidth: 1520, width: '100%', margin: '0 auto', overflowX: 'hidden', boxSizing: 'border-box' }}>
            {/* Analytics Overview (compact sizing matched to admin dashboard) */}
            <div className={styles.banner}>
                <div className={styles.bannerOverlay}></div>
                <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '4px' }}>
                    <div style={{ padding: '14px 14px', flex: '0 1 255px', minWidth: 220, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignSelf: 'stretch', borderRadius: 14, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.22)' }}>
                        <div style={{ alignSelf: 'flex-start', padding: '3px 9px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.28)', color: '#dbeafe', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                            Manager Dashboard
                        </div>
                        <h1 style={{ margin: 0, fontSize: 'clamp(18px, 1.75vw, 24px)', fontWeight: 900, lineHeight: 1.12, letterSpacing: '0.02em', maxWidth: 245, textAlign: 'left' }}>Welcome, {bannerWelcomeName}!</h1>
                        <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.85)', fontSize: 12, lineHeight: 1.35, maxWidth: 240 }}>
                            Here&apos;s what&apos;s happening with your system today.
                        </p>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, padding: 0, flex: '1 1 500px', justifyContent: 'flex-end', flexWrap: 'wrap', maxWidth: '100%' }}>
                        <div style={{ flex: '1 1 auto', maxWidth: '100%', minWidth: 280, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(90px, 1fr))', gap: '8px' }}>
                            {[
                                {
                                    label: 'Total Users',
                                    value: counts?.total_users ?? '-',
                                    color: '#1e3a8a',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
                                    route: '/users',
                                },
                                {
                                    label: 'Pending Tasks',
                                    value: counts?.tasks_pending ?? '-',
                                    color: '#fbbf24',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>,
                                    route: '/my-tasks',
                                },
                                {
                                    label: 'Completed Tasks',
                                    value: counts?.tasks_completed ?? '-',
                                    color: '#1e3a8a',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
                                    route: '/my-tasks',
                                },
                                {
                                    label: 'Payroll Pending',
                                    value: counts?.payroll_pending ?? '-',
                                    color: '#fbbf24',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>,
                                    route: '/payroll-management',
                                },
                                {
                                    label: 'Projects',
                                    value: counts?.total_projects ?? '-',
                                    color: '#1e3a8a',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>,
                                    route: '/projects',
                                },
                                {
                                    label: 'Clients',
                                    value: counts?.total_clients ?? '-',
                                    color: '#fbbf24',
                                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="2" ry="2"></rect><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"></path></svg>,
                                    route: '/clients',
                                },
                            ].map((item) => (
                                <div
                                    key={item.label}
                                    className={styles.statsCard}
                                    onClick={() => router.push(item.route)}
                                    style={{ minWidth: 0, padding: '6px', cursor: 'pointer', transition: 'all 0.2s ease' }}
                                    onMouseEnter={(e) => {
                                        e.currentTarget.style.transform = 'translateY(-2px)';
                                        e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
                                    }}
                                    onMouseLeave={(e) => {
                                        e.currentTarget.style.transform = 'translateY(0)';
                                        e.currentTarget.style.boxShadow = '';
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
                                        <div className={styles.statsIconBox} style={{ background: item.color, width: 32, height: 32, fontSize: 12, flexShrink: 0 }}>
                                            {item.icon}
                                        </div>
                                        <div style={{ minWidth: 0 }}>
                                            <h2 style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#111827', lineHeight: 1.1 }} className="llb-tabular">{item.value}</h2>
                                            <p style={{ margin: '2px 0 0 0', color: '#6b7280', fontSize: '10px', lineHeight: 1.2 }}>{item.label}</p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                        <div style={{ flex: '0 0 200px', width: 200, height: 200, display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
                            <DashboardClock
                                onExpandCalendar={() => setCalendarOpen(true)}
                                events={dateEvents}
                                onDayClick={(d) => openTasksForDate(d)}
                                theme="light"
                            />
                        </div>
                    </div>
                </div>
            </div>

            {/* Charts Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '10px' }}>
                <div style={{ background: '#ffffff', padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minHeight: 260, display: 'flex', flexDirection: 'column' }}>
                    <h3 style={{ margin: '0 0 12px 0', color: '#111827', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                            Task Distribution ({distHint})
                        </span>
                        {renderWindowControls(distPeriod, distMonth, distYear, setDistPeriod, setDistMonth, setDistYear)}
                    </h3>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 30, paddingLeft: 8, paddingRight: 8 }}>
                        {/* Left side: Legend with labels */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: '0 0 auto', marginLeft: 72 }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#f59e0b', border: '2px solid #fcd34d' }}></div>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Pending</span>
                                </div>
                                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distribution.pending}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#2563eb', border: '2px solid #93c5fd' }}></div>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>In Progress</span>
                                </div>
                                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distribution.in_progress}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#10b981', border: '2px solid #6ee7b7' }}></div>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Completed</span>
                                </div>
                                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distribution.completed}</div>
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 14, height: 14, borderRadius: '50%', background: '#ef4444', border: '2px solid #fca5a5' }}></div>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Cancelled</span>
                                </div>
                                <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>
                                    {Math.max(0, distribution.total - distribution.pending - distribution.in_progress - distribution.completed)}
                                </div>
                            </div>
                        </div>
                        {/* Right side: Pie chart */}
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', maxWidth: 200, marginRight: 20 }}>
                            <div style={{ width: '100%', aspectRatio: '1' }}>
                                <Doughnut
                                    data={{
                                        labels: ['Pending', 'In Progress', 'Completed', 'Cancelled'],
                                        datasets: [{
                                            data: [
                                                distribution.pending,
                                                distribution.in_progress,
                                                distribution.completed,
                                                Math.max(0, distribution.total - distribution.pending - distribution.in_progress - distribution.completed)
                                            ],
                                            backgroundColor: ['#f59e0b', '#2563eb', '#10b981', '#ef4444'],
                                            borderColor: ['#fcd34d', '#93c5fd', '#6ee7b7', '#fca5a5'],
                                            borderWidth: 2,
                                            hoverOffset: 8,
                                            spacing: 2,
                                        }]
                                    }}
                                    options={{
                                        responsive: true,
                                        maintainAspectRatio: true,
                                        cutout: '68%',
                                        plugins: {
                                            legend: {
                                                display: false,
                                            },
                                            tooltip: {
                                                backgroundColor: 'rgba(17,24,39,0.95)',
                                                titleFont: { size: 12, weight: 'bold' },
                                                bodyFont: { size: 11 },
                                                padding: 10,
                                                cornerRadius: 8,
                                                callbacks: {
                                                    label: (ctx: any) => {
                                                        const total = ctx.dataset.data.reduce((a: number, b: number) => a + b, 0);
                                                        const pct = total ? ((ctx.raw / total) * 100).toFixed(1) : '0';
                                                        return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
                                                    }
                                                }
                                            },
                                            datalabels: {
                                                color: '#fff',
                                                font: {
                                                    weight: 'bold',
                                                    size: 16,
                                                },
                                                formatter: (value: number) => {
                                                    return value > 0 ? value : '';
                                                },
                                            },
                                        },
                                        animation: {
                                            animateRotate: true,
                                            animateScale: true,
                                            duration: 1200,
                                            easing: 'easeOutQuart'
                                        }
                                    }}
                                />
                            </div>
                            <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                                <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{distribution.total}</div>
                                <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>Total Tasks</div>
                            </div>
                        </div>
                    </div>
                </div>

                <div style={{ background: '#ffffff', padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minHeight: 210, display: 'flex', flexDirection: 'column' }}>
                    <h3 style={{ margin: '0 0 12px 0', color: '#111827', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'space-between' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                            Task Activity Trends ({trendHint})
                        </span>
                        {renderWindowControls(trendPeriod, trendMonth, trendYear, setTrendPeriod, setTrendMonth, setTrendYear)}
                    </h3>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                        <div style={{ color: '#6b7280', fontSize: '11px' }}>Task creation &amp; completion over time</div>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '11px', fontWeight: 600, color: '#111827' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#2563eb' }}></span>
                                Created
                            </span>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
                                <span style={{ width: '10px', height: '10px', borderRadius: '50%', backgroundColor: '#16a34a' }}></span>
                                Completed
                            </span>
                        </span>
                    </div>
                    <div style={{ flex: 1, minHeight: 0 }}>
                        <Line
                            data={{
                                labels: trend.map(t => formatTrendLabel(t.date, trendPeriod)),
                                datasets: [
                                    {
                                        label: 'Created',
                                        data: trend.map(t => t.created),
                                        borderColor: '#2563eb',
                                        backgroundColor: 'rgba(37,99,235,0.08)',
                                        fill: true,
                                        tension: 0.4,
                                        pointRadius: 3,
                                        pointHoverRadius: 5,
                                        pointBackgroundColor: '#2563eb',
                                        pointBorderColor: '#fff',
                                        pointBorderWidth: 1.5,
                                        borderWidth: 2,
                                    },
                                    {
                                        label: 'Completed',
                                        data: trend.map(t => t.completed),
                                        borderColor: '#16a34a',
                                        backgroundColor: 'rgba(22,163,74,0.08)',
                                        fill: true,
                                        tension: 0.4,
                                        pointRadius: 3,
                                        pointHoverRadius: 5,
                                        pointBackgroundColor: '#16a34a',
                                        pointBorderColor: '#fff',
                                        pointBorderWidth: 1.5,
                                        borderWidth: 2,
                                    }
                                ]
                            }}
                            options={{
                                responsive: true,
                                maintainAspectRatio: false,
                                interaction: { mode: 'index', intersect: false },
                                plugins: {
                                    legend: {
                                        display: false
                                    },
                                    tooltip: {
                                        backgroundColor: 'rgba(17,24,39,0.9)',
                                        titleFont: { size: 12, weight: 'bold' },
                                        bodyFont: { size: 11 },
                                        padding: 8,
                                        cornerRadius: 6
                                    }
                                },
                                scales: {
                                    x: {
                                        grid: { display: false },
                                        ticks: { font: { size: 10, weight: 'bold' }, color: '#6b7280' }
                                    },
                                    y: {
                                        beginAtZero: true,
                                        ticks: {
                                            stepSize: 1,
                                            font: { size: 10 },
                                            color: '#6b7280'
                                        },
                                        grid: { color: 'rgba(0,0,0,0.04)' }
                                    }
                                },
                                animation: {
                                    duration: shouldAnimateTrendLine ? (trend.length * snakePointDelay * 2) + 300 : 0,
                                    easing: 'linear',
                                    onComplete: () => {
                                        if (shouldAnimateTrendLine) setLineTrendAnimated(true);
                                    }
                                },
                                animations: shouldAnimateTrendLine ? {
                                    x: {
                                        type: 'number',
                                        easing: 'linear',
                                        duration: snakePointDelay,
                                        from: NaN,
                                        delay: (ctx: any) => {
                                            if (ctx.type !== 'data' || ctx.mode !== 'default') return 0;
                                            if (ctx.xStarted) return 0;
                                            ctx.xStarted = true;
                                            return ((ctx.datasetIndex * trend.length) + ctx.dataIndex) * snakePointDelay;
                                        }
                                    },
                                    y: {
                                        type: 'number',
                                        easing: 'linear',
                                        duration: snakePointDelay,
                                        from: (ctx: any) => {
                                            if (ctx.type !== 'data' || ctx.mode !== 'default') return 0;
                                            const yScale = ctx.chart.scales.y;
                                            if (ctx.dataIndex === 0) return yScale.getPixelForValue(0);
                                            const prev = ctx.chart.getDatasetMeta(ctx.datasetIndex).data[ctx.dataIndex - 1];
                                            return prev ? prev.getProps(['y'], true).y : yScale.getPixelForValue(0);
                                        },
                                        delay: (ctx: any) => {
                                            if (ctx.type !== 'data' || ctx.mode !== 'default') return 0;
                                            if (ctx.yStarted) return 0;
                                            ctx.yStarted = true;
                                            return ((ctx.datasetIndex * trend.length) + ctx.dataIndex) * snakePointDelay;
                                        }
                                    }
                                } : {}
                            }}
                        />
                    </div>
                </div>
            </div>

            <ActivityLogsPanel />
            {dateModalOpen && (() => {
                const mgmt = selectedDate ? dateEvents[selectedDate]?.managementDots || [] : [];
                return (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ width: '90%', maxWidth: 900, background: 'white', borderRadius: 10, padding: 12, boxShadow: '0 10px 25px rgba(0,0,0,0.2)', maxHeight: '86vh', overflow: 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                            <div style={{ fontWeight: 700, color: '#111827' }}>Details for {selectedDate}</div>
                            <button onClick={() => setDateModalOpen(false)} style={{ background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}>Close</button>
                        </div>
                        {mgmt.length > 0 && (
                            <div style={{ marginBottom: 10, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                                <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0ea5e9', display: 'inline-block' }} />
                                    Calendar Management
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {mgmt.map((dot: any, idx: number) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155', background: 'white', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px' }}>
                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot.color, flexShrink: 0, display: 'inline-block' }} />
                                            <span style={{ flex: 1, minWidth: 0 }}>{dot.label}</span>
                                            <span style={{ fontSize: 10, color: dot.kind === 'holiday' ? '#be123c' : dot.kind === 'birthday' ? '#7e22ce' : '#334155', fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 }}>{dot.kind}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {loadingTasks ? (
                            <div style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>Loading tasks...</div>
                        ) : dateTasks.length === 0 ? (
                            <div style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>No tasks for projects on this date.</div>
                        ) : (
                            <>
                            <div style={{ maxHeight: '60vh', overflow: 'auto' }}>
                                <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                    <thead style={{ background: '#f8fafc' }}>
                                        <tr>
                                            <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#4b5563' }}>Task</th>
                                            <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#4b5563' }}>Client</th>
                                            <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#4b5563' }}>Project</th>
                                            <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#4b5563' }}>Status</th>
                                            <th style={{ textAlign: 'left', padding: '8px 10px', fontSize: 12, color: '#4b5563' }}>Due Date</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {paginatedDateTasks.map((t: any) => {
                                            const isDone = t.status === 'completed';
                                            return (
                                                <tr key={t.id} style={{ borderTop: '1px solid #e5e7eb', background: isDone ? 'linear-gradient(90deg, rgba(16,185,129,0.10), rgba(255,255,255,0))' : 'transparent' }}>
                                                    <td style={{ padding: '8px 10px', fontSize: 13, color: '#111827' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                            <span style={{ textDecoration: isDone ? 'line-through' : 'none', color: isDone ? '#6b7280' : '#111827' }}>
                                                                {formatTaskLabel(t)}
                                                            </span>
                                                            {isDone && (
                                                                <span style={{ background: '#10b981', color: '#ffffff', padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, letterSpacing: '0.03em' }}>
                                                                    DONE
                                                                </span>
                                                            )}
                                                        </div>
                                                    </td>
                                                    <td className="llb-trunc" title={t.client_name || '-'} style={{ padding: '8px 10px', fontSize: 12, color: '#6b7280' }}>{t.client_name || '-'}</td>
                                                    <td className="llb-trunc" title={t.project_name} style={{ padding: '8px 10px', fontSize: 12, color: '#6b7280' }}>{t.project_name}</td>
                                                    <td style={{ padding: '8px 10px' }}>
                                                        <span style={{ padding: '4px 8px', borderRadius: 999, background: isDone ? '#dcfce7' : '#f1f5f9', color: isDone ? '#15803d' : '#475569', fontSize: 11, fontWeight: 700 }}>
                                                            {t.workflow_status ? String(t.workflow_status).replace(/_/g, ' ') : (t.status === 'in_progress' ? 'in progress' : t.status || 'not started')}
                                                        </span>
                                                    </td>
                                                    <td style={{ padding: '8px 10px', fontSize: 12, color: '#6b7280' }}>
                                                        {t.due_date ? String(t.due_date).slice(0, 10) : '—'}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                            <Pagination
                                currentPage={dateTasksPage}
                                totalItems={dateTasks.length}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={setDateTasksPage}
                                label="tasks"
                            />
                            </>
                        )}
                    </div>
                </div>
                );
            })()}
            <DashboardCalendarOverlay open={calendarOpen} onClose={() => setCalendarOpen(false)} events={dateEvents} onDayClick={(d) => openTasksForDate(d)} />
            </div>
        </Layout>
    );
}
