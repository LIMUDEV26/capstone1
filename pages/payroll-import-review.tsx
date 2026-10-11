import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import ClockLoader from '@/components/ClockLoader';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';

const API = getApiBaseUrl();

type SessionUser = {
  role?: string;
  [key: string]: unknown;
};

type BatchRow = {
  batch_id: string;
  source_system: string;
  original_filename: string;
  pay_period_start: string;
  pay_period_end: string;
  status: 'pending_review' | 'processing' | 'processed' | 'rejected' | string;
  review_note?: string | null;
  records_parsed: number;
  records_ready: number;
  records_skipped: number;
  records_processed: number;
  records_failed: number;
  uploaded_by_name?: string | null;
  reviewed_by_name?: string | null;
  created_at: string;
  reviewed_at?: string | null;
  processed_at?: string | null;
  warnings?: string[];
  errors?: string[];
  identity_summary?: {
    matched_via_biometric_id?: number;
    matched_via_base44?: number;
    matched_via_smart_name?: number;
    unresolved?: number;
    source_system?: string;
  };
};

type BatchItem = {
  item_id: number;
  row_number: number;
  external_employee_code?: string | null;
  external_employee_name?: string | null;
  external_role?: string | null;
  external_branch?: string | null;
  matched_employee_id?: number | null;
  matched_employee_name?: string | null;
  identity_method?: string | null;
  identity_label?: string | null;
  identity_confidence?: number | null;
  days_worked: number;
  overtime_hours: number;
  late_minutes: number;
  absent_days: number;
  leave_days: number;
  status: 'ready' | 'skipped' | 'processed' | 'duplicate' | 'failed' | string;
  error_message?: string | null;
  created_payroll_id?: number | null;
};

type ApiResponse<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

type BatchPayload = {
  batch: BatchRow;
  items: BatchItem[];
};

