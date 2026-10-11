import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { EllipsisVertical } from 'lucide-react';
import Layout from '@/components/Layout';
import CrudActionIcon from '@/components/CrudActionIcon';
import Pagination from '@/components/Pagination';
import { getApiBaseUrl } from '@/utils/network';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API = getApiBaseUrl();

type SessionUser = {
  role?: string;
  employee_id?: number;
  branch_id?: number;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
};

type EmployeeOption = {
  employee_id: number;
  employee_date_id?: string | null;
  branch_id?: number | null;
  first_name?: string;
  last_name?: string;
  position?: string | null;
  roles?: string | null;
  linked_user_role?: string | null;
  status?: string;
};

type CashAdvanceRow = {
  cash_advance_request_id: number;
  employee_id: number;
  employee_name?: string;
  employee_role?: string | null;
  request_date: string;
  amount: number | string;
  reason: string;
  status: 'submitted' | 'approved' | 'rejected' | 'cancelled' | string;
  manager_notes?: string | null;
  created_at: string;
  approved_at?: string | null;
  deducted_payroll_id?: number | null;
  deducted_at?: string | null;
  deducted_pay_period_start?: string | null;
  deducted_pay_period_end?: string | null;
  deducted_payroll_status?: string | null;
  is_archived?: number | boolean;
  archived_at?: string | null;
  archived_by?: number | null;
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

function todayValue() {
  const now = new Date();
  const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function money(value: number | string | null | undefined) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatDateTime(value?: string | null) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatEmployeeLabel(employee?: EmployeeOption | null) {
    if (!employee) return 'Select employee';
    const name = `${String(employee.first_name || '').trim()} ${String(employee.last_name || '').trim()}`.trim();
    if (name) return name;
    return `Employee #${employee.employee_id}`;
}

function formatEmployeeOptionLabel(employee?: EmployeeOption | null, ownEmployeeId = 0) {
  if (!employee) return 'Select employee';
  const baseLabel = formatEmployeeLabel(employee);
  return employee.employee_id === ownEmployeeId && ownEmployeeId > 0
    ? `${baseLabel} (Own)`
    : baseLabel;
}

function formatSelfLabel(user: SessionUser | null, employeeId: number) {
  const name = `${String(user?.first_name || '').trim()} ${String(user?.last_name || '').trim()}`.trim();
  if (name) return name;
  if (employeeId > 0) return `Linked employee #${employeeId}`;
  return 'No linked employee';
}

function truncateText(text: string | null | undefined, maxLength: number) {
  if (!text) return '';
  const normalized = String(text);
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, maxLength) + '...';
}

function normalizeEmployeeRole(role?: string | null) {
  const normalized = String(role || '').trim().toLowerCase();
  if (normalized === 'admin' || normalized === 'manager' || normalized === 'staff') {
    return normalized;
  }
  return 'staff';
}

function resolveEmployeeDropdownRole(employee?: EmployeeOption | null) {
  const candidates = [
    String(employee?.linked_user_role || ''),
    String(employee?.roles || ''),
    String(employee?.position || ''),
  ];

  for (const candidate of candidates) {
    const normalized = candidate.trim().toLowerCase();
    if (!normalized) continue;
    if (/\badmin\b/.test(normalized)) return 'admin';
    if (/\bmanager\b/.test(normalized)) return 'manager';
    if (/\bstaff\b/.test(normalized)) return 'staff';
  }

  return 'staff';
}

function canSelectEmployeeForRequest(employee: EmployeeOption, actorRole: string, actorBranchId = 0) {
  const employeeRole = resolveEmployeeDropdownRole(employee);
  if (actorRole === 'admin') {
    return employeeRole !== 'admin';
  }
  if (actorRole === 'manager') {
    return employeeRole === 'staff' && Number(employee.branch_id || 0) === actorBranchId;
  }
  return false;
}

function isCashAdvanceRow(value: unknown): value is CashAdvanceRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<CashAdvanceRow>;
  return Number(row.cash_advance_request_id || 0) > 0
    && Number(row.employee_id || 0) > 0
    && typeof row.request_date === 'string'
    && row.request_date.length > 0
    && row.amount !== undefined
    && typeof row.reason === 'string'
    && typeof row.status === 'string'
    && typeof row.created_at === 'string';
}

function rowBelongsInCurrentList(row: CashAdvanceRow, statusFilter: string, archivedOnly: boolean) {
  const isArchived = Number(row.is_archived ?? 0) === 1;
  if (isArchived !== archivedOnly) return false;
  return statusFilter === 'all' || String(row.status || '').toLowerCase() === statusFilter;
}

