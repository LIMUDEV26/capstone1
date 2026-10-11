import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import { getBackendBaseUrl } from '@/utils/network';
import { getRoleFallbackPath } from '@/utils/roleFeatureAccess';
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

interface StaffAnalyticsCounts {
    total_projects: number;
    total_clients: number;
    tasks_total: number;
    tasks_pending: number;
    tasks_in_progress: number;
    tasks_completed: number;
    tasks_due_today: number;
    tasks_overdue: number;
}

type TimePeriodFilter = 'week' | 'month' | 'year';

interface TrendPoint {
    date: string;
    created: number;
    completed: number;
}

interface TrendApiRow {
    date: string;
    created?: number | null;
    completed?: number | null;
}

interface SessionUser {
    id: number;
    role: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    [key: string]: unknown;
}

interface TaskRow {
    id: number;
    status?: string | null;
    due_date?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
}

interface ProjectRow {
    id: number;
    status?: string | null;
    client_id?: number | null;
    client_name?: string | null;
}

interface ApiResponse<T> {
    success?: boolean;
    message?: string;
    data?: T;
}

const API_BASE_URL = getBackendBaseUrl();

function buildEmptyCounts(): StaffAnalyticsCounts {
    return {
        total_projects: 0,
        total_clients: 0,
        tasks_total: 0,
        tasks_pending: 0,
        tasks_in_progress: 0,
        tasks_completed: 0,
        tasks_due_today: 0,
        tasks_overdue: 0,
    };
}

function formatDateKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildSevenDayTrend(): TrendPoint[] {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6);
    const rows: TrendPoint[] = [];

    for (let cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
        rows.push({
            date: formatDateKey(cursor),
            created: 0,
            completed: 0,
        });
    }

    return rows;
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

function isOpenTask(status: unknown) {
    const normalized = String(status || '').trim().toLowerCase();
    return normalized !== 'completed' && normalized !== 'cancelled';
}

function buildStaffAnalytics(tasks: TaskRow[], projects: ProjectRow[]) {
    const counts = buildEmptyCounts();
    const trend = buildSevenDayTrend();
    const trendMap = new Map<string, TrendPoint>(trend.map((row) => [row.date, row]));
    const todayKey = formatDateKey(new Date());

    const activeProjects = projects.filter((project) => String(project?.status || '').toLowerCase() !== 'archived');
    counts.total_projects = activeProjects.length;

    const clientKeys = new Set<string>();
    activeProjects.forEach((project) => {
        const clientId = Number(project?.client_id || 0);
        const clientName = String(project?.client_name || '').trim();
        if (clientId > 0) {
            clientKeys.add(`id:${clientId}`);
        } else if (clientName) {
            clientKeys.add(`name:${clientName.toLowerCase()}`);
        }
    });
    counts.total_clients = clientKeys.size;

    tasks.forEach((task) => {
        const status = String(task?.status || '').trim().toLowerCase();
        counts.tasks_total += 1;

        if (status === 'pending') counts.tasks_pending += 1;
        if (status === 'in_progress') counts.tasks_in_progress += 1;
        if (status === 'completed') counts.tasks_completed += 1;

        const dueKey = normalizeDateKey(task?.due_date);
        if (dueKey && isOpenTask(status)) {
            if (dueKey === todayKey) {
                counts.tasks_due_today += 1;
            } else if (dueKey < todayKey) {
                counts.tasks_overdue += 1;
            }
        }

        const createdKey = normalizeDateKey(task?.created_at);
        if (createdKey && trendMap.has(createdKey)) {
            trendMap.get(createdKey)!.created += 1;
        }

        if (status === 'completed') {
            const completedKey = normalizeDateKey(task?.updated_at);
            if (completedKey && trendMap.has(completedKey)) {
                trendMap.get(completedKey)!.completed += 1;
            }
        }
    });

    return { counts, trend };
}

