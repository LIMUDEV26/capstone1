import Head from 'next/head';
import { useRouter } from 'next/router';
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
} from 'react';
import {
  ArcElement,
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Tooltip,
  type ChartOptions,
} from 'chart.js';
import { Bar, Doughnut } from 'react-chartjs-2';
import Layout from '@/components/Layout';
import { useProtectedPage } from '@/components/AuthProvider';
import ExpandIconButton from '@/components/ExpandIconButton';
import FloatingListPanel from '@/components/FloatingListPanel';
import Pagination from '@/components/Pagination';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError } from '@/utils/notify';
import { getRoleFallbackPath } from '@/utils/roleFeatureAccess';
import {
  type ReportDefinition,
  type ReportExportFormat,
  type ReportMetricsSection,
  type ReportPayload,
  type ReportSection,
  type ReportTableSection,
  downloadAllReports,
  downloadSingleReport,
} from '@/utils/reportExport';
import styles from '@/styles/Reports.module.css';

type BranchOption = {
  branch_id: number;
  branch_name: string;
};

type CatalogResponse = {
  reports?: ReportDefinition[];
  branches?: BranchOption[];
  scope?: {
    branch_id?: number | null;
    branch_label?: string | null;
  };
};

type FilterState = {
  dateFrom: string;
  dateTo: string;
  branchId: string;
};

type PayrollFocusKey = 'overview' | 'spend' | 'deductions' | 'attendance' | 'branches';

const API_BASE = getApiBaseUrl();

const DEFAULT_FILTERS: FilterState = {
  dateFrom: '',
  dateTo: '',
  branchId: 'all',
};

const DEFAULT_PAYROLL_FOCUS: PayrollFocusKey = 'overview';

const PAYROLL_FOCUS_OPTIONS: Array<{
  key: PayrollFocusKey;
  label: string;
  title: string;
  description: string;
}> = [
  {
    key: 'overview',
    label: 'Overview',
    title: 'Payroll and Attendance',
    description: 'Full payroll health across spend, deductions, attendance, and branch totals.',
  },
  {
    key: 'spend',
    label: 'Spend',
    title: 'Payroll Spend Report',
    description: 'Focus on gross payroll outlay, net release, overtime, and the people using the most payroll budget.',
  },
  {
    key: 'deductions',
    label: 'Deductions',
    title: 'Payroll Deduction Report',
    description: 'Focus on total deductions, deduction drivers, and where payroll leakage is concentrated.',
  },
  {
    key: 'attendance',
    label: 'Attendance',
    title: 'Payroll Attendance Report',
    description: 'Focus on worked time, overtime, lateness, absences, and attendance pressure.',
  },
  {
    key: 'branches',
    label: 'Branches',
    title: 'Payroll Branch Report',
    description: 'Focus on which branches carry the highest payroll value, deductions, and attendance load.',
  },
];

ChartJS.register(ArcElement, Tooltip, Legend, CategoryScale, LinearScale, BarElement);

const VISUAL_EXPORT_FORMATS: Array<{ value: ReportExportFormat; label: string }> = [
  { value: 'pdf', label: 'PDF document' },
  { value: 'png', label: 'PNG image' },
  { value: 'excel', label: 'Excel workbook' },
  { value: 'html', label: 'Styled HTML' },
  { value: 'print', label: 'Print' },
];

const REPORT_CHART_COLORS = ['#075f66', '#0f7b82', '#3f9298', '#76adb1', '#a9cbcd', '#d8e5e6'];
const REPORT_GAUGE_COLORS = ['#c8db72', '#f4b665', '#ef7078'];
const REPORT_TABLE_PREVIEW_LIMIT = 3;

type ReportTheme = {
  gradient: string;
  accent: string;
  soft: string;
  palette: string[];
  icon: 'overview' | 'delivery' | 'payroll' | 'documents' | 'audit';
  tagline: string;
};

const REPORT_THEMES: Record<string, ReportTheme> = {
  executive_overview: {
    gradient: 'linear-gradient(135deg, #1e1b4b 0%, #4c1d95 55%, #7c3aed 100%)',
    accent: '#8b5cf6',
    soft: 'rgba(139, 92, 246, 0.12)',
    palette: ['#8b5cf6', '#6366f1', '#a78bfa', '#c4b5fd', '#6d28d9', '#4c1d95'],
    icon: 'overview',
    tagline: 'Command view',
  },
  project_delivery: {
    gradient: 'linear-gradient(135deg, #0c2d6b 0%, #1d4ed8 55%, #38bdf8 100%)',
    accent: '#3b82f6',
    soft: 'rgba(59, 130, 246, 0.12)',
    palette: ['#3b82f6', '#0ea5e9', '#6366f1', '#38bdf8', '#1d4ed8', '#0c2d6b'],
    icon: 'delivery',
    tagline: 'Delivery pulse',
  },
  payroll_attendance: {
    gradient: 'linear-gradient(135deg, #022c22 0%, #047857 55%, #34d399 100%)',
    accent: '#10b981',
    soft: 'rgba(16, 185, 129, 0.12)',
    palette: ['#10b981', '#059669', '#34d399', '#6ee7b7', '#047857', '#065f46'],
    icon: 'payroll',
    tagline: 'Money in motion',
  },
  documents_compliance: {
    gradient: 'linear-gradient(135deg, #431407 0%, #b45309 55%, #f59e0b 100%)',
    accent: '#f59e0b',
    soft: 'rgba(245, 158, 11, 0.14)',
    palette: ['#f59e0b', '#d97706', '#fbbf24', '#fcd34d', '#b45309', '#92400e'],
    icon: 'documents',
    tagline: 'Compliance watch',
  },
  audit_activity: {
    gradient: 'linear-gradient(135deg, #2e1065 0%, #7c3aed 55%, #e879f9 100%)',
    accent: '#a855f7',
    soft: 'rgba(168, 85, 247, 0.12)',
    palette: ['#a855f7', '#7c3aed', '#e879f9', '#c084fc', '#6d28d9', '#4c1d95'],
    icon: 'audit',
    tagline: 'Trust ledger',
  },
};

const DEFAULT_REPORT_THEME: ReportTheme = REPORT_THEMES.executive_overview;

function resolveReportTheme(reportKey: string): ReportTheme {
  const theme = REPORT_THEMES[reportKey] || DEFAULT_REPORT_THEME;
  return {
    ...theme,
    accent: '#075f66',
    soft: 'rgba(7, 95, 102, 0.10)',
    palette: REPORT_CHART_COLORS,
  };
}