export default function CashAdvancePage() {
  const ITEMS_PER_PAGE = usePaginationSetting();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<CashAdvanceRow[]>([]);
  const [employees, setEmployees] = useState<EmployeeOption[]>([]);
  const [employeesLoading, setEmployeesLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [actingId, setActingId] = useState<string | null>(null);
  const [showRequestModal, setShowRequestModal] = useState(false);
  const [showArchiveView, setShowArchiveView] = useState(false);
  const [selectedRow, setSelectedRow] = useState<CashAdvanceRow | null>(null);
  const [openActionRowId, setOpenActionRowId] = useState<number | null>(null);

  const [selectedEmployeeId, setSelectedEmployeeId] = useState('');
  const [requestOwn, setRequestOwn] = useState(false);
  const [requestDate, setRequestDate] = useState(todayValue());
  const [amount, setAmount] = useState('1000');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Inline (labeled) submit error for the request modal.
  // Kept separate from page `error` (which toasts via SweetAlert) on purpose.
  const [submitFormError, setSubmitFormError] = useState('');
  const [submitFormErrorFields, setSubmitFormErrorFields] = useState<string[]>([]);

  const role = String(user?.role || '').toLowerCase();
  const selfEmployeeId = Number(user?.employee_id || 0);
  const selfBranchId = Number(user?.branch_id || 0);
  const isAdmin = role === 'admin';
  const isManager = role === 'manager';
  const canChooseRequestEmployee = isAdmin || isManager;
  const canRequestOwnAsAdmin = isAdmin && selfEmployeeId > 0;
  const canRequestOwnAsManager = isManager && selfEmployeeId > 0;
  const canRequestOwn = canRequestOwnAsAdmin || canRequestOwnAsManager;
  const canOpenRequestModal = isAdmin || (isManager ? selfBranchId > 0 : selfEmployeeId > 0);
  const requestModalDisabledReason = isManager
    ? 'Your account is not linked to a branch.'
    : 'Your account is not linked to an employee record.';
  const effectiveEmployeeId = canChooseRequestEmployee
    ? Number(((isAdmin || isManager) && requestOwn ? selfEmployeeId : selectedEmployeeId) || 0)
    : selfEmployeeId;

  const ownEmployeeOption = useMemo(() => {
    if (selfEmployeeId <= 0) return null;
    return employees.find((employee) => employee.employee_id === selfEmployeeId) || {
      employee_id: selfEmployeeId,
      branch_id: selfBranchId,
      first_name: user?.first_name,
      last_name: user?.last_name,
      position: role ? `${role.charAt(0).toUpperCase()}${role.slice(1)}` : 'Employee',
      linked_user_role: role,
      status: 'active',
    };
  }, [employees, role, selfBranchId, selfEmployeeId, user?.first_name, user?.last_name]);

  const requestableEmployees = useMemo(
    () => employees.filter((employee) => canSelectEmployeeForRequest(employee, role, selfBranchId)),
    [employees, role, selfBranchId]
  );

  const requestEmployeeOptions = useMemo(() => {
    if (!canChooseRequestEmployee) return employees;
    return requestableEmployees;
  }, [canChooseRequestEmployee, employees, requestableEmployees]);

  const selectedEmployee = useMemo(
    () => {
      if (!canChooseRequestEmployee) return ownEmployeeOption;
      if ((isAdmin || isManager) && requestOwn) return ownEmployeeOption;
      const targetEmployeeId = Number(selectedEmployeeId);
      return requestEmployeeOptions.find((employee) => employee.employee_id === targetEmployeeId) || null;
    },
    [canChooseRequestEmployee, isAdmin, isManager, ownEmployeeOption, requestEmployeeOptions, requestOwn, selectedEmployeeId]
  );

  const selectedEmployeeLabel = canChooseRequestEmployee
    ? formatEmployeeLabel(selectedEmployee)
    : formatSelfLabel(user, selfEmployeeId);

  useEffect(() => {
    const init = async () => {
      try {
        const sessionRes = await fetch(`${API}/auth.php`, { credentials: 'include' });
        const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
        if (!sessionData.success || !sessionData.data) {
          router.push('/');
          return;
        }

        const nextUser = sessionData.data;
        const userRole = String(nextUser.role || '').toLowerCase();
        if (!['staff', 'manager', 'admin'].includes(userRole)) {
          router.push('/dashboard');
          return;
        }

        setUser(nextUser);
        if (userRole === 'admin' || userRole === 'manager') {
          await fetchEmployees(nextUser);
        } else if (Number(nextUser.employee_id || 0) > 0) {
          setSelectedEmployeeId(String(nextUser.employee_id));
        }
        await fetchRows('all', false);
      } catch {
        router.push('/');
      } finally {
        setLoading(false);
      }
    };

    void init();
  }, [router]);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
    setError('');
  }, [error]);

  useEffect(() => {
    if (openActionRowId === null) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && !target.closest('.action-dropdown')) {
        setOpenActionRowId(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openActionRowId]);

  useEffect(() => {
    if (!showRequestModal) return undefined;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowRequestModal(false);
      }
    };

    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [showRequestModal]);

  useEffect(() => {
    if (!selectedRow) return;
    const nextSelected = rows.find((row) => row.cash_advance_request_id === selectedRow.cash_advance_request_id) || null;
    setSelectedRow(nextSelected);
  }, [rows, selectedRow]);

  useEffect(() => {
    if (!canChooseRequestEmployee) return;
    if ((isAdmin || isManager) && requestOwn && selfEmployeeId > 0) {
      if (selectedEmployeeId !== String(selfEmployeeId)) {
        setSelectedEmployeeId(String(selfEmployeeId));
      }
      return;
    }
    const selectedExists = requestEmployeeOptions.some((employee) => employee.employee_id === Number(selectedEmployeeId));
    if (requestEmployeeOptions.length === 0) {
      if (selectedEmployeeId !== '') {
        setSelectedEmployeeId('');
      }
      return;
    }
    if ((!selectedEmployeeId || !selectedExists) && requestEmployeeOptions.length > 0) {
      setSelectedEmployeeId(String(requestEmployeeOptions[0].employee_id));
    }
  }, [canChooseRequestEmployee, isAdmin, isManager, requestEmployeeOptions, requestOwn, selectedEmployeeId, selfEmployeeId]);

  const fetchEmployees = async (sessionUser?: SessionUser | null) => {
    const actorRole = String(sessionUser?.role || '').toLowerCase();
    const actorBranchId = Number(sessionUser?.branch_id || 0);
    if (actorRole === 'manager' && actorBranchId <= 0) {
      setEmployees([]);
      setSelectedEmployeeId('');
      setError('Your account is not linked to a branch.');
      return;
    }

    setEmployeesLoading(true);
    try {
      const params = new URLSearchParams();
      if (actorRole === 'manager' && actorBranchId > 0) {
        params.set('branch_id', String(actorBranchId));
      }
      const query = params.toString();
      const res = await fetch(`${API}/employees.php${query ? `?${query}` : ''}`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<EmployeeOption[]>;
      if (data.success && Array.isArray(data.data)) {
        const nextEmployees = data.data;
        const selectableEmployees = nextEmployees.filter((employee) => canSelectEmployeeForRequest(employee, actorRole, actorBranchId));
        setEmployees(nextEmployees);

        const preferredEmployeeId = Number(sessionUser?.employee_id || 0);
        const preferredExists = selectableEmployees.some((employee) => employee.employee_id === preferredEmployeeId);
        if (preferredExists) {
          setSelectedEmployeeId(String(preferredEmployeeId));
        } else if (selectableEmployees.length > 0) {
          setSelectedEmployeeId(String(selectableEmployees[0].employee_id));
        } else {
          setSelectedEmployeeId('');
        }
      } else {
        setEmployees([]);
        setSelectedEmployeeId('');
        setError(data.message || 'Failed to load employee choices.');
      }
    } catch {
      setEmployees([]);
      setSelectedEmployeeId('');
      setError('Failed to load employee choices.');
    } finally {
      setEmployeesLoading(false);
    }
  };

  const fetchRows = async (nextStatus: string, archivedOnly = showArchiveView) => {
    setRefreshing(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (nextStatus !== 'all') params.set('status', nextStatus);
      params.set('archived', archivedOnly ? '1' : '0');
      const res = await fetch(`${API}/cash-advance-requests.php?${params.toString()}`, { credentials: 'include' });
      const data = (await res.json()) as ApiResponse<CashAdvanceRow[]>;
      if (data.success && Array.isArray(data.data)) {
        setRows(data.data);
      } else {
        setRows([]);
        setError(data.message || 'Failed to load cash advance requests.');
      }
    } catch {
      setRows([]);
      setError('Failed to load cash advance requests.');
    } finally {
      setRefreshing(false);
    }
  };

  const toggleArchiveView = () => {
    const nextArchiveView = !showArchiveView;
    setShowArchiveView(nextArchiveView);
    setStatusFilter('all');
    setCurrentPage(1);
    setSelectedRow(null);
    void fetchRows('all', nextArchiveView);
  };

  const openRequestModal = () => {
    if (!canOpenRequestModal) {
      setError(requestModalDisabledReason);
      return;
    }
    if (canChooseRequestEmployee && !selectedEmployeeId && requestEmployeeOptions.length > 0) {
      setSelectedEmployeeId(String(requestEmployeeOptions[0].employee_id));
    }
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
    setShowRequestModal(true);
  };

  const closeRequestModal = () => {
    if (submitting) return;
    setShowRequestModal(false);
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
  };

  const resetRequestForm = () => {
    setRequestDate(todayValue());
    setAmount('1000');
    setReason('');
    setRequestOwn(false);
    if (!canChooseRequestEmployee && selfEmployeeId > 0) {
      setSelectedEmployeeId(String(selfEmployeeId));
    } else if (canChooseRequestEmployee) {
      if (requestEmployeeOptions.length > 0) {
        setSelectedEmployeeId(String(requestEmployeeOptions[0].employee_id));
      } else {
        setSelectedEmployeeId('');
      }
    }
  };

  const submitRequest = async () => {
    if (!canOpenRequestModal) {
      setError(requestModalDisabledReason);
      return;
    }
    setSubmitFormError('');
    setSubmitFormErrorFields([]);
    if (!effectiveEmployeeId) {
      setSubmitFormError('Please choose an employee for this cash advance request.');
      setSubmitFormErrorFields(['employee_id']);
      return;
    }
    const missingCashFields: string[] = [];
    if (!requestDate) missingCashFields.push('request_date');
    if (!amount) missingCashFields.push('amount');
    if (!reason.trim()) missingCashFields.push('reason');
    if (missingCashFields.length > 0) {
      setSubmitFormError('Employee, Request Date, Amount, and Reason are all required.');
      setSubmitFormErrorFields(missingCashFields);
      return;
    }

    setSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        request_date: requestDate,
        amount: Number(amount),
        reason: reason.trim(),
      };
      if (canChooseRequestEmployee) {
        payload.employee_id = effectiveEmployeeId;
        if ((isAdmin || isManager) && requestOwn) {
          payload.request_own = true;
        }
      }

      // X-No-Toast: form errors render inline (labeled) below — never as SweetAlert.
      const res = await fetch(`${API}/cash-advance-requests.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-No-Toast': '1' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        // Show the accurate backend message inline, labeled to the conflicting field.
        setSubmitFormError(data.message || 'Failed to submit cash advance request.');
        const fields = Array.isArray(data.errors?.fields) && data.errors.fields.length > 0
          ? data.errors.fields.filter((f): f is string => typeof f === 'string')
          : (typeof data.errors?.field === 'string' ? [data.errors.field] : []);
        setSubmitFormErrorFields(fields);
        return;
      }

      resetRequestForm();
      setSubmitFormError('');
      setSubmitFormErrorFields([]);
      setShowRequestModal(false);
      const createdRow = data.data;
      if (isCashAdvanceRow(createdRow)) {
        if (rowBelongsInCurrentList(createdRow, statusFilter, showArchiveView)) {
          setRows(prev => [
            createdRow,
            ...prev.filter(row => row.cash_advance_request_id !== createdRow.cash_advance_request_id),
          ]);
          setCurrentPage(1);
        }
      } else {
        await fetchRows(statusFilter, showArchiveView);
      }
      await notifySuccess('Cash advance request submitted.');
    } catch {
      setSubmitFormError('Network error. Please check your connection and try again.');
      setSubmitFormErrorFields([]);
    } finally {
      setSubmitting(false);
    }
  };

  const updateStatus = async (row: CashAdvanceRow, nextStatus: 'approved' | 'rejected' | 'cancelled') => {
    const actionKey = `${row.cash_advance_request_id}-${nextStatus}`;
    setActingId(actionKey);
    setError('');
    try {
      const payload: Record<string, unknown> = {
        cash_advance_request_id: row.cash_advance_request_id,
      };

      if (nextStatus === 'cancelled') {
        payload.action = 'cancel';
      } else {
        payload.status = nextStatus;
        payload.manager_notes = nextStatus === 'approved'
          ? 'Approved from cash advance board.'
          : 'Rejected from cash advance board.';
      }

      const res = await fetch(`${API}/cash-advance-requests.php`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to update cash advance request.');
        return;
      }

      if (selectedRow?.cash_advance_request_id === row.cash_advance_request_id) {
        setSelectedRow(prev => prev && prev.cash_advance_request_id === row.cash_advance_request_id ? { ...prev, status: nextStatus } : prev);
      }
      setRows(prev => prev.map(r =>
        r.cash_advance_request_id === row.cash_advance_request_id ? { ...r, status: nextStatus } : r
      ));
      await notifySuccess(
        nextStatus === 'approved'
          ? 'Cash advance request approved.'
          : nextStatus === 'rejected'
            ? 'Cash advance request rejected.'
            : 'Cash advance request cancelled.'
      );
    } catch {
      setError('Failed to update cash advance request.');
    } finally {
      setActingId(null);
    }
  };

  const archiveRequest = async (row: CashAdvanceRow) => {
    const ok = await confirmAction({
      title: 'Archive cash advance request?',
      text: `Move request #${row.cash_advance_request_id} to archive storage?`,
      confirmButtonText: 'Archive',
      danger: true,
    });
    if (!ok) return;

    setActingId(`${row.cash_advance_request_id}-archive`);
    setError('');
    try {
      const res = await fetch(`${API}/cash-advance-requests.php`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cash_advance_request_id: row.cash_advance_request_id, action: 'archive' }),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to archive cash advance request.');
        return;
      }
      if (selectedRow?.cash_advance_request_id === row.cash_advance_request_id) {
        setSelectedRow(null);
      }
      setRows(prev => prev.filter(r => r.cash_advance_request_id !== row.cash_advance_request_id));
      await notifySuccess('Cash advance request archived.');
    } catch {
      setError('Failed to archive cash advance request.');
    } finally {
      setActingId(null);
    }
  };

  const restoreRequest = async (row: CashAdvanceRow) => {
    setActingId(`${row.cash_advance_request_id}-restore`);
    setError('');
    try {
      const res = await fetch(`${API}/cash-advance-requests.php`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ cash_advance_request_id: row.cash_advance_request_id, action: 'restore' }),
      });
      const data = (await res.json()) as ApiResponse<unknown>;
      if (!data.success) {
        setError(data.message || 'Failed to restore cash advance request.');
        return;
      }
      if (selectedRow?.cash_advance_request_id === row.cash_advance_request_id) {
        setSelectedRow(null);
      }
      setRows(prev => prev.filter(r => r.cash_advance_request_id !== row.cash_advance_request_id));
      await notifySuccess('Cash advance request restored.');
    } catch {
      setError('Failed to restore cash advance request.');
    } finally {
      setActingId(null);
    }
  };

  const archiveAllRequests = async () => {
    if (showArchiveView || rows.length === 0) {
      if (showArchiveView) {
        await notifyError('Cannot archive all from archive view.');
      } else {
        await notifyError('No active requests to archive.');
      }
      return;
    }

    const ok = await confirmAction({
      title: 'Archive all cash advance requests?',
      text: `This will archive ${rows.length} request(s).`,
      confirmButtonText: 'Archive All',
      danger: true,
    });
    if (!ok) return;

    setError('');
    try {
      const results = await Promise.all(
        rows.map((row) =>
          fetch(`${API}/cash-advance-requests.php`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ cash_advance_request_id: row.cash_advance_request_id, action: 'archive' }),
          }).then((res) => res.json())
        )
      );

      const failed = results.filter((r: ApiResponse<unknown>) => !r?.success).length;
      if (failed > 0) {
        setError(`${failed} request(s) could not be archived.`);
      }
      await fetchRows(statusFilter, showArchiveView);
      if (failed === 0) {
        await notifySuccess('All requests archived successfully.');
      }
    } catch {
      setError('Failed to archive all requests.');
    }
  };

  const summary = useMemo(() => {
    return rows.reduce(
      (acc, row) => {
        const amountValue = Number(row.amount || 0);
        acc.totalRequested += amountValue;
        if (row.status === 'approved' && Number(row.deducted_payroll_id || 0) > 0) {
          acc.deducted += amountValue;
        } else if (row.status === 'approved') {
          acc.queued += amountValue;
        } else if (row.status === 'submitted') {
          acc.pending += amountValue;
        }
        return acc;
      },
      { totalRequested: 0, pending: 0, queued: 0, deducted: 0 }
    );
  }, [rows]);

  const paginatedRows = useMemo(() => {
    return rows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
  }, [rows, currentPage]);

  useEffect(() => {
    setCurrentPage(1);
  }, [rows.length, statusFilter, showArchiveView]);

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
        <title>Cash Advance</title>
      </Head>

      <div style={{ maxWidth: 1240, margin: '0 auto', padding: 12 }}>
        <div className="pageHeaderInline" style={heroRowStyle}>
          <div className="pageHeaderText">
            <h1 style={{ margin: 0, fontSize: 13, color: '#1f2937', letterSpacing: '-0.03em' }}>Cash Advance</h1>
            <p style={{ margin: '2px 0 0 0', color: '#64748b', fontSize: 11 }}>
              Submit and track cash advance requests.
            </p>
          </div>
          <div className="pageInlineFilters">
            <select
              value={statusFilter}
              onChange={(e) => {
                const value = e.target.value;
                setStatusFilter(value);
                void fetchRows(value, showArchiveView);
              }}
              style={inputStyle}
            >
              <option value="all">All Status</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <button onClick={() => void fetchRows(statusFilter, showArchiveView)} style={refreshButtonStyle}>
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
            {!showArchiveView && rows.length > 0 && (
              <button
                type="button"
                onClick={archiveAllRequests}
                style={{
                  ...archiveStorageButton(false),
                  background: '#dc2626',
                  color: 'white',
                }}
              >
                <CrudActionIcon action="archive" size={15} />
                Archive All
              </button>
            )}
            <button type="button" onClick={toggleArchiveView} style={archiveStorageButton(showArchiveView)}>
              <CrudActionIcon action="archive" size={15} />
              {showArchiveView ? 'Back to Active' : 'Archive Storage'}
            </button>
          <button
            type="button"
            onClick={openRequestModal}
            disabled={!canOpenRequestModal}
            style={{
              ...requestButtonStyle,
              opacity: canOpenRequestModal ? 1 : 0.55,
              cursor: canOpenRequestModal ? 'pointer' : 'not-allowed',
            }}
            title={canOpenRequestModal ? 'Open cash advance request form' : requestModalDisabledReason}
          >
            Request Cash Advance
          </button>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6, marginBottom: 8 }}>
          <SummaryCard label="Total Requested" value={money(summary.totalRequested)} color="#1e3a8a" background="linear-gradient(135deg, #dbeafe 0%, #eff6ff 100%)" />
          <SummaryCard label="Pending Approval" value={money(summary.pending)} color="#92400e" background="linear-gradient(135deg, #fef3c7 0%, #fffbeb 100%)" />
          <SummaryCard label="Approved Queue" value={money(summary.queued)} color="#6d28d9" background="linear-gradient(135deg, #ede9fe 0%, #faf5ff 100%)" />
          <SummaryCard label="Already Deducted" value={money(summary.deducted)} color="#166534" background="linear-gradient(135deg, #dcfce7 0%, #f0fdf4 100%)" />
        </div>

        {!canOpenRequestModal && (
          <div style={{ ...warningCardStyle, padding: 10, marginBottom: 10 }}>
            {requestModalDisabledReason} The request button is disabled.
          </div>
        )}

        <div style={tableShellStyle}>
          <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead style={{ background: '#f8fafc' }}>
              <tr>
                <th style={thStyle}>Employee</th>
                <th style={thStyle}>Request Date</th>
                <th className="llb-num" style={thStyle}>Amount</th>
                <th style={thStyle}>Reason</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Payroll Deduction</th>
                <th style={thStyle}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: 28, textAlign: 'center', color: '#64748b' }}>
                    {showArchiveView ? 'No archived cash advance requests found.' : 'No cash advance requests found.'}
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const actionBase = String(row.cash_advance_request_id);
                  const normalizedStatus = String(row.status || '').toLowerCase();
                  const targetRole = normalizeEmployeeRole(row.employee_role);
                  const isOwnRow = Number(row.employee_id) === selfEmployeeId && selfEmployeeId > 0;
                  const isOwnSubmittedRequest = normalizedStatus === 'submitted' && Number(row.employee_id) === selfEmployeeId;
                  const canReviewRow = normalizedStatus === 'submitted'
                    && (role === 'admin'
                      || (role === 'manager'
                        && targetRole === 'staff'
                        && Number(row.employee_id) !== selfEmployeeId));
                  const canCancelRow = isOwnSubmittedRequest || canReviewRow;
                  const canManageArchiveRow = role === 'admin'
                    || (role === 'manager' ? targetRole === 'staff' || isOwnRow : isOwnRow);
                  const canArchiveRow = !showArchiveView
                    && canManageArchiveRow
                    && ['approved', 'rejected', 'cancelled'].includes(normalizedStatus);
                  const canRestoreRow = showArchiveView && canManageArchiveRow;

                  return (
                    <tr key={row.cash_advance_request_id} style={{ borderTop: '1px solid #eef2f7' }}>
                      <td className="llb-trunc" title={row.employee_name || `Employee #${row.employee_id}`} style={tdStyle}>{row.employee_name || `Employee #${row.employee_id}`}</td>
                      <td style={tdStyle}>
                        <div>{row.request_date}</div>
                        <div style={{ color: '#64748b', fontSize: 12 }}>{formatDateTime(row.created_at)}</div>
                      </td>
                      <td className="llb-num" style={tdStyle}>{money(row.amount)}</td>
                      <td style={tdStyle}>
                        <div style={{ maxWidth: 240, color: '#334155' }}>{truncateText(row.reason, 64)}</div>
                        {row.manager_notes && (
                          <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
                            Note: {truncateText(row.manager_notes, 72)}
                          </div>
                        )}
                      </td>
                      <td style={tdStyle}>
                        <span style={statusPill(row.status)}>{row.status}</span>
                      </td>
                      <td style={tdStyle}>
                        {row.status === 'approved' && Number(row.deducted_payroll_id || 0) > 0 ? (
                          <div style={{ display: 'grid', gap: 3 }}>
                            <span style={deductionPill(true)}>Deducted</span>
                            <span style={{ fontSize: 11, color: '#334155' }}>
                              Payroll #{row.deducted_payroll_id}
                            </span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>
                              {row.deducted_pay_period_start || '-'} - {row.deducted_pay_period_end || '-'}
                            </span>
                          </div>
                        ) : row.status === 'approved' ? (
                          <div style={{ display: 'grid', gap: 3 }}>
                            <span style={deductionPill(false)}>Queued</span>
                            <span style={{ fontSize: 11, color: '#64748b' }}>
                              Waiting for the next open payroll.
                            </span>
                          </div>
                        ) : (
                          <span style={{ color: '#94a3b8', fontSize: 11 }}>Not yet applicable</span>
                        )}
                      </td>
                      <td className="llb-actions" style={{ ...tdStyle, width: 74 }}>
                        <div className="action-dropdown" style={actionDropdownWrapStyle}>
                          <button
                            type="button"
                            onClick={() => setOpenActionRowId(prev => prev === row.cash_advance_request_id ? null : row.cash_advance_request_id)}
                            style={actionMenuButtonStyle}
                            aria-label={`Open actions for cash advance request #${row.cash_advance_request_id}`}
                            aria-haspopup="menu"
                            aria-expanded={openActionRowId === row.cash_advance_request_id}
                          >
                            <EllipsisVertical size={18} strokeWidth={2.2} />
                          </button>

                          {openActionRowId === row.cash_advance_request_id && (
                            <div style={actionMenuStyle} role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => { setSelectedRow(row); setOpenActionRowId(null); }}
                                style={menuItemStyle}
                              >
                                <CrudActionIcon action="view" size={15} />
                                View
                              </button>
                              {canReviewRow && (
                                <>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { void updateStatus(row, 'approved'); setOpenActionRowId(null); }}
                                    disabled={actingId === `${actionBase}-approved`}
                                    style={menuItemStyle}
                                  >
                                    <CrudActionIcon action="approve" size={15} />
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => { void updateStatus(row, 'rejected'); setOpenActionRowId(null); }}
                                    disabled={actingId === `${actionBase}-rejected`}
                                    style={menuItemStyle}
                                  >
                                    <CrudActionIcon action="cancel" size={15} />
                                    Reject
                                  </button>
                                </>
                              )}
                              {canCancelRow && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { void updateStatus(row, 'cancelled'); setOpenActionRowId(null); }}
                                  disabled={actingId === `${actionBase}-cancelled`}
                                  style={menuItemStyle}
                                >
                                  <CrudActionIcon action="cancel" size={15} />
                                  Cancel
                                </button>
                              )}
                              {canArchiveRow && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { void archiveRequest(row); setOpenActionRowId(null); }}
                                  disabled={actingId === `${actionBase}-archive`}
                                  style={menuItemStyle}
                                >
                                  <CrudActionIcon action="archive" size={15} />
                                  Archive
                                </button>
                              )}
                              {canRestoreRow && (
                                <button
                                  type="button"
                                  role="menuitem"
                                  onClick={() => { void restoreRequest(row); setOpenActionRowId(null); }}
                                  disabled={actingId === `${actionBase}-restore`}
                                  style={menuItemStyle}
                                >
                                  <CrudActionIcon action="restore" size={15} />
                                  Restore
                                </button>
                              )}
                            </div>
                          )}
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
          totalItems={rows.length}
          itemsPerPage={ITEMS_PER_PAGE}
          onPageChange={setCurrentPage}
          label={showArchiveView ? 'archived cash advance requests' : 'cash advance requests'}
        />
      </div>

      {showRequestModal && (
        <div style={modalBackdropStyle} onClick={closeRequestModal}>
          <div style={modalCardStyle} onClick={(event) => event.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div>
                <h2 style={{ margin: 0, fontSize: 14, color: '#0f172a', letterSpacing: '-0.03em' }}>Request Cash Advance</h2>
                <p style={{ margin: '6px 0 0 0', color: '#64748b', fontSize: 13 }}>
                  Fill in the request details.
                </p>
              </div>
              <button type="button" onClick={closeRequestModal} style={modalCloseButtonStyle} aria-label="Close cash advance request modal">
                x
              </button>
            </div>

            {submitFormError && (
              <div role="alert" aria-live="assertive" style={{ border: '1px solid #fca5a5', background: '#fef2f2', borderRadius: 10, padding: '10px 12px', margin: '0 0 12px 0' }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#b91c1c', marginBottom: 4 }}>
                  {submitFormErrorFields.includes('request_date') ? 'Duplicate request — Request Date' : 'Cannot submit request'}
                </div>
                <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.5 }}>{submitFormError}</div>
              </div>
            )}

            <div style={modalContentGridStyle}>
              <div style={modalPanelStyle}>
                <div style={formGridStyle}>
                  <div style={{ gridColumn: '1 / -1' }}>
                    {(isAdmin || isManager) && (
                      <label style={requestOwnToggleStyle}>
                        <input
                          type="checkbox"
                          checked={requestOwn}
                          onChange={(e) => setRequestOwn(e.target.checked)}
                          disabled={!canRequestOwn}
                        />
                        <span>Request own</span>
                      </label>
                    )}
                    <label style={labelStyle} htmlFor="cash-employee">Employee</label>
                    <select
                      id="cash-employee"
                      value={canChooseRequestEmployee ? ((isAdmin || isManager) && requestOwn ? String(selfEmployeeId || '') : selectedEmployeeId) : String(selfEmployeeId || '')}
                      onChange={(e) => { setSelectedEmployeeId(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                      disabled={!canChooseRequestEmployee || ((isAdmin || isManager) && requestOwn)}
                      required
                      aria-required="true"
                      aria-invalid={submitFormErrorFields.includes('employee_id')}
                      style={{ ...inputStyle, width: '100%', background: canChooseRequestEmployee && !((isAdmin || isManager) && requestOwn) ? '#fff' : '#f8fafc', borderColor: submitFormErrorFields.includes('employee_id') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('employee_id') ? 2 : undefined }}
                    >
                      {canChooseRequestEmployee ? (
                        <>
                          <option value="">{employeesLoading ? 'Loading employees...' : 'Select employee'}</option>
                          {requestEmployeeOptions.map((employee) => (
                            <option key={employee.employee_id} value={employee.employee_id}>
                              {formatEmployeeOptionLabel(employee, selfEmployeeId)}
                            </option>
                          ))}
                        </>
                      ) : (
                        <option value={String(selfEmployeeId || '')}>{selectedEmployeeLabel}</option>
                      )}
                    </select>
                    {submitFormError && submitFormErrorFields.includes('employee_id') && (
                      <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                    )}
                    <div style={helperTextStyle}>
                      {isAdmin
                        ? canRequestOwnAsAdmin
                          ? 'Choose a staff or manager employee, or use Request own for your linked employee.'
                          : 'Choose a staff or manager employee from this list.'
                        : isManager
                          ? canRequestOwnAsManager
                            ? 'Choose a staff employee from your branch, or use Request own for yourself.'
                            : 'Choose a staff employee from your branch.'
                          : 'This request is tied to your linked employee account.'}
                    </div>
                  </div>

                  <div>
                    <label style={labelStyle} htmlFor="cash-request-date">Request Date</label>
                    <input
                      id="cash-request-date"
                      type="date"
                      value={requestDate}
                      onChange={(e) => { setRequestDate(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                      required
                      aria-required="true"
                      aria-invalid={submitFormErrorFields.includes('request_date')}
                      style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('request_date') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('request_date') ? 2 : undefined }}
                    />
                    {submitFormError && submitFormErrorFields.includes('request_date') && (
                      <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>{requestDate ? 'This date already has a request for this employee.' : 'Required.'}</div>
                    )}
                  </div>

                  <div>
                    <label style={labelStyle} htmlFor="cash-amount">Amount</label>
                    <input
                      id="cash-amount"
                      type="number"
                      min={1}
                      step={0.01}
                      value={amount}
                      onChange={(e) => { setAmount(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                      required
                      aria-required="true"
                      aria-invalid={submitFormErrorFields.includes('amount')}
                      style={{ ...inputStyle, width: '100%', borderColor: submitFormErrorFields.includes('amount') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('amount') ? 2 : undefined }}
                    />
                    {submitFormError && submitFormErrorFields.includes('amount') && (
                      <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                    )}
                  </div>

                  <div style={{ gridColumn: '1 / -1' }}>
                    <label style={labelStyle} htmlFor="cash-reason">Reason</label>
                    <textarea
                      id="cash-reason"
                      value={reason}
                      onChange={(e) => { setReason(e.target.value); if (submitFormError) { setSubmitFormError(''); setSubmitFormErrorFields([]); } }}
                      placeholder="Explain why this cash advance is needed..."
                      required
                      aria-required="true"
                      aria-invalid={submitFormErrorFields.includes('reason')}
                      style={{ ...inputStyle, width: '100%', minHeight: 168, resize: 'vertical', borderColor: submitFormErrorFields.includes('reason') ? '#ef4444' : undefined, borderWidth: submitFormErrorFields.includes('reason') ? 2 : undefined }}
                    />
                    {submitFormError && submitFormErrorFields.includes('reason') && (
                      <div style={{ fontSize: 12, color: '#b91c1c', marginTop: 4 }}>Required.</div>
                    )}
                  </div>
                </div>
              </div>

              <div style={modalAsideStyle}>
                <div style={asideRowStyle}>
                  <span style={asideLabelStyle}>Request For</span>
                  <span style={asideValueStyle}>{selectedEmployeeLabel}</span>
                </div>
                <div style={asideRowStyle}>
                  <span style={asideLabelStyle}>Target Amount</span>
                  <span style={asideValueStyle}>{money(amount || 0)}</span>
                </div>
                <div style={asideRowStyle}>
                  <span style={asideLabelStyle}>Payroll Effect</span>
                  <span style={asideValueStyle}>Adds to Cash Advance deductions</span>
                </div>
                <div style={asideNoteStyle}>
                  Approved requests are queued into the next open payroll on or after the request date.
                </div>
              </div>
            </div>

            <div style={modalFooterStyle}>
              <button type="button" onClick={closeRequestModal} style={secondaryButtonStyle}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitRequest()}
                disabled={submitting || !effectiveEmployeeId || (isAdmin && employeesLoading)}
                style={{
                  ...primaryButtonStyle,
                  opacity: submitting || !effectiveEmployeeId || (isAdmin && employeesLoading) ? 0.65 : 1,
                  cursor: submitting || !effectiveEmployeeId || (isAdmin && employeesLoading) ? 'not-allowed' : 'pointer',
                }}
              >
                {submitting ? 'Submitting...' : 'Submit Request'}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedRow && (
        <div style={modalBackdropStyle} onClick={() => setSelectedRow(null)}>
          <div style={detailModalCardStyle} onClick={(event) => event.stopPropagation()}>
            <div style={modalHeaderStyle}>
              <div>
                <h2 style={{ margin: 0, fontSize: 14, color: '#0f172a', letterSpacing: '-0.03em' }}>
                  Cash Advance #{selectedRow.cash_advance_request_id}
                </h2>
                <p style={{ margin: '6px 0 0 0', color: '#64748b', fontSize: 13 }}>
                  Review the full cash advance record.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <span style={statusPill(selectedRow.status)}>{selectedRow.status}</span>
                  {Number(selectedRow.is_archived ?? 0) === 1 && <span style={detailChipStyle}>Archive Storage</span>}
                  <span style={detailChipStyle}>{selectedRow.employee_name || `Employee #${selectedRow.employee_id}`}</span>
                  <span style={detailChipStyle}>{money(selectedRow.amount)}</span>
                </div>
              </div>
              <button type="button" onClick={() => setSelectedRow(null)} style={modalCloseButtonStyle} aria-label="Close cash advance details">
                x
              </button>
            </div>

            <div style={detailGridStyle}>
              <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Request Date</div>
                <div style={detailValueStyle}>{selectedRow.request_date}</div>
              </div>
              <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Created</div>
                <div style={detailValueStyle}>{formatDateTime(selectedRow.created_at)}</div>
              </div>
              <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Payroll Deduction</div>
                <div style={detailValueStyle}>
                  {selectedRow.deducted_payroll_id ? `Payroll #${selectedRow.deducted_payroll_id}` : 'Waiting for payroll'}
                </div>
              </div>
              {Number(selectedRow.is_archived ?? 0) === 1 && (
                <div style={detailCardStyle}>
                  <div style={detailLabelStyle}>Archived At</div>
                  <div style={detailValueStyle}>{formatDateTime(selectedRow.archived_at)}</div>
                </div>
              )}
            </div>

            <div style={detailTextCardStyle}>
              <div style={detailLabelStyle}>Reason</div>
              <div style={detailTextStyle}>{selectedRow.reason || 'No reason provided.'}</div>
            </div>

            <div style={detailTextCardStyle}>
              <div style={detailLabelStyle}>Manager Note</div>
              <div style={detailTextStyle}>{selectedRow.manager_notes || 'No manager note yet.'}</div>
            </div>
          </div>
        </div>
      )}
    </Layout>
  );
}

function SummaryCard({
  label,
  value,
  color,
  background,
}: {
  label: string;
  value: string;
  color: string;
  background: string;
}) {
  return (
    <div style={{ background, borderRadius: 24, padding: 16, border: '1px solid rgba(148, 163, 184, 0.18)', boxShadow: '0 10px 30px rgba(15, 23, 42, 0.05)' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ marginTop: 10, fontSize: 14, fontWeight: 800, color: '#0f172a' }}>{value}</div>
    </div>
  );
}

const heroRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  marginBottom: 10,
};

const requestButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  border: '1px solid #1e3a8a',
  background: '#1e3a8a',
  color: '#fff',
  borderRadius: 999,
  padding: '7px 14px',
  fontWeight: 700,
  fontSize: 12,
  boxShadow: '0 8px 18px rgba(30, 58, 138, 0.2)',
};

const warningCardStyle: CSSProperties = {
  background: 'linear-gradient(135deg, #fff7ed 0%, #fffbeb 100%)',
  border: '1px solid #fdba74',
  borderRadius: 14,
  padding: 10,
  marginBottom: 10,
  color: '#9a3412',
  fontSize: 12,
};

const toolbarStyle: CSSProperties = {
  display: 'flex',
  gap: 8,
  flexWrap: 'wrap',
  marginBottom: 8,
};

const tableShellStyle: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e8f0',
  borderRadius: 14,
  overflow: 'visible',
  boxShadow: '0 4px 12px rgba(15, 23, 42, 0.04)',
};

const labelStyle: CSSProperties = {
  display: 'block',
  marginBottom: 8,
  fontSize: 12,
  color: '#475569',
  fontWeight: 800,
  letterSpacing: '0.03em',
  textTransform: 'uppercase',
};

const helperTextStyle: CSSProperties = {
  marginTop: 8,
  fontSize: 12,
  color: '#64748b',
  lineHeight: 1.5,
};

const requestOwnToggleStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  marginBottom: 12,
  color: '#334155',
  fontSize: 13,
  fontWeight: 700,
};

const inputStyle: CSSProperties = {
  padding: '7px 10px',
  borderRadius: 10,
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#1f2937',
  outline: 'none',
  fontSize: 12,
};

const refreshButtonStyle: CSSProperties = {
  border: '1px solid #1e3a8a',
  background: '#1e3a8a',
  color: '#fff',
  borderRadius: 10,
  padding: '7px 12px',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: 12,
};

const archiveStorageButton = (active: boolean): CSSProperties => ({
  border: '1px solid #64748b',
  background: active ? '#64748b' : 'transparent',
  color: active ? '#fff' : '#334155',
  borderRadius: 10,
  padding: '7px 12px',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: 12,
});

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  color: '#475569',
  fontSize: 12,
  fontWeight: 800,
};

