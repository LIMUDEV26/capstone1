import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { type NextRouter, useRouter } from 'next/router';
import Layout from '@/components/Layout';
import Pagination from '@/components/Pagination';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError } from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API = getApiBaseUrl();

type SessionUser = {
  role?: string;
  [key: string]: unknown;
};

type PrecheckSummary = {
  period: {
    pay_period_start: string;
    pay_period_end: string;
    ot_threshold: number;
  };
  total_anomalies: number;
  missing_logs: number;
  overtime_outliers: number;
  unresolved_leaves: number;
  severity: {
    low: number;
    medium: number;
    high: number;
    critical: number;
  };
};

type AnomalyRow = {
  anomaly_id: string;
  type: 'missing_logs' | 'overtime_outlier' | 'unresolved_leave' | string;
  severity: 'low' | 'medium' | 'high' | 'critical' | string;
  employee_id: number;
  employee_name: string;
  source_record_id: number | null;
  title: string;
  details: string;
  recommended_action: string;
};

type ApiResponse<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

type PrecheckPayload = {
  summary: PrecheckSummary;
  anomalies: AnomalyRow[];
};

function getDefaultPeriod() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = now.getDate();
  if (d <= 15) {
    return { start: `${y}-${m}-01`, end: `${y}-${m}-15` };
  }
  const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
  return { start: `${y}-${m}-16`, end: `${y}-${m}-${String(lastDay).padStart(2, '0')}` };
}