function formatPesoFigure(value: number) {
  return `PHP ${Number(value || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

type ReportInsight = {
  key: string;
  title: string;
  text: string;
  tone: 'good' | 'warn' | 'danger' | 'info';
};

function findReportTable(report: ReportPayload, fragment: string): ReportTableSection | null {
  const needle = fragment.toLowerCase();
  return report.sections.filter(isTableSection).find((section) => section.title.toLowerCase().includes(needle)) || null;
}

function findReportMetric(report: ReportPayload, fragment: string) {
  const needle = fragment.toLowerCase();
  for (const section of report.sections.filter(isMetricsSection)) {
    const found = section.items.find((item) => item.label.toLowerCase().includes(needle));
    if (found) return found;
  }
  return null;
}

function tableCellNumber(row: Record<string, string | number | null>, key: string) {
  return parseMetricNumber((row[key] ?? '') as string | number);
}

function maxTableRow(table: ReportTableSection | null, numericKey: string) {
  if (!table || table.rows.length === 0) return null;
  let best: (typeof table.rows)[number] | null = null;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const row of table.rows) {
    const value = tableCellNumber(row, numericKey);
    if (value > bestValue) {
      bestValue = value;
      best = row;
    }
  }
  return best ? { row: best, value: bestValue } : null;
}

function buildReportInsights(report: ReportPayload): ReportInsight[] {
  const insights: ReportInsight[] = [];
  const key = report.report_key;

  if (key === 'executive_overview') {
    const domains = findReportTable(report, 'domain snapshot');
    if (domains && domains.rows.length > 0) {
      let total = 0;
      let closed = 0;
      let open = 0;
      for (const row of domains.rows) {
        // Prefer explicit totals; fall back to open + closed when needed.
        const rowTotal = tableCellNumber(row, 'total_records');
        const rowOpen = tableCellNumber(row, 'open_or_pending');
        const rowClosed = tableCellNumber(row, 'closed_or_completed');
        total += rowTotal > 0 ? rowTotal : rowOpen + rowClosed;
        closed += rowClosed;
        open += rowOpen;
      }
      const rate = total > 0 ? (closed / total) * 100 : 0;
      insights.push({
        key: 'exec-completion',
        title: `${rate.toFixed(1)}% overall completion`,
        text: `${Math.round(closed).toLocaleString()} of ${Math.round(total).toLocaleString()} tracked records closed across all domains.`,
        tone: rate >= 75 ? 'good' : rate >= 40 ? 'info' : 'warn',
      });
      if (open > 0) {
        insights.push({
          key: 'exec-backlog',
          title: `${Math.round(open).toLocaleString()} open items need action`,
          text: 'Backlog is spread across domains — clear owners and due dates to move it.',
          tone: 'warn',
        });
      }
    }
    const trend = findReportTable(report, 'recent activity trend');
    if (trend && trend.rows.length > 0) {
      const peak = maxTableRow(trend, 'activity_count');
      if (peak) {
        insights.push({
          key: 'exec-peak',
          title: `Peak activity ${String(peak.row.activity_date || '').slice(0, 10)}`,
          text: `${Math.round(peak.value).toLocaleString()} activity logs on the busiest day in scope.`,
          tone: 'info',
        });
      }
    }
  }

  if (key === 'project_delivery') {
    const rateMetric = findReportMetric(report, 'task completion rate');
    if (rateMetric) {
      insights.push({
        key: 'proj-rate',
        title: `Task completion ${String(rateMetric.value)}`,
        text: 'Completed tasks divided by total tasks in the selected window.',
        tone: parseMetricNumber(rateMetric.value) >= 75 ? 'good' : 'info',
      });
    }
    const progress = findReportTable(report, 'top project progress');
    const topProject = maxTableRow(progress, 'progress_percent');
    if (topProject) {
      insights.push({
        key: 'proj-top',
        title: `Top progress: ${String(topProject.row.project_name || 'a project')}`,
        text: `${String(topProject.row.progress_percent || '')} complete${topProject.row.client_name ? ` for ${topProject.row.client_name}` : ''}.`,
        tone: 'good',
      });
    }
    const status = findReportTable(report, 'project status breakdown');
    if (status && status.rows.length > 0) {
      let budget = 0;
      let actual = 0;
      for (const row of status.rows) {
        budget += tableCellNumber(row, 'total_budget');
        actual += tableCellNumber(row, 'total_actual_cost');
      }
      if (budget > 0) {
        const diff = budget - actual;
        insights.push({
          key: 'proj-budget',
          title: diff >= 0 ? `${formatPesoFigure(diff)} under budget` : `${formatPesoFigure(Math.abs(diff))} over budget`,
          text: `Budgeted ${formatPesoFigure(budget)} against ${formatPesoFigure(actual)} actual cost.`,
          tone: diff >= 0 ? 'good' : 'danger',
        });
      }
    }
    const overdue = findReportMetric(report, 'overdue tasks');
    if (overdue && parseMetricNumber(overdue.value) > 0) {
      insights.push({
        key: 'proj-overdue',
        title: `${formatDisplayValue(overdue.value)} overdue tasks`,
        text: 'Open tasks that already missed their due dates need immediate attention.',
        tone: 'danger',
      });
    }
  }

  if (key === 'payroll_attendance') {
    const branches = findReportTable(report, 'branch payroll totals');
    const topBranch = maxTableRow(branches, 'total_gross_pay');
    if (topBranch) {
      insights.push({
        key: 'pay-branch',
        title: `${String(topBranch.row.branch_name || 'Top branch')} leads spend`,
        text: `${formatPesoFigure(topBranch.value)} gross payroll in scope.`,
        tone: 'info',
      });
    }
    const deductions = findReportTable(report, 'deduction breakdown');
    const topDeduction = maxTableRow(deductions, 'amount');
    if (topDeduction) {
      insights.push({
        key: 'pay-deduction',
        title: `Top deduction: ${String(topDeduction.row.deduction_name || 'deductions')}`,
        text: `${formatPesoFigure(topDeduction.value)} — the largest single deduction driver.`,
        tone: 'warn',
      });
    }
    const gross = findReportMetric(report, 'gross payroll spend');
    const net = findReportMetric(report, 'total net pay');
    if (gross && net) {
      const grossValue = parseMetricNumber(gross.value);
      const netValue = parseMetricNumber(net.value);
      if (grossValue > 0) {
        const payout = (netValue / grossValue) * 100;
        insights.push({
          key: 'pay-payout',
          title: `${payout.toFixed(1)}% of gross reaches employees`,
          text: `Net ${formatPesoFigure(netValue)} out of ${formatPesoFigure(grossValue)} gross payroll.`,
          tone: payout >= 80 ? 'good' : 'warn',
        });
      }
    }
    const pending = findReportMetric(report, 'pending payroll');
    if (pending && parseMetricNumber(pending.value) > 0) {
      insights.push({
        key: 'pay-pending',
        title: `${formatDisplayValue(pending.value)} payroll records pending`,
        text: 'Records waiting for review or action before release.',
        tone: 'warn',
      });
    }
  }

  if (key === 'documents_compliance') {
    const clients = findReportTable(report, 'documents by client');
    const topClient = maxTableRow(clients, 'total_documents');
    if (topClient) {
      insights.push({
        key: 'doc-client',
        title: `${String(topClient.row.client_name || 'Top client')} leads volume`,
        text: `${Math.round(topClient.value).toLocaleString()} documents${topClient.row.completion_rate ? ` at ${topClient.row.completion_rate} completion` : ''}.`,
        tone: 'info',
      });
    }
    const acceptance = findReportMetric(report, 'acceptance rate');
    if (acceptance) {
      insights.push({
        key: 'doc-acceptance',
        title: `Acceptance rate ${String(acceptance.value)}`,
        text: 'Accepted submissions divided by total submissions.',
        tone: parseMetricNumber(acceptance.value) >= 85 ? 'good' : 'warn',
      });
    }
    const processing = findReportMetric(report, 'processing');
    if (processing && parseMetricNumber(processing.value) > 0) {
      insights.push({
        key: 'doc-processing',
        title: `${formatDisplayValue(processing.value)} documents processing`,
        text: 'In-flight documents to chase toward completion.',
        tone: 'warn',
      });
    }
    const rejected = findReportMetric(report, 'rejected');
    if (rejected && parseMetricNumber(rejected.value) > 0) {
      insights.push({
        key: 'doc-rejected',
        title: `${formatDisplayValue(rejected.value)} submissions rejected`,
        text: 'Rejected submissions worth reviewing for recurring causes.',
        tone: 'danger',
      });
    }
  }

  if (key === 'audit_activity') {
    const byType = findReportTable(report, 'activity by type');
    const topType = maxTableRow(byType, 'activity_count');
    if (topType) {
      insights.push({
        key: 'audit-top',
        title: `Most frequent: ${String(topType.row.activity_type || 'activity')}`,
        text: `${Math.round(topType.value).toLocaleString()} logged events in scope.`,
        tone: 'info',
      });
    }
    const critical = findReportMetric(report, 'critical exceptions');
    if (critical) {
      const criticalValue = parseMetricNumber(critical.value);
      insights.push({
        key: 'audit-critical',
        title: criticalValue > 0 ? `${formatDisplayValue(critical.value)} critical exceptions open` : 'No critical exceptions open',
        text: criticalValue > 0 ? 'Unresolved critical items need immediate review.' : 'Exception queue is clear of critical items.',
        tone: criticalValue > 0 ? 'danger' : 'good',
      });
    }
    const actors = findReportMetric(report, 'active actors');
    if (actors) {
      insights.push({
        key: 'audit-actors',
        title: `${formatDisplayValue(actors.value)} active actors`,
        text: 'Distinct users with tracked activity in scope.',
        tone: 'info',
      });
    }
  }

  return insights.slice(0, 4);
}

type DerivedMetric = {
  key: string;
  sectionTitle: string;
  label: string;
  value: string | number;
  hint?: string;
  tone?: string;
  numericValue: number;
};

type TablePreviewRow = {
  id: string;
  title: string;
  detail: string;
  badges: string[];
};

type PreviewRowInteraction = {
  getRowTarget: (row: TablePreviewRow) => string;
  onNavigate: (event: MouseEvent<HTMLElement>, path: string) => void;
};

function isMetricsSection(section: ReportSection): section is ReportMetricsSection {
  return section.type === 'metrics';
}

function isTableSection(section: ReportSection): section is ReportTableSection {
  return section.type === 'table';
}

function formatDisplayValue(value: unknown) {
  const normalized = String(value ?? '').trim();
  return normalized || 'N/A';
}

function parseMetricNumber(value: string | number) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value);
  }

  const normalized = String(value ?? '')
    .replace(/,/g, '')
    .trim();
  const match = normalized.match(/-?\d+(\.\d+)?/);
  if (!match) {
    return 0;
  }

  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) ? Math.abs(parsed) : 0;
}

function buildDerivedMetrics(sections: ReportMetricsSection[]) {
  return sections.flatMap((section) =>
    section.items.map((item, index) => ({
      key: `${section.title}-${item.label}-${index}`,
      sectionTitle: section.title,
      label: item.label,
      value: item.value,
      hint: item.hint,
      tone: item.tone,
      numericValue: parseMetricNumber(item.value),
    }))
  );
}

function getMetricGaugeValue(metric: DerivedMetric, metrics: DerivedMetric[]) {
  const rawValue = String(metric.value ?? '');
  if (rawValue.includes('%')) {
    return Math.max(0, Math.min(100, metric.numericValue));
  }

  const largestValue = Math.max(...metrics.map((item) => item.numericValue), 0);
  if (largestValue <= 0) return 0;
  return Math.max(8, Math.min(100, (metric.numericValue / largestValue) * 100));
}

function buildTablePreviewRows(section: ReportTableSection, limit = 4): TablePreviewRow[] {
  const [primaryColumn, ...otherColumns] = section.columns;

  return section.rows.slice(0, limit).map((row, index) => {
    const title = primaryColumn
      ? formatDisplayValue(row[primaryColumn.key])
      : `Row ${index + 1}`;
    const detail = otherColumns
      .slice(0, 2)
      .map((column) => `${column.label}: ${formatDisplayValue(row[column.key])}`)
      .join(' | ');
    const badges = otherColumns
      .slice(2, 5)
      .map((column) => `${column.label}: ${formatDisplayValue(row[column.key])}`);

    return {
      id: `${section.title}-${index}`,
      title,
      detail,
      badges,
    };
  });
}

function resolveBaseReportRoute(reportKey: string, role: unknown) {
  switch (reportKey) {
    case 'project_delivery':
      return '/projects';
    case 'payroll_attendance':
      return '/payroll-management';
    case 'documents_compliance':
      return '/documents';
    case 'executive_overview':
    case 'audit_activity':
    default:
      return getRoleFallbackPath(role);
  }
}

function resolveReportDestination(reportKey: string, role: unknown, context = '') {
  const normalized = `${reportKey} ${context}`.trim().toLowerCase();

  if (/(leave)/.test(normalized)) {
    return '/leave-requests';
  }
  if (/(overtime)/.test(normalized)) {
    return '/overtime-requests';
  }
  if (/(cash advance|cash_advance|cash-advance)/.test(normalized)) {
    return '/cash-advance';
  }
  if (/(payroll|attendance|deduction|pre-check|precheck)/.test(normalized)) {
    return '/payroll-management';
  }
  if (/(project|task|delivery|overdue|dispatch|progress)/.test(normalized)) {
    return '/projects';
  }
  if (/(document|submission|compliance|intake)/.test(normalized)) {
    return '/documents';
  }
  if (/(activity|audit)/.test(normalized)) {
    return getRoleFallbackPath(role);
  }

  return resolveBaseReportRoute(reportKey, role);
}

function renderPreviewRows(section: ReportTableSection, limit = 4, interaction?: PreviewRowInteraction) {
  const rows = buildTablePreviewRows(section, limit);

  if (rows.length === 0) {
    return <div className={styles.emptyMini}>No rows available for this section.</div>;
  }

  return (
    <div className={styles.previewList}>
      {rows.map((row) => (
        <div
          key={row.id}
          className={`${styles.previewRow}${interaction ? ` ${styles.previewRowInteractive}` : ''}`}
          title={interaction ? 'Double-click to open the related page.' : undefined}
          onDoubleClick={
            interaction
              ? (event) => interaction.onNavigate(event, interaction.getRowTarget(row))
              : undefined
          }
        >
          <div className={`${styles.previewRowTitle} llb-ellipsis`} title={row.title}>{row.title}</div>
          {row.detail ? <div className={`${styles.previewRowDetail} llb-ellipsis`} title={row.detail}>{row.detail}</div> : null}
          {row.badges.length > 0 ? (
            <div className={styles.previewBadges}>
              {row.badges.map((badge) => (
                <span key={`${row.id}-${badge}`} className={styles.previewBadge}>
                  {badge}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function renderExpandedTableRows(section: ReportTableSection, rows: ReportTableSection['rows']) {
  if (rows.length === 0) {
    return <div className={styles.emptyMini}>No rows available for this section.</div>;
  }

  return (
    <div className={styles.expandedTableWrap}>
      <table className={`${styles.expandedTable} llb-table`}>
        <thead className={styles.expandedTableHead}>
          <tr>
            {section.columns.map((column) => (
              <th key={`${section.title}-${column.key}`}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${section.title}-row-${index}`}>
              {section.columns.map((column) => (
                <td key={`${section.title}-${index}-${column.key}`}>
                  {formatDisplayValue(row[column.key])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function buildReportUrl(reportKey: string, filters: FilterState) {
  const params = new URLSearchParams({
    action: 'generate',
    report_key: reportKey,
  });

  if (filters.dateFrom) params.set('date_from', filters.dateFrom);
  if (filters.dateTo) params.set('date_to', filters.dateTo);
  if (filters.branchId && filters.branchId !== 'all') params.set('branch_id', filters.branchId);

  return `${API_BASE}/reports.php?${params.toString()}`;
}

function formatFilterSummary(report: ReportPayload | null) {
  if (!report?.filters) return 'All time';

  const parts: string[] = [];
  if (report.filters.branch_label) {
    parts.push(report.filters.branch_label);
  }
  if (report.filters.date_from || report.filters.date_to) {
    parts.push(`${report.filters.date_from || 'Beginning'} to ${report.filters.date_to || 'Present'}`);
  } else {
    parts.push('All time');
  }
  return parts.join(' · ');
}

function buildFocusedPayrollReport(
  report: ReportPayload | null,
  focus: PayrollFocusKey
): ReportPayload | null {
  if (!report || report.report_key !== 'payroll_attendance' || focus === DEFAULT_PAYROLL_FOCUS) {
    return report;
  }

  const focusDefinition = PAYROLL_FOCUS_OPTIONS.find((item) => item.key === focus) || PAYROLL_FOCUS_OPTIONS[0];
  const sectionMatcher = (section: ReportSection) => {
    const title = section.title.toLowerCase();

    switch (focus) {
      case 'spend':
        return /(payroll snapshot|payroll spend summary|payroll status breakdown|branch payroll totals|payroll spend by employee)/.test(title);
      case 'deductions':
        return /(payroll snapshot|deduction summary|deduction breakdown|top deduction loads|branch payroll totals)/.test(title);
      case 'attendance':
        return /(attendance snapshot|attendance by branch)/.test(title);
      case 'branches':
        return /(payroll snapshot|branch payroll totals|attendance by branch|payroll status breakdown)/.test(title);
      case 'overview':
      default:
        return true;
    }
  };

  const sections = report.sections.filter(sectionMatcher);
  const scopeNotes = [report.filters?.scope_note, `Payroll focus: ${focusDefinition.label}.`].filter(Boolean).join(' ');

  return {
    ...report,
    title: focusDefinition.title,
    description: focusDefinition.description,
    filters: {
      ...report.filters,
      scope_note: scopeNotes,
    },
    sections: sections.length > 0 ? sections : report.sections,
  };
}

/**
 * Shape an export payload that matches exactly what the UI shows: the
 * featured metrics, the primary + secondary tables, and the Key Insights
 * strip. Extra "additional data" sections are left out of every export.
 */
function buildExportReport(report: ReportPayload, insights: ReportInsight[]): ReportPayload {
  const metrics = report.sections.filter(isMetricsSection);
  const tables = report.sections.filter(isTableSection);
  const sections: ReportSection[] = [];
  if (metrics[0]) sections.push(metrics[0]);
  if (tables[0]) sections.push(tables[0]);
  if (tables[1]) sections.push(tables[1]);
  if (insights.length > 0) {
    sections.push({
      type: 'metrics',
      title: 'Key Insights',
      description: 'Auto-generated highlights for this report.',
      items: insights.map((insight) => ({
        label: insight.title,
        value: insight.text,
        tone: insight.tone,
      })),
    });
  }
  const theme = resolveReportTheme(report.report_key);
  return {
    ...report,
    theme: {
      gradient: theme.gradient,
      accent: theme.accent,
      tagline: 'Analytics dashboard',
      palette: theme.palette,
    },
    sections,
  };
}

export default function ReportsPage() {
  const router = useRouter();
  const { user, loading: authLoading, logout } = useProtectedPage({
    allowedRoles: ['admin', 'manager'],
    unauthorizedRedirect: '/403',
  });
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [reportLoading, setReportLoading] = useState(false);
  const [exportingAll, setExportingAll] = useState(false);
  const [availableReports, setAvailableReports] = useState<ReportDefinition[]>([]);
  const [branchOptions, setBranchOptions] = useState<BranchOption[]>([]);
  const [selectedReportKey, setSelectedReportKey] = useState('');
  const [currentReport, setCurrentReport] = useState<ReportPayload | null>(null);
  const [draftFilters, setDraftFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [initialFilters, setInitialFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [currentExportFormat, setCurrentExportFormat] = useState<ReportExportFormat>('pdf');
  const [selectedPayrollFocus, setSelectedPayrollFocus] = useState<PayrollFocusKey>(DEFAULT_PAYROLL_FOCUS);

  const [expandedTableSection, setExpandedTableSection] = useState<ReportTableSection | null>(null);
  const [expandedTablePage, setExpandedTablePage] = useState(1);
  // Rows per page comes from Settings → Pagination, same as every other list.
  const REPORT_TABLE_PAGE_SIZE = usePaginationSetting();

  const selectedReportDefinition = useMemo(
    () => availableReports.find((item) => item.key === selectedReportKey) || null,
    [availableReports, selectedReportKey]
  );
  const displayReport = useMemo(
    () => buildFocusedPayrollReport(currentReport, selectedPayrollFocus),
    [currentReport, selectedPayrollFocus]
  );
  const activeReportKey = displayReport?.report_key || selectedReportKey;
  const isPayrollReportSelected = selectedReportKey === 'payroll_attendance';
  const selectedPayrollFocusDefinition = useMemo(
    () => PAYROLL_FOCUS_OPTIONS.find((item) => item.key === selectedPayrollFocus) || PAYROLL_FOCUS_OPTIONS[0],
    [selectedPayrollFocus]
  );
  const defaultReportRoute = useMemo(
    () => resolveBaseReportRoute(activeReportKey, user?.role),
    [activeReportKey, user?.role]
  );

  useEffect(() => {
    setExpandedTableSection(null);
  }, [displayReport]);

  useEffect(() => {
    setExpandedTablePage(1);
  }, [expandedTableSection]);

  useEffect(() => {
    setExpandedTablePage(1);
  }, [REPORT_TABLE_PAGE_SIZE]);

  const handleCardNavigate = useCallback(
    (event: MouseEvent<HTMLElement>, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      void router.push(path);
    },
    [router]
  );

  const resolveCardTarget = useCallback(
    (context = '') => resolveReportDestination(activeReportKey, user?.role, context),
    [activeReportKey, user?.role]
  );

  const reportLayout = useMemo(() => {
    if (!displayReport) {
      return {
        metricsSections: [] as ReportMetricsSection[],
        tableSections: [] as ReportTableSection[],
        derivedMetrics: [] as DerivedMetric[],
        spotlightMetrics: [] as DerivedMetric[],
        snapshotMetrics: [] as DerivedMetric[],
        performanceMetrics: [] as DerivedMetric[],
        primaryTable: null as ReportTableSection | null,
        secondaryTable: null as ReportTableSection | null,
        briefPoints: [] as string[],
      };
    }

    const metricsSections = displayReport.sections.filter(isMetricsSection);
    const tableSections = displayReport.sections.filter(isTableSection);
    const derivedMetrics = buildDerivedMetrics(metricsSections);
    const featuredMetricsSection = metricsSections[0] || null;
    const spotlightMetrics = buildDerivedMetrics(featuredMetricsSection ? [featuredMetricsSection] : [])
      .filter((item) => item.numericValue > 0)
      .slice(0, 5);
    const fallbackSpotlight = derivedMetrics.filter((item) => item.numericValue > 0).slice(0, 5);
    const snapshotMetrics = (featuredMetricsSection ? buildDerivedMetrics([featuredMetricsSection]) : derivedMetrics).slice(0, 4);
    const performanceMetrics = (derivedMetrics.filter((item) => item.numericValue > 0).length > 0
      ? derivedMetrics.filter((item) => item.numericValue > 0)
      : derivedMetrics
    ).slice(0, 6);
    const primaryTable = tableSections[0] || null;
    const secondaryTable = tableSections[1] || null;

    const briefPoints = [
      displayReport.description,
      `Scope: ${formatFilterSummary(displayReport)}`,
      `${metricsSections.length} metric section${metricsSections.length === 1 ? '' : 's'} and ${tableSections.length} data section${tableSections.length === 1 ? '' : 's'} are included in this analytics view.`,
      performanceMetrics[0]
        ? `Top tracked figure: ${performanceMetrics[0].label} at ${formatDisplayValue(performanceMetrics[0].value)}.`
        : '',
    ].filter(Boolean);

    return {
      metricsSections,
      tableSections,
      derivedMetrics,
      spotlightMetrics: spotlightMetrics.length > 0 ? spotlightMetrics : fallbackSpotlight,
      snapshotMetrics,
      performanceMetrics,
      primaryTable,
      secondaryTable,
      briefPoints,
    };
  }, [displayReport]);

  const reportTheme = useMemo(
    () => resolveReportTheme(displayReport?.report_key || selectedReportKey),
    [displayReport, selectedReportKey]
  );

  const reportInsights = useMemo(
    () => (displayReport ? buildReportInsights(displayReport) : []),
    [displayReport]
  );

  // Export payload mirrors the screen: featured metrics, primary/secondary
  // tables, and the Key Insights strip — nothing else.
  const exportReport = useMemo(
    () => (displayReport ? buildExportReport(displayReport, reportInsights) : null),
    [displayReport, reportInsights]
  );

  // Executive-only activity trend derived from the date table.
  const activityTrend = useMemo(() => {
    if (!displayReport || displayReport.report_key !== 'executive_overview') return null;
    const table = findReportTable(displayReport, 'recent activity trend');
    if (!table || table.rows.length === 0) return null;
    const rows = [...table.rows].reverse();
    return {
      labels: rows.map((row) => String(row.activity_date || '').slice(5) || String(row.activity_date || '')),
      activity: rows.map((row) => tableCellNumber(row, 'activity_count')),
      audit: rows.map((row) => tableCellNumber(row, 'audit_count')),
    };
  }, [displayReport]);

  const paginatedExpandedTableRows = useMemo(() => {
    if (!expandedTableSection) {
      return [];
    }

    const startIndex = (expandedTablePage - 1) * REPORT_TABLE_PAGE_SIZE;
    return expandedTableSection.rows.slice(startIndex, startIndex + REPORT_TABLE_PAGE_SIZE);
  }, [expandedTablePage, expandedTableSection, REPORT_TABLE_PAGE_SIZE]);

  const spotlightChartData = useMemo(() => {
    const items = reportLayout.spotlightMetrics;
    const palette = reportTheme.palette.length > 0 ? reportTheme.palette : REPORT_CHART_COLORS;
    return {
      labels: items.map((item) => item.label),
      datasets: [
        {
          data: items.map((item, index) => item.numericValue || items.length - index),
          backgroundColor: items.map((_, index) => palette[index % palette.length]),
          borderColor: '#ffffff',
          borderWidth: 3,
          hoverOffset: 6,
        },
      ],
    };
  }, [reportLayout.spotlightMetrics, reportTheme]);

  const spotlightChartOptions = useMemo<ChartOptions<'doughnut'>>(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const item = reportLayout.spotlightMetrics[context.dataIndex];
              return item ? `${item.label}: ${formatDisplayValue(item.value)}` : '';
            },
          },
        },
      },
    }),
    [reportLayout.spotlightMetrics]
  );

  const performanceChartData = useMemo(() => ({
    labels: reportLayout.performanceMetrics.map((item) => item.label),
    datasets: [
      {
        data: reportLayout.performanceMetrics.map((item, index) => item.numericValue || reportLayout.performanceMetrics.length - index),
        backgroundColor: reportLayout.performanceMetrics.map(
          (_, index) => (reportTheme.palette.length > 0 ? reportTheme.palette : REPORT_CHART_COLORS)[index % (reportTheme.palette.length > 0 ? reportTheme.palette : REPORT_CHART_COLORS).length]
        ),
        borderRadius: 8,
        borderSkipped: false as const,
        barThickness: 12,
      },
    ],
  }), [reportLayout.performanceMetrics, reportTheme]);

  const performanceChartOptions = useMemo<ChartOptions<'bar'>>(
    () => ({
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (context) => {
              const item = reportLayout.performanceMetrics[context.dataIndex];
              return item ? `${item.label}: ${formatDisplayValue(item.value)}` : '';
            },
          },
        },
      },
      scales: {
        x: {
          display: false,
          grid: { display: false },
          border: { display: false },
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: {
            color: '#475569',
            font: {
              size: 11,
              weight: 600,
            },
          },
        },
      },
    }),
    [reportLayout.performanceMetrics]
  );

  const fetchReportPayload = useCallback(
    async (reportKey: string, filters: FilterState) => {
      const response = await fetch(buildReportUrl(reportKey, filters), {
        credentials: 'include',
      });
      const payload = (await response.json()) as {
        success?: boolean;
        message?: string;
        data?: ReportPayload;
      };

      if (!payload?.success || !payload.data) {
        throw new Error(payload?.message || 'Failed to load the selected analytics view.');
      }

      return payload.data;
    },
    []
  );

  useEffect(() => {
    if (authLoading || !user) return;

    let active = true;

    const loadCatalog = async () => {
      setCatalogLoading(true);
      try {
        const response = await fetch(`${API_BASE}/reports.php?action=list`, {
          credentials: 'include',
        });
        const payload = (await response.json()) as {
          success?: boolean;
          message?: string;
          data?: CatalogResponse;
        };

        if (!payload?.success || !payload.data) {
          throw new Error(payload?.message || 'Failed to load analytics options.');
        }

        if (!active) return;

        const reports = Array.isArray(payload.data.reports) ? payload.data.reports : [];
        const branches = Array.isArray(payload.data.branches) ? payload.data.branches : [];
        const scopedBranchId = payload.data.scope?.branch_id ? String(payload.data.scope.branch_id) : 'all';
        const nextFilters: FilterState = {
          dateFrom: '',
          dateTo: '',
          branchId: scopedBranchId,
        };

        setAvailableReports(reports);
        setBranchOptions(branches);
        setInitialFilters(nextFilters);
        setDraftFilters(nextFilters);
        setAppliedFilters(nextFilters);
        setSelectedReportKey((current) => current || reports[0]?.key || '');
      } catch (catalogError) {
        if (active) {
          void notifyError(catalogError instanceof Error ? catalogError.message : 'Failed to load analytics options.');
        }
      } finally {
        if (active) {
          setCatalogLoading(false);
        }
      }
    };

    void loadCatalog();

    return () => {
      active = false;
    };
  }, [authLoading, user]);

  useEffect(() => {
    if (authLoading || !user || !selectedReportKey) return;

    let active = true;
    setReportLoading(true);

    const loadReport = async () => {
      try {
        const report = await fetchReportPayload(selectedReportKey, appliedFilters);
        if (!active) return;
        setCurrentReport(report);
      } catch (reportError) {
        if (active) {
          setCurrentReport(null);
          void notifyError(reportError instanceof Error ? reportError.message : 'Failed to load the selected analytics view.');
        }
      } finally {
        if (active) {
          setReportLoading(false);
        }
      }
    };

    void loadReport();

    return () => {
      active = false;
    };
  }, [appliedFilters, authLoading, fetchReportPayload, selectedReportKey, user]);

  useEffect(() => {
    if (selectedReportKey === 'payroll_attendance') return;
    setSelectedPayrollFocus(DEFAULT_PAYROLL_FOCUS);
  }, [selectedReportKey]);

  const handleSelectReport = (reportKey: string) => {
    startTransition(() => {
      setSelectedReportKey(reportKey);
      if (reportKey !== 'payroll_attendance') {
        setSelectedPayrollFocus(DEFAULT_PAYROLL_FOCUS);
      }
    });
  };

  const handleSelectPayrollFocus = (focus: PayrollFocusKey) => {
    startTransition(() => {
      setSelectedPayrollFocus(focus);
    });
  };

  const handleDraftFilterChange = (field: keyof FilterState, value: string) => {
    setDraftFilters((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const handleApplyFilters = () => {
    if (draftFilters.dateFrom && draftFilters.dateTo && draftFilters.dateFrom > draftFilters.dateTo) {
      void notifyError('The start date cannot be later than the end date.');
      return;
    }

    startTransition(() => {
      setAppliedFilters(draftFilters);
    });
  };

  const handleResetFilters = () => {
    setDraftFilters(initialFilters);
    startTransition(() => {
      setAppliedFilters(initialFilters);
    });
  };

  const [exportingCurrent, setExportingCurrent] = useState(false);

  const handleExportCurrent = async () => {
    if (!exportReport) {
      void notifyError('Load an analytics view before exporting it.');
      return;
    }

    setExportingCurrent(true);
    try {
      await downloadSingleReport(exportReport, currentExportFormat);
    } catch (exportError) {
      void notifyError(exportError instanceof Error ? exportError.message : 'Failed to export the current analytics view.');
    } finally {
      setExportingCurrent(false);
    }
  };

  const handleExportAll = async () => {
    if (availableReports.length === 0) {
      void notifyError('No reports are available to export.');
      return;
    }

    setExportingAll(true);
    try {
      const reports = await Promise.all(
        availableReports.map((item) => fetchReportPayload(item.key, appliedFilters))
      );
      const exportPayloads = reports.map((report) => {
        const focused = report.report_key === 'payroll_attendance'
          ? buildFocusedPayrollReport(report, selectedPayrollFocus) || report
          : report;
        return buildExportReport(focused, buildReportInsights(focused));
      });
      await downloadAllReports(exportPayloads, currentExportFormat);
    } catch (exportError) {
      void notifyError(exportError instanceof Error ? exportError.message : 'Failed to export all reports.');
    } finally {
      setExportingAll(false);
    }
  };


  if (authLoading || catalogLoading) {
    return (
      <Layout role={user?.role as string | undefined} user={user} onLogout={logout}>
        <div className={styles.page}>
          <div className={styles.loadingCard}>Loading analytics...</div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout role={user?.role as string | undefined} user={user} onLogout={logout}>
      <Head>
        <title>Analytics | Capstone1</title>
      </Head>

      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <h1 className={styles.title}>Analytics Dashboard</h1>
            <p className={styles.subtitle}>Monitor, compare, and export operational analytics from one clean workspace.</p>
          </div>
          <div className={styles.metaRow}>
            <span className={`${styles.metaChip} ${styles.metaChipStrong}`}>
              {displayReport?.title || selectedReportDefinition?.title || 'No analytics selected'}
            </span>
            <span className={styles.metaChip}>Scope: {formatFilterSummary(displayReport)}</span>
            {isPayrollReportSelected ? (
              <span className={styles.metaChip}>Focus: {selectedPayrollFocusDefinition.label}</span>
            ) : null}
            <span className={styles.metaChip}>
              Updated:{' '}
              {displayReport
                ? new Date(displayReport.generated_at).toLocaleString()
                : 'Waiting for data'}
            </span>
          </div>
        </header>

        <section className={styles.commandCard}>
          <div className={styles.commandTop}>
            <div className={styles.filtersGrid}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>Analytics view</span>
                <select
                  className={styles.select}
                  value={selectedReportKey}
                  onChange={(event) => handleSelectReport(event.target.value)}
                >
                  {availableReports.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Date from</span>
                <input
                  className={styles.input}
                  type="date"
                  value={draftFilters.dateFrom}
                  onChange={(event) => handleDraftFilterChange('dateFrom', event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Date to</span>
                <input
                  className={styles.input}
                  type="date"
                  value={draftFilters.dateTo}
                  onChange={(event) => handleDraftFilterChange('dateTo', event.target.value)}
                />
              </label>

              <label className={styles.field}>
                <span className={styles.fieldLabel}>Branch</span>
                <select
                  className={styles.select}
                  value={draftFilters.branchId}
                  onChange={(event) => handleDraftFilterChange('branchId', event.target.value)}
                  disabled={branchOptions.length <= 1}
                >
                  {branchOptions.length > 1 ? <option value="all">All branches</option> : null}
                  {branchOptions.map((branch) => (
                    <option key={branch.branch_id} value={String(branch.branch_id)}>
                      {branch.branch_name}
                    </option>
                  ))}
                  {branchOptions.length === 0 ? <option value="all">All branches</option> : null}
                </select>
              </label>
            </div>

            <div className={styles.exportBlock}>
              <div className={styles.exportControls}>
                <select
                  className={styles.exportSelect}
                  value={currentExportFormat}
                  onChange={(event) => setCurrentExportFormat(event.target.value as ReportExportFormat)}
                  aria-label="Visual analytics export format"
                >
                  {VISUAL_EXPORT_FORMATS.map((format) => (
                    <option key={format.value} value={format.value}>
                      {format.label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={() => void handleExportCurrent()}
                  disabled={!displayReport || exportingCurrent}
                >
                  {exportingCurrent ? 'Exporting…' : 'Export'}
                </button>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => void handleExportAll()}
                  disabled={exportingAll || availableReports.length === 0}
                >
                  {exportingAll ? 'Preparing…' : 'Export all'}
                </button>

              </div>
              <p className={styles.exportHint}>Visual exports match the dashboard; Excel uses the same color-coded analytics structure.</p>
            </div>
          </div>

          <div className={styles.actionRow}>
            <button type="button" className={styles.btnPrimary} onClick={handleApplyFilters}>
              Apply filters
            </button>
            <button type="button" className={styles.btnGhost} onClick={handleResetFilters}>
              Reset
            </button>
          </div>

          {isPayrollReportSelected ? (
            <div className={styles.focusBlock}>
              <div className={styles.focusLabel}>Payroll focus</div>
              <div className={styles.focusRow}>
                {PAYROLL_FOCUS_OPTIONS.map((option) => {
                  const isActive = option.key === selectedPayrollFocus;
                  return (
                    <button
                      key={option.key}
                      type="button"
                      className={`${styles.focusChip}${isActive ? ` ${styles.focusChipActive}` : ''}`}
                      onClick={() => handleSelectPayrollFocus(option.key)}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
              <p className={styles.focusDescription}>{selectedPayrollFocusDefinition.description}</p>
            </div>
          ) : null}
        </section>

        {reportLoading ? (
          <div className={styles.loadingCard}>Loading analytics…</div>
        ) : !displayReport ? (
          <div className={styles.emptyState}>Select an analytics view and apply filters to begin.</div>
        ) : (
          <>
            <div className={styles.dashboardGrid}>
            {reportInsights.length > 0 ? (
              <div className={styles.insightGrid}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelHeaderText}>
                    <div className={styles.eyebrow}>Data signals</div>
                    <div className={styles.panelTitle}>Key insights</div>
                  </div>
                </div>
                {reportInsights.map((insight) => (
                  <div key={`insight-${insight.key}`} className={styles.insightCard}>
                    <span className={styles.insightDot} style={{ background: reportTheme.accent }} aria-hidden="true" />
                    <div className={styles.insightText}>
                      <strong className={styles.insightTitle}>{insight.title}</strong>
                      <span className={styles.insightBody}>{insight.text}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            {activityTrend ? (
              <article className={styles.panel}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelHeaderText}>
                    <div className={styles.eyebrow}>Momentum</div>
                    <div className={styles.panelTitle}>Activity trend</div>
                  </div>
                </div>
                <div className={styles.trendChartFrame}>
                  <Bar
                    data={{
                      labels: activityTrend.labels,
                      datasets: [
                        {
                          label: 'Activity Logs',
                          data: activityTrend.activity,
                          backgroundColor: reportTheme.accent,
                          borderRadius: 5,
                          borderSkipped: false as const,
                          barThickness: 14,
                        },
                        {
                          label: 'Audit Changes',
                          data: activityTrend.audit,
                          backgroundColor: '#8abfc2',
                          borderRadius: 5,
                          borderSkipped: false as const,
                          barThickness: 14,
                        },
                      ],
                    }}
                    options={{
                      responsive: true,
                      maintainAspectRatio: false,
                      plugins: {
                        legend: {
                          position: 'top' as const,
                          align: 'end' as const,
                          labels: { color: '#475569', font: { size: 11, weight: 600 }, boxWidth: 12, boxHeight: 12, usePointStyle: true },
                        },
                        tooltip: { callbacks: { label: (context) => ` ${context.dataset.label}: ${context.parsed.y}` } },
                      },
                      scales: {
                        x: { grid: { display: false }, ticks: { color: '#64748b', font: { size: 10 } } },
                        y: { beginAtZero: true, grid: { color: '#eef2f7' }, ticks: { color: '#64748b', font: { size: 10 }, precision: 0 } },
                      },
                    }}
                  />
                </div>
              </article>
            ) : null}

            {reportLayout.snapshotMetrics.length > 0 ? (
              <div className={styles.kpiGrid}>
                <div className={styles.panelHeader}>
                  <div className={styles.panelHeaderText}>
                    <div className={styles.eyebrow}>{reportLayout.metricsSections[0]?.title || 'Overview'}</div>
                    <div className={styles.panelTitle}>Performance overview</div>
                  </div>
                </div>
                <div className={styles.gaugeGrid}>
                {reportLayout.snapshotMetrics.slice(0, 3).map((metric, index) => {
                  const gaugeValue = getMetricGaugeValue(metric, reportLayout.snapshotMetrics);
                  const gaugeColor = REPORT_GAUGE_COLORS[index % REPORT_GAUGE_COLORS.length];
                  return (
                  <div
                    key={`kpi-${metric.key}`}
                    className={`${styles.kpiCard} ${styles.kpiCardInteractive}`}
                    title="Double-click to open the related page."
                    onDoubleClick={(event) =>
                      handleCardNavigate(event, resolveCardTarget(`${metric.sectionTitle} ${metric.label}`))
                    }
                  >
                    <span className={styles.kpiLabel}>{metric.label}</span>
                    <div
                      className={styles.metricGauge}
                      style={{
                        '--gauge-value': `${gaugeValue * 2.7}deg`,
                        '--gauge-color': gaugeColor,
                      } as CSSProperties}
                      aria-label={`${metric.label}: ${formatDisplayValue(metric.value)}`}
                    >
                      <div className={styles.metricGaugeCenter}>
                        <strong className={styles.kpiValue}>{formatDisplayValue(metric.value)}</strong>
                      </div>
                    </div>
                    {metric.hint ? <span className={styles.kpiHint}>{metric.hint}</span> : null}
                  </div>
                  );
                })}
                </div>
              </div>
            ) : null}

            <div className={styles.mainGrid}>
              <div className={styles.column}>
                <article
                  className={`${styles.panel} ${styles.panelInteractive}`}
                  title="Double-click to open the related page."
                  onDoubleClick={(event) =>
                    handleCardNavigate(
                      event,
                      resolveCardTarget(reportLayout.metricsSections[0]?.title || displayReport.title)
                    )
                  }
                >
                  <div className={styles.panelHeader}>
                    <div className={styles.panelHeaderText}>
                      <div className={styles.eyebrow}>
                        {reportLayout.metricsSections[0]?.title || 'Metric mix'}
                      </div>
                      <div className={styles.panelTitle}>Distribution overview</div>
                    </div>
                  </div>
                  {reportLayout.spotlightMetrics.length > 0 ? (
                    <div className={styles.spotlightBody}>
                      <div className={styles.chartFrame}>
                        <Doughnut data={spotlightChartData} options={spotlightChartOptions} />
                      </div>
                      <div className={styles.legendList}>
                        {reportLayout.spotlightMetrics.map((metric, index) => (
                          <div
                            key={`spotlight-${metric.key}`}
                            className={`${styles.legendRow} ${styles.legendRowInteractive}`}
                            title="Double-click to open the related page."
                            onDoubleClick={(event) =>
                              handleCardNavigate(
                                event,
                                resolveCardTarget(`${metric.sectionTitle} ${metric.label}`)
                              )
                            }
                          >
                            <span
                              className={styles.legendSwatch}
                              style={{ background: (reportTheme.palette.length > 0 ? reportTheme.palette : REPORT_CHART_COLORS)[index % (reportTheme.palette.length > 0 ? reportTheme.palette : REPORT_CHART_COLORS).length] }}
                            />
                            <div className={styles.legendText}>
                              <strong className={styles.legendLabel}>{metric.label}</strong>
                              <span className={styles.legendValue}>{formatDisplayValue(metric.value)}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <div className={styles.emptyMini}>No chart-ready metrics are available for this analytics view.</div>
                  )}
                </article>

                {reportLayout.performanceMetrics.length > 1 ? (
                  <article
                    className={`${styles.panel} ${styles.panelInteractive}`}
                    title="Double-click to open the related page."
                    onDoubleClick={(event) => handleCardNavigate(event, defaultReportRoute)}
                  >
                    <div className={styles.panelHeader}>
                      <div className={styles.panelHeaderText}>
                        <div className={styles.eyebrow}>Performance</div>
                        <div className={styles.panelTitle}>Metric ranking</div>
                      </div>
                    </div>
                    <div className={styles.barChartFrame}>
                      <Bar data={performanceChartData} options={performanceChartOptions} />
                    </div>
                  </article>
                ) : null}
              </div>

              <div className={styles.column}>
                {reportLayout.primaryTable ? (
                  <article
                    className={`${styles.panel} ${styles.panelInteractive}`}
                    title="Double-click to open the related page."
                    onDoubleClick={(event) =>
                      handleCardNavigate(
                        event,
                        resolveCardTarget(reportLayout.primaryTable?.title || displayReport.title)
                      )
                    }
                  >
                    <div className={styles.panelHeader}>
                      <div className={styles.panelHeaderText}>
                        <div className={styles.eyebrow}>{reportLayout.primaryTable.title}</div>
                        <div className={styles.panelTitle}>Detailed analytics</div>
                      </div>
                      <ExpandIconButton
                        label={`Expand ${reportLayout.primaryTable.title}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setExpandedTableSection(reportLayout.primaryTable);
                        }}
                      />
                    </div>
                    {renderPreviewRows(reportLayout.primaryTable, REPORT_TABLE_PREVIEW_LIMIT, {
                      getRowTarget: () =>
                        resolveCardTarget(reportLayout.primaryTable?.title || displayReport.title),
                      onNavigate: handleCardNavigate,
                    })}
                    {reportLayout.primaryTable.rows.length > REPORT_TABLE_PREVIEW_LIMIT ? (
                      <div className={styles.previewMeta}>
                        Showing {REPORT_TABLE_PREVIEW_LIMIT} of {reportLayout.primaryTable.rows.length} rows
                      </div>
                    ) : null}
                  </article>
                ) : (
                  <div className={styles.emptyState}>No detailed analytics are available for this view.</div>
                )}

                {reportLayout.secondaryTable ? (
                  <article
                    className={`${styles.panel} ${styles.panelInteractive}`}
                    title="Double-click to open the related page."
                    onDoubleClick={(event) =>
                      handleCardNavigate(
                        event,
                        resolveCardTarget(reportLayout.secondaryTable?.title || displayReport.title)
                      )
                    }
                  >
                    <div className={styles.panelHeader}>
                      <div className={styles.panelHeaderText}>
                        <div className={styles.eyebrow}>{reportLayout.secondaryTable.title}</div>
                        <div className={styles.panelTitle}>Supporting analytics</div>
                      </div>
                      <ExpandIconButton
                        label={`Expand ${reportLayout.secondaryTable.title}`}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setExpandedTableSection(reportLayout.secondaryTable);
                        }}
                      />
                    </div>
                    {renderPreviewRows(reportLayout.secondaryTable, REPORT_TABLE_PREVIEW_LIMIT, {
                      getRowTarget: () =>
                        resolveCardTarget(reportLayout.secondaryTable?.title || displayReport.title),
                      onNavigate: handleCardNavigate,
                    })}
                    {reportLayout.secondaryTable.rows.length > REPORT_TABLE_PREVIEW_LIMIT ? (
                      <div className={styles.previewMeta}>
                        Showing {REPORT_TABLE_PREVIEW_LIMIT} of {reportLayout.secondaryTable.rows.length} rows
                      </div>
                    ) : null}
                  </article>
                ) : null}
              </div>
            </div>
            </div>
          </>
        )}

        <FloatingListPanel
          open={expandedTableSection !== null}
          onClose={() => setExpandedTableSection(null)}
          title={expandedTableSection?.title || 'Expanded table'}
          description={
            expandedTableSection?.description
            || (expandedTableSection ? `${expandedTableSection.rows.length} rows available in this section.` : undefined)
          }
        >
          {expandedTableSection ? (
            <>
              {renderExpandedTableRows(expandedTableSection, paginatedExpandedTableRows)}
              <Pagination
                currentPage={expandedTablePage}
                totalItems={expandedTableSection.rows.length}
                itemsPerPage={REPORT_TABLE_PAGE_SIZE}
                onPageChange={setExpandedTablePage}
                label="rows"
              />
            </>
          ) : null}
        </FloatingListPanel>
      </div>
    </Layout>
  );
}