const tdStyle: CSSProperties = {
  padding: '8px 10px',
  color: '#334155',
  fontSize: 12,
  verticalAlign: 'top',
};

const modalBackdropStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15, 23, 42, 0.56)',
  backdropFilter: 'blur(8px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 16,
  zIndex: 1200,
};

const modalCardStyle: CSSProperties = {
  width: 'min(1040px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  background: '#fff',
  borderRadius: 30,
  border: '1px solid rgba(226, 232, 240, 0.9)',
  boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const detailModalCardStyle: CSSProperties = {
  width: 'min(1040px, calc(100vw - 32px))',
  maxHeight: 'calc(100vh - 32px)',
  background: '#fff',
  borderRadius: 30,
  border: '1px solid rgba(226, 232, 240, 0.9)',
  boxShadow: '0 28px 80px rgba(15, 23, 42, 0.28)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
};

const modalHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 16,
  padding: '22px 24px 18px',
  borderBottom: '1px solid #e2e8f0',
};

const modalCloseButtonStyle: CSSProperties = {
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  borderRadius: 999,
  width: 38,
  height: 38,
  cursor: 'pointer',
  fontSize: 14,
  lineHeight: 1,
};

const modalContentGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
  gap: 18,
  padding: 24,
  overflowY: 'auto',
  background: 'linear-gradient(180deg, #f8fafc 0%, #ffffff 100%)',
};