export default function PayrollPrecheckPage() {
  const ITEMS_PER_PAGE = usePaginationSetting();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<PrecheckSummary | null>(null);
  const [rows, setRows] = useState<AnomalyRow[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const defaults = useMemo(() => getDefaultPeriod(), []);
  const [payPeriodStart, setPayPeriodStart] = useState(defaults.start);
  const [payPeriodEnd, setPayPeriodEnd] = useState(defaults.end);
  const [otThreshold, setOtThreshold] = useState('20');
  const [queueResults, setQueueResults] = useState(true);

  useEffect(() => {
    const init = async () => {
      try {
        const sessionRes = await fetch(`${API}/auth.php`, { credentials: 'include' });
        const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
        if (!sessionData.success || !sessionData.data) {
          router.push('/');
          return;
        }

        const role = String(sessionData.data.role || '').toLowerCase();
        if (!['manager', 'admin'].includes(role)) {
          router.push('/dashboard');
          return;
        }

        setUser(sessionData.data);
        await runPrecheck(defaults.start, defaults.end, '20', true);
      } catch {
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [router, defaults.end, defaults.start]);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
    setError('');
  }, [error]);

  const runPrecheck = async (start: string, end: string, threshold: string, queue: boolean) => {
    setRunning(true);
    setError('');
    try {
      const params = new URLSearchParams({
        pay_period_start: start,
        pay_period_end: end,
        ot_threshold: String(Number(threshold) || 20),
        queue: queue ? '1' : '0',
      });
      const res = await fetch(`${API}/payroll-precheck.php?${params.toString()}`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<PrecheckPayload>;
      if (data.success && data.data) {
        setSummary(data.data.summary);
        setRows(Array.isArray(data.data.anomalies) ? data.data.anomalies : []);
        setCurrentPage(1);
      } else {
        setSummary(null);
        setRows([]);
        setError(data.message || 'Failed to run payroll pre-check.');
      }
    } catch {
      setSummary(null);
      setRows([]);
      setError('Failed to run payroll pre-check.');
    } finally {
      setRunning(false);
    }
  };

  const paginatedRows = useMemo(() => {
    return rows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  }, [rows, currentPage]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [rows.length, currentPage]);

  const handleLogout = async () => {
    await fetch(`${API}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
    router.push('/');
  };

  if (loading) {

    return (

      <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>

        <div style={{ padding: 20 }}>Loading...</div>

      </Layout>

    );

  }

  return (
    <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>
      <Head>
        <title>Payroll Pre-check</title>
      </Head>

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 14, color: '#1f2937' }}>Payroll Pre-check</h1>
          <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13 }}>
            Detect missing logs, overtime outliers, and unresolved leaves before payroll approval.
          </p>
        </div>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, marginBottom: 12 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, alignItems: 'end' }}>
            <div>
              <label style={labelStyle}>Pay Period Start</label>
              <input type="date" value={payPeriodStart} onChange={(e) => setPayPeriodStart(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Pay Period End</label>
              <input type="date" value={payPeriodEnd} onChange={(e) => setPayPeriodEnd(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>OT Outlier Threshold (hours)</label>
              <input type="number" min={1} step={0.5} value={otThreshold} onChange={(e) => setOtThreshold(e.target.value)} style={inputStyle} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#334155', fontWeight: 600 }}>
              <input type="checkbox" checked={queueResults} onChange={(e) => setQueueResults(e.target.checked)} />
              Queue anomalies for review tracking
            </label>
            <button
              onClick={() => void runPrecheck(payPeriodStart, payPeriodEnd, otThreshold, queueResults)}
              style={{
                ...runBtn,
                opacity: running ? 0.75 : 1,
                cursor: running ? 'not-allowed' : 'pointer',
              }}
              disabled={running}
            >
              {running ? 'Running...' : 'Run Pre-check'}
            </button>
          </div>
        </div>

        {summary && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 10 }}>
              <SummaryCard label="Total Anomalies" value={summary.total_anomalies} color="#1e3a8a" background="#dbeafe" />
              <SummaryCard label="Missing Logs" value={summary.missing_logs} color="#b91c1c" background="#fee2e2" />
              <SummaryCard label="OT Outliers" value={summary.overtime_outliers} color="#92400e" background="#fef3c7" />
              <SummaryCard label="Unresolved Leaves" value={summary.unresolved_leaves} color="#6d28d9" background="#ede9fe" />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginBottom: 12 }}>
              <MiniSeverity label="Critical" value={summary.severity.critical} color="#991b1b" />
              <MiniSeverity label="High" value={summary.severity.high} color="#b91c1c" />
              <MiniSeverity label="Medium" value={summary.severity.medium} color="#92400e" />
              <MiniSeverity label="Low" value={summary.severity.low} color="#334155" />
            </div>
          </>
        )}

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Severity</th>
                <th style={thStyle}>Employee</th>
                <th style={thStyle}>Issue</th>
                <th style={thStyle}>Recommended Action</th>
                <th style={thStyle}>Open</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
                    No anomalies found for the selected payroll period.
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => (
                  <tr key={row.anomaly_id} style={{ borderTop: '1px solid #eef2f7' }}>
                    <td style={tdStyle}>
                      <span style={typePill(row.type)}>{formatType(row.type)}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={severityPill(row.severity)}>{row.severity}</span>
                    </td>
                    <td className="llb-trunc" title={row.employee_name || `Employee #${row.employee_id}`} style={tdStyle}>{row.employee_name || `Employee #${row.employee_id}`}</td>
                    <td style={tdStyle}>
                      <div style={{ fontWeight: 600, color: '#0f172a' }}>{row.title}</div>
                      <div style={{ color: '#64748b', fontSize: 12 }}>{row.details}</div>
                    </td>
                    <td className="llb-trunc" title={row.recommended_action} style={tdStyle}>{row.recommended_action}</td>
                    <td className="llb-actions" style={tdStyle}>
                      <button
                        onClick={() => routeFromAnomaly(router, row)}
                        style={{
                          border: '1px solid #1e3a8a',
                          background: '#fff',
                          color: '#1e3a8a',
                          borderRadius: 8,
                          padding: '6px 10px',
                          fontSize: 12,
                          cursor: 'pointer',
                          fontWeight: 600,
                        }}
                      >
                        Open
                      </button>
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
          label="anomalies"
        />
      </div>
    </Layout>
  );
}

function routeFromAnomaly(router: NextRouter, row: AnomalyRow) {
  if (row.type === 'unresolved_leave' && row.source_record_id) {
    router.push(`/leave-requests?request_id=${row.source_record_id}`);
    return;
  }
  if (row.type === 'overtime_outlier') {
    router.push('/overtime-requests');
    return;
  }
  router.push('/employees');
}

function formatType(value: string) {
  if (value === 'missing_logs') return 'Missing Logs';
  if (value === 'overtime_outlier') return 'OT Outlier';
  if (value === 'unresolved_leave') return 'Unresolved Leave';
  return value;
}

function SummaryCard({ label, value, color, background }: { label: string; value: number; color: string; background: string }) {
  return (
    <div style={{ background, border: '1px solid rgba(15,23,42,0.06)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 12, color }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

function MiniSeverity({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
      <div style={{ fontSize: 12, color }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const labelStyle: CSSProperties = {
  display: 'block',
  marginBottom: 6,
  fontSize: 12,
  color: '#475569',
  fontWeight: 700,
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#1f2937',
};

const runBtn: CSSProperties = {
  border: '1px solid #1e3a8a',
  background: '#1e3a8a',
  color: '#fff',
  borderRadius: 10,
  padding: '10px 12px',
  fontWeight: 700,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '12px 14px',
  color: '#475569',
  fontSize: 13,
  fontWeight: 700,
};

const tdStyle: CSSProperties = {
  padding: '12px 14px',
  color: '#334155',
  fontSize: 13,
  verticalAlign: 'top',
};

function severityPill(value: string): CSSProperties {
  if (value === 'critical') return { background: '#991b1b', color: '#fff', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (value === 'high') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (value === 'medium') return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  return { background: '#e2e8f0', color: '#334155', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
}

function typePill(value: string): CSSProperties {
  if (value === 'missing_logs') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (value === 'overtime_outlier') return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  return { background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
}