export default function PayrollImportReviewPage() {
  const router = useRouter();
  const batchId = String(router.query.batch_id || router.query.id || '').trim();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [batch, setBatch] = useState<BatchRow | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);

  const role = String(user?.role || '').toLowerCase();
  const isAdmin = role === 'admin';

  useEffect(() => {
    const init = async () => {
      try {
        const sessionRes = await fetch(`${API}/auth.php`, { credentials: 'include' });
        const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
        if (!sessionData.success || !sessionData.data) {
          router.push('/');
          return;
        }

        const nextRole = String(sessionData.data.role || '').toLowerCase();
        if (!['manager', 'admin'].includes(nextRole)) {
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

    void init();
  }, [router]);

  useEffect(() => {
    if (!user || !batchId) return;
    void fetchBatch();
  }, [user, batchId]);

  useEffect(() => {
    if (!batchId || batch?.status !== 'processing') return;
    const timer = window.setInterval(() => {
      void fetchBatch(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [batchId, batch?.status]);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
    setError('');
  }, [error]);

  const fetchBatch = async (silent = false) => {
    try {
      const res = await fetch(`${API}/attendance_import.php?action=batch&id=${encodeURIComponent(batchId)}`, {
        credentials: 'include',
      });
      const data = (await res.json()) as ApiResponse<BatchPayload>;
      if (data.success && data.data) {
        setBatch(data.data.batch);
        setItems(Array.isArray(data.data.items) ? data.data.items : []);
      } else {
        if (!silent) {
          setBatch(null);
          setItems([]);
          setError(data.message || 'Failed to load attendance import batch.');
        }
      }
    } catch {
      if (!silent) {
        setBatch(null);
        setItems([]);
        setError('Failed to load attendance import batch.');
      }
    }
  };

  const handleReview = async (action: 'approve_batch' | 'reject_batch') => {
    if (!batch || !batchId) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/attendance_import.php`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          batch_id: batchId,
          action,
        }),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to review attendance import batch.');
        return;
      }
      if (action === 'approve_batch') {
        setBatch(prev => prev ? {
          ...prev,
          status: 'processing',
          review_note: 'Approved by admin. Processing payroll generation.',
        } : prev);
        void notifySuccess('Attendance import batch accepted. Payroll generation is now processing.');
        void fetchBatch(true);
      } else {
        void notifySuccess('Attendance import batch rejected.');
        setBatch(prev => prev ? { ...prev, status: 'rejected' } : prev);
      }
    } catch {
      setError('Failed to review attendance import batch.');
    } finally {
      setSubmitting(false);
    }
  };

  const readyItems = useMemo(() => items.filter(item => item.status === 'ready'), [items]);
  const skippedItems = useMemo(() => items.filter(item => item.status !== 'ready'), [items]);
  const isProcessingBatch = batch?.status === 'processing';

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
        <title>Payroll Import Review</title>
      </Head>

      <div style={{ maxWidth: 1280, margin: '0 auto', padding: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 14, color: '#0f172a' }}>Payroll Import Review</h1>
            <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13 }}>
              Review staged biometric upload rows before processing them into draft payroll.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => router.push('/manager/dashboard')} style={secondaryBtn}>Back to Dashboard</button>
            {isAdmin && batch?.status === 'pending_review' && (
              <>
                <button onClick={() => void handleReview('reject_batch')} disabled={submitting} style={dangerBtn}>
                  Reject Batch
                </button>
                <button onClick={() => void handleReview('approve_batch')} disabled={submitting} style={primaryBtn}>
                  {submitting ? 'Processing...' : 'Process to Draft Payroll'}
                </button>
              </>
            )}
          </div>
        </div>

        {!batch ? (
          <div style={cardStyle}>No attendance import batch found.</div>
        ) : (
          <>
            {isProcessingBatch && (
              <div style={{ ...cardStyle, marginBottom: 12, borderColor: '#bfdbfe', background: '#eff6ff' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <ClockLoader size={28} />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14, color: '#1e3a8a' }}>Processing payroll from attendance import</div>
                    <div style={{ marginTop: 4, color: '#475569', fontSize: 13 }}>
                      Small batches should finish quickly. Large batches may take longer, but this page will refresh automatically until processing is complete.
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
              <SummaryCard label="Batch ID" value={batch.batch_id} />
              <SummaryCard label="Status" value={batch.status} />
              <SummaryCard label="Ready Rows" value={String(batch.records_ready || 0)} />
              <SummaryCard label="Skipped Rows" value={String(batch.records_skipped || 0)} />
              <SummaryCard label="Processed Rows" value={String(batch.records_processed || 0)} />
              <SummaryCard label="Failed Rows" value={String(batch.records_failed || 0)} />
            </div>

            <div style={{ ...cardStyle, marginBottom: 12 }}>
              <div style={metaGrid}>
                <InfoTile label="Source File" value={batch.original_filename || '-'} />
                <InfoTile label="Source System" value={batch.source_system || '-'} />
                <InfoTile label="Pay Period" value={`${batch.pay_period_start} to ${batch.pay_period_end}`} />
                <InfoTile label="Uploaded By" value={batch.uploaded_by_name || '-'} />
                <InfoTile label="Uploaded At" value={new Date(batch.created_at).toLocaleString()} />
                <InfoTile label="Reviewed By" value={batch.reviewed_by_name || '-'} />
              </div>
              {batch.identity_summary && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10, marginTop: 12 }}>
                  <SummaryCard label="Biometric ID Matched" value={String(batch.identity_summary.matched_via_biometric_id || 0)} />
                  <SummaryCard label="External Mapping Matched" value={String(batch.identity_summary.matched_via_base44 || 0)} />
                  <SummaryCard label="Smart Name Matched" value={String(batch.identity_summary.matched_via_smart_name || 0)} />
                  <SummaryCard label="Unresolved" value={String(batch.identity_summary.unresolved || 0)} />
                </div>
              )}
              {Array.isArray(batch.warnings) && batch.warnings.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={sectionTitle}>Warnings</div>
                  <ul style={listStyle}>
                    {batch.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}
                  </ul>
                </div>
              )}
              {Array.isArray(batch.errors) && batch.errors.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={sectionTitle}>Validation Issues</div>
                  <ul style={listStyle}>
                    {batch.errors.map((message, index) => <li key={`${message}-${index}`}>{message}</li>)}
                  </ul>
                </div>
              )}
            </div>

            <div style={{ ...cardStyle, marginBottom: 12 }}>
              <div style={sectionTitle}>Ready Rows ({readyItems.length})</div>
              <BatchItemTable rows={readyItems} />
            </div>

            <div style={cardStyle}>
              <div style={sectionTitle}>Skipped / Processed Rows ({skippedItems.length})</div>
              <BatchItemTable rows={skippedItems} />
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

function BatchItemTable({ rows }: { rows: BatchItem[] }) {
  if (rows.length === 0) {
    return <div style={{ color: '#64748b', fontSize: 13 }}>No rows in this section.</div>;
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ background: '#f8fafc' }}>
          <tr>
            <th className="llb-num" style={thStyle}>Row</th>
            <th style={thStyle}>External Employee</th>
            <th style={thStyle}>Matched Employee</th>
            <th style={thStyle}>Attendance</th>
            <th style={thStyle}>Identity</th>
            <th style={thStyle}>Status</th>
            <th style={thStyle}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.item_id} style={{ borderTop: '1px solid #e2e8f0' }}>
              <td className="llb-num" style={tdStyle}>{row.row_number}</td>
              <td style={tdStyle}>
                <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.external_employee_name || '-'}</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>Code: {row.external_employee_code || '-'}</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>Branch: {row.external_branch || '-'}</div>
              </td>
              <td style={tdStyle}>
                <div style={{ fontWeight: 700, color: '#0f172a' }}>{row.matched_employee_name || '-'}</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>Employee ID: {row.matched_employee_id || '-'}</div>
              </td>
              <td style={tdStyle}>
                <div>Days Worked: {row.days_worked}</div>
                <div>OT Hours: {row.overtime_hours}</div>
                <div>Late Min: {row.late_minutes}</div>
                <div>Absent Days: {row.absent_days}</div>
                <div>Leave Days: {row.leave_days}</div>
              </td>
              <td style={tdStyle}>
                <div>{row.identity_label || '-'}</div>
                <div style={{ color: '#64748b', fontSize: 12 }}>
                  {row.identity_method || '-'} {typeof row.identity_confidence === 'number' ? `(${row.identity_confidence})` : ''}
                </div>
              </td>
              <td style={tdStyle}>
                <span style={statusPill(row.status)}>{row.status}</span>
                {row.created_payroll_id ? (
                  <div style={{ color: '#64748b', fontSize: 12, marginTop: 4 }}>Payroll #{row.created_payroll_id}</div>
                ) : null}
              </td>
              <td className="llb-trunc" title={row.error_message || '-'} style={tdStyle}>{row.error_message || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 12, color: '#64748b' }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 14, fontWeight: 700, color: '#0f172a' }}>{value}</div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={infoTileStyle}>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: '#0f172a', fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const cardStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 12,
  padding: 14,
};

const infoTileStyle: CSSProperties = {
  border: '1px solid #dbeafe',
  borderRadius: 10,
  padding: 12,
  background: '#f8fbff',
};

const metaGrid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
  gap: 10,
};

const sectionTitle: CSSProperties = {
  marginBottom: 10,
  fontSize: 13,
  fontWeight: 700,
  color: '#0f172a',
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

const primaryBtn: CSSProperties = {
  border: '1px solid #1e3a8a',
  background: '#1e3a8a',
  color: '#fff',
  borderRadius: 9,
  padding: '10px 12px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const secondaryBtn: CSSProperties = {
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  borderRadius: 9,
  padding: '10px 12px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const dangerBtn: CSSProperties = {
  border: '1px solid #dc2626',
  background: '#dc2626',
  color: '#fff',
  borderRadius: 9,
  padding: '10px 12px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
};

const listStyle: CSSProperties = {
  margin: 0,
  paddingLeft: 18,
  color: '#475569',
  fontSize: 13,
};

function statusPill(status: string): CSSProperties {
  if (status === 'ready') return { background: '#dcfce7', color: '#166534', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (status === 'processing') return { background: '#e0f2fe', color: '#075985', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (status === 'processed') return { background: '#dbeafe', color: '#1d4ed8', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (status === 'duplicate') return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (status === 'failed') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  return { background: '#e2e8f0', color: '#334155', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
}