const modalPanelStyle: CSSProperties = {
  background: '#fff',
  borderRadius: 24,
  border: '1px solid #e2e8f0',
  padding: 18,
  boxShadow: '0 14px 28px rgba(15, 23, 42, 0.05)',
};

const formGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  gap: 14,
};

const modalAsideStyle: CSSProperties = {
  background: 'linear-gradient(180deg, #eff6ff 0%, #ffffff 100%)',
  borderRadius: 24,
  border: '1px solid #bfdbfe',
  padding: 18,
  boxShadow: '0 14px 28px rgba(30, 58, 138, 0.07)',
  display: 'grid',
  gap: 14,
  alignContent: 'start',
};

const asideRowStyle: CSSProperties = {
  display: 'grid',
  gap: 6,
};

const asideLabelStyle: CSSProperties = {
  fontSize: 11,
  color: '#475569',
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
};

const asideValueStyle: CSSProperties = {
  fontSize: 14,
  color: '#0f172a',
  fontWeight: 700,
};

const asideNoteStyle: CSSProperties = {
  background: 'rgba(255, 255, 255, 0.72)',
  borderRadius: 20,
  padding: 14,
  color: '#334155',
  fontSize: 13,
  lineHeight: 1.6,
};

const modalFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 10,
  padding: '16px 24px 22px',
  borderTop: '1px solid #e2e8f0',
  background: '#fff',
};

