import { useEffect, useRef, useState, type CSSProperties } from 'react';
import ExpandIconButton from '@/components/ExpandIconButton';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE = getApiBaseUrl();

// ─── Module-scope style constants (extracted to avoid rebuilding on every render) ───

const S_OVERLAY: CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 25000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 };
const S_MODAL: CSSProperties = { width: '100%', height: '100%', background: 'white', borderRadius: 14, display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.3)', position: 'relative' };
const S_MODAL_HEADER: CSSProperties = { padding: '16px 20px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 };
const S_FILTER_BAR: CSSProperties = { padding: '14px 20px', borderBottom: '1px solid #f1f5f9', display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', flexShrink: 0, background: '#fafbfc' };
const S_FILTER_GROUP: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const S_FILTER_LABEL: CSSProperties = { fontSize: 11, color: '#6b7280', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' };
const S_FILTER_INPUT: CSSProperties = { padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13 };
const S_FILTER_SELECT: CSSProperties = { padding: '8px 12px', borderRadius: 8, border: '1px solid #e5e7eb', fontSize: 13, background: 'white', minWidth: 150 };
const S_BTN_PRIMARY: CSSProperties = { padding: '8px 16px', background: '#1e3a8a', color: 'white', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 500, alignSelf: 'flex-end' };
const S_BTN_SECONDARY: CSSProperties = { padding: '8px 16px', background: 'transparent', color: '#6b7280', border: '1px solid #e5e7eb', borderRadius: 8, cursor: 'pointer', fontSize: 13, alignSelf: 'flex-end' };
const S_DETAIL_LABEL: CSSProperties = { fontSize: 11, color: '#6b7280', letterSpacing: '0.04em', textTransform: 'uppercase', fontWeight: 600, marginBottom: 4 };
const S_DETAIL_VALUE: CSSProperties = { fontSize: 13, color: '#111827', fontWeight: 500 };
const S_TH: CSSProperties = { textAlign: 'left', padding: '12px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12 };
const S_TH_NOWRAP: CSSProperties = { ...S_TH, whiteSpace: 'nowrap' };
const S_FOOTER: CSSProperties = { padding: '12px 20px', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, background: '#fafbfc' };
const ACTIVITY_LOG_PREVIEW_LIMIT = 6;
const ACTIVITY_LOG_PAGE_SIZE = 10;

interface ActivityLogItem {
  id: number;
  user_id: number | null;
  action: string;
  description: string | null;
  activity_type: string | null;
  ip_address: string | null;
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  role: string | null;
}

interface ActivityLogUserOption {
  id: number | string;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  role?: string | null;
}

type ActivityLogsFetchOverrides = {
  search?: string;
  date_from?: string;
  date_to?: string;
  user_id?: string;
  activity_type?: string;
  page?: number;
  page_size?: number;
};

type ActivityLogsFetchOptions = {
  silent?: boolean;
};

function ActivityLogsPreview({
  logLoading,
  activityLogs,
  onExpand,
}: {
  logLoading: boolean;
  activityLogs: ActivityLogItem[];
  onExpand: () => void;
}) {
  return (
    <div style={{ background: 'linear-gradient(135deg, #f9fafb 0%, #f3f4f6 45%, #e5e7eb 100%)', padding: '12px', borderRadius: '10px', border: '1px solid #d1d5db', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, gap: 8 }}>
        <h3 style={{ margin: 0, color: '#4b5563', fontSize: '14px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
          Activity Logs
        </h3>
        <ExpandIconButton
          label="Expand activity logs"
          onClick={onExpand}
        />
      </div>
      {logLoading && activityLogs.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>Loading logs...</div>
      ) : activityLogs.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#9ca3af', fontSize: 14 }}>No activity logs found.</div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12, whiteSpace: 'nowrap' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12 }}>User</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12 }}>Action</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12 }}>Description</th>
                  <th style={{ textAlign: 'left', padding: '8px 10px', color: '#4b5563', fontWeight: 600, fontSize: 12 }}>Type</th>
                </tr>
              </thead>
              <tbody>
                {activityLogs.slice(0, ACTIVITY_LOG_PREVIEW_LIMIT).map((log) => (
                  <tr key={log.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px 10px', color: '#6b7280', whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(log.created_at).toLocaleString()}</td>
                    <td style={{ padding: '8px 10px', color: '#111827' }}>
                      {(() => {
                        const full = `${log.first_name ?? ''} ${log.last_name ?? ''}`.trim();
                        const name = full || log.username || null;
                        const role = log.role ?? '';
                        if (!name) return <span style={{ color: '#9ca3af' }}>System</span>;
                        return role ? `${name} (${role})` : name;
                      })()}
                    </td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ background: '#eff6ff', color: '#1e3a8a', padding: '2px 8px', borderRadius: 6, fontSize: 12, fontWeight: 500 }}>{log.action}</span>
                    </td>
                    <td className="llb-trunc" title={log.description || '—'} style={{ padding: '8px 10px', color: '#374151', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.description || '—'}</td>
                    <td style={{ padding: '8px 10px' }}>
                      <span style={{ background: '#f0fdf4', color: '#166534', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 500 }}>{log.activity_type || '—'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {activityLogs.length > ACTIVITY_LOG_PREVIEW_LIMIT ? (
            <div style={{ color: '#64748b', fontSize: 11, fontWeight: 700, letterSpacing: '0.03em' }}>
              Showing {ACTIVITY_LOG_PREVIEW_LIMIT} of {activityLogs.length} recent logs.
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function ActivityLogsPanel() {
  const [activityLogs, setActivityLogs] = useState<ActivityLogItem[]>([]);
  const [activityLogsTotal, setActivityLogsTotal] = useState(0);
  const [activityLogsExpanded, setActivityLogsExpanded] = useState(false);
  const [logSearch, setLogSearch] = useState('');
  const [logDateFrom, setLogDateFrom] = useState('');
  const [logDateTo, setLogDateTo] = useState('');
  const [logUserId, setLogUserId] = useState('');
  const [logType, setLogType] = useState('');
  const [logUsers, setLogUsers] = useState<ActivityLogUserOption[]>([]);
  const [logTypes, setLogTypes] = useState<string[]>([]);
  const [logPage, setLogPage] = useState(0);
  const [logLoading, setLogLoading] = useState(false);
  const [selectedActivityLogId, setSelectedActivityLogId] = useState<number | null>(null);
  const [logDetailCardOpen, setLogDetailCardOpen] = useState(false);
  const logPageSize = usePaginationSetting();
  const logQueryRef = useRef<ActivityLogsFetchOverrides>({
    search: '',
    date_from: '',
    date_to: '',
    user_id: '',
    activity_type: '',
    page: 0,
    page_size: ACTIVITY_LOG_PAGE_SIZE,
  });

  useEffect(() => {
    logQueryRef.current = {
      search: logSearch,
      date_from: logDateFrom,
      date_to: logDateTo,
      user_id: logUserId,
      activity_type: logType,
      page: logPage,
      page_size: logPageSize,
    };
  }, [logSearch, logDateFrom, logDateTo, logUserId, logType, logPage, logPageSize]);

  // Re-fetch from page 0 when the admin-configured page size changes.
  const prevLogPageSizeRef = useRef(logPageSize);
  useEffect(() => {
    if (prevLogPageSizeRef.current === logPageSize) return;
    prevLogPageSizeRef.current = logPageSize;
    setLogPage(0);
    void fetchActivityLogs({ page: 0, page_size: logPageSize });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logPageSize]);

  const fetchActivityLogs = async (overrides?: ActivityLogsFetchOverrides, options?: ActivityLogsFetchOptions) => {
    const silent = !!options?.silent;
    if (!silent) setLogLoading(true);
    try {
      const p = new URLSearchParams();
      const current = logQueryRef.current;
      const s = overrides?.search ?? current.search ?? '';
      const df = overrides?.date_from ?? current.date_from ?? '';
      const dt = overrides?.date_to ?? current.date_to ?? '';
      const uid = overrides?.user_id ?? current.user_id ?? '';
      const at = overrides?.activity_type ?? current.activity_type ?? '';
      const pg = overrides?.page ?? current.page ?? 0;
      const pageSize = Math.max(1, Math.min(100, Math.trunc(overrides?.page_size ?? current.page_size ?? logPageSize)));
      if (s) p.set('search', s);
      if (df) p.set('date_from', df);
      if (dt) p.set('date_to', dt);
      if (uid) p.set('user_id', uid);
      if (at) p.set('activity_type', at);
      p.set('limit', String(pageSize));
      p.set('offset', String(pg * pageSize));
      const res = await fetch(`${API_BASE}/activity-logs.php?${p.toString()}`, { credentials: 'include' });
      const d = await res.json();
      if (!res.ok || !d.success) {
        return;
      }
      const rows: ActivityLogItem[] = (Array.isArray(d.data) ? d.data : (Array.isArray(d.data?.rows) ? d.data.rows : []))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((row: any): ActivityLogItem => ({
          id: Number(row?.id ?? 0),
          user_id: row?.user_id == null ? null : Number(row.user_id),
          action: String(row?.action ?? ''),
          description: row?.description == null ? null : String(row.description),
          activity_type: row?.activity_type == null ? null : String(row.activity_type),
          ip_address: row?.ip_address == null ? null : String(row.ip_address),
          created_at: String(row?.created_at ?? ''),
          first_name: row?.first_name == null ? null : String(row.first_name),
          last_name: row?.last_name == null ? null : String(row.last_name),
          username: row?.username == null ? null : String(row.username),
          role: row?.role == null ? null : String(row.role),
        }));
      const total = typeof d.total === 'number' ? d.total : (typeof d.data?.total === 'number' ? d.data.total : rows.length);
      setActivityLogs(rows);
      setActivityLogsTotal(total);
      if (rows.length === 0) {
        setLogDetailCardOpen(false);
      }
      setSelectedActivityLogId((currentSelectedId) => {
        if (rows.length === 0) return null;
        if (currentSelectedId === null) return null;
        if (rows.some((row) => row.id === currentSelectedId)) return currentSelectedId;
        return rows[0]?.id ?? null;
      });
    } catch { /* noop */ }
    finally { if (!silent) setLogLoading(false); }
  };

  const fetchActivityLogsMeta = async () => {
    try {
      const res = await fetch(`${API_BASE}/activity-logs.php?meta=1`, { credentials: 'include' });
      const d = await res.json();
      if (!res.ok || !d.success) return;
      const users = Array.isArray(d.users) ? d.users : (Array.isArray(d.data?.users) ? d.data.users : []);
      const types = Array.isArray(d.types) ? d.types : (Array.isArray(d.data?.types) ? d.data.types : []);
      setLogUsers(users);
      setLogTypes(types);
    } catch { /* noop */ }
  };

  useEffect(() => {
    void fetchActivityLogsMeta();
    void fetchActivityLogs({ page_size: logPageSize });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyLogFilters = (overrides?: ActivityLogsFetchOverrides) => {
    setLogPage(0);
    fetchActivityLogs({ ...overrides, page: 0 });
  };

  const clearLogFilters = () => {
    setLogSearch('');
    setLogDateFrom('');
    setLogDateTo('');
    setLogUserId('');
    setLogType('');
    setLogPage(0);
    fetchActivityLogs({ search: '', date_from: '', date_to: '', user_id: '', activity_type: '', page: 0 });
  };

  const selectedActivityLog = selectedActivityLogId === null
    ? null
    : activityLogs.find((log) => log.id === selectedActivityLogId) || null;
  const selectedActivityLogUserName = (() => {
    if (!selectedActivityLog) return 'System';
    const full = `${selectedActivityLog.first_name ?? ''} ${selectedActivityLog.last_name ?? ''}`.trim();
    const name = full || selectedActivityLog.username || 'System';
    const role = selectedActivityLog.role ?? '';
    return role ? `${name} (${role})` : name;
  })();

  return (
    <>
      <ActivityLogsPreview
        logLoading={logLoading}
        activityLogs={activityLogs}
        onExpand={() => {
          setActivityLogsExpanded(true);
          void fetchActivityLogs({ page_size: logPageSize });
        }}
      />

      {activityLogsExpanded && (
        <div style={S_OVERLAY}>
          <div style={S_MODAL}>
            {/* Header */}
            <div style={S_MODAL_HEADER}>
              <h2 style={{ margin: 0, fontSize: 14, color: '#111827', display: 'flex', alignItems: 'center', gap: 10 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="16" y1="13" x2="8" y2="13"></line><line x1="16" y1="17" x2="8" y2="17"></line><polyline points="10 9 9 9 8 9"></polyline></svg>
                Activity Logs
                <span style={{ fontSize: 13, color: '#6b7280', fontWeight: 400, marginLeft: 4 }}>({activityLogsTotal} total)</span>
              </h2>
              <button type="button" onClick={() => { setActivityLogsExpanded(false); setSelectedActivityLogId(null); setLogDetailCardOpen(false); }} style={{ background: 'transparent', border: '1px solid #e5e7eb', borderRadius: 8, padding: '8px 16px', cursor: 'pointer', fontSize: 14, color: '#374151', display: 'flex', alignItems: 'center', gap: 6 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                Close
              </button>
            </div>

            {/* Filters */}
            <div style={S_FILTER_BAR}>
              <div style={S_FILTER_GROUP}>
                <label htmlFor="log-search" style={S_FILTER_LABEL}>Search</label>
                <input
                  id="log-search"
                  type="text" placeholder="Search action or description…" value={logSearch}
                  onChange={e => setLogSearch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && applyLogFilters({ search: logSearch })}
                  style={{ ...S_FILTER_INPUT, width: 220 }}
                />
              </div>
              <div style={S_FILTER_GROUP}>
                <label htmlFor="log-date-from" style={S_FILTER_LABEL}>From</label>
                <input id="log-date-from" type="date" value={logDateFrom} onChange={e => setLogDateFrom(e.target.value)} style={S_FILTER_INPUT} />
              </div>
              <div style={S_FILTER_GROUP}>
                <label htmlFor="log-date-to" style={S_FILTER_LABEL}>To</label>
                <input id="log-date-to" type="date" value={logDateTo} onChange={e => setLogDateTo(e.target.value)} style={S_FILTER_INPUT} />
              </div>
              <div style={S_FILTER_GROUP}>
                <label htmlFor="log-user-id" style={S_FILTER_LABEL}>User</label>
                {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                <select id="log-user-id" value={logUserId} onChange={e => setLogUserId(e.target.value)} style={S_FILTER_SELECT}>
                  <option value="">All Users</option>
                  {logUsers.map((u) => {
                    const full = `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim();
                    const name = full || u.username || `User #${u.id}`;
                    const role = u.role ?? '';
                    return <option key={u.id} value={u.id}>{role ? `${name} (${role})` : name}</option>;
                  })}
                </select>
              </div>
              <div style={S_FILTER_GROUP}>
                <label htmlFor="log-type" style={S_FILTER_LABEL}>Type</label>
                <select id="log-type" value={logType} onChange={e => setLogType(e.target.value)} style={S_FILTER_SELECT}>
                  <option value="">All Types</option>
                  {logTypes.map((t: string) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <button type="button" onClick={() => applyLogFilters()} style={S_BTN_PRIMARY}>Apply</button>
              <button type="button" onClick={() => clearLogFilters()} style={S_BTN_SECONDARY}>Clear</button>
            </div>

            {logDetailCardOpen && selectedActivityLog && (
              <div
                onClick={() => setLogDetailCardOpen(false)}
                style={{
                  position: 'absolute',
                  inset: 0,
                  zIndex: 20,
                  background: 'rgba(15, 23, 42, 0.28)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 20
                }}
              >
                <div
                  onClick={(event) => event.stopPropagation()}
                  style={{
                    width: 'min(1180px, 96%)',
                    maxHeight: '85vh',
                    overflow: 'auto',
                    borderRadius: 14,
                    border: '1px solid #dbeafe',
                    background: 'linear-gradient(90deg, #f8fbff 0%, #f8fafc 100%)',
                    boxShadow: '0 18px 48px rgba(15, 23, 42, 0.32)',
                    padding: 18
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14 }}>
                    <h3 style={{ margin: 0, fontSize: 14, color: '#111827' }}>Activity Log Details</h3>
                    <button
                      type="button"
                      onClick={() => setLogDetailCardOpen(false)}
                      style={{ background: 'transparent', border: '1px solid #cbd5e1', borderRadius: 8, color: '#374151', fontSize: 13, padding: '6px 12px', cursor: 'pointer' }}
                    >
                      Close
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                    <div>
                      <div style={S_DETAIL_LABEL}>Time</div>
                          <div style={S_DETAIL_VALUE}>{new Date(selectedActivityLog.created_at).toLocaleString()}</div>
                        </div>
                        <div>
                          <div style={S_DETAIL_LABEL}>User</div>
                          <div style={S_DETAIL_VALUE}>{selectedActivityLogUserName}</div>
                        </div>
                        <div>
                          <div style={S_DETAIL_LABEL}>Action</div>
                          <div style={{ fontSize: 13, color: '#1e3a8a', fontWeight: 600 }}>{selectedActivityLog.action || '-'}</div>
                        </div>
                        <div>
                          <div style={S_DETAIL_LABEL}>Type</div>
                          <div style={{ fontSize: 13, color: '#166534', fontWeight: 600 }}>{selectedActivityLog.activity_type || '-'}</div>
                        </div>
                        <div>
                          <div style={S_DETAIL_LABEL}>IP Address</div>
                          <div style={{ fontSize: 13, color: '#111827', fontFamily: 'monospace' }}>{selectedActivityLog.ip_address || '-'}</div>
                        </div>
                        <div>
                          <div style={S_DETAIL_LABEL}>Log ID</div>
                          <div style={{ fontSize: 13, color: '#111827', fontFamily: 'monospace' }}>{selectedActivityLog.id}</div>
                        </div>
                        <div style={{ gridColumn: '1 / -1', background: 'white', border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px' }}>
                          <div style={S_DETAIL_LABEL}>Description</div>
                          <div style={{ fontSize: 14, color: '#111827', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{selectedActivityLog.description || '-'}</div>
                        </div>
                  </div>
                </div>
              </div>
            )}

            {/* Table */}
            <div style={{ flex: 1, overflow: 'auto', padding: '0 20px' }}>
              {logLoading && activityLogs.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>Loading…</div>
              ) : activityLogs.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>No activity logs match your filters.</div>
              ) : (
                <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
                    <tr style={{ borderBottom: '2px solid #e5e7eb' }}>
                      <th style={S_TH_NOWRAP}>Time</th>
                      <th style={S_TH}>User</th>
                      <th style={S_TH}>Action</th>
                      <th style={S_TH}>Description</th>
                      <th style={S_TH}>Type</th>
                      <th style={S_TH}>IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activityLogs.map((log) => {
                      const isSelected = log.id === selectedActivityLogId;
                      const logFull = `${log.first_name ?? ''} ${log.last_name ?? ''}`.trim();
                      const logBaseName = logFull || log.username || null;
                      const logUserName = logBaseName
                        ? (log.role ? `${logBaseName} (${log.role})` : logBaseName)
                        : null;
                      return (
                        <tr
                          key={log.id}
                          onClick={() => { setSelectedActivityLogId(log.id); setLogDetailCardOpen(true); }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === ' ') {
                              event.preventDefault();
                              setSelectedActivityLogId(log.id);
                              setLogDetailCardOpen(true);
                            }
                          }}
                          tabIndex={0}
                          role="button"
                          aria-label={`View details for log ${log.id}`}
                          style={{
                            borderTop: '1px solid #f1f5f9',
                            cursor: 'pointer',
                            background: isSelected ? '#eff6ff' : 'white',
                            boxShadow: isSelected ? 'inset 3px 0 0 #1e3a8a' : 'none',
                            transition: 'background 0.16s ease'
                          }}
                        >
                          <td style={{ padding: '10px 10px', color: '#6b7280', whiteSpace: 'nowrap', fontSize: 12 }}>{new Date(log.created_at).toLocaleString()}</td>
                          <td style={{ padding: '10px 10px', color: '#111827', fontWeight: 500 }}>{logUserName || <span style={{ color: '#9ca3af' }}>System</span>}</td>
                          <td style={{ padding: '10px 10px' }}>
                            <span style={{ background: '#eff6ff', color: '#1e3a8a', padding: '3px 10px', borderRadius: 6, fontSize: 12, fontWeight: 500 }}>{log.action}</span>
                          </td>
                          <td className="llb-trunc" title={log.description || '-'} style={{ padding: '10px 10px', color: '#374151', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.description || '-'}</td>
                          <td style={{ padding: '10px 10px' }}>
                            <span style={{ background: '#f0fdf4', color: '#166534', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 500 }}>{log.activity_type || '-'}</span>
                          </td>
                          <td style={{ padding: '10px 10px', color: '#9ca3af', fontSize: 12, fontFamily: 'monospace' }}>{log.ip_address || '-'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination */}
            <div style={S_FOOTER}>
              <span style={{ fontSize: 13, color: '#6b7280' }}>
                Showing {Math.min(logPage * logPageSize + 1, activityLogsTotal)}–{Math.min((logPage + 1) * logPageSize, activityLogsTotal)} of {activityLogsTotal}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  title="First page"
                  aria-label="First page"
                  disabled={logPage === 0}
                  onClick={() => { setLogPage(0); fetchActivityLogs({ page: 0 }); }}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: logPage === 0 ? '#f3f4f6' : 'white', cursor: logPage === 0 ? 'default' : 'pointer', fontSize: 13, color: logPage === 0 ? '#9ca3af' : '#374151' }}
                >«</button>
                <button
                  type="button"
                  disabled={logPage === 0}
                  onClick={() => { const p = logPage - 1; setLogPage(p); fetchActivityLogs({ page: p }); }}
                  style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: logPage === 0 ? '#f3f4f6' : 'white', cursor: logPage === 0 ? 'default' : 'pointer', fontSize: 13, color: logPage === 0 ? '#9ca3af' : '#374151' }}
                >← Prev</button>
                <button
                  type="button"
                  disabled={(logPage + 1) * logPageSize >= activityLogsTotal}
                  onClick={() => { const p = logPage + 1; setLogPage(p); fetchActivityLogs({ page: p }); }}
                  style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: (logPage + 1) * logPageSize >= activityLogsTotal ? '#f3f4f6' : 'white', cursor: (logPage + 1) * logPageSize >= activityLogsTotal ? 'default' : 'pointer', fontSize: 13, color: (logPage + 1) * logPageSize >= activityLogsTotal ? '#9ca3af' : '#374151' }}
                >Next →</button>
                <button
                  type="button"
                  title="Last page"
                  aria-label="Last page"
                  disabled={(logPage + 1) * logPageSize >= activityLogsTotal}
                  onClick={() => { const p = Math.max(0, Math.ceil(activityLogsTotal / logPageSize) - 1); setLogPage(p); fetchActivityLogs({ page: p }); }}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: (logPage + 1) * logPageSize >= activityLogsTotal ? '#f3f4f6' : 'white', cursor: (logPage + 1) * logPageSize >= activityLogsTotal ? 'default' : 'pointer', fontSize: 13, color: (logPage + 1) * logPageSize >= activityLogsTotal ? '#9ca3af' : '#374151' }}
                >»</button>
                <form
                  className="system-form-compact"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const raw = new FormData(e.currentTarget).get('goto');
                    const n = Number.parseInt(String(raw ?? ''), 10);
                    if (Number.isNaN(n)) return;
                    const totalPages = Math.max(1, Math.ceil(activityLogsTotal / logPageSize));
                    const p = Math.min(Math.max(1, n), totalPages) - 1;
                    setLogPage(p);
                    fetchActivityLogs({ page: p });
                  }}
                  style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 4 }}
                >
                  <label htmlFor="activity-log-goto" style={{ fontSize: 12, color: '#6b7280' }}>Go to</label>
                  <input
                    key={`activity-log-goto-${logPage}`}
                    id="activity-log-goto"
                    name="goto"
                    type="number"
                    min={1}
                    max={Math.max(1, Math.ceil(activityLogsTotal / logPageSize))}
                    defaultValue={logPage + 1}
                    style={{ width: 60, padding: '5px 8px', borderRadius: 6, border: '1px solid #e5e7eb', fontSize: 12, color: '#111827' }}
                  />
                  <span style={{ fontSize: 12, color: '#6b7280' }}>of {Math.max(1, Math.ceil(activityLogsTotal / logPageSize))}</span>
                  <button
                    type="submit"
                    style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #e5e7eb', background: 'white', cursor: 'pointer', fontSize: 12, color: '#374151', fontWeight: 600 }}
                  >Go</button>
                </form>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
