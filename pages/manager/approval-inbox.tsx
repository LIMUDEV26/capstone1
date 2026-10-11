import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import Pagination from '@/components/Pagination';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError } from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API = getApiBaseUrl();

type SessionUser = {
  role?: string;
  employee_id?: number;
  [key: string]: unknown;
};

type InboxSummary = {
  total: number;
  by_type: {
    leave: number;
    overtime: number;
  };
};

type InboxItem = {
  type: 'leave' | 'overtime' | string;
  id: number;
  title: string;
  subtitle: string;
  submitted_at: string;
  priority: 'low' | 'medium' | 'high' | string;
  link?: string;
  meta?: Record<string, unknown>;
};

type ApiResponse<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

type InboxPayload = {
  summary: InboxSummary;
  items: InboxItem[];
};

const emptySummary: InboxSummary = {
  total: 0,
  by_type: {
    leave: 0,
    overtime: 0,
  },
};

export default function ApprovalInboxPage() {
  const ITEMS_PER_PAGE = usePaginationSetting();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<InboxSummary>(emptySummary);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [typeFilter, setTypeFilter] = useState<'all' | 'leave' | 'overtime'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const role = String(user?.role || '').toLowerCase();
  const isManager = role === 'manager';

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
        await fetchInbox('all');
      } catch {
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    init();
  }, [router]);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
    setError('');
  }, [error]);

  const fetchInbox = async (
    nextType: 'all' | 'leave' | 'overtime'
  ) => {
    setRefreshing(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('type', nextType);
      const res = await fetch(`${API}/approval-inbox.php?${params.toString()}`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<InboxPayload>;
      if (data.success && data.data) {
        setSummary(data.data.summary || emptySummary);
        setItems(Array.isArray(data.data.items) ? data.data.items : []);
      } else {
        setSummary(emptySummary);
        setItems([]);
        setError(data.message || 'Failed to load approval inbox.');
      }
    } catch {
      setSummary(emptySummary);
      setItems([]);
      setError('Failed to load approval inbox.');
    } finally {
      setRefreshing(false);
    }
  };

  const handleFilterChange = async (
    nextType: 'all' | 'leave' | 'overtime'
  ) => {
    setTypeFilter(nextType);
    setCurrentPage(1);
    await fetchInbox(nextType);
  };

  const runAction = async (
    item: Pick<InboxItem, 'type' | 'id'>,
    action: 'approve' | 'reject' | 'in_review' | 'resolve'
  ): Promise<boolean> => {
    const actionKey = `${item.type}-${item.id}-${action}`;
    setActingOnId(actionKey);
    setError('');

    try {
      let requestUrl = '';
      let payload: Record<string, unknown> = {};

      if (item.type === 'leave') {
        requestUrl = `${API}/leave-requests.php`;
        payload = {
          leave_request_id: item.id,
          action: action === 'approve' ? 'approve' : 'reject',
        };
      } else if (item.type === 'overtime') {
        requestUrl = `${API}/overtime-requests.php`;
        payload = {
          overtime_request_id: item.id,
          status: action === 'approve' ? 'approved' : 'rejected',
          manager_notes: action === 'approve'
            ? 'Approved from manager approval inbox.'
            : 'Rejected from manager approval inbox.',
        };
      }

      if (!requestUrl) {
        setError('Unsupported approval item type.');
        return false;
      }

      const res = await fetch(requestUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to update record.');
        return false;
      }

      setItems((prev) => prev.filter((i) => !(i.type === item.type && i.id === item.id)));
      return true;
    } catch {
      setError('Failed to update record.');
      return false;
    } finally {
      setActingOnId(null);
    }
  };

  const paginatedItems = useMemo(() => {
    return items.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  }, [items, currentPage]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE));
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [items.length, currentPage]);

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
        <title>Approval Inbox</title>
      </Head>

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: 12 }}>
        <div style={{ marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 14, color: '#1f2937' }}>Manager Approval Inbox</h1>
          <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: 13 }}>
            Review leave and overtime requests.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, marginBottom: 12 }}>
          <SummaryCard label="Total Pending" value={summary.total} color="#1e3a8a" background="#dbeafe" />
          <SummaryCard label="Leave" value={summary.by_type.leave} color="#1d4ed8" background="#eff6ff" />
          <SummaryCard label="Overtime" value={summary.by_type.overtime} color="#92400e" background="#fef3c7" />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
          <button
            onClick={() => fetchInbox(typeFilter)}
            style={{
              border: '1px solid #1e3a8a',
              background: refreshing ? '#1e40af' : '#1e3a8a',
              color: '#fff',
              borderRadius: 10,
              padding: '10px 12px',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            {refreshing ? 'Refreshing...' : 'Refresh Inbox'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <select
            value={typeFilter}
            onChange={(e) => void handleFilterChange(e.target.value as 'all' | 'leave' | 'overtime')}
            style={filterStyle}
          >
            <option value="all">All Types</option>
            <option value="leave">Leave</option>
            <option value="overtime">Overtime</option>
          </select>
        </div>

        <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, overflow: 'hidden' }}>
          <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Request</th>
                <th style={thStyle}>Submitted</th>
                <th style={thStyle}>Priority</th>
                <th style={thStyle}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 24, textAlign: 'center', color: '#64748b' }}>
                    No approval items found for selected filters.
                  </td>
                </tr>
              ) : (
                paginatedItems.map((item) => {
                  const leaveTargetRole = String(item.meta?.employee_role || '').toLowerCase();
                  const isManagerRestrictedLeave = isManager && item.type === 'leave' && leaveTargetRole !== 'staff';
                  const approveDisabled = actingOnId === `${item.type}-${item.id}-approve`;
                  const rejectDisabled = actingOnId === `${item.type}-${item.id}-reject`;

                  return (
                    <tr key={`${item.type}-${item.id}`} style={{ borderTop: '1px solid #eef2f7' }}>
                      <td style={tdStyle}>
                        <span style={typeBadge(item.type)}>{formatType(item.type)}</span>
                      </td>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: '#0f172a' }} className="llb-ellipsis" title={item.title}>{item.title}</div>
                        <div style={{ color: '#64748b', fontSize: 12 }} className="llb-ellipsis" title={item.subtitle}>{item.subtitle}</div>
                      </td>
                      <td style={tdStyle}>{new Date(item.submitted_at).toLocaleString()}</td>
                      <td style={tdStyle}>
                        <span style={priorityBadge(item.priority)}>{String(item.priority || 'medium')}</span>
                      </td>
                      <td className="llb-actions" style={tdStyle}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {item.type === 'leave' && (
                            <>
                              {!isManagerRestrictedLeave && (
                                <>
                                  <button
                                    onClick={() => void runAction(item, 'approve')}
                                    disabled={approveDisabled}
                                    style={approveDisabled ? { ...approveBtn, opacity: 0.6, cursor: 'not-allowed' } : approveBtn}
                                  >
                                    Approve
                                  </button>
                                  <button
                                    onClick={() => void runAction(item, 'reject')}
                                    disabled={rejectDisabled}
                                    style={rejectDisabled ? { ...rejectBtn, opacity: 0.6, cursor: 'not-allowed' } : rejectBtn}
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                            </>
                          )}
                          {item.type === 'overtime' && (
                            <>
                              <button
                                onClick={() => void runAction(item, 'approve')}
                                disabled={actingOnId === `${item.type}-${item.id}-approve`}
                                style={approveBtn}
                              >
                                Approve
                              </button>
                              <button
                                onClick={() => void runAction(item, 'reject')}
                                disabled={actingOnId === `${item.type}-${item.id}-reject`}
                                style={rejectBtn}
                              >
                                Reject
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => {
                              if (item.link) router.push(item.link);
                            }}
                            style={linkBtn}
                          >
                            Open
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          currentPage={currentPage}
          totalItems={items.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setCurrentPage}
          label="approval items"
        />
      </div>

    </Layout>
  );
}

function formatType(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function SummaryCard({ label, value, color, background }: { label: string; value: number; color: string; background: string }) {
  return (
    <div style={{ background, border: '1px solid rgba(15,23,42,0.06)', borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 12, color }}>{label}</div>
      <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}

const filterStyle: CSSProperties = {
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#1f2937',
  minWidth: 180,
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

function typeBadge(type: string): CSSProperties {
  if (type === 'leave') return { background: '#dbeafe', color: '#1d4ed8', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (type === 'overtime') return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  return { background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
}

function priorityBadge(priority: string): CSSProperties {
  if (priority === 'high') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  if (priority === 'low') return { background: '#e2e8f0', color: '#334155', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
  return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '4px 10px', fontSize: 12, fontWeight: 700 };
}

function disabledButtonStyle(base: CSSProperties): CSSProperties {
  return {
    ...base,
    opacity: 0.6,
    cursor: 'not-allowed',
  };
}

const approveBtn: CSSProperties = {
  border: '1px solid #16a34a',
  background: '#16a34a',
  color: '#fff',
  borderRadius: 7,
  padding: '6px 9px',
  fontSize: 12,
  cursor: 'pointer',
};

const rejectBtn: CSSProperties = {
  border: '1px solid #dc2626',
  background: '#dc2626',
  color: '#fff',
  borderRadius: 7,
  padding: '6px 9px',
  fontSize: 12,
  cursor: 'pointer',
};

const linkBtn: CSSProperties = {
  border: '1px solid #1e3a8a',
  background: '#fff',
  color: '#1e3a8a',
  borderRadius: 7,
  padding: '6px 9px',
  fontSize: 12,
  cursor: 'pointer',
  fontWeight: 600,
};