const primaryButtonStyle: CSSProperties = {
  border: '1px solid #1e3a8a',
  background: '#1e3a8a',
  color: '#fff',
  borderRadius: 18,
  padding: '12px 18px',
  fontWeight: 700,
};

const secondaryButtonStyle: CSSProperties = {
  border: '1px solid #cbd5e1',
  background: '#fff',
  color: '#334155',
  borderRadius: 18,
  padding: '12px 18px',
  cursor: 'pointer',
  fontWeight: 700,
};

function statusPill(status: string): CSSProperties {
  if (status === 'approved') return { background: '#dcfce7', color: '#166534', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
  if (status === 'rejected') return { background: '#fee2e2', color: '#b91c1c', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
  if (status === 'cancelled') return { background: '#e2e8f0', color: '#334155', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
  return { background: '#fef3c7', color: '#92400e', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
}

function deductionPill(deducted: boolean): CSSProperties {
  if (deducted) return { background: '#dcfce7', color: '#166534', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
  return { background: '#ede9fe', color: '#6d28d9', borderRadius: 999, padding: '5px 11px', fontSize: 12, fontWeight: 700 };
}

const actionDropdownWrapStyle: CSSProperties = {
  position: 'relative',
  display: 'flex',
  justifyContent: 'flex-end',
};

const actionMenuButtonStyle: CSSProperties = {
  width: 34,
  height: 34,
  border: '1px solid #cbd5e1',
  borderRadius: 999,
  background: '#fff',
  color: '#334155',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
};

const actionMenuStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  zIndex: 20,
  minWidth: 150,
  padding: '6px 0',
  border: '1px solid #e2e8f0',
  borderRadius: 10,
  background: '#fff',
  boxShadow: '0 18px 36px rgba(15, 23, 42, 0.16)',
};

const menuItemStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '8px 14px',
  border: 'none',
  background: 'none',
  color: '#334155',
  fontSize: 13,
  cursor: 'pointer',
  textAlign: 'left',
};

const detailChipStyle: CSSProperties = {
  background: '#f1f5f9',
  color: '#475569',
  borderRadius: 999,
  padding: '5px 11px',
  fontSize: 12,
  fontWeight: 600,
};

const detailGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
  padding: '20px 24px',
};

const detailCardStyle: CSSProperties = {
  background: '#f8fafc',
  borderRadius: 16,
  padding: '14px 16px',
  border: '1px solid #e2e8f0',
};

const detailLabelStyle: CSSProperties = {
  fontSize: 11,
  color: '#64748b',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
  marginBottom: 6,
};

const detailValueStyle: CSSProperties = {
  fontSize: 14,
  color: '#0f172a',
  fontWeight: 600,
};

const detailTextCardStyle: CSSProperties = {
  background: '#f8fafc',
  borderRadius: 16,
  padding: '14px 16px',
  border: '1px solid #e2e8f0',
  gridColumn: '1 / -1',
};

const detailTextStyle: CSSProperties = {
  fontSize: 13,
  color: '#334155',
  lineHeight: 1.6,
};
