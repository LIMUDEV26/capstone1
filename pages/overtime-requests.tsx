import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import Pagination from '@/components/Pagination';
import CrudActionIcon from '@/components/CrudActionIcon';
import DescriptionCell from '@/components/DescriptionCell';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError } from '@/utils/notify';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '@/components/SearchBar';
import ZeroResults from '@/components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API = getApiBaseUrl();

// Auto-resizing textarea component
function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  style,
  minRows = 2,
  maxRows = 6,
}: {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  style?: CSSProperties;
  minRows?: number;
  maxRows?: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';
    
    // Calculate the line height
    const computedStyle = window.getComputedStyle(textarea);
    const lineHeight = parseInt(computedStyle.lineHeight) || 20;
    const paddingTop = parseInt(computedStyle.paddingTop) || 0;
    const paddingBottom = parseInt(computedStyle.paddingBottom) || 0;
    
    // Calculate min and max heights
    const minHeight = (lineHeight * minRows) + paddingTop + paddingBottom;
    const maxHeight = (lineHeight * maxRows) + paddingTop + paddingBottom;
    
    // Set new height based on content, but respect min/max
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
  }, [value, minRows, maxRows]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      style={{
        ...style,
        resize: 'none',
        overflow: 'auto',
        transition: 'height 0.1s ease',
      }}
    />
  );
}

type SessionUser = {
  role?: string;
  employee_id?: number;
  [key: string]: unknown;
};

type EmployeeOption = {
  employee_id: number;
  first_name: string;
  last_name: string;
  email?: string;
  status?: string;
};

