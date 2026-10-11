
import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';

import Layout from '../components/Layout';
import Pagination from '../components/Pagination';
import { DashboardClock, DashboardCalendarOverlay, type DashboardCalendarEventMap, fetchManagementCalendarMaps, mergeDashboardCalendarMaps } from '../components/DashboardCalendar';
import styles from '../styles/Layout.module.css';
import { getApiBaseUrl, getBackendBaseUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Line, Doughnut } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartDataLabels
);

interface MySummary { pending: number; in_progress: number; completed: number }
interface ProjectCalendarSource {
    id: number;
    status?: string | null;
    start_date?: string | null;
    end_date?: string | null;
}

interface DashboardTaskRow {
    id: number;
    title: string;
    status: string;
    client_name?: string | null;
    project_name?: string | null;
    due_date?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
}

type TimePeriodFilter = 'week' | 'month' | 'year';

interface TaskTrendData {
    labels: string[];
    created: number[];
    completed: number[];
}

interface TaskTrendApiRow {
    date: string;
    created?: number | null;
    completed?: number | null;
}

interface DashboardCachePayload {
    tasks: DashboardTaskRow[];
    projectCount: number;
    dateEvents: DashboardCalendarEventMap;
    savedAt: number;
}

const API_BASE_URL = getBackendBaseUrl();
const DASHBOARD_CACHE_TTL_MS = 60 * 1000;
const EMPTY_SUMMARY: MySummary = { pending: 0, in_progress: 0, completed: 0 };

function formatDateKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeDateKey(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const directMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (directMatch) {
        return directMatch[1];
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return '';
    }

    return formatDateKey(parsed);
}

function formatDateTime(value: unknown, emptyLabel = '-') {
    const raw = String(value || '').trim();
    if (!raw) return emptyLabel;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function buildProjectDateEvents(projects: ProjectCalendarSource[]): DashboardCalendarEventMap {
    const eventMap: DashboardCalendarEventMap = {};
    const activeProjects = projects.filter((project) => project?.status !== 'archived');

    for (const project of activeProjects) {
        if (project?.start_date) {
            const startDate = new Date(project.start_date);
            const startKey = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
            eventMap[startKey] = eventMap[startKey] || { projectIds: [] };
            eventMap[startKey].start = true;
            if (!eventMap[startKey].projectIds.includes(project.id)) {
                eventMap[startKey].projectIds.push(project.id);
            }
        }

        if (project?.end_date) {
            const endDate = new Date(project.end_date);
            const endKey = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
            eventMap[endKey] = eventMap[endKey] || { projectIds: [] };
            eventMap[endKey].end = true;
            if (!eventMap[endKey].projectIds.includes(project.id)) {
                eventMap[endKey].projectIds.push(project.id);
            }
        }
    }

    return eventMap;
}

function buildTaskSummary(tasks: DashboardTaskRow[]): MySummary {
    return tasks.reduce<MySummary>((summary, task) => {
        if (task.status === 'pending') summary.pending += 1;
        else if (task.status === 'in_progress') summary.in_progress += 1;
        else if (task.status === 'completed') summary.completed += 1;
        return summary;
    }, { ...EMPTY_SUMMARY });
}

function getDashboardCacheKey(userId: number) {
    return `staff-dashboard:${userId}:v1`;
}

function readDashboardCache(userId: number): DashboardCachePayload | null {
    if (typeof window === 'undefined' || userId <= 0) return null;

    try {
        const raw = window.sessionStorage.getItem(getDashboardCacheKey(userId));
        if (!raw) return null;

        const parsed = JSON.parse(raw) as Partial<DashboardCachePayload> | null;
        if (!parsed || !Array.isArray(parsed.tasks) || typeof parsed.projectCount !== 'number' || typeof parsed.savedAt !== 'number') {
            window.sessionStorage.removeItem(getDashboardCacheKey(userId));
            return null;
        }

        if (Date.now() - parsed.savedAt > DASHBOARD_CACHE_TTL_MS) {
            window.sessionStorage.removeItem(getDashboardCacheKey(userId));
            return null;
        }

        return {
            tasks: parsed.tasks as DashboardTaskRow[],
            projectCount: parsed.projectCount,
            dateEvents: parsed.dateEvents && typeof parsed.dateEvents === 'object' ? parsed.dateEvents as DashboardCalendarEventMap : {},
            savedAt: parsed.savedAt,
        };
    } catch {
        return null;
    }
}

function writeDashboardCache(userId: number, payload: Omit<DashboardCachePayload, 'savedAt'>) {
    if (typeof window === 'undefined' || userId <= 0) return;

    try {
        window.sessionStorage.setItem(
            getDashboardCacheKey(userId),
            JSON.stringify({
                ...payload,
                savedAt: Date.now(),
            })
        );
    } catch {
        // Ignore storage failures; the dashboard should continue without cache.
    }
}

function getBannerWelcomeName(user: { first_name?: unknown; last_name?: unknown; full_name?: unknown; username?: unknown; role?: unknown } | null | undefined, fallback = 'User') {
    const fullName = `${String(user?.first_name || '').trim()} ${String(user?.last_name || '').trim()}`.trim();
    const displayName = fullName || String(user?.full_name || user?.username || user?.role || fallback).trim() || fallback;
    return displayName;
}

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
    const monthName = new Date(y, m, 1).toLocaleString(undefined, { month: 'short', year: 'numeric' });
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
                style={{ textAlign: 'center', padding: 0, borderRadius: 3, background: isToday(d) ? 'rgba(0,0,0,0.06)' : 'transparent', fontWeight: isToday(d) ? 700 as any : 400 as any, cursor: clickable ? 'pointer' : 'default', position: 'relative', lineHeight: 1 }}>
                {d ?? ''}
                {ev && (
                    <div style={{ position: 'absolute', left: '50%', bottom: 1, transform: 'translateX(-50%)', display: 'flex', gap: 2 }}>
                        {ev.start && <span style={{ width: 4, height: 4, background: '#22c55e', borderRadius: '50%' }} />}
                        {ev.end && <span style={{ width: 4, height: 4, background: '#ef4444', borderRadius: '50%' }} />}
                    </div>
                )}
            </div>
        );
    };

        return (
        <div style={{ width: 104, height: 104, boxSizing: 'border-box', background: '#ffffff', border: '1px solid #e5e7eb', color: '#111827', borderRadius: 8, padding: 4, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 2, marginBottom: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <button onClick={prevYear} title="Prev Year" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 3, padding: '0 2px', fontSize: 8, cursor: 'pointer', lineHeight: 1.1, flexShrink: 0 }}>«</button>
                    <button onClick={prevMonth} title="Prev Month" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 3, padding: '0 2px', fontSize: 8, cursor: 'pointer', lineHeight: 1.1, flexShrink: 0 }}>‹</button>
                </div>
                <div style={{ fontSize: 8, fontWeight: 700, textAlign: 'center', lineHeight: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{monthName}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                    <button onClick={nextMonth} title="Next Month" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 3, padding: '0 2px', fontSize: 8, cursor: 'pointer', lineHeight: 1.1, flexShrink: 0 }}>›</button>
                    <button onClick={nextYear} title="Next Year" style={{ background: 'transparent', color: '#111827', border: '1px solid #e5e7eb', borderRadius: 3, padding: '0 2px', fontSize: 8, cursor: 'pointer', lineHeight: 1.1, flexShrink: 0 }}>»</button>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, fontSize: 7 }}>
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (<div key={i} style={{ textAlign: 'center', opacity: 0.8 }}>{d}</div>))}
                {weeks.flat().map((d, i) => dayCell(d, i))}
            </div>
        </div>
    );
}

