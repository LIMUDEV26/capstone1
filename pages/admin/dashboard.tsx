import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  ArcElement,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
} from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { Bar, Doughnut, Line } from 'react-chartjs-2';
import Layout from '@/components/Layout';
import { useProtectedPage } from '@/components/AuthProvider';
import ActivityLogsPanel from '@/components/ActivityLogsPanel';
import {
  DashboardClock,
  DashboardCalendarOverlay,
  type DashboardCalendarEventMap,
  fetchManagementCalendarMaps,
  mergeDashboardCalendarMaps,
} from '@/components/DashboardCalendar';
import { getApiBaseUrl } from '@/utils/network';
import styles from '../../styles/Layout.module.css';
import { useLiveSync } from '@/utils/liveSync';

ChartJS.register(
  CategoryScale,
  LinearScale,
  ArcElement,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  ChartDataLabels
);

const API_BASE = getApiBaseUrl();

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

interface TrendPoint {
  date: string;
  created: number;
  completed: number;
}

interface AnalyticsResponse {
  success?: boolean;
  data?: {
    counts?: Partial<AnalyticsCounts>;
    trend?: TrendPoint[];
    distribution?: Partial<TaskDistribution>;
  };
}

interface TaskDistribution {
  pending: number;
  in_progress: number;
  completed: number;
  total: number;
}

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
  if (Number.isNaN(parsed.getTime())) return formatShortDate(value);
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

interface PayrollMonthlyPoint {
  month: string;
  total: number;
}

interface PayrollKpi {
  headcount: number;
  total_payroll: number;
  total_salaries: number;
  total_deductions: number;
  total_benefits: number;
  avg_salary: number;
  avg_deductions: number;
  avg_benefit: number;
}

interface PayrollAnalyticsResponse {
  success?: boolean;
  data?: {
    kpi?: Partial<PayrollKpi>;
    charts?: {
      monthly?: PayrollMonthlyPoint[];
    };
  };
}

interface DashboardUser {
  id: number;
  username?: string | null;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  role?: string | null;
  status?: string | null;
  created_at?: string | null;
  branch_name?: string | null;
  employee_name?: string | null;
  salary?: number | string | null;
}

interface UsersResponse {
  success?: boolean;
  data?: DashboardUser[];
}

interface ProjectCalendarRow {
  id: number;
  status?: string | null;
  start_date?: string | null;
  end_date?: string | null;
}

interface ProjectsResponse {
  success?: boolean;
  data?: ProjectCalendarRow[];
}

interface CalendarTaskRow {
  id: number;
  title: string;
  client_name?: string | null;
  project_name?: string | null;
  status?: string | null;
  due_date?: string | null;
}

interface TasksResponse {
  success?: boolean;
  data?: CalendarTaskRow[];
}

const EMPTY_COUNTS: AnalyticsCounts = {
  total_users: 0,
  total_projects: 0,
  total_clients: 0,
  tasks_total: 0,
  tasks_pending: 0,
  tasks_in_progress: 0,
  tasks_completed: 0,
  payroll_pending: 0,
};

const EMPTY_PAYROLL_KPI: PayrollKpi = {
  headcount: 0,
  total_payroll: 0,
  total_salaries: 0,
  total_deductions: 0,
  total_benefits: 0,
  avg_salary: 0,
  avg_deductions: 0,
  avg_benefit: 0,
};