export default function AnalyticsPage() {
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [counts, setCounts] = useState<StaffAnalyticsCounts>(buildEmptyCounts());
    const [trend, setTrend] = useState<TrendPoint[]>(() => buildSevenDayTrend());
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [timePeriod, setTimePeriod] = useState<TimePeriodFilter>('week');
    const [trendLoading, setTrendLoading] = useState(false);

    useEffect(() => {
        let active = true;

        const init = async () => {
            try {
                const sessionRes = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
                const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;

                if (!sessionData.success || !sessionData.data) {
                    await router.push('/');
                    return;
                }

                if (!active) return;

                const sessionUser = sessionData.data;
                const normalizedRole = String(sessionUser.role || '').trim().toLowerCase();
                setUser(sessionUser);

                if (normalizedRole !== 'staff') {
                    await router.push(getRoleFallbackPath(normalizedRole));
                    return;
                }

                const userId = Number(sessionUser.id || 0);
                if (userId <= 0) {
                    setCounts(buildEmptyCounts());
                    setTrend(buildSevenDayTrend());
                    return;
                }

                const [tasksResult, projectsResult] = await Promise.allSettled([
                    fetch(`${API_BASE_URL}/api/tasks.php?assigned_to=${userId}&include_collaborations=1`, { credentials: 'include' }).then((res) => res.json()),
                    fetch(`${API_BASE_URL}/api/projects.php`, { credentials: 'include' }).then((res) => res.json()),
                ]);

                if (!active) return;

                const loadErrors: string[] = [];
                const tasks = tasksResult.status === 'fulfilled' && tasksResult.value?.success && Array.isArray(tasksResult.value.data)
                    ? (tasksResult.value.data as TaskRow[])
                    : [];
                const projects = projectsResult.status === 'fulfilled' && projectsResult.value?.success && Array.isArray(projectsResult.value.data)
                    ? (projectsResult.value.data as ProjectRow[])
                    : [];

                if (tasksResult.status !== 'fulfilled' || !tasksResult.value?.success) {
                    loadErrors.push('tasks');
                }
                if (projectsResult.status !== 'fulfilled' || !projectsResult.value?.success) {
                    loadErrors.push('projects');
                }

                const summary = buildStaffAnalytics(tasks, projects);
                setCounts(summary.counts);
                setTrend(summary.trend);
                setError(loadErrors.length > 0 ? 'Some analytics data could not be loaded completely.' : '');
            } catch {
                if (active) {
                    await router.push('/');
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        void init();

        return () => {
            active = false;
        };
    }, [router]);

    // Fetch task trend data based on time period
    useEffect(() => {
        if (!user || !user.id) return;

        const fetchTrend = async () => {
            setTrendLoading(true);
            try {
                const userId = Number(user.id);
                const response = await fetch(`${API_BASE_URL}/api/analytics.php?user_id=${userId}&period=${timePeriod}`, {
                    credentials: 'include',
                });
                const result = await response.json();

                if (result.success && Array.isArray(result.data?.trend)) {
                    const trendData = result.data.trend as TrendApiRow[];
                    setTrend(trendData.map((item) => ({
                        date: item.date,
                        created: item.created || 0,
                        completed: item.completed || 0,
                    })));
                }
            } catch (error) {
                console.error('Failed to fetch task trend:', error);
            } finally {
                setTrendLoading(false);
            }
        };

        fetchTrend();
    }, [user, timePeriod]);

    const handleLogout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        await router.push('/');
    };

    // Line chart data for task trend
    const lineChartData = useMemo(() => ({
        labels: trend.map((row) => {
            const date = new Date(`${row.date}T00:00:00`);
            if (timePeriod === 'week') {
                return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            } else if (timePeriod === 'month') {
                return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            } else {
                return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
            }
        }),
        datasets: [
            {
                label: 'Tasks Created',
                data: trend.map((row) => row.created || 0),
                borderColor: '#6366f1',
                backgroundColor: 'rgba(99, 102, 241, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 8,
                pointBackgroundColor: '#6366f1',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointHoverBackgroundColor: '#6366f1',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3,
            },
            {
                label: 'Tasks Completed',
                data: trend.map((row) => row.completed || 0),
                borderColor: '#10b981',
                backgroundColor: 'rgba(16, 185, 129, 0.1)',
                borderWidth: 3,
                fill: true,
                tension: 0.4,
                pointRadius: 5,
                pointHoverRadius: 8,
                pointBackgroundColor: '#10b981',
                pointBorderColor: '#ffffff',
                pointBorderWidth: 2,
                pointHoverBackgroundColor: '#10b981',
                pointHoverBorderColor: '#ffffff',
                pointHoverBorderWidth: 3,
            },
        ],
    }), [trend, timePeriod]);

    const lineChartOptions = useMemo<ChartOptions<'line'>>(() => ({
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
                        size: 11,
                        weight: 'bold',
                    },
                    usePointStyle: true,
                    pointStyle: 'circle',
                    padding: 16,
                },
            },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#f8fafc',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(99, 102, 241, 0.3)',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                titleFont: {
                    size: 12,
                    weight: 'bold',
                },
                bodyFont: {
                    size: 11,
                    weight: 'normal',
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
                        size: 10,
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
                        size: 10,
                    },
                    padding: 8,
                    stepSize: 1,
                },
            },
        },
    }), []);

    // Pie chart data for task status distribution
    const pieChartData = useMemo(() => ({
        labels: ['Pending', 'In Progress', 'Completed'],
        datasets: [
            {
                data: [counts.tasks_pending, counts.tasks_in_progress, counts.tasks_completed],
                backgroundColor: [
                    'rgba(148, 163, 184, 0.85)',  // Slate
                    'rgba(59, 130, 246, 0.85)',   // Blue
                    'rgba(16, 185, 129, 0.85)',   // Emerald
                ],
                borderColor: [
                    '#94a3b8',
                    '#3b82f6',
                    '#10b981',
                ],
                borderWidth: 3,
                hoverOffset: 12,
                hoverBorderColor: '#ffffff',
                hoverBorderWidth: 3,
            },
        ],
    }), [counts]);

    const pieChartOptions = useMemo<ChartOptions<'doughnut'>>(() => ({
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        interaction: {
            mode: 'point' as const,
            intersect: true,
        },
        plugins: {
            legend: {
                display: true,
                position: 'bottom' as const,
                labels: {
                    color: '#94a3b8',
                    font: {
                        size: 11,
                        weight: 'bold',
                    },
                    usePointStyle: true,
                    pointStyle: 'circle',
                    padding: 14,
                },
            },
            tooltip: {
                backgroundColor: 'rgba(15, 23, 42, 0.95)',
                titleColor: '#f8fafc',
                bodyColor: '#e2e8f0',
                borderColor: 'rgba(99, 102, 241, 0.3)',
                borderWidth: 1,
                padding: 10,
                cornerRadius: 8,
                displayColors: true,
                boxPadding: 6,
                titleFont: {
                    size: 12,
                    weight: 'bold',
                },
                bodyFont: {
                    size: 11,
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

    if (loading) {
        return (
            <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </Layout>
        );
    }

    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head>
                <title>Analytics</title>
            </Head>

            <div style={{ marginBottom: 8 }}>
                <h1 style={{ margin: '0 0 2px 0', fontSize: 16, color: '#f8fbff' }}>Analytics</h1>
                <div style={{ color: '#9fb3de', fontSize: 12 }}>Quick summary of your tasks, projects, and workload.</div>
            </div>

            {error && (
                <div style={{ marginBottom: 8, padding: '8px 10px', borderRadius: 8, border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e', fontSize: 12 }}>
                    {error}
                </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8, marginBottom: 10 }}>
                <Card label="My Active Projects" value={counts.total_projects} onClick={() => void router.push('/projects')} hint="Open project list" />
                <Card label="My Clients" value={counts.total_clients} onClick={() => void router.push('/projects')} hint="Review client projects" />
                <Card label="Total Tasks" value={counts.tasks_total} onClick={() => void router.push('/my-tasks')} hint="Open all of my tasks" />
                <Card label="Pending Tasks" value={counts.tasks_pending} onClick={() => void router.push('/my-tasks?status=pending')} hint="Open pending tasks" />
                <Card label="In Progress" value={counts.tasks_in_progress} onClick={() => void router.push('/my-tasks?status=in_progress')} hint="Open tasks in progress" />
                <Card label="Completed Tasks" value={counts.tasks_completed} onClick={() => void router.push('/my-tasks?status=completed')} hint="Open completed tasks" />
                <Card label="Due Today" value={counts.tasks_due_today} onClick={() => void router.push('/my-tasks?filter=due_today')} hint="See today's deadlines" />
                <Card label="Overdue Tasks" value={counts.tasks_overdue} accent={counts.tasks_overdue > 0 ? '#b91c1c' : undefined} onClick={() => void router.push('/my-tasks?filter=overdue')} hint="See overdue tasks" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                {/* Line Chart - Task Trend */}
                <section style={{ background: '#0d1d3d', border: '1px solid #274574', borderRadius: 10, padding: 14 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                        <div>
                            <h2 style={{ margin: '0 0 2px 0', fontSize: 14, color: '#f8fbff' }}>
                                My Task Trend
                            </h2>
                            <div style={{ color: '#9fb3de', fontSize: 11 }}>
                                {timePeriod === 'week' ? 'Last 7 days' : timePeriod === 'month' ? 'Last 30 days' : 'Last 12 months'}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: 4 }}>
                            {(['week', 'month', 'year'] as TimePeriodFilter[]).map((period) => (
                                <button
                                    key={period}
                                    onClick={() => setTimePeriod(period)}
                                    disabled={trendLoading}
                                    style={{
                                        padding: '5px 12px',
                                        borderRadius: 6,
                                        fontSize: 11,
                                        fontWeight: 600,
                                        cursor: trendLoading ? 'not-allowed' : 'pointer',
                                        border: timePeriod === period ? '1px solid #6366f1' : '1px solid #274574',
                                        background: timePeriod === period ? 'rgba(99, 102, 241, 0.2)' : 'rgba(39, 69, 116, 0.3)',
                                        color: timePeriod === period ? '#a5b4fc' : '#9fb3de',
                                        transition: 'all 0.2s ease',
                                        opacity: trendLoading ? 0.5 : 1,
                                    }}
                                >
                                    {period === 'week' ? 'Week' : period === 'month' ? 'Month' : 'Year'}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div style={{ height: 280, marginTop: 8, position: 'relative' }}>
                        {trendLoading && (
                            <div style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                right: 0,
                                bottom: 0,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: 'rgba(13, 29, 61, 0.8)',
                                borderRadius: 8,
                                zIndex: 10,
                            }}>
                                <div style={{
                                    color: '#a5b4fc',
                                    fontSize: 12,
                                    fontWeight: 600,
                                }}>
                                    Loading...
                                </div>
                            </div>
                        )}
                        <Line data={lineChartData} options={lineChartOptions} />
                    </div>
                </section>

                {/* Pie Chart - Status Distribution */}
                <section style={{ background: '#0d1d3d', border: '1px solid #274574', borderRadius: 10, padding: 14 }}>
                    <h2 style={{ margin: '0 0 4px 0', fontSize: 14, color: '#f8fbff' }}>Task Status</h2>
                    <div style={{ color: '#9fb3de', fontSize: 11, marginBottom: 12 }}>Current task distribution.</div>
                    <div style={{ height: 280, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <Doughnut data={pieChartData} options={pieChartOptions} />
                    </div>
                </section>
            </div>
        </Layout>
    );
}

function Card({
    label,
    value,
    accent,
    onClick,
    hint,
}: {
    label: string;
    value: number;
    accent?: string;
    onClick?: () => void;
    hint?: string;
}) {
    const cardStyle = {
        width: '100%',
        background: '#0d1d3d',
        border: '1px solid #274574',
        borderRadius: 8,
        padding: 10,
        font: 'inherit',
        appearance: 'none' as const,
        textAlign: 'left' as const,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'transform 0.15s ease, box-shadow 0.15s ease, border-color 0.15s ease',
        boxShadow: onClick ? '0 2px 4px rgba(0, 0, 0, 0.2)' : 'none',
    };

    if (onClick) {
        return (
            <button type="button" onClick={onClick} style={cardStyle} data-static-hover="true">
                <div style={{ fontSize: 11, color: '#9fb3de' }}>{label}</div>
                <div style={{ marginTop: 2, fontSize: 20, fontWeight: 700, color: accent || '#f8fbff' }}>{value}</div>
                <div style={{ marginTop: 4, fontSize: 11, color: '#a5b4fc' }}>{hint || 'Open details'}</div>
            </button>
        );
    }

    return (
        <div style={cardStyle} data-static-hover="true">
            <div style={{ fontSize: 11, color: '#9fb3de' }}>{label}</div>
            <div style={{ marginTop: 2, fontSize: 20, fontWeight: 700, color: accent || '#f8fbff' }}>{value}</div>
        </div>
    );
}