export default function Dashboard() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const { user, loading: authLoading, logout } = useProtectedPage();
    const [myTasks, setMyTasks] = useState<DashboardTaskRow[]>([]);
    const [mySummary, setMySummary] = useState<MySummary>({ pending: 0, in_progress: 0, completed: 0 });
    const [loading, setLoading] = useState(true);

    const [dateEvents, setDateEvents] = useState<DashboardCalendarEventMap>({});
    const [projectCount, setProjectCount] = useState(0);
    const [calendarOpen, setCalendarOpen] = useState(false);
    const [dateModalOpen, setDateModalOpen] = useState(false);
    const [selectedDate, setSelectedDate] = useState<string | null>(null);
    const [dateTasks, setDateTasks] = useState<DashboardTaskRow[]>([]);
    const [loadingDateTasks, setLoadingDateTasks] = useState(false);
    const [dateTasksPage, setDateTasksPage] = useState(1);
    const [timePeriod, setTimePeriod] = useState<TimePeriodFilter>('week');
    const [timeMonth, setTimeMonth] = useState<string>(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    const [timeYear, setTimeYear] = useState<string>(() => String(new Date().getFullYear()));
    const trendQuery = timePeriod === 'month'
        ? `&month=${timeMonth}`
        : timePeriod === 'year'
            ? `&year=${timeYear}`
            : '&period=week';
    const [distPeriod, setDistPeriod] = useState<TimePeriodFilter>('week');
    const [distMonth, setDistMonth] = useState<string>(() => {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    });
    const [distYear, setDistYear] = useState<string>(() => String(new Date().getFullYear()));
    const [taskTrend, setTaskTrend] = useState<TaskTrendData>({ labels: [], created: [], completed: [] });
    const [trendLoading, setTrendLoading] = useState(false);
    const bannerWelcomeName = getBannerWelcomeName(user);

    // Silent background refresh for live-sync (no loading spinner shown).
    const silentRefresh = useCallback(async () => {
        const userId = Number(user?.id || 0);
        if (!userId) return;
        const [tasksResult, projectsResult, managementMap] = await Promise.all([
            fetch(`${API_BASE_URL}/api/tasks.php?assigned_to=${userId}&include_collaborations=1&compact=dashboard`, { credentials: 'include' }).then((r) => r.json()).catch(() => null),
            fetch(`${API_BASE_URL}/api/projects.php?compact=calendar`, { credentials: 'include' }).then((r) => r.json()).catch(() => null),
            fetchManagementCalendarMaps(getApiBaseUrl()).catch(() => ({} as DashboardCalendarEventMap)),
        ]);
        if (tasksResult?.success) {
            const items: DashboardTaskRow[] = Array.isArray(tasksResult.data) ? tasksResult.data : [];
            setMyTasks(items);
            setMySummary(buildTaskSummary(items));
        }
        const projectMap = (projectsResult?.success && Array.isArray(projectsResult.data))
            ? buildProjectDateEvents(projectsResult.data as ProjectCalendarSource[])
            : {};
        if (projectsResult?.success) {
            const projs: ProjectCalendarSource[] = Array.isArray(projectsResult.data) ? projectsResult.data : [];
            setProjectCount(projs.filter((p) => p?.status !== 'archived').length);
        }
        setDateEvents(mergeDashboardCalendarMaps(projectMap, managementMap as DashboardCalendarEventMap));
    }, [user?.id]);

    useLiveSync(silentRefresh);

    useEffect(() => {
        const userId = Number(user?.id || 0);
        if (!userId) {
            if (!authLoading) {
                setMyTasks([]);
                setMySummary({ ...EMPTY_SUMMARY });
                setProjectCount(0);
                setDateEvents({});
                setLoading(false);
            }
            return;
        }

        let active = true;
        const controller = new AbortController();
        const cached = readDashboardCache(userId);

        if (cached) {
            setMyTasks(cached.tasks);
            setMySummary(buildTaskSummary(cached.tasks));
            setProjectCount(cached.projectCount);
            setDateEvents(cached.dateEvents);
            setLoading(false);
        } else {
            setLoading(true);
        }

        const loadDashboard = async () => {
            const [tasksResult, projectsResult, managementMap] = await Promise.all([
                fetch(`${API_BASE_URL}/api/tasks.php?assigned_to=${userId}&include_collaborations=1&compact=dashboard`, {
                    credentials: 'include',
                    signal: controller.signal,
                }).then((res) => res.json()).catch(() => null),
                fetch(`${API_BASE_URL}/api/projects.php?compact=calendar`, {
                    credentials: 'include',
                    signal: controller.signal,
                }).then((res) => res.json()).catch(() => null),
                fetchManagementCalendarMaps(getApiBaseUrl()).catch(() => ({} as DashboardCalendarEventMap)),
            ]);

            if (!active || controller.signal.aborted) return;

            let nextTasks = cached?.tasks ?? [];
            let nextProjectCount = cached?.projectCount ?? 0;
            let nextDateEvents: DashboardCalendarEventMap = cached?.dateEvents ?? {};
            let shouldPersistCache = false;

            if (tasksResult?.success) {
                const items: DashboardTaskRow[] = Array.isArray(tasksResult.data) ? tasksResult.data : [];
                nextTasks = items;
                setMyTasks(items);
                setMySummary(buildTaskSummary(items));
                shouldPersistCache = true;
            } else if (!cached) {
                setMyTasks([]);
                setMySummary({ ...EMPTY_SUMMARY });
                nextTasks = [];
            }

            let projectMap: DashboardCalendarEventMap = {};
            if (projectsResult?.success && Array.isArray(projectsResult.data)) {
                const accessibleProjects: ProjectCalendarSource[] = projectsResult.data as ProjectCalendarSource[];
                nextProjectCount = accessibleProjects.filter((project) => project?.status !== 'archived').length;
                projectMap = buildProjectDateEvents(accessibleProjects);
                setProjectCount(nextProjectCount);
                shouldPersistCache = true;
            } else if (!cached) {
                setProjectCount(0);
                nextProjectCount = 0;
            }
            const merged = mergeDashboardCalendarMaps(projectMap, managementMap as DashboardCalendarEventMap);
            nextDateEvents = merged;
            setDateEvents(merged);

            if (active) {
                if (shouldPersistCache) {
                    writeDashboardCache(userId, {
                        tasks: nextTasks,
                        projectCount: nextProjectCount,
                        dateEvents: nextDateEvents,
                    });
                }
                setLoading(false);
            }
        };

        void loadDashboard();

        return () => {
            active = false;
            controller.abort();
        };
    }, [authLoading, user?.id]);

    // Fetch task trend data for the selected window. Month/Year pin to the
    // chosen calendar month/year via dropdowns; 7 days uses the relative week.
    // Inline spinner only — the page never reloads or flashes.
    const fetchTaskTrend = useCallback(async (userId: number, query: string) => {
        setTrendLoading(true);
        try {
            const response = await fetch(`${API_BASE_URL}/api/analytics.php?user_id=${userId}${query}`, {
                credentials: 'include',
            });
            const result = await response.json();
            
            if (result.success && Array.isArray(result.data?.trend)) {
                const trend = result.data.trend as TaskTrendApiRow[];
                setTaskTrend({
                    labels: trend.map((item) => item.date),
                    created: trend.map((item) => item.created || 0),
                    completed: trend.map((item) => item.completed || 0),
                });
            }
        } catch (error) {
            console.error('Failed to fetch task trend:', error);
        } finally {
            setTrendLoading(false);
        }
    }, []);

    useEffect(() => {
        const userId = Number(user?.id || 0);
        if (userId) {
            fetchTaskTrend(userId, trendQuery);
        }
    }, [user?.id, trendQuery, fetchTaskTrend]);

    const assignmentAnalytics = useMemo(() => {
        const today = new Date();
        const todayKey = formatDateKey(today);
        const nextWeek = new Date(today);
        nextWeek.setDate(today.getDate() + 7);
        const nextWeekKey = formatDateKey(nextWeek);
        const openStatuses = new Set(['pending', 'in_progress']);

        const projectAssignments = new Map<string, number>();
        const clientAssignments = new Map<string, number>();

        let dueToday = 0;
        let overdue = 0;
        let dueNextSevenDays = 0;
        let noDueDate = 0;

        for (const task of myTasks) {
            const projectName = String(task.project_name || '').trim() || 'Unspecified project';
            const clientName = String(task.client_name || '').trim() || 'Unspecified client';
            projectAssignments.set(projectName, (projectAssignments.get(projectName) || 0) + 1);
            clientAssignments.set(clientName, (clientAssignments.get(clientName) || 0) + 1);

            const dueKey = normalizeDateKey(task.due_date);
            if (!dueKey) {
                noDueDate += 1;
                continue;
            }

            const normalizedStatus = String(task.status || '').trim().toLowerCase();
            if (!openStatuses.has(normalizedStatus)) {
                continue;
            }

            if (dueKey === todayKey) {
                dueToday += 1;
                continue;
            }

            if (dueKey < todayKey) {
                overdue += 1;
                continue;
            }

            if (dueKey <= nextWeekKey) {
                dueNextSevenDays += 1;
            }
        }

        const toTopRows = (source: Map<string, number>) => (
            Array.from(source.entries())
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .slice(0, 5)
                .map(([label, count]) => ({ label, count }))
        );

        const completionRate = myTasks.length > 0
            ? Math.round((mySummary.completed / myTasks.length) * 100)
            : 0;

        return {
            completionRate,
            dueNextSevenDays,
            dueToday,
            noDueDate,
            overdue,
            topClients: toTopRows(clientAssignments),
            topProjects: toTopRows(projectAssignments),
            totalOpenTasks: mySummary.pending + mySummary.in_progress,
        };
    }, [mySummary.completed, mySummary.in_progress, mySummary.pending, myTasks]);

    // Premium chart data configuration
    const trendChartData = useMemo(() => ({
        labels: taskTrend.labels.map((date) => {
            // Monthly buckets arrive as 'Y-m'; daily buckets as 'Y-m-d'.
            if (/^\d{4}-\d{2}$/.test(date)) {
                const m = new Date(`${date}-01T00:00:00`);
                return Number.isNaN(m.getTime()) ? date : m.toLocaleDateString('en-US', { month: 'short' });
            }
            const d = new Date(date);
            if (Number.isNaN(d.getTime())) return date;
            if (timePeriod === 'week') {
                return d.toLocaleDateString('en-US', { weekday: 'short' });
            } else if (timePeriod === 'month') {
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            } else {
                return d.toLocaleDateString('en-US', { month: 'short' });
            }
        }),
        datasets: [
            {
                label: 'Tasks Created',
                data: taskTrend.created,
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 7,
                pointBackgroundColor: '#6366f1',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointHoverBackgroundColor: '#6366f1',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3,
            },
            {
                label: 'Tasks Completed',
                data: taskTrend.completed,
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 4,
                pointHoverRadius: 7,
                pointBackgroundColor: '#10b981',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointHoverBackgroundColor: '#10b981',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3,
            },
        ],
    }), [taskTrend, timePeriod]);

    const trendChartOptions = useMemo<ChartOptions<'line'>>(() => ({
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
            mode: 'index' as const,
            intersect: false,
        },
        plugins: {
            legend: {
                display: true,
                position: 'top' as const,
                align: 'end' as const,
                labels: {
                    color: '#94a3b8',
                    font: {
                        size: 12,
                        weight: 'bold',
                    },
                    usePointStyle: true,
                    pointStyle: 'circle',
                    padding: 20,
                },
            },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#f8fafc',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(99, 102, 241, 0.3)',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                titleFont: {
                    size: 13,
                    weight: 'bold',
                },
                bodyFont: {
                    size: 12,
                    weight: 'normal',
                },
                callbacks: {
                    title: (items) => {
                        if (items.length > 0) {
                            const index = items[0].dataIndex;
                            const originalDate = taskTrend.labels[index];
                            return new Date(originalDate).toLocaleDateString('en-US', {
                                weekday: 'long',
                                year: 'numeric',
                                month: 'long',
                                day: 'numeric',
                            });
                        }
                        return '';
                    },
                },
            },
        },
        scales: {
            x: {
                grid: {
                    display: false,
                },
                border: {
                    display: false,
                },
                ticks: {
                    color: '#64748b',
                    font: {
                        size: 11,
                        weight: 'normal',
                    },
                    maxRotation: 0,
                },
            },
            y: {
                beginAtZero: true,
                grid: {
                    color: 'rgba(148, 163, 184, 0.1)',
                    drawBorder: false,
                },
                border: {
                    display: false,
                },
                ticks: {
                    color: '#64748b',
                    font: {
                        size: 11,
                        weight: 'normal',
                    },
                    padding: 8,
                    stepSize: 1,
                },
            },
        },
    }), [taskTrend.labels]);

    // Task Status Distribution (Pie Chart) — scoped to the selected window
    // (7 days, a chosen calendar month, or a chosen calendar year) by task
    // creation date (tasks without a date always count).
    const lastTwelveMonthOptions = useMemo(() => {
        const out: Array<{ value: string; label: string; short: string }> = [];
        const cursor = new Date();
        cursor.setDate(1);
        for (let i = 0; i < 12; i++) {
            const value = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
            out.push({
                value,
                label: cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
                short: cursor.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
            });
            cursor.setMonth(cursor.getMonth() - 1);
        }
        return out;
    }, []);

    const recentYearOptions = useMemo(() => {
        const current = new Date().getFullYear();
        return Array.from({ length: 6 }, (_, i) => String(current - i));
    }, []);

    const distSummary = useMemo(() => {
        const matchesWindow = (createdAt?: string | null): boolean => {
            if (!createdAt) return true;
            const d = new Date(createdAt);
            if (Number.isNaN(d.getTime())) return true;
            if (distPeriod === 'year') {
                return d.getFullYear() === Number(distYear);
            }
            if (distPeriod === 'month') {
                return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === distMonth;
            }
            const start = new Date();
            start.setDate(start.getDate() - 6);
            start.setHours(0, 0, 0, 0);
            return d >= start;
        };
        const inWindow = myTasks.filter((t) => matchesWindow(t.created_at));
        const summary = { completed: 0, in_progress: 0, pending: 0, total: inWindow.length };
        inWindow.forEach((t) => {
            const s = String(t.status || '').toLowerCase();
            if (s === 'completed') summary.completed += 1;
            else if (s === 'in_progress') summary.in_progress += 1;
            else summary.pending += 1;
        });
        return summary;
    }, [myTasks, distPeriod, distMonth, distYear]);

    const statusDistributionData = useMemo(() => ({
        labels: ['Completed', 'In Progress', 'Pending'],
        datasets: [
            {
                data: [distSummary.completed, distSummary.in_progress, distSummary.pending],
                backgroundColor: [
                    'rgba(16, 185, 129, 0.85)',  // Emerald
                    'rgba(59, 130, 246, 0.85)',  // Blue
                    'rgba(148, 163, 184, 0.85)', // Slate
                ],
                borderColor: [
                    '#10b981',
                    '#3b82f6',
                    '#94a3b8',
                ],
                borderWidth: 3,
                hoverOffset: 12,
                hoverBorderColor: '#ffffff',
                hoverBorderWidth: 3,
            },
        ],
    }), [distSummary]);

    const statusDistributionOptions = useMemo<ChartOptions<'doughnut'>>(() => ({
        responsive: true,
        maintainAspectRatio: false,
        cutout: '70%',
        interaction: {
            mode: 'point' as const,
            intersect: true,
        },
        plugins: {
            legend: {
                display: false, // Hide legend since we're showing custom labels
            },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#f8fafc',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(99, 102, 241, 0.3)',
                borderWidth: 1,
                padding: 12,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                titleFont: {
                    size: 13,
                    weight: 'bold',
                },
                bodyFont: {
                    size: 12,
                    weight: 'normal',
                },
                callbacks: {
                    label: (context) => {
                        const label = context.label || '';
                        const value = context.parsed || 0;
                        const total = context.dataset.data.reduce((a: number, b: number) => a + b, 0);
                        const percentage = total > 0 ? Math.round((value / total) * 100) : 0;
                        return `${label}: ${value} tasks (${percentage}%)`;
                    },
                },
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
    }), []);

    const openTasksForDate = async (dateStr: string) => {
        setSelectedDate(dateStr);
        const event = dateEvents[dateStr];
        const hasManagement = !!((event?.managementDots?.length || 0) > 0);
        const hasProjects = !!((event?.projectIds?.length || 0) > 0);
        if (!event || (!hasProjects && !hasManagement)) {
            setDateTasks([]);
            setDateModalOpen(true);
            return;
        }
        if (!hasProjects) {
            setDateTasks([]);
            setDateModalOpen(true);
            return;
        }

        setLoadingDateTasks(true);
        try {
            const params = new URLSearchParams();
            params.set('project_ids', event.projectIds.join(','));
            const response = await fetch(`${API_BASE_URL}/api/tasks.php?${params.toString()}`, { credentials: 'include' });
            const result = await response.json();
            setDateTasks(result?.success && Array.isArray(result.data) ? result.data : []);
        } catch {
            setDateTasks([]);
        } finally {
            setLoadingDateTasks(false);
            setDateModalOpen(true);
        }
    };

    const paginatedDateTasks = useMemo(
        () => dateTasks.slice((dateTasksPage - 1) * ITEMS_PER_PAGE, dateTasksPage * ITEMS_PER_PAGE),
        [dateTasks, dateTasksPage]
    );

    useEffect(() => {
        setDateTasksPage(1);
    }, [selectedDate, dateModalOpen]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(dateTasks.length / ITEMS_PER_PAGE));
        if (dateTasksPage > totalPages) setDateTasksPage(totalPages);
    }, [dateTasks.length, dateTasksPage]);

    const getCalendarTaskStatusStyles = (status: string) => {
        if (status === 'completed') {
            return {
                background: '#dcfce7',
                color: '#166534',
            };
        }

        if (status === 'in_progress') {
            return {
                background: '#dbeafe',
                color: '#1e40af',
            };
        }

        return {
            background: '#fef3c7',
            color: '#92400e',
        };
    };

    if (authLoading || loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={user?.role} user={user} onLogout={logout}>
            <Head>
                <title>Dashboard</title>
            </Head>

            <div style={{ display: 'grid', gap: 10, padding: '12px 16px', maxWidth: 1520, width: '100%', margin: '0 auto', overflowX: 'hidden', boxSizing: 'border-box' }}>
                {/* Banner (Manager Dashboard style) */}
                <div className={styles.banner}>
                    <div className={styles.bannerOverlay}></div>
                    <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '4px' }}>
                        <div style={{ padding: '14px 14px', flex: '0 1 255px', minWidth: 220, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignSelf: 'stretch', borderRadius: 14, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.22)' }}>
                            <div style={{ alignSelf: 'flex-start', padding: '3px 9px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.28)', color: '#dbeafe', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                                Staff Dashboard
                            </div>
                            <h1 style={{ margin: 0, fontSize: 'clamp(18px, 1.75vw, 24px)', fontWeight: 900, lineHeight: 1.12, letterSpacing: '0.02em', maxWidth: 245, textAlign: 'left' }}>Welcome, {bannerWelcomeName}!</h1>
                            <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.85)', fontSize: 12, lineHeight: 1.35, maxWidth: 240 }}>
                                Here&apos;s your task overview for today.
                            </p>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, padding: 0, flex: '1 1 500px', justifyContent: 'flex-end', flexWrap: 'wrap', maxWidth: '100%' }}>
                            <div style={{ flex: '1 1 auto', maxWidth: '100%', minWidth: 280, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(90px, 1fr))', gap: '8px' }}>
                                {[
                                    {
                                        label: 'Total Tasks',
                                        value: myTasks.length,
                                        color: '#1e3a8a',
                                        route: '/my-tasks',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>,
                                    },
                                    {
                                        label: 'Open Tasks',
                                        value: assignmentAnalytics.totalOpenTasks,
                                        color: '#fbbf24',
                                        route: '/my-tasks',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>,
                                    },
                                    {
                                        label: 'Completed Tasks',
                                        value: mySummary.completed,
                                        color: '#1e3a8a',
                                        route: '/my-tasks',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
                                    },
                                    {
                                        label: 'Due Today',
                                        value: assignmentAnalytics.dueToday,
                                        color: '#fbbf24',
                                        route: '/my-tasks',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>,
                                    },
                                    {
                                        label: 'Overdue',
                                        value: assignmentAnalytics.overdue,
                                        color: assignmentAnalytics.overdue > 0 ? '#ef4444' : '#1e3a8a',
                                        route: '/my-tasks',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path></svg>,
                                    },
                                    {
                                        label: 'Active Projects',
                                        value: projectCount,
                                        color: '#fbbf24',
                                        route: '/projects',
                                        icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>,
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
                                    onDayClick={(date) => openTasksForDate(date)}
                                    theme="light"
                                />
                            </div>
                        </div>
                    </div>
                </div>



                {/* Charts Row */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '10px' }}>
                    <div style={{ background: '#ffffff', padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minHeight: 260, display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ margin: '0 0 12px 0', color: '#111827', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', justifyContent: 'space-between' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
                                Task Distribution
                            </span>
                            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
                                <button
                                    type="button"
                                    title="Last 7 Days"
                                    onClick={() => setDistPeriod('week')}
                                    style={{
                                        padding: '5px 12px',
                                        borderRadius: 8,
                                        fontSize: 11,
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap',
                                        border: distPeriod === 'week' ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                                        background: distPeriod === 'week' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc',
                                        color: distPeriod === 'week' ? '#1d4ed8' : '#64748b',
                                        transition: 'all 0.2s ease',
                                    }}
                                >
                                    7 Days
                                </button>
                                <select
                                    aria-label="Select month"
                                    title="Filter by month"
                                    value={distPeriod === 'month' ? distMonth : ''}
                                    onChange={(e) => { setDistMonth(e.target.value); setDistPeriod('month'); }}
                                    style={{ padding: '5px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, width: 92, color: distPeriod === 'month' ? '#1d4ed8' : '#64748b', border: distPeriod === 'month' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: distPeriod === 'month' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
                                >
                                    <option value="" disabled>Month</option>
                                    {lastTwelveMonthOptions.map((m) => (
                                        <option key={m.value} value={m.value}>{m.short}</option>
                                    ))}
                                </select>
                                <select
                                    aria-label="Select year"
                                    title="Filter by year"
                                    value={distPeriod === 'year' ? distYear : ''}
                                    onChange={(e) => { setDistYear(e.target.value); setDistPeriod('year'); }}
                                    style={{ padding: '5px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, width: 70, color: distPeriod === 'year' ? '#1d4ed8' : '#64748b', border: distPeriod === 'year' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: distPeriod === 'year' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
                                >
                                    <option value="" disabled>Year</option>
                                    {recentYearOptions.map((y) => (
                                        <option key={y} value={y}>{y}</option>
                                    ))}
                                </select>
                            </span>
                        </h3>
                        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 30, paddingLeft: 8, paddingRight: 8 }}>
                            {distSummary.total > 0 ? (
                                <>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, flex: '0 0 auto', marginLeft: 72 }}>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(16, 185, 129, 0.85)', border: '2px solid #10b981' }}></div>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Completed</span>
                                            </div>
                                            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distSummary.completed}</div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(59, 130, 246, 0.85)', border: '2px solid #3b82f6' }}></div>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>In Progress</span>
                                            </div>
                                            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distSummary.in_progress}</div>
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                                <div style={{ width: 14, height: 14, borderRadius: '50%', background: 'rgba(148, 163, 184, 0.85)', border: '2px solid #94a3b8' }}></div>
                                                <span style={{ fontSize: 12, fontWeight: 600, color: '#111827' }}>Pending</span>
                                            </div>
                                            <div style={{ fontSize: 18, fontWeight: 800, color: '#111827', marginLeft: 22 }}>{distSummary.pending}</div>
                                        </div>
                                    </div>
                                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', maxWidth: 200, marginRight: 20 }}>
                                        <div style={{ width: '100%', aspectRatio: '1' }}>
                                            <Doughnut data={statusDistributionData} options={statusDistributionOptions} />
                                        </div>
                                        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                                            <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{distSummary.total}</div>
                                            <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>Total Tasks</div>
                                        </div>
                                    </div>
                                </>
                            ) : (
                                <div style={{ color: '#6b7280', fontSize: 13, width: '100%', textAlign: 'center' }}>No tasks in this period</div>
                            )}
                        </div>
                    </div>

                    <div style={{ background: '#ffffff', padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', boxShadow: '0 1px 4px rgba(0,0,0,0.06)', minHeight: 210, display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ margin: '0 0 2px 0', color: '#111827', fontSize: '13px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'nowrap', justifyContent: 'space-between' }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '6px', whiteSpace: 'nowrap', flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="5" y1="12" x2="19" y2="12"></line><polyline points="12 5 19 12 12 19"></polyline></svg>
                                Task Activity Trends
                            </span>
                            <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap', flexShrink: 0, marginLeft: 'auto' }}>
                                <button
                                    onClick={() => setTimePeriod('week')}
                                    title="Last 7 Days"
                                    style={{
                                        padding: '5px 12px',
                                        borderRadius: 8,
                                        fontSize: 11,
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        whiteSpace: 'nowrap',
                                        border: timePeriod === 'week' ? '1px solid #3b82f6' : '1px solid #e2e8f0',
                                        background: timePeriod === 'week' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc',
                                        color: timePeriod === 'week' ? '#1d4ed8' : '#64748b',
                                        transition: 'all 0.2s ease',
                                    }}
                                >
                                    7 Days
                                </button>
                                <select
                                        aria-label="Select month"
                                        title="Filter by month"
                                        value={timePeriod === 'month' ? timeMonth : ''}
                                        onChange={(e) => { setTimeMonth(e.target.value); setTimePeriod('month'); }}
                                        style={{ padding: '5px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, width: 92, color: timePeriod === 'month' ? '#1d4ed8' : '#64748b', border: timePeriod === 'month' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: timePeriod === 'month' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
                                    >
                                    <option value="" disabled>Month</option>
                                    {lastTwelveMonthOptions.map((m) => (
                                        <option key={m.value} value={m.value}>{m.short}</option>
                                    ))}
                                </select>
                                <select
                                        aria-label="Select year"
                                        title="Filter by year"
                                        value={timePeriod === 'year' ? timeYear : ''}
                                        onChange={(e) => { setTimeYear(e.target.value); setTimePeriod('year'); }}
                                        style={{ padding: '5px 4px', borderRadius: 8, fontSize: 11, fontWeight: 700, width: 70, color: timePeriod === 'year' ? '#1d4ed8' : '#64748b', border: timePeriod === 'year' ? '1px solid #3b82f6' : '1px solid #e2e8f0', background: timePeriod === 'year' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc', cursor: 'pointer', outline: 'none' }}
                                    >
                                    <option value="" disabled>Year</option>
                                    {recentYearOptions.map((y) => (
                                        <option key={y} value={y}>{y}</option>
                                    ))}
                                </select>
                            </span>
                        </h3>
                        <div style={{ color: '#6b7280', fontSize: '11px', marginBottom: 10 }}>Task creation &amp; completion over time</div>
                        <div style={{ flex: 1, minHeight: 0 }}>
                            {trendLoading ? (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', fontSize: 13 }}>
                                    Loading analytics...
                                </div>
                            ) : taskTrend.labels.length > 0 ? (
                                <Line data={trendChartData} options={trendChartOptions} />
                            ) : (
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280', fontSize: 13 }}>
                                    No trend data available
                                </div>
                            )}
                        </div>
                    </div>
                </div>



            </div>
            {dateModalOpen && (() => {
                const mgmt = selectedDate ? dateEvents[selectedDate]?.managementDots || [] : [];
                const mgmtTitles = selectedDate ? dateEvents[selectedDate]?.managementTitles || [] : [];
                return (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ width: '90%', maxWidth: 900, background: 'white', borderRadius: 10, padding: 12, boxShadow: '0 10px 25px rgba(0,0,0,0.2)', maxHeight: '86vh', overflow: 'auto' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, gap: 10 }}>
                            <div style={{ fontWeight: 700, color: '#111827', fontSize: 14 }}>Details for {selectedDate}</div>
                            <button onClick={() => setDateModalOpen(false)} style={{ background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 6, padding: '6px 12px', cursor: 'pointer', fontSize: 13 }}>Close</button>
                        </div>
                        {mgmt.length > 0 && (
                            <div style={{ marginBottom: 12, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                                <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0ea5e9', display: 'inline-block' }} />
                                    Calendar Management
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    {mgmt.map((dot, idx) => (
                                        <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155', background: 'white', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px' }}>
                                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot.color, flexShrink: 0, display: 'inline-block' }} />
                                            <span style={{ flex: 1, minWidth: 0 }}>{dot.label}</span>
                                            <span style={{ fontSize: 10, color: dot.kind === 'holiday' ? '#be123c' : dot.kind === 'birthday' ? '#7e22ce' : '#334155', fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 }}>{dot.kind}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                        {loadingDateTasks ? (
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
                                            {paginatedDateTasks.map((task) => (
                                                <tr key={task.id} style={{ borderTop: '1px solid #e5e7eb' }}>
                                                    <td className="llb-trunc" title={task.title} style={{ padding: '10px', fontSize: 13, color: '#111827', fontWeight: 500 }}>{task.title}</td>
                                                    <td className="llb-trunc" title={task.client_name || '-'} style={{ padding: '10px', fontSize: 12, color: '#6b7280' }}>{task.client_name || '-'}</td>
                                                    <td className="llb-trunc" title={task.project_name || '-'} style={{ padding: '10px', fontSize: 12, color: '#6b7280' }}>{task.project_name || '-'}</td>
                                                    <td style={{ padding: '10px' }}>
                                                        <span style={{ ...getCalendarTaskStatusStyles(task.status), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, textTransform: 'capitalize' }}>
                                                            {String(task.status || 'pending').replace('_', ' ')}
                                                        </span>
                                                    </td>
                                                    <td style={{ padding: '10px', fontSize: 12, color: '#4b5563' }}>
                                                        {formatDateTime(task.due_date)}
                                                    </td>
                                                </tr>
                                            ))}
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
            <DashboardCalendarOverlay
                open={calendarOpen}
                onClose={() => setCalendarOpen(false)}
                events={dateEvents}
                onDayClick={(date) => openTasksForDate(date)}
            />

        </Layout>
    );
}