function formatCurrency(value: number) {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatCompactNumber(value: number) {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatShortDate(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function buildProjectDateEvents(projects: ProjectCalendarRow[]): DashboardCalendarEventMap {
  const eventMap: DashboardCalendarEventMap = {};

  for (const project of projects) {
    if (project.status === 'archived') continue;

    if (project.start_date) {
      const startDate = new Date(project.start_date);
      if (!Number.isNaN(startDate.getTime())) {
        const key = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')}`;
        eventMap[key] = eventMap[key] || { projectIds: [] };
        eventMap[key].start = true;
        if (!eventMap[key].projectIds.includes(project.id)) {
          eventMap[key].projectIds.push(project.id);
        }
      }
    }

    if (project.end_date) {
      const endDate = new Date(project.end_date);
      if (!Number.isNaN(endDate.getTime())) {
        const key = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
        eventMap[key] = eventMap[key] || { projectIds: [] };
        eventMap[key].end = true;
        if (!eventMap[key].projectIds.includes(project.id)) {
          eventMap[key].projectIds.push(project.id);
        }
      }
    }
  }

  return eventMap;
}

function getTaskStatusTone(status: string) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed') {
    return { background: '#dcfce7', color: '#166534' };
  }
  if (normalized === 'in_progress') {
    return { background: '#dbeafe', color: '#1d4ed8' };
  }
  if (normalized === 'cancelled') {
    return { background: '#fee2e2', color: '#b91c1c' };
  }
  return { background: '#fef3c7', color: '#92400e' };
}

function getBannerWelcomeName(user: { first_name?: unknown; last_name?: unknown; full_name?: unknown; username?: unknown; role?: unknown } | null | undefined, fallback = 'Admin') {
  const fullName = `${String(user?.first_name || '').trim()} ${String(user?.last_name || '').trim()}`.trim();
  const displayName = fullName || String(user?.full_name || user?.username || user?.role || fallback).trim() || fallback;
  return displayName;
}

async function fetchJson<T>(url: string, timeoutMs = 15000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: 'include', signal: ctrl.signal });
    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default function AdminDashboard() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useProtectedPage({
    allowedRoles: ['admin'],
    unauthorizedRedirect: '/403',
  });

  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState<AnalyticsCounts>(EMPTY_COUNTS);
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

  const buildWindowQuery = (period: ChartPeriod, month: string, year: string) =>
    period === 'month'
      ? `?month=${month}`
      : period === 'year'
        ? `?year=${year}`
        : '?period=week';

  // Analytics query for the selected window. Specific month/year pin to that
  // calendar window; otherwise the relative 7-day window is used.
  const trendQuery = buildWindowQuery(trendPeriod, trendMonth, trendYear);
  const distQuery = buildWindowQuery(distPeriod, distMonth, distYear);
  const [payrollKpi, setPayrollKpi] = useState<PayrollKpi>(EMPTY_PAYROLL_KPI);
  const [monthlyPayroll, setMonthlyPayroll] = useState<PayrollMonthlyPoint[]>([]);
  const [users, setUsers] = useState<DashboardUser[]>([]);
  const [dateEvents, setDateEvents] = useState<DashboardCalendarEventMap>({});
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [dateModalOpen, setDateModalOpen] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [dateTasks, setDateTasks] = useState<CalendarTaskRow[]>([]);
  const [loadingDateTasks, setLoadingDateTasks] = useState(false);
  const bannerWelcomeName = getBannerWelcomeName(user);

  // Silent background refresh for live-sync.
  const silentRefreshAdmin = useCallback(async () => {
    if (String(user?.role || '').toLowerCase() !== 'admin') return;
    const [trendAnalytics, distAnalytics, payroll, usersRes, projectsRes, managementMap] = await Promise.all([
      fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${trendQuery}`),
      fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${distQuery}`),
      fetchJson<PayrollAnalyticsResponse>(`${API_BASE}/payroll_analytics.php`),
      fetchJson<UsersResponse>(`${API_BASE}/users.php?status=active`),
      fetchJson<ProjectsResponse>(`${API_BASE}/projects.php?compact=calendar`),
      fetchManagementCalendarMaps(getApiBaseUrl()).catch(() => ({} as DashboardCalendarEventMap)),
    ]);
    setCounts({ ...EMPTY_COUNTS, ...(trendAnalytics?.data?.counts || {}) });
    setTrend(Array.isArray(trendAnalytics?.data?.trend) ? (trendAnalytics?.data?.trend ?? []) : []);
    setDistribution({ ...EMPTY_DISTRIBUTION, ...(distAnalytics?.data?.distribution || {}) });
    setPayrollKpi({ ...EMPTY_PAYROLL_KPI, ...(payroll?.data?.kpi || {}) });
    setMonthlyPayroll(Array.isArray(payroll?.data?.charts?.monthly) ? (payroll?.data?.charts?.monthly ?? []) : []);
    setUsers(Array.isArray(usersRes?.data) ? (usersRes?.data ?? []) : []);
    const projectMap = buildProjectDateEvents(Array.isArray(projectsRes?.data) ? (projectsRes?.data ?? []) : []);
    setDateEvents(mergeDashboardCalendarMaps(projectMap, managementMap as DashboardCalendarEventMap));
  }, [user?.role, trendQuery, distQuery]);

  useLiveSync(silentRefreshAdmin);

  useEffect(() => {
    if (String(user?.role || '').toLowerCase() !== 'admin') {
      if (!authLoading) {
        setLoading(false);
      }
      return;
    }

    let active = true;

    const loadDashboard = async () => {
      // Full-page spinner only on the very first load — switching 7 days /
      // month / year refreshes the charts live in the background instead.
      if (initialLoadRef.current) setLoading(true);

      try {
        const [trendAnalytics, distAnalytics, payroll, usersRes, projectsRes, managementMap] = await Promise.all([
          fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${trendQuery}`),
          fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${distQuery}`),
          fetchJson<PayrollAnalyticsResponse>(`${API_BASE}/payroll_analytics.php`),
          fetchJson<UsersResponse>(`${API_BASE}/users.php?status=active`),
          fetchJson<ProjectsResponse>(`${API_BASE}/projects.php?compact=calendar`),
          fetchManagementCalendarMaps(getApiBaseUrl()).catch(() => ({} as DashboardCalendarEventMap)),
        ]);

        if (!active) return;

        setCounts({ ...EMPTY_COUNTS, ...(trendAnalytics?.data?.counts || {}) });
        setTrend(Array.isArray(trendAnalytics?.data?.trend) ? (trendAnalytics?.data?.trend ?? []) : []);
        setDistribution({ ...EMPTY_DISTRIBUTION, ...(distAnalytics?.data?.distribution || {}) });
        setPayrollKpi({ ...EMPTY_PAYROLL_KPI, ...(payroll?.data?.kpi || {}) });
        setMonthlyPayroll(Array.isArray(payroll?.data?.charts?.monthly) ? (payroll?.data?.charts?.monthly ?? []) : []);
        setUsers(Array.isArray(usersRes?.data) ? (usersRes?.data ?? []) : []);
        const projectMap = buildProjectDateEvents(Array.isArray(projectsRes?.data) ? (projectsRes?.data ?? []) : []);
        setDateEvents(mergeDashboardCalendarMaps(projectMap, managementMap as DashboardCalendarEventMap));
      } finally {
        // Never trap the page on "Loading...": a slow/failed endpoint shows
        // empty states instead of hanging forever.
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
  }, [authLoading, user?.role]);

  // Analytics-only live refresh for each card's own window (7 days / month /
  // year). Never touches the page spinner, so switching windows updates the
  // charts in place without anything flashing or reloading.
  useEffect(() => {
    if (String(user?.role || '').toLowerCase() !== 'admin') return;
    let active = true;
    fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${trendQuery}`).then((analytics) => {
      if (!active || !analytics?.success) return;
      setCounts({ ...EMPTY_COUNTS, ...(analytics?.data?.counts || {}) });
      setTrend(Array.isArray(analytics?.data?.trend) ? (analytics?.data?.trend ?? []) : []);
    });
    fetchJson<AnalyticsResponse>(`${API_BASE}/analytics.php${distQuery}`).then((analytics) => {
      if (!active || !analytics?.success) return;
      setDistribution({ ...EMPTY_DISTRIBUTION, ...(analytics?.data?.distribution || {}) });
    });
    return () => {
      active = false;
    };
  }, [trendQuery, distQuery, user?.role]);

  const openTasksForDate = async (date: string) => {
    setSelectedDate(date);
    const event = dateEvents[date];
    const hasMgmt = !!((event?.managementDots?.length || 0) > 0);
    const hasProj = !!((event?.projectIds?.length || 0) > 0);
    if (!event || (!hasProj && !hasMgmt)) {
      setDateTasks([]);
      setDateModalOpen(true);
      return;
    }
    if (!hasProj) {
      setDateTasks([]);
      setDateModalOpen(true);
      return;
    }

    setLoadingDateTasks(true);
    try {
      const params = new URLSearchParams();
      params.set('project_ids', event.projectIds.join(','));
      const result = await fetchJson<TasksResponse>(`${API_BASE}/tasks.php?${params.toString()}`);
      setDateTasks(Array.isArray(result?.data) ? result!.data! : []);
    } catch {
      setDateTasks([]);
    }
    setLoadingDateTasks(false);
    setDateModalOpen(true);
  };

  const roleBreakdown = useMemo(() => {
    return users.reduce(
      (acc, current) => {
        const role = String(current.role || '').toLowerCase();
        if (role === 'admin') acc.admin += 1;
        else if (role === 'manager') acc.manager += 1;
        else acc.staff += 1;
        return acc;
      },
      { admin: 0, manager: 0, staff: 0 }
    );
  }, [users]);

  const recentUsers = useMemo(() => {
    return [...users]
      .sort((left, right) => new Date(String(right.created_at || '')).getTime() - new Date(String(left.created_at || '')).getTime())
      .slice(0, 5);
  }, [users]);

  const lineData = useMemo(() => ({
    labels: trend.map((item) => formatTrendLabel(item.date, trendPeriod)),
    datasets: [
      {
        label: 'Created',
        data: trend.map((item) => item.created),
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37, 99, 235, 0.16)',
        fill: true,
        tension: 0.35,
        borderWidth: 3,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
      {
        label: 'Completed',
        data: trend.map((item) => item.completed),
        borderColor: '#16a34a',
        backgroundColor: 'rgba(22, 163, 74, 0.08)',
        fill: true,
        tension: 0.35,
        borderWidth: 3,
        pointRadius: 4,
        pointHoverRadius: 6,
      },
    ],
  }), [trend, trendPeriod]);

  const lineOptions = useMemo<ChartOptions<'line'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false
      },
    },
    scales: {
      x: { grid: { display: false } },
      y: {
        beginAtZero: true,
        ticks: { stepSize: 1 },
        grid: { color: 'rgba(148, 163, 184, 0.15)' },
      },
    },
  }), []);

  const barData = useMemo(() => ({
    labels: monthlyPayroll.map((item) => item.month),
    datasets: [
      {
        label: 'Net Payroll',
        data: monthlyPayroll.map((item) => item.total),
        backgroundColor: ['#2563eb', '#38bdf8', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981'],
        borderRadius: 10,
        maxBarThickness: 38,
      },
    ],
  }), [monthlyPayroll]);

  const barOptions = useMemo<ChartOptions<'bar'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
    },
    scales: {
      x: { grid: { display: false } },
      y: {
        beginAtZero: true,
        grid: { color: 'rgba(148, 163, 184, 0.15)' },
      },
    },
  }), []);

  const doughnutData = useMemo(() => ({
    labels: ['Pending', 'In Progress', 'Completed'],
    datasets: [
      {
        data: [distribution.pending, distribution.in_progress, distribution.completed],
        backgroundColor: ['#f59e0b', '#2563eb', '#10b981'],
        borderColor: ['#fcd34d', '#93c5fd', '#6ee7b7'],
        borderWidth: 2,
        hoverOffset: 8,
      },
    ],
  }), [distribution.pending, distribution.in_progress, distribution.completed]);

  const doughnutOptions = useMemo<ChartOptions<'doughnut'>>(() => ({
    responsive: true,
    maintainAspectRatio: false,
    cutout: '70%',
    plugins: {
      legend: {
        display: false, // Hide legend since we're showing custom labels
      },
      tooltip: {
        enabled: true,
        backgroundColor: 'rgba(15, 23, 42, 0.95)',
        titleColor: '#f8fafc',
        bodyColor: '#e2e8f0',
        borderColor: 'rgba(99, 102, 241, 0.3)',
        borderWidth: 1,
        padding: 12,
        cornerRadius: 8,
        displayColors: true,
        boxPadding: 6,
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


  const cardStyle: CSSProperties = {
    background: '#ffffff',
    borderRadius: 10,
    border: '1px solid #e5e7eb',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  };

  const distHint = periodHintText(distPeriod, distMonth, distYear);
  const trendHint = periodHintText(trendPeriod, trendMonth, trendYear);
  const monthOptions = useMemo(() => lastTwelveMonths(), []);
  const yearOptions = useMemo(() => recentYears(6), []);

  // Compact one-line window control shared by both cards. Each card passes its
  // OWN state, so the two cards filter independently. Month/Year are always
  // visible dropdowns — picking one switches that card to it; 7 Days is a button.
  const renderWindowControls = (
    period: ChartPeriod,
    month: string,
    year: string,
    onPeriod: (p: ChartPeriod) => void,
    onMonth: (m: string) => void,
    onYear: (y: string) => void,
  ) => (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'nowrap' }}>
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
        style={{
          padding: '4px 4px',
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 700,
          maxWidth: 92,
          color: period === 'month' ? '#1d4ed8' : '#64748b',
          border: period === 'month' ? '1px solid #3b82f6' : '1px solid #e2e8f0',
          background: period === 'month' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc',
          cursor: 'pointer',
          outline: 'none',
        }}
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
        style={{
          padding: '4px 4px',
          borderRadius: 8,
          fontSize: 11,
          fontWeight: 700,
          maxWidth: 70,
          color: period === 'year' ? '#1d4ed8' : '#64748b',
          border: period === 'year' ? '1px solid #3b82f6' : '1px solid #e2e8f0',
          background: period === 'year' ? 'rgba(59, 130, 246, 0.12)' : '#f8fafc',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <option value="" disabled>Year</option>
        {yearOptions.map((y) => (
          <option key={y} value={y}>{y}</option>
        ))}
      </select>
    </div>
  );

  if (authLoading || loading) {
    return (
      <Layout role="admin" user={user} onLogout={logout}>
        <div style={{ padding: 20 }}>Loading...</div>
      </Layout>
    );
  }

  return (
    <Layout role="admin" user={user} onLogout={logout}>
      <Head>
        <title>Admin Dashboard</title>
      </Head>

      <div style={{ display: 'grid', gap: 10, padding: '12px 16px', maxWidth: 1520, width: '100%', margin: '0 auto', overflowX: 'hidden', boxSizing: 'border-box' }}>
        <div className={styles.banner}>
          <div className={styles.bannerOverlay}></div>
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'stretch', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', padding: '4px' }}>
            <div style={{ padding: '14px 14px', flex: '0 1 255px', minWidth: 220, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', alignSelf: 'stretch', borderRadius: 14, background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.22)' }}>
              <div style={{ alignSelf: 'flex-start', padding: '3px 9px', borderRadius: 999, background: 'rgba(255,255,255,0.18)', border: '1px solid rgba(255,255,255,0.28)', color: '#dbeafe', fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 10 }}>
                Admin Dashboard
              </div>
              <h1 style={{ margin: 0, fontSize: 'clamp(18px, 1.75vw, 24px)', fontWeight: 900, lineHeight: 1.12, letterSpacing: '0.02em', maxWidth: 245, textAlign: 'left' }}>Welcome, {bannerWelcomeName}!</h1>
              <p style={{ margin: '8px 0 0', color: 'rgba(255,255,255,0.85)', fontSize: 12, lineHeight: 1.35, maxWidth: 240 }}>
                Here&apos;s your system overview for today.
              </p>
            </div>

            <div style={{ display: 'flex', alignItems: 'stretch', gap: 8, padding: 0, flex: '1 1 500px', justifyContent: 'flex-end', flexWrap: 'wrap', maxWidth: '100%' }}>
              <div style={{ flex: '1 1 auto', maxWidth: '100%', minWidth: 280, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(90px, 1fr))', gap: '8px' }}>
                {[
                  {
                    label: 'Total Users',
                    value: counts.total_users,
                    color: '#1e3a8a',
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>,
                    route: '/users',
                  },
                  {
                    label: 'Pending Tasks',
                    value: counts.tasks_pending,
                    color: '#fbbf24',
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>,
                    route: '/my-tasks',
                  },
                  {
                    label: 'Completed Tasks',
                    value: counts.tasks_completed,
                    color: '#1e3a8a',
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>,
                    route: '/my-tasks',
                  },
                  {
                    label: 'Payroll Pending',
                    value: counts.payroll_pending,
                    color: '#fbbf24',
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>,
                    route: '/payroll-management',
                  },
                  {
                    label: 'Projects',
                    value: counts.total_projects,
                    color: '#1e3a8a',
                    icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>,
                    route: '/projects',
                  },
                  {
                    label: 'Clients',
                    value: counts.total_clients,
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
                  onDayClick={(date) => { void openTasksForDate(date); }}
                  theme="light"
                />
              </div>
            </div>
          </div>
        </div>



        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(380px, 100%), 1fr))', gap: '10px' }}>
          <div style={{ ...cardStyle, padding: 14, minHeight: 260, display: 'flex', flexDirection: 'column' }}>
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
              </div>
              {/* Right side: Pie chart (centered slightly) */}
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', maxWidth: 200, marginRight: 20 }}>
                <div style={{ width: '100%', aspectRatio: '1' }}>
                  <Doughnut data={doughnutData} options={doughnutOptions} />
                </div>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: '#111827', lineHeight: 1 }}>{distribution.total}</div>
                  <div style={{ fontSize: 10, color: '#6b7280', marginTop: 3 }}>Total Tasks</div>
                </div>
              </div>
            </div>
          </div>

          <div style={{ ...cardStyle, padding: 14, minHeight: 210, display: 'flex', flexDirection: 'column' }}>
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
              <Line data={lineData} options={lineOptions} />
            </div>
          </div>
        </section>

        <ActivityLogsPanel />
      </div>

      <DashboardCalendarOverlay
        open={calendarOpen}
        onClose={() => setCalendarOpen(false)}
        events={dateEvents}
        onDayClick={(date) => {
          void openTasksForDate(date);
        }}
      />

      {dateModalOpen && (() => {
        const mgmt = selectedDate ? dateEvents[selectedDate]?.managementDots || [] : [];
        return (
        <div data-no-clock-close style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.5)', zIndex: 20000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ width: 'min(920px, 100%)', maxHeight: '86vh', overflow: 'auto', background: '#ffffff', borderRadius: 24, border: '1px solid #e5e7eb', boxShadow: '0 24px 60px rgba(15, 23, 42, 0.25)', padding: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14 }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>Details for {selectedDate}</h2>
                <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 13 }}>Project tasks and calendar management entries on this date.</p>
              </div>
              <button onClick={() => setDateModalOpen(false)} style={{ border: '1px solid #cbd5e1', background: '#fff', borderRadius: 12, padding: '8px 12px', cursor: 'pointer', color: '#0f172a', fontWeight: 700 }}>
                Close
              </button>
            </div>
            {mgmt.length > 0 && (
              <div style={{ marginBottom: 12, padding: '10px 12px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12 }}>
                <div style={{ fontWeight: 700, fontSize: 12, color: '#0f172a', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#0ea5e9', display: 'inline-block' }} />
                  Calendar Management
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {mgmt.map((dot, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#334155', background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, padding: '6px 8px' }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: dot.color, flexShrink: 0, display: 'inline-block' }} />
                      <span style={{ flex: 1, minWidth: 0 }}>{dot.label}</span>
                      <span style={{ fontSize: 10, color: dot.kind === 'holiday' ? '#be123c' : dot.kind === 'birthday' ? '#7e22ce' : '#334155', fontWeight: 600, textTransform: 'capitalize', flexShrink: 0 }}>{dot.kind}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {loadingDateTasks ? (
              <div style={{ padding: 28, textAlign: 'center', color: '#64748b' }}>Loading tasks...</div>
            ) : dateTasks.length === 0 ? (
              <div style={{ padding: 28, textAlign: 'center', color: '#64748b' }}>No project tasks found for this date.</div>
            ) : (
              <div style={{ display: 'grid', gap: 10 }}>
                {dateTasks.map((task) => {
                  const tone = getTaskStatusTone(String(task.status || 'pending'));
                  return (
                    <div key={task.id} style={{ borderRadius: 18, border: '1px solid #e2e8f0', background: '#f8fafc', padding: '12px 14px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                        <div>
                          <div style={{ fontWeight: 700, color: '#0f172a' }}>{task.title}</div>
                          <div style={{ marginTop: 6, color: '#64748b', fontSize: 13 }}>
                            {(task.client_name || 'No client')} | {(task.project_name || 'No project')}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                          <span style={{ ...tone, borderRadius: 999, padding: '4px 10px', fontSize: 11, fontWeight: 800, textTransform: 'capitalize' }}>
                            {String(task.status || 'pending').replace(/_/g, ' ')}
                          </span>
                          <span style={{ color: '#64748b', fontSize: 12 }}>{formatDateTime(task.due_date)}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        );
        })()}
    </Layout>
  );
}