type OvertimeRow = {
  overtime_request_id: number;
  employee_id: number;
  employee_name?: string;
  work_date: string;
  hours_requested: number;
  reason: string;
  status: 'submitted' | 'approved' | 'rejected' | 'cancelled' | string;
  manager_notes?: string;
  created_at: string;
  is_archived?: number | boolean;
  archived_at?: string | null;
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

export default function OvertimeRequestsPage() {
  const ITEMS_PER_PAGE = usePaginationSetting();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<OvertimeRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [statusFilter, setStatusFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [showArchiveView, setShowArchiveView] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [actingId, setActingId] = useState<number | null>(null);

  const [workDate, setWorkDate] = useState(new Date().toISOString().slice(0, 10));
  const [hoursRequested, setHoursRequested] = useState('2');
  const [reason, setReason] = useState('');
  const [requestingForSelf, setRequestingForSelf] = useState(true);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number>(0);
  const [showStaffRequestModal, setShowStaffRequestModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Inline (labeled) submit error for the request modals.
  // Kept separate from page `error` (which toasts via SweetAlert) on purpose.
  const [submitFormError, setSubmitFormError] = useState('');
  const [submitFormErrorFields, setSubmitFormErrorFields] = useState<string[]>([]);

  const closeRequestModals = () => {
    if (submitting) return;
    setShowStaffRequestModal(false);
    setShowCreateModal(false);
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
  };

  const openRequestModal = () => {
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
    if (role === 'admin') {
      setShowCreateModal(true);
    } else {
      setShowStaffRequestModal(true);
    }
  };
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedRow, setSelectedRow] = useState<OvertimeRow | null>(null);
  const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);
  const dropdownMenuRef = useRef<HTMLDivElement | null>(null);
  const actionButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});

  const role = String(user?.role || '').toLowerCase();
  const canSubmit = ['staff', 'manager', 'admin'].includes(role);
  const canApprove = role === 'manager' || role === 'admin';

  useEffect(() => {
    const init = async () => {
      try {
        const sessionRes = await fetch(`${API}/auth.php`, { credentials: 'include' });
        const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
        if (!sessionData.success || !sessionData.data) {
          router.push('/');
          return;
        }

        const userRole = String(sessionData.data.role || '').toLowerCase();
        if (!['staff', 'manager', 'admin'].includes(userRole)) {
          router.push('/dashboard');
          return;
        }

        setUser(sessionData.data);
        
        // Fetch employees and rows in parallel
        await Promise.all([
          userRole === 'manager' || userRole === 'admin' ? fetchEmployees() : Promise.resolve(),
          fetchRows('all', false),
        ]);
      } catch {
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
    setError('');
  }, [error]);

  useEffect(() => {
    if (!selectedRow) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectedRow(null);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedRow]);

  useEffect(() => {
    const closeDropdown = () => {
      setActiveDropdown(null);
      setDropdownPosition(null);
    };

    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (dropdownMenuRef.current?.contains(target)) return;
      const clickedToggle = Object.values(actionButtonRefs.current).some((buttonEl) => {
        return buttonEl?.contains(target) ?? false;
      });
      if (clickedToggle) return;
      closeDropdown();
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDropdown();
    };

    document.addEventListener('mousedown', handleDocumentMouseDown);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('resize', closeDropdown);
    window.addEventListener('scroll', closeDropdown, true);

    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('resize', closeDropdown);
      window.removeEventListener('scroll', closeDropdown, true);
    };
  }, []);

  const fetchRows = async (nextStatus: string, archivedOnly = showArchiveView) => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (nextStatus !== 'all') params.set('status', nextStatus);
      params.set('archived', archivedOnly ? '1' : '0');
      const res = await fetch(`${API}/overtime-requests.php?${params.toString()}`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<OvertimeRow[]>;
      if (data.success && Array.isArray(data.data)) {
        setRows(data.data);
      } else {
        setRows([]);
        setError(data.message || 'Failed to load overtime requests.');
      }
    } catch {
      setRows([]);
      setError('Failed to load overtime requests.');
    }
  };

  // Live-sync: silently re-fetch overtime rows in background.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLiveSync(async () => {
    if (!user) return;
    await fetchRows(statusFilter, showArchiveView);
  });

  const fetchEmployees = async () => {
    try {
      const res = await fetch(`${API}/employees.php?status=active`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<EmployeeOption[]>;
      if (data.success && Array.isArray(data.data)) {
        setEmployees(data.data);
      } else {
        setEmployees([]);
      }
    } catch {
      setEmployees([]);
    }
  };

  const submitRequest = async () => {
    if (!canSubmit) return;
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
    const missingFields: string[] = [];
    if (!workDate) missingFields.push('work_date');
    if (!hoursRequested) missingFields.push('hours_requested');
    if (!reason.trim()) missingFields.push('reason');
    if (missingFields.length > 0) {
      setSubmitFormError('Please fill in all required fields: Work Date, Hours, and Reason.');
      setSubmitFormErrorFields(missingFields);
      return;
    }

    // For managers/admins: if not requesting for self, must select an employee
    if ((role === 'manager' || role === 'admin') && !requestingForSelf) {
      if (!selectedEmployeeId || selectedEmployeeId <= 0) {
        setSubmitFormError('Please select an employee for this overtime request.');
        setSubmitFormErrorFields(['employee_id']);
        return;
      }
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        work_date: workDate,
        hours_requested: Number(hoursRequested),
        reason: reason.trim(),
      };
      
      // Determine which employee_id to use
      if (role === 'staff') {
        // Staff always submits for themselves (no employee_id needed, backend handles it)
      } else if (role === 'manager' || role === 'admin') {
        if (requestingForSelf) {
          // Requesting for own account
          if (user?.employee_id) {
            payload.employee_id = Number(user.employee_id);
          }
        } else {
          // Requesting on behalf of another employee
          payload.employee_id = selectedEmployeeId;
        }
      }

      // X-No-Toast: form errors render inline (labeled) below — never as SweetAlert.
      const res = await fetch(`${API}/overtime-requests.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-No-Toast': '1' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        // Show the accurate backend message inline, labeled to the conflicting field.
        setSubmitFormError(data.message || 'Failed to submit overtime request.');
        const fields = Array.isArray(data.errors?.fields) && data.errors.fields.length > 0
          ? data.errors.fields.filter((f): f is string => typeof f === 'string')
          : (typeof data.errors?.field === 'string' ? [data.errors.field] : []);
        setSubmitFormErrorFields(fields);
        return;
      }

      setReason('');
      setHoursRequested('2');
      setRequestingForSelf(true);
      setSelectedEmployeeId(0);
      setSubmitFormError('');
      setSubmitFormErrorFields([]);
      await fetchRows(statusFilter, showArchiveView);
      if (role === 'admin') {
        setShowCreateModal(false);
      } else {
        setShowStaffRequestModal(false);
      }
    } catch {
      setSubmitFormError('Network error. Please check your connection and try again.');
      setSubmitFormErrorFields([]);
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (row: OvertimeRow, nextStatus: 'approved' | 'rejected' | 'cancelled') => {
    setActingId(row.overtime_request_id);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        overtime_request_id: row.overtime_request_id,
      };
      if (nextStatus === 'cancelled') {
        payload.action = 'cancel';
      } else {
        payload.status = nextStatus;
        payload.manager_notes = nextStatus === 'approved'
          ? 'Approved from overtime request board.'
          : 'Rejected from overtime request board.';
      }

      const res = await fetch(`${API}/overtime-requests.php`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to update overtime request.');
        return;
      }
      if (selectedRow?.overtime_request_id === row.overtime_request_id) {
        setSelectedRow(null);
      }
      await fetchRows(statusFilter, showArchiveView);
    } catch {
      setError('Failed to update overtime request.');
    } finally {
      setActingId(null);
    }
  };

  const toggleArchiveView = () => {
    const nextArchiveView = !showArchiveView;
    setShowArchiveView(nextArchiveView);
    setStatusFilter('all');
    setCurrentPage(1);
    setSelectedRow(null);
    setActiveDropdown(null);
    void fetchRows('all', nextArchiveView);
  };

  const toggleDropdown = (e: React.MouseEvent, rowId: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeDropdown === rowId) {
      setActiveDropdown(null);
      setDropdownPosition(null);
      return;
    }
    const buttonRect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
    const menuWidth = 150;
    const viewportPadding = 8;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
    const computedLeft = Math.min(Math.max(buttonRect.right - menuWidth, viewportPadding), maxLeft);
    setDropdownPosition({ top: buttonRect.bottom + 6, left: computedLeft });
    setActiveDropdown(rowId);
  };

  const filteredRows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((row) => {
      const haystack = [
        row.overtime_request_id,
        row.employee_id,
        row.employee_name,
        row.work_date,
        row.hours_requested,
        row.reason,
        row.status,
        row.manager_notes,
      ]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      return haystack.includes(query);
    });
  }, [rows, searchQuery]);

  const paginatedRows = useMemo(() => {
    return filteredRows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  }, [filteredRows, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [rows.length, statusFilter, showArchiveView, searchQuery]);

  useEffect(() => {
    const totalPages = Math.max(1, Math.ceil(filteredRows.length / ITEMS_PER_PAGE));
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [filteredRows.length, currentPage]);

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
        <title>Overtime Requests</title>
      </Head>

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: 12 }}>
        <div style={{ marginBottom: 12 }}>
          <div className="pageHeaderInline" style={{ marginBottom: 10, alignItems: 'center' }}>
            <div className="pageHeaderText" style={{ display: 'flex', alignItems: 'center', gap: 16, flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ flex: '0 0 auto' }}>
                <h1 style={{ margin: 0, fontSize: 14, fontWeight: 'bold', color: '#1a202c' }}>Overtime Requests</h1>
                <p style={{ margin: '2px 0 0 0', color: '#64748b', fontSize: 12 }}>
                  Submit and track overtime requests.
                </p>
              </div>
              <div style={{ flex: '1 1 360px', width: '100%', minWidth: 280, maxWidth: 480 }}>
                <SearchBar
                  storageKey="overtime:list"
                  placeholder="Search by employee, reason, status, date..."
                  ariaLabel="Search overtime requests"
                  value={searchQuery}
                  onChange={setSearchQuery}
                  suggestions={collectSearchTerms(rows, [
                    (r: any) => r.employee_name,
                    (r: any) => r.reason,
                    (r: any) => r.status,
                    (r: any) => r.work_date,
                  ])}
                />
              </div>
            </div>
            <div className="pageInlineFilters">
              <select
                id="overtime-status-filter"
                value={statusFilter}
                onChange={(e) => {
                  const value = e.target.value;
                  setStatusFilter(value);
                  void fetchRows(value, showArchiveView);
                }}
                aria-label="Filter by status"
                style={filterControlStyle}
              >
                <option value="all">All Status</option>
                <option value="submitted">Submitted</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="cancelled">Cancelled</option>
              </select>
              <button
                type="button"
                onClick={toggleArchiveView}
                title={showArchiveView ? 'Back to active overtime requests' : 'Open overtime archive storage'}
                aria-label={showArchiveView ? 'Back to active overtime requests' : 'Open overtime archive storage'}
                style={headerArchiveButtonStyle(showArchiveView)}
              >
                <CrudActionIcon action="archive" size={14} />
                {showArchiveView ? 'Back to Active' : 'Archive Storage'}
              </button>
            </div>
          </div>
          {canSubmit && !showArchiveView && (
            <div style={primaryActionRowStyle}>
              <button
                type="button"
                onClick={openRequestModal}
                title="Add Overtime Request"
                aria-label="Add Overtime Request"
                className="app-action-btn app-action-btn-primary page-primary-action-btn"
              >
                {role === 'admin' ? 'Add Overtime' : 'Request Overtime'}
              </button>
            </div>
          )}
        </div>

        {canSubmit && role !== 'admin' && showStaffRequestModal && (
          <div style={modalBackdrop} onClick={closeRequestModals}>
            <div style={modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={modalHeaderRow}>
                <h2 style={{ margin: 0, fontSize: 14, color: '#1f2937' }}>Request Overtime</h2>
                <button type="button" onClick={closeRequestModals} style={modalCloseBtn} aria-label="Close">x</button>
              </div>
              {submitFormError && (
                <div role="alert" aria-live="assertive" style={{ border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c', marginBottom: 4 }}>
                    {submitFormErrorFields.includes('work_date') ? 'Duplicate request — Work Date' : 'Cannot submit request'}
                  </div>
                  <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.5 }}>{submitFormError}</div>
                </div>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                {role === 'manager' && (
                  <>
                    <div style={{ gridColumn: 'span 2' }}>
                      <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input type="checkbox" checked={requestingForSelf} onChange={(e) => { setRequestingForSelf(e.target.checked); if (e.target.checked) setSelectedEmployeeId(0); }} style={{ width: 16, height: 16, cursor: 'pointer' }} />
                        <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>Requesting for myself</span>
                      </label>
                    </div>
                    {!requestingForSelf && (
                      <div style={{ gridColumn: 'span 2' }}>
                        <label style={labelStyle} htmlFor="overtime-employee">Select Employee</label>
                        <select id="overtime-employee" value={selectedEmployeeId} onChange={(e) => { setSelectedEmployeeId(Number(e.target.value)); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} required aria-required="true" aria-invalid={submitFormErrorFields.includes('employee_id')} style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('employee_id') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('employee_id') ? 2 : undefined }}>
                          <option value={0}>-- Select Employee --</option>
                          {employees.map((emp) => (
                            <option key={emp.employee_id} value={emp.employee_id}>{emp.first_name} {emp.last_name}</option>
                          ))}
                        </select>
                        {submitFormError && submitFormErrorFields.includes('employee_id') && (
                          <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div>
                  <label style={labelStyle} htmlFor="overtime-work-date">Work Date</label>
                  <input id="overtime-work-date" type="date" value={workDate} onChange={(e) => { setWorkDate(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} required aria-required="true" aria-invalid={submitFormErrorFields.includes('work_date')} style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('work_date') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('work_date') ? 2 : undefined }} />
                  {submitFormError && submitFormErrorFields.includes('work_date') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{workDate ? 'This date already has a request for this employee.' : 'Required.'}</div>
                  )}
                </div>
                <div>
                  <label style={labelStyle} htmlFor="overtime-hours">Hours</label>
                  <input id="overtime-hours" type="number" min={0.5} max={24} step={0.5} value={hoursRequested} onChange={(e) => { setHoursRequested(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} required aria-required="true" aria-invalid={submitFormErrorFields.includes('hours_requested')} style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('hours_requested') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('hours_requested') ? 2 : undefined }} />
                  {submitFormError && submitFormErrorFields.includes('hours_requested') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                  )}
                </div>
                <div style={{ gridColumn: 'span 2' }}>
                  <label style={labelStyle}>Reason</label>
                  <AutoResizeTextarea value={reason} onChange={(e) => { setReason(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} placeholder="Describe why overtime is needed..." style={{ ...inputStyle, width: '100%', minHeight: 40, borderColor: submitFormErrorFields.includes('reason') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('reason') ? 2 : undefined }} minRows={2} maxRows={6} />
                  {submitFormError && submitFormErrorFields.includes('reason') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                  )}
                </div>
                <div style={{ gridColumn: 'span 2', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" onClick={closeRequestModals} style={{ padding: '8px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                  <button onClick={() => void submitRequest()} disabled={submitting} className="app-action-btn app-action-btn-primary" style={{ opacity: submitting ? 0.6 : 1 }}>
                    {submitting ? 'Submitting...' : 'Submit Request'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {canSubmit && role === 'admin' && showCreateModal && (
          <div style={modalBackdrop} onClick={closeRequestModals}>
            <div style={modalCard} onClick={(e) => e.stopPropagation()}>
              <div style={modalHeaderRow}>
                <h2 style={{ margin: 0, fontSize: 14, color: '#1f2937' }}>Add Overtime Request</h2>
                <button
                  type="button"
                  onClick={closeRequestModals}
                  style={modalCloseBtn}
                  aria-label="Close add overtime request modal"
                >
                  x
                </button>
              </div>
              {submitFormError && (
                <div role="alert" aria-live="assertive" style={{ border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10, padding: '10px 12px', marginBottom: 10 }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c', marginBottom: 4 }}>
                    {submitFormErrorFields.includes('work_date') ? 'Duplicate request — Work Date' : 'Cannot submit request'}
                  </div>
                  <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.5 }}>{submitFormError}</div>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
                <div>
                  <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={requestingForSelf}
                      onChange={(e) => {
                        setRequestingForSelf(e.target.checked);
                        if (e.target.checked) setSelectedEmployeeId(0);
                      }}
                      style={{ width: 16, height: 16, cursor: 'pointer' }}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#374151' }}>
                      Requesting for myself
                    </span>
                  </label>
                </div>
                {!requestingForSelf && (
                  <div>
                    <label style={labelStyle} htmlFor="overtime-employee-admin">Select Employee</label>
                    <select
                      id="overtime-employee-admin"
                      value={selectedEmployeeId}
                      onChange={(e) => { setSelectedEmployeeId(Number(e.target.value)); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                      required
                      aria-required="true"
                      aria-invalid={submitFormErrorFields.includes('employee_id')}
                      style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('employee_id') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('employee_id') ? 2 : undefined }}
                    >
                      <option value={0}>-- Select Employee --</option>
                      {employees.map((emp) => (
                        <option key={emp.employee_id} value={emp.employee_id}>
                          {emp.first_name} {emp.last_name}
                        </option>
                      ))}
                    </select>
                    {submitFormError && submitFormErrorFields.includes('employee_id') && (
                      <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                    )}
                  </div>
                )}
                <div>
                  <label style={labelStyle} htmlFor="overtime-work-date-admin">Work Date</label>
                  <input id="overtime-work-date-admin" type="date" value={workDate} onChange={(e) => { setWorkDate(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} required aria-required="true" aria-invalid={submitFormErrorFields.includes('work_date')} style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('work_date') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('work_date') ? 2 : undefined }} />
                  {submitFormError && submitFormErrorFields.includes('work_date') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{workDate ? 'This date already has a request for this employee.' : 'Required.'}</div>
                  )}
                </div>
                <div>
                  <label style={labelStyle} htmlFor="overtime-hours-admin">Hours Requested</label>
                  <input id="overtime-hours-admin" type="number" min={0.5} max={24} step={0.5} value={hoursRequested} onChange={(e) => { setHoursRequested(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }} required aria-required="true" aria-invalid={submitFormErrorFields.includes('hours_requested')} style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('hours_requested') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('hours_requested') ? 2 : undefined }} />
                  {submitFormError && submitFormErrorFields.includes('hours_requested') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                  )}
                </div>
                <div>
                  <label style={labelStyle}>Reason</label>
                  <AutoResizeTextarea
                    value={reason}
                    onChange={(e) => { setReason(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                    placeholder="Describe why overtime is needed..."
                    style={{ ...inputStyle, width: '100%', minHeight: 40, borderColor: submitFormErrorFields.includes('reason') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('reason') ? 2 : undefined }}
                    minRows={2}
                    maxRows={6}
                  />
                  {submitFormError && submitFormErrorFields.includes('reason') && (
                    <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                  )}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, alignItems: 'center' }}>
                  <button
                    type="button"
                    onClick={closeRequestModals}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: 'pointer',
                      color: '#64748b',
                      fontWeight: 600,
                      fontSize: 14
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void submitRequest()}
                    disabled={submitting}
                    style={{ 
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: submitting ? 'not-allowed' : 'pointer',
                      color: submitting ? '#94a3b8' : '#2563eb',
                      fontWeight: 600,
                      fontSize: 14,
                      opacity: submitting ? 0.6 : 1 
                    }}
                  >
                    {submitting ? 'Saving...' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
          <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={{ ...thStyle, width: '16%' }}>Employee</th>
                <th style={{ ...thStyle, width: '12%' }}>Work Date</th>
                <th className="llb-num" style={{ ...thStyle, width: '8%' }}>Hours</th>
                <th style={{ ...thStyle, width: '28%' }}>Reason</th>
                <th style={{ ...thStyle, width: '10%' }}>Status</th>
                <th style={{ ...thStyle, width: '5%', textAlign: 'center' }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '12px', textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                    {searchQuery.trim()
                      ? (
                        <ZeroResults
                          query={searchQuery}
                          itemLabel="overtime requests"
                          alternatives={getAlternativeSuggestions(searchQuery, collectSearchTerms(rows, [
                            (r: any) => r.employee_name,
                            (r: any) => r.reason,
                            (r: any) => r.status,
                          ]))}
                          onPickAlternative={(term) => setSearchQuery(term)}
                          onClear={() => setSearchQuery('')}
                        />
                      )
                      : showArchiveView
                        ? 'No archived overtime requests found.'
                        : 'No overtime requests found.'}
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const canCancelRow = row.status === 'submitted'
                    && (canApprove || Number(row.employee_id) === Number(user?.employee_id));
                  return (
                  <tr key={row.overtime_request_id} style={{ transition: 'background-color 0.15s' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                      <td className="llb-trunc" title={row.employee_name || `Employee #${row.employee_id}`} style={tdStyle}>{row.employee_name || `Employee #${row.employee_id}`}</td>
                      <td style={{ ...tdStyle, fontSize: 12 }}>{row.work_date}</td>
                      <td className="llb-num" style={tdStyle}>{formatHours(row.hours_requested)}</td>
                      <td style={tdStyle}>
                        <div style={{ maxWidth: 280 }}>
                          <DescriptionCell 
                            text={row.reason} 
                            title="Reason"
                            recordId={row.overtime_request_id}
                            charLimit={50}
                          />
                          {row.manager_notes && (
                            <div style={{ marginTop: 6 }}>
                              <DescriptionCell 
                                text={row.manager_notes} 
                                title="Manager Notes"
                                recordId={row.overtime_request_id}
                                charLimit={40}
                                showLabel={true}
                                labelText="Note:"
                                fontSize={11}
                                color="#64748b"
                              />
                            </div>
                          )}
                        </div>
                      </td>
                      <td style={tdStyle}>
                        <span style={statusPill(row.status)}>{row.status}</span>
                      </td>
                      <td className="llb-actions" style={tdStyle}>
                        <div style={{ position: 'relative', textAlign: 'center' }}>
                          <button
                            ref={(el) => { actionButtonRefs.current[row.overtime_request_id] = el; }}
                            onClick={(e) => toggleDropdown(e, row.overtime_request_id)}
                            aria-expanded={activeDropdown === row.overtime_request_id}
                            aria-haspopup="menu"
                            aria-label={`Actions for request ${row.overtime_request_id}`}
                            style={{
                              background: activeDropdown === row.overtime_request_id ? '#f1f5f9' : 'transparent',
                              border: 'none',
                              cursor: 'pointer',
                              padding: '6px',
                              borderRadius: '6px',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="#64748b">
                              <circle cx="12" cy="5" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="12" cy="19" r="2" />
                            </svg>
                          </button>
                          {activeDropdown === row.overtime_request_id && dropdownPosition && (
                              <div
                                ref={dropdownMenuRef}
                                onClick={(e) => e.stopPropagation()}
                                role="menu"
                                style={{
                                  position: 'fixed',
                                  top: dropdownPosition.top,
                                  left: dropdownPosition.left,
                                  background: 'white',
                                  border: '1px solid #e2e8f0',
                                  borderRadius: '8px',
                                  boxShadow: '0 8px 24px rgba(15, 23, 42, 0.24)',
                                  zIndex: 1400,
                                  minWidth: '140px',
                                  padding: '4px',
                                }}
                              >
                              <div style={{ display: 'flex', flexDirection: 'column' }}>
                                <button
                                  onClick={() => { setSelectedRow(row); setActiveDropdown(null); setDropdownPosition(null); }}
                                  title="View Details"
                                  aria-label="View details"
                                  style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#1e3a8a', borderRadius: '6px' }}
                                  onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'}
                                  onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                >
                                  <CrudActionIcon action="view" /> View
                                </button>
                                {canApprove && row.status === 'submitted' && (
                                  <button
                                    onClick={() => { void updateStatus(row, 'approved'); setActiveDropdown(null); setDropdownPosition(null); }}
                                    disabled={actingId === row.overtime_request_id}
                                    title="Approve"
                                    aria-label="Approve request"
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#16a34a', borderRadius: '6px' }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0fdf4'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                  >
                                    <CrudActionIcon action="approve" /> Approve
                                  </button>
                                )}
                                {canApprove && row.status === 'submitted' && (
                                  <button
                                    onClick={() => { void updateStatus(row, 'rejected'); setActiveDropdown(null); setDropdownPosition(null); }}
                                    disabled={actingId === row.overtime_request_id}
                                    title="Reject"
                                    aria-label="Reject request"
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#dc2626', borderRadius: '6px' }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fef2f2'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                  >
                                    <CrudActionIcon action="delete" /> Reject
                                  </button>
                                )}
                                {canCancelRow && (
                                  <button
                                    onClick={() => { void updateStatus(row, 'cancelled'); setActiveDropdown(null); setDropdownPosition(null); }}
                                    disabled={actingId === row.overtime_request_id}
                                    title="Cancel"
                                    aria-label="Cancel request"
                                    style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#64748b', borderRadius: '6px' }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
                                  >
                                    <CrudActionIcon action="cancel" /> Cancel
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                        </div>
                      </td>
                  </tr>
                )})
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          currentPage={currentPage}
          totalItems={filteredRows.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setCurrentPage}
          label={showArchiveView ? 'archived overtime requests' : 'overtime requests'}
        />
      </div>

      {selectedRow && (
        <div style={modalBackdrop} onClick={() => setSelectedRow(null)}>
          <div style={viewModalCard} onClick={(event) => event.stopPropagation()}>
            <div style={viewModalHeader}>
              <div style={{ display: 'grid', gap: 8 }}>
                <div style={viewModalEyebrow}>Overtime Request Details</div>
                <div>
                  <h2 style={viewModalTitle}>
                    Request #{selectedRow.overtime_request_id}
                  </h2>
                  <p style={viewModalSubtitle}>
                    Review the full overtime request record.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <span style={statusPill(selectedRow.status)}>{selectedRow.status}</span>
                  <span style={viewMetaChip}>{selectedRow.employee_name || `Employee #${selectedRow.employee_id}`}</span>
                  <span style={viewMetaChip}>{selectedRow.work_date}</span>
                  <span style={viewMetaChip}>{formatHours(selectedRow.hours_requested)} hours</span>
                  {Number(selectedRow.is_archived ?? 0) === 1 && <span style={viewMetaChip}>Archive Storage</span>}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedRow(null)}
                style={modalCloseBtn}
                aria-label="Close overtime request details"
              >
                x
              </button>
            </div>

            <div style={viewModalBody}>
              <div style={detailGridStyle}>
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Employee</div>
                  <div style={detailValueStyle}>{selectedRow.employee_name || `Employee #${selectedRow.employee_id}`}</div>
                </div>
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Work Date</div>
                  <div style={detailValueStyle}>{selectedRow.work_date}</div>
                </div>
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Hours Requested</div>
                  <div style={detailValueStyle}>{formatHours(selectedRow.hours_requested)}</div>
                </div>
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Submitted At</div>
                  <div style={detailValueStyle}>{formatDateTime(selectedRow.created_at)}</div>
                </div>
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Current Status</div>
                  <div style={detailValueStyle}>
                    <span style={statusPill(selectedRow.status)}>{selectedRow.status}</span>
                  </div>
                </div>
                {Number(selectedRow.is_archived ?? 0) === 1 && (
                  <div style={detailCardStyle}>
                    <div style={detailLabelStyle}>Archived At</div>
                    <div style={detailValueStyle}>{formatDateTime(selectedRow.archived_at)}</div>
                  </div>
                )}
              </div>

              <div style={detailSectionStyle}>
                <div style={detailLabelStyle}>Reason</div>
                <div style={detailTextStyle}>{selectedRow.reason || 'No reason provided.'}</div>
              </div>

              <div style={detailSectionStyle}>
                <div style={detailLabelStyle}>Manager Notes</div>
                <div style={detailTextStyle}>{selectedRow.manager_notes || 'No manager notes yet.'}</div>
              </div>
            </div>

            <div style={viewModalFooter}>
              <button
                type="button"
                onClick={() => setSelectedRow(null)}
                className="app-action-btn"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

const filterControlStyle: CSSProperties = {
  height: 36,
  minWidth: 132,
  padding: '0 10px',
  borderRadius: 8,
  border: '1px solid #e2e8f0',
  fontSize: 13,
  color: '#333',
  backgroundColor: '#fff',
};

const primaryActionRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-start',
  marginBottom: 4,
};

function headerArchiveButtonStyle(active: boolean): CSSProperties {
  return {
    background: active ? '#1e3a8a' : '#f1f5f9',
    color: active ? '#fff' : '#64748b',
    border: 'none',
    borderRadius: 6,
    height: 36,
    padding: '0 12px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 13,
    fontWeight: 'bold',
    whiteSpace: 'nowrap',
  };
}

const labelStyle: CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontSize: 11,
  color: '#475569',
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const inputStyle: CSSProperties = {
  padding: '8px 10px',
  borderRadius: 8,
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#1f2937',
  fontSize: 13,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  color: '#475569',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.03em',
};

const tdStyle: CSSProperties = {
  padding: '10px 12px',
  color: '#1e293b',
  fontSize: 13,
  verticalAlign: 'middle',
};

function formatHours(value: number | string | null | undefined) {
  return Number(value || 0).toFixed(2);
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function statusPill(status: string): CSSProperties {
  if (status === 'approved') return { background: '#dcfce7', color: '#15803d', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' as const };
  if (status === 'rejected') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' as const };
  if (status === 'cancelled') return { background: '#f1f5f9', color: '#475569', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' as const };
  return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, textTransform: 'capitalize' as const };
}

const modalBackdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 14,
  background: 'rgba(15, 23, 42, 0.45)',
};

const modalCard: CSSProperties = {
  width: '100%',
  maxWidth: 480,
  borderRadius: 'var(--modal-radius)',
  border: '1px solid #cbd5e1',
  background: '#fff',
  boxShadow: '0 18px 45px rgba(2, 6, 23, 0.28)',
  padding: 16,
};

const modalHeaderRow: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 12,
};

const modalCloseBtn: CSSProperties = {
  border: '1px solid #cbd5e1',
  background: '#f8fafc',
  color: '#334155',
  borderRadius: 8,
  width: 28,
  height: 28,
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: 12,
};

const modalSecondaryBtn: CSSProperties = {
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  borderRadius: 999,
  padding: '8px 14px',
  fontWeight: 600,
  fontSize: 12,
  cursor: 'pointer',
};

const viewModalCard: CSSProperties = {
  width: 'min(700px, calc(100vw - 28px))',
  maxHeight: 'calc(100vh - 28px)',
  borderRadius: 'var(--modal-radius)',
  border: '1px solid #cbd5e1',
  background: '#fff',
  boxShadow: '0 18px 45px rgba(2, 6, 23, 0.28)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const viewModalHeader: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  padding: '16px 16px 0 16px',
};

const viewModalEyebrow: CSSProperties = {
  fontSize: 10,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 800,
};

const viewModalTitle: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: '#0f172a',
  letterSpacing: '-0.03em',
};

const viewModalSubtitle: CSSProperties = {
  margin: '4px 0 0 0',
  color: '#64748b',
  fontSize: 12,
};

const viewMetaChip: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '4px 10px',
  borderRadius: 999,
  background: '#f1f5f9',
  color: '#475569',
  fontSize: 11,
  fontWeight: 600,
};

const viewModalBody: CSSProperties = {
  padding: 16,
  overflowY: 'auto',
  display: 'grid',
  gap: 12,
};

const detailGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: 10,
};

const detailCardStyle: CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  background: '#f8fafc',
  padding: '10px 12px',
};

const detailSectionStyle: CSSProperties = {
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  background: '#fff',
  padding: '12px 14px',
};

const detailLabelStyle: CSSProperties = {
  fontSize: 10,
  color: '#64748b',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 800,
  marginBottom: 4,
};

const detailValueStyle: CSSProperties = {
  color: '#0f172a',
  fontSize: 13,
  fontWeight: 700,
  lineHeight: 1.5,
};

const detailTextStyle: CSSProperties = {
  color: '#334155',
  fontSize: 13,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
};

const viewModalFooter: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '0 16px 16px 16px',
};
