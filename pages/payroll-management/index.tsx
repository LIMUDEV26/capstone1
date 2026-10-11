import { type Dispatch, type SetStateAction, useState, useEffect, useMemo, useRef, useEffectEvent } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import s from '../../styles/Payroll.module.css';
import { getApiBaseUrl } from '@/utils/network';
import {
    confirmAction,
    finishLoadingToast,
    notifyError,
    notifySuccess,
    showLoadingToast,
} from '@/utils/notify';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import UploadProgressBar from '@/components/UploadProgressBar';
import {
    abortSession as abortChunkedSession,
    formatBytes,
    runResumableUpload,
    type UploadProgress,
    type UploadSession,
} from '@/utils/chunkedUpload';
import {
    Chart as ChartJS,
    CategoryScale, LinearScale, BarElement, ArcElement,
    Tooltip, Legend, Title
} from 'chart.js';
import { Bar, Doughnut, Pie } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, ArcElement, Tooltip, Legend, Title);

const API = getApiBaseUrl();
const OPTS: RequestInit = { credentials: 'include' };
const AZ_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
const PESO_SYMBOL = '\u20B1';

const fmt = (v: number | string | null) => {
    const n = Number(v) || 0;
    return `${PESO_SYMBOL}${n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const toNumber = (v: number | string | null | undefined) => Number(v) || 0;
const hasPositiveValues = (values: Array<number | string | null | undefined>) => values.some(value => Number(value) > 0);
const formatChartCurrencyTick = (value: number | string) => `${PESO_SYMBOL}${Number(value).toLocaleString('en-PH')}`;

// Attendance imports retain the biometric-machine name in the payroll note.
// The payroll list follows the source file: when an imported name is present,
// show that value (for example, "MGE") rather than guessing a full name.
const importedBiometricName = (record: { notes?: string | null }) => {
    const match = String(record.notes || '').match(/(?:^|;\s*)external name\s+([^;]+)/i);
    return match?.[1]?.trim() || '';
};

const displayPayrollNotes = (notes?: string | null) => {
    const value = String(notes || '').trim();
    if (!value.toLowerCase().startsWith('auto-generated from attendance import')) return value;

    const sourceName = value.match(/external name\s+([^;\)]+)/i)?.[1]?.trim();
    const biometricId = value.match(/external code\s+([^;\)]+)/i)?.[1]?.trim();
    const parts = ['Generated from uploaded attendance file.'];
    if (sourceName) parts.push(`Name in file: ${sourceName}.`);
    if (biometricId) parts.push(`Biometric ID: ${biometricId}.`);
    parts.push('Matched using the biometric ID.');
    return parts.join(' ');
};

type PayrollRecord = {
    id: number;
    employee_id: number;
    employee_name: string;
    full_employee_name?: string;
    branch_name?: string;
    pay_period_start: string;
    pay_period_end: string;
    basic_salary: number;
    overtime_hours: number;
    overtime_rate: number;
    overtime_pay: number;
    bonus: number;
    clothing_allowance: number;
    travel_allowance: number;
    salary_adjustment: number;
    late_deduction: number;
    absence_deduction: number;
    unpaid_leave_days?: number | null;
    unpaid_leave_amount?: number | null;
    tax: number;
    sss_contribution: number;
    pagibig_contribution: number;
    philhealth_contribution: number;
    cash_advance_manual_deduction?: number;
    cash_advance_deduction: number;
    cash_advance_request_count?: number;
    cash_advance_request_total?: number;
    laptop_loan_deduction: number;
    other_deductions: number;
    gross_pay: number;
    total_deductions: number;
    net_pay: number;
    status: 'draft' | 'pending' | 'approved' | 'paid' | 'archived';
    notes: string;
    created_at: string;
};

type Employee = {
    employee_id: number;
    first_name: string;
    last_name: string;
    salary: number;
    status: string;
};

type BranchOption = {
    branch_id: number;
    branch_name: string;
    status?: string;
};

type LeaveBalanceFigure = {
    leave_type: string;
    type_name: string;
    total_days: number;
    used_days: number;
    remaining_days: number;
    default_days: number | null;
    is_paid: number;
};

type LeaveImpact = {
    loading: boolean;
    days: number;
    amount: number;
    daily_rate: number;
    balances: LeaveBalanceFigure[];
    applied: boolean;
};

type AnalyticsMonthlyPoint = {
    month?: string | null;
    month_label?: string | null;
    total?: number | string | null;
};

type AnalyticsBranchPoint = {
    branch_name?: string | null;
    total?: number | string | null;
};

type AnalyticsContractPoint = {
    employment_type?: string | null;
    total?: number | string | null;
};

const calcAttendanceDeduction = (r: Pick<PayrollRecord, 'late_deduction' | 'absence_deduction'>) => (
    toNumber(r.late_deduction) + toNumber(r.absence_deduction)
);

const calcGovDeductions = (r: Pick<PayrollRecord, 'tax' | 'sss_contribution' | 'pagibig_contribution' | 'philhealth_contribution'>) => (
    toNumber(r.tax) + toNumber(r.sss_contribution) + toNumber(r.pagibig_contribution) + toNumber(r.philhealth_contribution)
);

const calcLoanDeductions = (r: Pick<PayrollRecord, 'cash_advance_deduction' | 'laptop_loan_deduction' | 'other_deductions'>) => (
    toNumber(r.cash_advance_deduction) + toNumber(r.laptop_loan_deduction) + toNumber(r.other_deductions)
);

const calcAllDeductions = (r: PayrollRecord) => (
    calcAttendanceDeduction(r) + calcGovDeductions(r) + calcLoanDeductions(r)
);

const calcGrossBeforeAttendance = (r: PayrollRecord) => (
    toNumber(r.basic_salary)
    + toNumber(r.overtime_pay)
    + toNumber(r.clothing_allowance)
    + toNumber(r.travel_allowance)
    + toNumber(r.salary_adjustment)
);

const badgeClass: Record<string, string> = {
    draft: s.badgeDraft,
    pending: s.badgePending,
    approved: s.badgeApproved,
    paid: s.badgePaid,
    archived: s.badgeArchived,
};

const defaultForm = {
    employee_id: '',
    pay_period_start: '',
    pay_period_end: '',
    overtime_hours: '0',
    overtime_rate: '0',
    bonus: '0',
    clothing_allowance: '0',
    travel_allowance: '0',
    salary_adjustment: '0',
    late_deduction: '0',
    absence_deduction: '0',
    tax: '0',
    sss_contribution: '0',
    pagibig_contribution: '0',
    philhealth_contribution: '0',
    cash_advance_deduction: '0',
    laptop_loan_deduction: '0',
    other_deductions: '0',
    status: 'draft',
    notes: '',
};

const todayDateValue = () => {
    const now = new Date();
    const localDate = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 10);
};

/** Helper: return 1st-half and 2nd-half date ranges for a given month */
const getPayPeriodDates = (half: 1 | 2) => {
    const now = new Date();
    const today = now.getDate();
    const targetMonth = half === 2 && today < 16
        ? new Date(now.getFullYear(), now.getMonth() - 1, 1)
        : new Date(now.getFullYear(), now.getMonth(), 1);
    const y = targetMonth.getFullYear();
    const m = String(targetMonth.getMonth() + 1).padStart(2, '0');
    const isCurrentMonth = targetMonth.getFullYear() === now.getFullYear() && targetMonth.getMonth() === now.getMonth();

    if (half === 1) {
        const endDay = isCurrentMonth ? Math.min(15, today) : 15;
        return { start: `${y}-${m}-01`, end: `${y}-${m}-${String(endDay).padStart(2, '0')}` };
    }

    const lastDay = new Date(y, targetMonth.getMonth() + 1, 0).getDate();
    const endDay = isCurrentMonth ? today : lastDay;
    return { start: `${y}-${m}-16`, end: `${y}-${m}-${String(endDay).padStart(2, '0')}` };
};

/**
 * Formats the attendance importer accepts. `binary: true` marks a spreadsheet
 * whose dates are stored as serials, so the text pay-period scan is skipped.
 */
/** One row of import evidence returned in `importResult.details`. */
type ImportDetailItem = {
    row?: number;
    code?: string;
    name?: string;
    status?: string;
    detail?: string;
    employee_id?: number;
    payroll_id?: number;
};

type ImportFileFormat = 'dat' | 'csv' | 'xls' | 'xlsx';

const IMPORT_FILE_FORMATS: Array<{ value: ImportFileFormat; label: string; binary: boolean }> = [
    { value: 'dat', label: '.dat (ZKTeco punch export, text)', binary: false },
    { value: 'csv', label: '.csv (attendance totals sheet)', binary: false },
    { value: 'xls', label: '.xls (ZKTeco Standard Report)', binary: true },
    { value: 'xlsx', label: '.xlsx (Excel totals sheet)', binary: true },
];

const IMPORT_FILE_EXT_LIST = IMPORT_FILE_FORMATS.map((format) => `.${format.value}`).join(',');
const IMPORT_FILE_EXT_TEXT = IMPORT_FILE_FORMATS.map((format) => `.${format.value}`).join(', ');
const IMPORT_FILE_IS_BINARY = (format: ImportFileFormat) =>
    IMPORT_FILE_FORMATS.some((entry) => entry.value === format && entry.binary);

/** Bytes scanned when a chosen file is too large to read whole. */
const IMPORT_DATE_SCAN_LIMIT = 8 * 1024 * 1024;
const IMPORT_DATE_SAMPLE_BYTES = 2 * 1024 * 1024;

const padDatePart = (value: number) => String(value).padStart(2, '0');

/** Build an ISO yyyy-mm-dd value, rejecting impossible calendar dates. */
const toIsoDate = (year: number, month: number, day: number) => {
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return '';
    return `${year}-${padDatePart(month)}-${padDatePart(day)}`;
};

/**
 * Pull every date-like token out of raw attendance text and return the span it
 * covers. A ZKTeco .dat punch log stamps every row `YYYY-MM-DD HH:MM:SS`, so the
 * earliest and latest stamp is the pay period that file represents.
 */
const extractAttendanceDateRange = (text: string): { start: string; end: string } | null => {
    const found: string[] = [];
    let match: RegExpExecArray | null;

    // Year-first layouts are unambiguous: 2026-01-05, 2026/01/05.
    const yearFirst = /\b(\d{4})[-/](\d{1,2})[-/](\d{1,2})\b/g;
    while ((match = yearFirst.exec(text)) !== null) {
        const iso = toIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
        if (iso) found.push(iso);
    }

    if (found.length === 0) {
        // Day/month-first spreadsheets (01/05/2026). The order is ambiguous, so
        // only trust it when at least one row proves the day-first layout.
        const shortFirst = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g;
        const candidates: Array<[number, number, number]> = [];
        while ((match = shortFirst.exec(text)) !== null) {
            candidates.push([Number(match[1]), Number(match[2]), Number(match[3])]);
        }
        const dayFirst = candidates.some(([first]) => first > 12);
        candidates.forEach(([first, second, year]) => {
            const iso = toIsoDate(year, dayFirst ? second : first, dayFirst ? first : second);
            if (iso) found.push(iso);
        });
    }

    if (found.length === 0) return null;
    found.sort();
    return { start: found[0], end: found[found.length - 1] };
};

/** Read the chosen file (head + tail when large) and find the dates it covers. */
const scanFileForDateRange = async (file: File): Promise<{ start: string; end: string } | null> => {
    if (file.size <= IMPORT_DATE_SCAN_LIMIT) {
        return extractAttendanceDateRange(await file.text());
    }
    const head = await file.slice(0, IMPORT_DATE_SAMPLE_BYTES).text();
    const tail = await file.slice(Math.max(0, file.size - IMPORT_DATE_SAMPLE_BYTES)).text();
    return extractAttendanceDateRange(`${head}\n${tail}`);
};

const validatePayPeriodRange = (start: string, end: string) => {
    if (!start || !end) return 'Please set the pay period dates';
    if (start > end) return 'Pay period start date cannot be after the end date';

    const today = todayDateValue();
    if (start > today || end > today) {
        return `Pay period cannot go beyond the current date (${today})`;
    }

    return '';
};

export default function PayrollManagement() {
    const router = useRouter();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [user, setUser] = useState<any>(null);
    const isMountedRef = useRef(true);
    const recordsRequestRef = useRef(0);
    const analyticsRequestRef = useRef(0);

    // Data
    const [records, setRecords] = useState<PayrollRecord[]>([]);
    const [employees, setEmployees] = useState<Employee[]>([]);
    const [branches, setBranches] = useState<BranchOption[]>([]);
    const [analytics, setAnalytics] = useState<any>(null);

    // UI state
    const [activeTab, setActiveTab] = useState<'records' | 'analytics'>('records');
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [periodStart, setPeriodStart] = useState('');
    const [periodEnd, setPeriodEnd] = useState('');
    const [analyticsBranchId, setAnalyticsBranchId] = useState('all');
    const [azFilterMode, setAzFilterMode] = useState<'all' | 'range'>('all');
    const [azStart, setAzStart] = useState('A');
    const [azEnd, setAzEnd] = useState('Z');
    const [azCardOpen, setAzCardOpen] = useState(false);
    const azFilterRef = useRef<HTMLDivElement | null>(null);
    const [currentPage, setCurrentPage] = useState(1);
    const [selectedIds, setSelectedIds] = useState<number[]>([]);
    const [recordsLoading, setRecordsLoading] = useState(false);
    const [analyticsLoading, setAnalyticsLoading] = useState(false);
    const [formSaving, setFormSaving] = useState(false);
    const [updatingIds, setUpdatingIds] = useState<number[]>([]);
    const [recalculatingIds, setRecalculatingIds] = useState<number[]>([]);
    const selectAllRef = useRef<HTMLInputElement | null>(null);

    // Modals
    const [showModal, setShowModal] = useState(false);
    const [editing, setEditing] = useState<PayrollRecord | null>(null);
    const [viewRecord, setViewRecord] = useState<PayrollRecord | null>(null);
    const [openActionsId, setOpenActionsId] = useState<number | null>(null);
    const [actionMenuPosition, setActionMenuPosition] = useState<{ top: number; left: number } | null>(null);
    const viewTotals = useMemo(() => {
        if (!viewRecord) return null;
        const attendance = calcAttendanceDeduction(viewRecord);
        const gov = calcGovDeductions(viewRecord);
        const loans = calcLoanDeductions(viewRecord);
        const totalAll = attendance + gov + loans;
        const grossBefore = calcGrossBeforeAttendance(viewRecord);
        return { attendance, gov, loans, totalAll, grossBefore };
    }, [viewRecord]);
    const viewCashAdvanceBreakdown = useMemo(() => {
        if (!viewRecord) {
            return { requestCount: 0, requestTotal: 0, manualTotal: 0 };
        }

        return {
            requestCount: Math.max(0, Math.floor(toNumber(viewRecord.cash_advance_request_count))),
            requestTotal: toNumber(viewRecord.cash_advance_request_total),
            manualTotal: toNumber(viewRecord.cash_advance_manual_deduction),
        };
    }, [viewRecord]);
    const [formData, setFormData] = useState({ ...defaultForm });
    const [formSalary, setFormSalary] = useState(0);
    const [formError, setFormError] = useState('');
    // Leave impact preview for the selected employee + pay period.
    const [leaveImpact, setLeaveImpact] = useState<LeaveImpact | null>(null);
    // Inline per-field "Required" messages for the Add/Edit Payroll form.
    const [formFieldErrors, setFormFieldErrors] = useState<Record<string, string>>({});

    const clearFormFieldError = (name: string) => {
        setFormFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    // Import modal state
    const [showImportModal, setShowImportModal] = useState(false);
    const [importFile, setImportFile] = useState<File | null>(null);
    const [importPeriodStart, setImportPeriodStart] = useState('');
    const [importPeriodEnd, setImportPeriodEnd] = useState('');
    // Attendance-import file format: '.dat' is the ZKTeco USB export, '.csv' is an
    // aggregate-totals sheet. Auto-set from the chosen file and mapped onto the
    // `source_system` value the API uses for Base44 identity lookups.
    const [importFileFormat, setImportFileFormat] = useState<ImportFileFormat>('csv');
    const [importLoading, setImportLoading] = useState(false);
    const [importResult, setImportResult] = useState<any>(null);
    const [importError, setImportError] = useState('');
    // Pay-period detection feedback shown under the date fields.
    const [importDateHint, setImportDateHint] = useState('');
    // Which result card's floating detail panel is open (null = closed).
    const [importDetailKey, setImportDetailKey] = useState<string | null>(null);
    // Guards a date scan that is still reading when a newer file is picked.
    const importScanRef = useRef(0);
    // Chunked-upload progress + resume state. A failed upload keeps its
    // server-confirmed offset so Retry CONTINUES instead of re-uploading.
    const [importProgress, setImportProgress] = useState<UploadProgress | null>(null);
    const [importPhase, setImportPhase] = useState<'uploading' | 'processing' | null>(null);
    const importSessionRef = useRef<UploadSession>({ uploadId: null, received: 0 });
    const resetImportSession = (abort = false) => {
        const session = importSessionRef.current;
        importSessionRef.current = { uploadId: null, received: 0 };
        setImportProgress(null);
        setImportPhase(null);
        if (abort && session.uploadId) {
            void abortChunkedSession(`${API}/attendance_import.php`, 'import_abort', session.uploadId);
        }
    };
    // Inline per-field "Required" messages for the import dates.
    const [importFieldErrors, setImportFieldErrors] = useState<Record<string, string>>({});
    const [dragOver, setDragOver] = useState(false);
    const today = todayDateValue();
    const isArchiveStorageView = statusFilter === 'archived';

    // ── Session ──
    useEffect(() => {
        // React Strict Mode runs an extra setup/cleanup cycle in development.
        // Reset this on every setup so the resolved session can populate the
        // role used by Layout to build the sidebar navigation.
        isMountedRef.current = true;
        void checkSession();
        return () => {
            isMountedRef.current = false;
        };
    }, []);
    useEffect(() => {
        const handleClick = (event: MouseEvent) => {
            if (!azCardOpen) return;
            const target = event.target as Node | null;
            if (azFilterRef.current && target && azFilterRef.current.contains(target)) return;
            setAzCardOpen(false);
        };
        const handleKey = (event: KeyboardEvent) => {
            if (!azCardOpen) return;
            if (event.key === 'Escape') setAzCardOpen(false);
        };
        document.addEventListener('mousedown', handleClick);
        document.addEventListener('keydown', handleKey);
        return () => {
            document.removeEventListener('mousedown', handleClick);
            document.removeEventListener('keydown', handleKey);
        };
    }, [azCardOpen]);
    useEffect(() => {
        if (!formError) return;
        void notifyError(formError);
        setFormError('');
    }, [formError]);
    useEffect(() => {
        if (!importError) return;
        void notifyError(importError);
        setImportError('');
    }, [importError]);

    const checkSession = async () => {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => {
            controller.abort();
        }, 12000);

        try {
            const [authRes] = await Promise.all([
                fetch(`${API}/auth.php`, { ...OPTS, signal: controller.signal }),
                fetchAll(),
            ]);
            if (!authRes.ok) throw new Error(`Auth session request failed: ${authRes.status}`);
            const d = await authRes.json();
            if (d.success) {
                if (isMountedRef.current) setUser(d.data);
            } else {
                await router.replace('/');
            }
        } catch (error: unknown) {
            if ((error as { name?: string })?.name === 'AbortError') {
                void notifyError('Session check timed out. Please refresh and try again.');
            }
            await router.replace('/');
        }
        finally {
            window.clearTimeout(timeoutId);
        }
    };

    // ── Data fetching ──
    const fetchAll = () => { fetchRecords(); fetchEmployees(); fetchBranches(); fetchAnalytics(); };

    const fetchRecords = async () => {
        const requestId = recordsRequestRef.current + 1;
        recordsRequestRef.current = requestId;
        setRecordsLoading(true);
        try {
            // Always include archived rows: the active list and the archive
            // storage view both render from this state, so archive/restore
            // actions stay live in both directions without a reload.
            let url = `${API}/payroll.php?include_archived=1&`;
            if (periodStart) url += `period_start=${periodStart}&`;
            if (periodEnd) url += `period_end=${periodEnd}&`;
            if (statusFilter && statusFilter !== 'all') url += `status=${statusFilter}&`;
            const res = await fetch(url, OPTS);
            const d = await res.json();
            if (requestId !== recordsRequestRef.current) return;
            if (d.success) setRecords(d.data);
        } catch { console.error('Failed to fetch payroll records'); }
        finally {
            if (requestId === recordsRequestRef.current && isMountedRef.current) {
                setRecordsLoading(false);
            }
        }
    };

    const fetchEmployees = async () => {
        try {
            const res = await fetch(`${API}/employees.php`, OPTS);
            const d = await res.json();
            if (d.success) setEmployees(d.data.filter((e: Employee) => e.status === 'active'));
        } catch { console.error('Failed to fetch employees'); }
    };

    const fetchBranches = async () => {
        try {
            const res = await fetch(`${API}/branches.php?status=active`, OPTS);
            const d = await res.json();
            if (d.success) {
                setBranches(Array.isArray(d.data) ? d.data : []);
            }
        } catch { console.error('Failed to fetch branches'); }
    };

    const fetchAnalytics = async () => {
        const requestId = analyticsRequestRef.current + 1;
        analyticsRequestRef.current = requestId;
        setAnalyticsLoading(true);
        try {
            const params = new URLSearchParams();
            if (periodStart) params.set('start', periodStart);
            if (periodEnd) params.set('end', periodEnd);
            if (analyticsBranchId !== 'all') params.set('branch_id', analyticsBranchId);
            const query = params.toString();
            const res = await fetch(`${API}/payroll_analytics.php${query ? `?${query}` : ''}`, OPTS);
            const d = await res.json();
            if (requestId !== analyticsRequestRef.current) return;
            if (d.success) setAnalytics(d.data);
        } catch { console.error('Failed to fetch analytics'); }
        finally {
            if (requestId === analyticsRequestRef.current && isMountedRef.current) {
                setAnalyticsLoading(false);
            }
        }
    };
    const refreshRecords = useEffectEvent(() => {
        fetchRecords();
    });
    const refreshAnalytics = useEffectEvent(() => {
        fetchAnalytics();
    });

    // ── Filtering ──
    const filtered = useMemo(() => {
        const hasAzRange = azFilterMode === 'range';
        const startIndex = hasAzRange ? AZ_LETTERS.indexOf(azStart) : -1;
        const endIndex = hasAzRange ? AZ_LETTERS.indexOf(azEnd) : -1;
        const rangeFrom = hasAzRange ? Math.min(startIndex, endIndex) : -1;
        const rangeTo = hasAzRange ? Math.max(startIndex, endIndex) : -1;

        return records.filter(r => {
            const name = (r.full_employee_name || r.employee_name || '').toLowerCase();
            if (!isArchiveStorageView && r.status === 'archived') return false;
            if (searchTerm && !name.includes(searchTerm.toLowerCase())) return false;
            if (statusFilter !== 'all' && r.status !== statusFilter) return false;
            if (hasAzRange) {
                const lastName = (r.full_employee_name || r.employee_name || '').trim().split(/\s+/).pop() || '';
                const letter = lastName ? lastName[0].toUpperCase() : '';
                const letterIndex = AZ_LETTERS.indexOf(letter);
                if (letterIndex === -1 || letterIndex < rangeFrom || letterIndex > rangeTo) return false;
            }
            return true;
        });
    }, [records, searchTerm, statusFilter, azFilterMode, azStart, azEnd]);
    const selectableIds = useMemo(
        () => filtered
            .filter(record => isArchiveStorageView || record.status !== 'archived')
            .map(record => Number(record.id))
            .filter(id => Number.isFinite(id) && id > 0),
        [filtered, isArchiveStorageView]
    );
    const selectedIdSet = useMemo(
        () => new Set(
            selectedIds
                .map(id => Number(id))
                .filter(id => Number.isFinite(id) && id > 0)
        ),
        [selectedIds]
    );
    const selectedRecords = useMemo(
        () => filtered.filter(record => selectedIdSet.has(Number(record.id))),
        [filtered, selectedIdSet]
    );
    const hasPayableSelection = selectedRecords.some(record => record.status !== 'paid' && record.status !== 'archived');
    const hasReleasableSelection = selectedRecords.some(
        record => record.status !== 'approved' && record.status !== 'paid' && record.status !== 'archived'
    );
    const hasArchivableSelection = selectedRecords.some(record => record.status === 'paid');
    const selectedArchivableIds = selectedRecords.filter(record => record.status === 'paid').map(record => record.id);
    const paginatedRecords = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
    // "Select All" covers the whole filtered list — every page, not just the rows
    // rendered on screen — so a bulk action reaches records further down the list.
    const allSelectableSelected = selectableIds.length > 0 && selectableIds.every(id => selectedIdSet.has(id));
    const allSelectedApproved = selectedRecords.length > 0 && selectedRecords.every(record => record.status === 'approved');
    const selectedUnreleaseIds = useMemo(
        () => selectedRecords.filter(record => record.status === 'approved').map(record => record.id),
        [selectedRecords]
    );

    const lastNameOf = (record: PayrollRecord) => {
        const fullName = String(record.full_employee_name || record.employee_name || '').trim();
        if (!fullName) return '';
        const parts = fullName.split(/\s+/);
        return parts[parts.length - 1]?.toLowerCase() || '';
    };

    const sortByLastName = (records: PayrollRecord[]) =>
        [...records].sort((a, b) => {
            const lastA = lastNameOf(a);
            const lastB = lastNameOf(b);
            if (lastA !== lastB) return lastA.localeCompare(lastB);
            const fullA = String(a.full_employee_name || a.employee_name || '').toLowerCase();
            const fullB = String(b.full_employee_name || b.employee_name || '').toLowerCase();
            if (fullA !== fullB) return fullA.localeCompare(fullB);
            return a.id - b.id;
        });
    const archivedIdsSorted = sortByLastName(
        filtered.filter(record => record.status === 'archived')
    ).map(record => record.id);

    const selectedReleaseIdsSorted = useMemo(
        () => sortByLastName(selectedRecords.filter(record => record.status !== 'approved' && record.status !== 'paid' && record.status !== 'archived'))
            .map(record => record.id),
        [selectedRecords]
    );
    const selectedArchivedIdsSorted = useMemo(
        () => sortByLastName(selectedRecords.filter(record => record.status === 'archived'))
            .map(record => record.id),
        [selectedRecords]
    );

    useEffect(() => {
        setCurrentPage(1);
    }, [activeTab, searchTerm, statusFilter, periodStart, periodEnd, azFilterMode, azStart, azEnd]);

    useEffect(() => {
        setSelectedIds(prev => prev.filter(id => selectableIds.includes(id)));
    }, [selectableIds]);

    // selectAllRef indeterminate effect removed — checkbox replaced with button UI

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [filtered.length, currentPage]);

    // ── Form helpers ──
    const onInput = (e: any) => {
        const { name, value } = e.target;
        setFormData(prev => ({ ...prev, [name]: value }));
        clearFormFieldError(name);

        if (name === 'employee_id') {
            const emp = employees.find(emp => emp.employee_id === Number(value));
            // employees.salary is monthly; periods are semi-monthly.
            setFormSalary(emp ? Number(emp.salary) / 2 : 0);
        }
    };

    const calc = useMemo(() => {
        const ot_hours = Number(formData.overtime_hours) || 0;
        const ot_rate = Number(formData.overtime_rate) || 0;
        const ot_pay = ot_hours * ot_rate;

        const clothing = Number(formData.clothing_allowance) || 0;
        const travel = Number(formData.travel_allowance) || 0;
        const adj = Number(formData.salary_adjustment) || 0;

        const late = Number(formData.late_deduction) || 0;
        const absence = Number(formData.absence_deduction) || 0;

        // Gross: basic + OT + allowances + adjustments − attendance deductions (bonus excluded)
        const gross = formSalary + ot_pay + clothing + travel + adj - late - absence;

        const tax = Number(formData.tax) || 0;
        const sss = Number(formData.sss_contribution) || 0;
        const pagibig = Number(formData.pagibig_contribution) || 0;
        const phil = Number(formData.philhealth_contribution) || 0;
        const ca = Number(formData.cash_advance_deduction) || 0;
        const laptop = Number(formData.laptop_loan_deduction) || 0;
        const other = Number(formData.other_deductions) || 0;
        const total_ded = tax + sss + pagibig + phil + ca + laptop + other;

        const bonus = Number(formData.bonus) || 0;
        const net = Math.max(0, gross - total_ded + bonus);

        return { ot_pay, gross, total_ded, bonus, net };
    }, [formData, formSalary]);

    // Leave impact preview: unpaid-leave days/amount + balances for the
    // selected employee + pay period (single source: leave_type figures).
    useEffect(() => {
        if (!showModal) {
            setLeaveImpact(null);
            return;
        }
        const empId = Number(formData.employee_id) || 0;
        const start = String(formData.pay_period_start || '');
        const end = String(formData.pay_period_end || '');
        if (!empId || validatePayPeriodRange(start, end)) {
            setLeaveImpact(null);
            return;
        }
        let cancelled = false;
        setLeaveImpact({ loading: true, days: 0, amount: 0, daily_rate: 0, balances: [], applied: false });
        (async () => {
            try {
                const res = await fetch(
                    `${API}/payroll.php?action=leave_impact&employee_id=${empId}&pay_period_start=${encodeURIComponent(start)}&pay_period_end=${encodeURIComponent(end)}`,
                    { credentials: 'include' }
                );
                const d = await res.json();
                if (cancelled) return;
                if (res.ok && d.success && d.data) {
                    setLeaveImpact({
                        loading: false,
                        days: Number(d.data.unpaid_leave_days) || 0,
                        amount: Number(d.data.unpaid_leave_amount) || 0,
                        daily_rate: Number(d.data.daily_rate) || 0,
                        balances: Array.isArray(d.data.balances) ? d.data.balances : [],
                        applied: false,
                    });
                } else {
                    setLeaveImpact(null);
                }
            } catch {
                if (!cancelled) setLeaveImpact(null);
            }
        })();
        return () => { cancelled = true; };
    }, [showModal, formData.employee_id, formData.pay_period_start, formData.pay_period_end]);

    const applyLeaveImpact = () => {
        if (!leaveImpact || leaveImpact.loading || leaveImpact.applied || leaveImpact.amount <= 0) return;
        const autoAmount = leaveImpact.amount;
        setFormData(prev => ({ ...prev, absence_deduction: String(autoAmount) }));
        setLeaveImpact(prev => (prev ? { ...prev, applied: true } : prev));
    };

    const applyPayPeriod = (half: 1 | 2) => {
        const dates = getPayPeriodDates(half);
        setFormData(prev => ({ ...prev, pay_period_start: dates.start, pay_period_end: dates.end }));
    };

    const openAdd = () => {
        setEditing(null);
        setFormData({ ...defaultForm });
        setFormSalary(0);
        setFormError('');
        setFormFieldErrors({});
        setShowModal(true);
    };

    const openEdit = (r: PayrollRecord) => {
        setEditing(r);
        setFormData({
            employee_id: String(r.employee_id),
            pay_period_start: r.pay_period_start,
            pay_period_end: r.pay_period_end,
            overtime_hours: String(r.overtime_hours),
            overtime_rate: String(r.overtime_rate),
            bonus: String(r.bonus),
            clothing_allowance: String(r.clothing_allowance),
            travel_allowance: String(r.travel_allowance),
            salary_adjustment: String(r.salary_adjustment),
            late_deduction: String(r.late_deduction),
            absence_deduction: String(r.absence_deduction),
            tax: String(r.tax),
            sss_contribution: String(r.sss_contribution),
            pagibig_contribution: String(r.pagibig_contribution),
            philhealth_contribution: String(r.philhealth_contribution),
            cash_advance_deduction: String(r.cash_advance_manual_deduction ?? r.cash_advance_deduction),
            laptop_loan_deduction: String(r.laptop_loan_deduction),
            other_deductions: String(r.other_deductions),
            status: r.status,
            notes: r.notes || '',
        });
        setFormSalary(Number(r.basic_salary));
        setFormError('');
        setFormFieldErrors({});
        setShowModal(true);
    };

    const handleSubmit = async (e: any) => {
        e.preventDefault();
        setFormError('');
        const isEdit = !!editing;
        // Required-field check with inline per-field messages.
        const missing: Record<string, string> = {};
        if (!String(formData.employee_id || '').trim()) missing.employee_id = 'Required.';
        if (!String(formData.pay_period_start || '').trim()) missing.pay_period_start = 'Required.';
        if (!String(formData.pay_period_end || '').trim()) missing.pay_period_end = 'Required.';
        if (Object.keys(missing).length > 0) {
            setFormFieldErrors(missing);
            return;
        }
        setFormFieldErrors({});
        const dateError = validatePayPeriodRange(formData.pay_period_start, formData.pay_period_end);
        if (dateError) {
            setFormError(dateError);
            return;
        }

        const payload: any = {
            employee_id: Number(formData.employee_id),
            pay_period_start: formData.pay_period_start,
            pay_period_end: formData.pay_period_end,
            overtime_hours: Number(formData.overtime_hours),
            overtime_rate: Number(formData.overtime_rate),
            bonus: Number(formData.bonus),
            clothing_allowance: Number(formData.clothing_allowance),
            travel_allowance: Number(formData.travel_allowance),
            salary_adjustment: Number(formData.salary_adjustment),
            late_deduction: Number(formData.late_deduction),
            absence_deduction: Number(formData.absence_deduction),
            tax: Number(formData.tax),
            sss_contribution: Number(formData.sss_contribution),
            pagibig_contribution: Number(formData.pagibig_contribution),
            philhealth_contribution: Number(formData.philhealth_contribution),
            cash_advance_deduction: Number(formData.cash_advance_deduction),
            laptop_loan_deduction: Number(formData.laptop_loan_deduction),
            other_deductions: Number(formData.other_deductions),
            status: formData.status,
            notes: formData.notes,
        };
        if (isEdit) payload.id = editing!.id;

        setFormSaving(true);
        try {
            const res = await fetch(`${API}/payroll.php`, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const d = await res.json();
            if (d.success) {
                setShowModal(false);
                if (isEdit) {
                    setRecords(prev => prev.map(r =>
                        r.id === editing!.id ? { ...r, ...d.data } : r
                    ));
                } else {
                    if (d.data) setRecords(prev => [d.data, ...prev]);
                    else fetchRecords();
                }
            } else {
                setFormError(d.message || 'Operation failed');
            }
        } catch { setFormError('Network error'); }
        finally { setFormSaving(false); }
    };

    const toggleRecordSelection = (payrollId: number | string) => {
        const normalizedId = Number(payrollId);
        if (!Number.isFinite(normalizedId) || normalizedId <= 0) return;

        setSelectedIds(prev =>
            prev.includes(normalizedId)
                ? prev.filter(id => id !== normalizedId)
                : [...prev, normalizedId]
        );
    };

    const toggleSelectAll = () => {
        setSelectedIds(prev => {
            const normalizedPrev = prev
                .map(id => Number(id))
                .filter(id => Number.isFinite(id) && id > 0);

            // selectableIds is the whole filtered list, so this selects or
            // clears every page at once instead of only the rendered page.
            if (allSelectableSelected) {
                return normalizedPrev.filter(id => !selectableIds.includes(id));
            }

            const merged = new Set(normalizedPrev);
            selectableIds.forEach(id => merged.add(id));
            return Array.from(merged);
        });
    };

    const updateBusyIds = (setter: Dispatch<SetStateAction<number[]>>, ids: number[], active: boolean) => {
        const normalizedIds = ids.map(Number).filter(id => Number.isFinite(id) && id > 0);
        if (normalizedIds.length === 0) return;
        setter(prev => {
            const current = new Set(prev);
            normalizedIds.forEach(id => active ? current.add(id) : current.delete(id));
            return Array.from(current);
        });
    };

    const isIdBusy = (id: number | string) => {
        const normalizedId = Number(id);
        return updatingIds.includes(normalizedId) || recalculatingIds.includes(normalizedId);
    };

    const updatePayrollStatus = async (
        targetIds: number[],
        nextStatus: 'approved' | 'draft' | 'paid' | 'archived',
        mode: 'single' | 'bulk' | 'bulk-az',
        originStatus?: PayrollRecord['status']
    ) => {
        if (targetIds.length === 0) return;

        const isRevertPaid = originStatus === 'paid' && nextStatus === 'approved';
        const isRestoreFromArchive = originStatus === 'archived' && nextStatus === 'paid';
        const actionLabel = isRevertPaid
            ? 'revert to approved'
            : isRestoreFromArchive
            ? 'restore'
            : nextStatus === 'approved'
            ? 'release'
            : nextStatus === 'draft'
                ? 'unrelease'
            : nextStatus === 'paid'
                ? 'mark as paid'
                : 'archive';
        const actionTitle = isRevertPaid
            ? 'Revert to Approved'
            : isRestoreFromArchive
            ? 'Restore Payroll'
            : nextStatus === 'approved'
            ? 'Release payslip'
            : nextStatus === 'draft'
                ? 'Unrelease payslip'
            : nextStatus === 'paid'
                ? 'Mark payroll as paid'
                : 'Archive payroll';
        const actionButton = isRevertPaid
            ? 'Revert to Approved'
            : isRestoreFromArchive
            ? 'Restore'
            : nextStatus === 'approved'
            ? 'Release Payslip'
            : nextStatus === 'draft'
                ? 'Unrelease Payslip'
            : nextStatus === 'paid'
                ? 'Mark as Paid'
                : 'Archive';
        const actionIcon = nextStatus === 'archived' ? 'warning' : 'question';
        const actionDanger = nextStatus === 'archived';
        const isAlphabetical = mode === 'bulk-az';
        const actionHelp = isRevertPaid
            ? (mode === 'single'
                ? 'This will revert the selected payroll record to approved in case it was marked as paid by mistake.'
                : `This will revert ${targetIds.length} payroll record(s) to approved.`)
            : isRestoreFromArchive
            ? (mode === 'single'
                ? 'This will restore the selected archived payroll record and return it to active records as paid.'
                : `This will restore ${targetIds.length} archived payroll record(s) and return them to active records as paid.`)
            : nextStatus === 'approved'
            ? (mode === 'single'
                ? 'This will release the selected payslip and make it available to the employee.'
                : isAlphabetical
                    ? `This will release ${targetIds.length} payslip(s) in A-Z order by last name and make them available to employees.`
                    : `This will release ${targetIds.length} selected payslip(s) and make them available to employees.`)
            : nextStatus === 'draft'
                ? (mode === 'single'
                    ? 'This will unrelease the selected payslip and hide it from the employee.'
                    : `This will unrelease ${targetIds.length} selected payslip(s) and hide them from employees.`)
            : mode === 'single'
                ? `This will ${actionLabel} the selected payroll record.`
                : `This will ${actionLabel} ${targetIds.length} selected payroll record(s).`;
        const confirmed = await confirmAction({
            title: `${actionTitle}?`,
            text: actionHelp,
            confirmButtonText: actionButton,
            icon: actionIcon,
            danger: actionDanger,
        });

        if (!confirmed) return;

        // Normalize once: selection state holds numbers while record.id
        // arrives as a string from the PHP API. Comparing without normalizing
        // silently matches zero rows, so bulk actions looked applied only
        // after a manual reload (which re-fetched from the already-updated DB).
        const normalizedTargetIds = targetIds
            .map(id => Number(id))
            .filter(id => Number.isFinite(id) && id > 0);
        if (normalizedTargetIds.length === 0) return;
        const targetIdSet = new Set(normalizedTargetIds);
        const isBulkArchiveOperation = mode !== 'single' && nextStatus === 'archived';
        const isBulkRestoreOperation = mode !== 'single' && isRestoreFromArchive;
        const usesBulkLoadingAlert = isBulkArchiveOperation || isBulkRestoreOperation;

        if (usesBulkLoadingAlert) {
            const operation = isBulkRestoreOperation ? 'Restoring' : 'Archiving';
            showLoadingToast(
                `${operation} ${normalizedTargetIds.length} payroll record(s)...`,
            );
        }

        const previousRecords = new Map(records.map(record => [Number(record.id), record]));
        updateBusyIds(setUpdatingIds, normalizedTargetIds, true);
        setRecords(prev => prev.map(record =>
            targetIdSet.has(Number(record.id)) ? { ...record, status: nextStatus } : record
        ));
        setViewRecord(prev => (
            prev && targetIdSet.has(Number(prev.id))
                ? { ...prev, status: nextStatus }
                : prev
        ));

        try {
            const payload = mode === 'single'
                ? { id: normalizedTargetIds[0], status: nextStatus }
                : { ids: normalizedTargetIds, status: nextStatus };

            const res = await fetch(`${API}/payroll.php`, {
                method: 'PUT',
                // This flow owns its notification. Suppress the global fetch
                // notifier so one API response cannot create duplicate toasts.
                headers: { 'Content-Type': 'application/json', 'X-No-Toast': '1' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const d = await res.json();

            if (!d.success) {
                setRecords(prev => prev.map(record => {
                    const original = previousRecords.get(Number(record.id));
                    return original ? { ...original } : record;
                }));
                setViewRecord(prev => {
                    if (!prev || !targetIdSet.has(Number(prev.id))) return prev;
                    const original = previousRecords.get(Number(prev.id));
                    return original ? { ...original } : prev;
                });
                const errorMessage = d.message || 'Failed to update payroll records.';
                if (usesBulkLoadingAlert) {
                    finishLoadingToast(`Bulk payroll update failed: ${errorMessage}`, 'error', 4000);
                } else {
                    void notifyError(errorMessage);
                }
                return;
            }

            setSelectedIds([]);
            const successMessage = d.message || (isRevertPaid
                    ? 'Payroll reverted to approved.'
                    : isRestoreFromArchive
                        ? 'Payroll restored from archive.'
                    : nextStatus === 'approved'
                        ? 'Payslip released.'
                        : nextStatus === 'draft'
                            ? 'Payslip unreleased.'
                            : nextStatus === 'paid'
                                ? 'Payroll marked as paid.'
                                : 'Payroll archived.');
            if (usesBulkLoadingAlert) {
                const completedTitle = isBulkRestoreOperation
                    ? 'Payroll records restored'
                    : 'Payroll records archived';
                finishLoadingToast(`${completedTitle}. ${successMessage}`, 'success', 3000);
            } else {
                void notifySuccess(successMessage);
            }
            // Reconcile with server truth: the backend skips ineligible rows
            // (e.g. already-paid/archived), which the optimistic update above
            // cannot know about. This is what makes the new statuses stick
            // without a manual reload.
            fetchRecords();
        } catch {
            setRecords(prev => prev.map(record => {
                const original = previousRecords.get(Number(record.id));
                return original ? { ...original } : record;
            }));
            setViewRecord(prev => {
                if (!prev || !targetIdSet.has(Number(prev.id))) return prev;
                const original = previousRecords.get(Number(prev.id));
                return original ? { ...original } : prev;
            });
            const errorMessage = 'Network error while updating payroll records.';
            if (usesBulkLoadingAlert) {
                finishLoadingToast(`Bulk payroll update failed: ${errorMessage}`, 'error', 4000);
            } else {
                void notifyError(errorMessage);
            }
        } finally {
            updateBusyIds(setUpdatingIds, normalizedTargetIds, false);
        }
    };

    const recalcGovernmentDeductions = async (recordId: number) => {
        if (recalculatingIds.includes(recordId)) return;

        const confirmed = await confirmAction({
            title: 'Recalculate government deductions?',
            text: 'This will recompute Withholding Tax, SSS, Pag-IBIG, and PhilHealth from Deduction Type settings based on the employee’s government numbers. Values are only filled when they are currently 0.',
            confirmButtonText: 'Recalculate',
            icon: 'question',
        });
        if (!confirmed) return;

        updateBusyIds(setRecalculatingIds, [recordId], true);
        try {
            const res = await fetch(`${API}/payroll.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: recordId }),
            });
            const d = await res.json();

            if (!d.success) {
                void notifyError(d.message || 'Failed to recalculate deductions.');
                return;
            }

            void notifySuccess('Government deductions recalculated.');
            const fresh = await fetch(`${API}/payroll.php?id=${recordId}`, OPTS);
            const freshData = await fresh.json();
            if (freshData.success && freshData.data) {
                setViewRecord(freshData.data);
                setRecords(prev => prev.map(r =>
                    Number(r.id) === Number(recordId) ? freshData.data : r
                ));
            }
        } catch {
            void notifyError('Network error while recalculating deductions.');
        } finally {
            updateBusyIds(setRecalculatingIds, [recordId], false);
        }
    };

    const toggleArchiveStorageView = () => {
        setActiveTab('records');
        setSelectedIds([]);
        setSearchTerm('');
        setPeriodStart('');
        setPeriodEnd('');
        setStatusFilter(prev => (prev === 'archived' ? 'all' : 'archived'));
    };

    const handleLogout = async () => {
        await fetch(`${API}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    // ── Import helpers ──
    const openImport = () => {
        setImportFile(null);
        setImportFileFormat('csv');
        setImportDateHint('');
        setImportPeriodStart('');
        setImportPeriodEnd('');
        setImportResult(null);
        setImportError('');
        setImportDetailKey(null);
        resetImportSession();
        setShowImportModal(true);
    };

    const applyImportPeriod = (half: 1 | 2) => {
        const dates = getPayPeriodDates(half);
        setImportPeriodStart(dates.start);
        setImportPeriodEnd(dates.end);
        setImportDateHint('');
    };

    /** The importer accepts .dat, .csv, .xls and .xlsx. */
    const detectImportFileFormat = (file: File): ImportFileFormat => {
        const name = file.name.toLowerCase();
        if (name.endsWith('.xlsx')) return 'xlsx';
        if (name.endsWith('.xls')) return 'xls';
        if (name.endsWith('.dat')) return 'dat';
        return 'csv';
    };

    /** `source_system` value sent to the API for each format (Base44 lookup key). */
    const sourceSystemForFormat = (format: ImportFileFormat) =>
        format === 'dat' ? 'zkteco' : 'payroll_excel';

    const isSupportedImportFile = (file?: File | null): file is File => {
        if (!file) return false;
        const name = file.name.toLowerCase();
        return IMPORT_FILE_FORMATS.some((format) => name.endsWith(`.${format.value}`));
    };

    /**
     * Accept a chosen file: sync the format dropdown, then read the file and
     * pre-fill the pay period from the dates that file actually covers.
     */
    const applyImportFile = async (file: File) => {
        resetImportSession(true);
        setImportFile(file);
        const format = detectImportFileFormat(file);
        setImportFileFormat(format);
        setImportError('');
        setImportFieldErrors({});

        // Binary workbooks hold dates as serials, so a text scan would only
        // produce noise — ask for the period instead.
        if (IMPORT_FILE_IS_BINARY(format)) {
            setImportPeriodStart('');
            setImportPeriodEnd('');
            setImportDateHint(`.${format} needs the pay period set by hand — use the 1st/2nd Half buttons or the date fields.`);
            return;
        }

        setImportDateHint('Reading the file for pay-period dates…');

        const scanId = importScanRef.current + 1;
        importScanRef.current = scanId;
        let range: { start: string; end: string } | null = null;
        try {
            range = await scanFileForDateRange(file);
        } catch {
            range = null;
        }
        if (importScanRef.current !== scanId) return; // a newer file replaced this one

        if (!range) {
            setImportPeriodStart('');
            setImportPeriodEnd('');
            setImportDateHint('No dates found in this file — set the pay period manually or use 1st/2nd Half.');
            return;
        }

        setImportPeriodStart(range.start);
        setImportPeriodEnd(range.end);
        const rangeError = validatePayPeriodRange(range.start, range.end);
        setImportDateHint(
            rangeError
                ? `Detected ${range.start} → ${range.end} in this file. ${rangeError}.`
                : `Pay period auto-filled from the file: ${range.start} → ${range.end}.`
        );
    };

    const handleFileDrop = (e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files[0];
        if (isSupportedImportFile(file)) {
            void applyImportFile(file);
        } else {
            setImportError(`Only ${IMPORT_FILE_EXT_TEXT} files are accepted`);
        }
    };

    const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) {
            if (isSupportedImportFile(file)) {
                void applyImportFile(file);
            } else {
                setImportError(`Only ${IMPORT_FILE_EXT_TEXT} files are accepted`);
            }
        }
    };

    const handleImport = async () => {
        if (!importFile) { setImportError(`Please select a ${IMPORT_FILE_EXT_TEXT} file`); return; }
        const detectedFormat = detectImportFileFormat(importFile);
        if (detectedFormat !== importFileFormat) {
            setImportError(`The selected format .${importFileFormat} does not match "${importFile.name}". Choose .${detectedFormat}, or pick a different file.`);
            return;
        }
        const importMissing: Record<string, string> = {};
        if (!importPeriodStart) importMissing.start = 'Required.';
        if (!importPeriodEnd) importMissing.end = 'Required.';
        if (Object.keys(importMissing).length > 0) { setImportFieldErrors(importMissing); return; }
        setImportFieldErrors({});
        const dateError = validatePayPeriodRange(importPeriodStart, importPeriodEnd);
        if (dateError) { setImportError(dateError); return; }

        setImportLoading(true);
        setImportError('');
        setImportResult(null);
        setImportPhase('uploading');

        try {
            const done = await runResumableUpload({
                baseUrl: `${API}/attendance_import.php`,
                initAction: 'import_init',
                chunkAction: 'import_chunk',
                completeAction: 'import_complete',
                file: importFile,
                fields: {
                    pay_period_start: importPeriodStart,
                    pay_period_end: importPeriodEnd,
                    source_system: sourceSystemForFormat(importFileFormat),
                },
                session: importSessionRef.current,
                onProgress: (progress) => setImportProgress(progress),
            });
            // Upload finished (100%) — the server is now parsing the file.
            setImportPhase('processing');
            const d = done?.data ?? null;
            if (d) {
                importSessionRef.current = { uploadId: null, received: 0 };
                setImportProgress(null);
                setImportPhase(null);
                setImportResult(d);
                fetchRecords();
            } else {
                // Upload reached the server but processing rejected it —
                // nothing left to resume, so drop the session (plain re-try).
                importSessionRef.current = { uploadId: null, received: 0 };
                setImportError('Import failed: empty server response');
                setImportPhase(null);
            }
        } catch (error: any) {
            // Upload failed mid-stream: the session keeps the confirmed
            // offset, so the Retry button below CONTINUES from there.
            const session = importSessionRef.current;
            const resumedPct = importFile.size > 0 ? Math.round((session.received / importFile.size) * 100) : 0;
            const base = error?.message || 'Network error during import';
            setImportError(session.received > 0 ? `${base} — retry continues from ${resumedPct}%.` : base);
            setImportPhase(null);
        }
        finally { setImportLoading(false); }
    };

    const downloadTemplate = () => {
        window.open(`${API}/attendance_import.php?action=template`, '_blank');
    };

    /**
     * The import result cards. Each one carries the row-level evidence the API
     * returns in `details`, so clicking a card can show WHICH employee or row
     * ended up in that bucket rather than a bare count.
     */
    const importCards = (() => {
        if (!importResult) return [];
        const details = importResult.details || {};
        const identity = importResult.identity_summary || {};
        const errorItems: ImportDetailItem[] = (importResult.errors || []).map((message: string) => ({
            status: 'error',
            detail: message,
        }));
        return [
            { key: 'created', label: 'Records Created', tone: '#059669', bg: '#f8fafc', border: '#e2e8f0', count: Number(importResult.records_created) || 0, items: (details.created || []) as ImportDetailItem[] },
            { key: 'skipped', label: 'Skipped', tone: '#f59e0b', bg: '#f8fafc', border: '#e2e8f0', count: Number(importResult.records_skipped) || 0, items: (details.skipped || []) as ImportDetailItem[] },
            { key: 'errors', label: 'Errors', tone: '#dc2626', bg: '#f8fafc', border: '#e2e8f0', count: errorItems.length, items: errorItems },
            { key: 'biometric_id', label: 'Biometric ID Matched', tone: '#1d4ed8', bg: '#eff6ff', border: '#dbeafe', count: Number(identity.matched_via_biometric_id) || 0, items: (details.matched_via_biometric_id || []) as ImportDetailItem[] },
            { key: 'base44', label: 'External Mapping Matched', tone: '#0369a1', bg: '#f0f9ff', border: '#e0f2fe', count: Number(identity.matched_via_base44) || 0, items: (details.matched_via_base44 || []) as ImportDetailItem[] },
            { key: 'smart_name', label: 'Smart Name Matched', tone: '#15803d', bg: '#f0fdf4', border: '#dcfce7', count: Number(identity.matched_via_smart_name) || 0, items: (details.matched_via_smart_name || []) as ImportDetailItem[] },
            { key: 'unresolved', label: 'Unresolved', tone: '#b91c1c', bg: '#fef2f2', border: '#fee2e2', count: Number(identity.unresolved) || 0, items: (details.unresolved || []) as ImportDetailItem[] },
        ];
    })();
    const activeImportCard = importCards.find((card) => card.key === importDetailKey) || null;

    // Re-fetch when filters change
    useEffect(() => {
        if (!user) return;
        refreshRecords();
    }, [user, statusFilter, periodStart, periodEnd]);
    useEffect(() => {
        if (!user) return;
        refreshAnalytics();
    }, [user, periodStart, periodEnd, analyticsBranchId]);

    // ── Chart data ──
    const monthlyChart = useMemo(() => {
        if (!Array.isArray(analytics?.charts?.monthly) || analytics.charts.monthly.length === 0) return null;
        const data = (analytics.charts.monthly as AnalyticsMonthlyPoint[])
            .map((point) => ({
                month: String(point.month || point.month_label || '').trim(),
                total: Number(point.total) || 0,
            }))
            .filter(point => point.month);
        if (data.length === 0 || !hasPositiveValues(data.map(point => point.total))) return null;
        return {
            labels: data.map(point => point.month),
            datasets: [{
                label: 'Net Payroll',
                data: data.map(point => point.total),
                backgroundColor: 'rgba(30,58,138,0.75)',
                borderColor: '#1e3a8a',
                borderWidth: 1,
                borderRadius: 6,
            }],
        };
    }, [analytics]);

    const breakdownChart = useMemo(() => {
        if (!analytics?.charts?.breakdown) return null;
        const entries = Object.entries(analytics.charts.breakdown as Record<string, number | string | null | undefined>)
            .map(([label, value]) => ({ label, value: Number(value) || 0 }))
            .filter(entry => entry.value > 0);
        if (entries.length === 0) return null;
        return {
            labels: entries.map(entry => entry.label),
            datasets: [{
                data: entries.map(entry => entry.value),
                backgroundColor: ['#1e3a8a', '#f59e0b', '#7c3aed', '#10b981'],
                borderWidth: 0,
            }],
        };
    }, [analytics]);

    const deductionBreakdownChart = useMemo(() => {
        if (!analytics?.charts?.deduction_breakdown) return null;
        const entries = Object.entries(analytics.charts.deduction_breakdown as Record<string, number | string | null | undefined>)
            .map(([label, value]) => ({ label, value: Number(value) || 0 }))
            .filter(entry => entry.value > 0);
        if (entries.length === 0) return null;
        return {
            labels: entries.map(entry => entry.label),
            datasets: [{
                data: entries.map(entry => entry.value),
                backgroundColor: ['#dc2626', '#f97316', '#f59e0b', '#2563eb', '#0ea5e9', '#14b8a6', '#8b5cf6', '#7c3aed', '#64748b'],
                borderWidth: 0,
            }],
        };
    }, [analytics]);

    const branchChart = useMemo(() => {
        if (!Array.isArray(analytics?.charts?.branch) || analytics.charts.branch.length === 0) return null;
        const data = (analytics.charts.branch as AnalyticsBranchPoint[])
            .map((point) => ({
                branch_name: String(point.branch_name || 'Unassigned').trim() || 'Unassigned',
                total: Number(point.total) || 0,
            }))
            .filter(point => point.total > 0);
        if (data.length === 0) return null;
        return {
            labels: data.map(point => point.branch_name || 'Unassigned'),
            datasets: [{
                label: 'Payroll',
                data: data.map(point => point.total),
                backgroundColor: ['#1e3a8a', '#059669', '#d97706', '#7c3aed', '#dc2626'],
                borderWidth: 0,
                borderRadius: 6,
            }],
        };
    }, [analytics]);

    const deductionBranchChart = useMemo(() => {
        if (!Array.isArray(analytics?.charts?.deduction_branch) || analytics.charts.deduction_branch.length === 0) return null;
        const data = (analytics.charts.deduction_branch as AnalyticsBranchPoint[])
            .map((point) => ({
                branch_name: String(point.branch_name || 'Unassigned').trim() || 'Unassigned',
                total: Number(point.total) || 0,
            }))
            .filter(point => point.total > 0);
        if (data.length === 0) return null;
        return {
            labels: data.map(point => point.branch_name || 'Unassigned'),
            datasets: [{
                label: 'Deductions',
                data: data.map(point => point.total),
                backgroundColor: ['#dc2626', '#f97316', '#f59e0b', '#8b5cf6', '#64748b'],
                borderWidth: 0,
                borderRadius: 6,
            }],
        };
    }, [analytics]);

    const contractChart = useMemo(() => {
        if (!Array.isArray(analytics?.charts?.contract_type) || analytics.charts.contract_type.length === 0) return null;
        const data = (analytics.charts.contract_type as AnalyticsContractPoint[])
            .map((point) => ({
                employment_type: String(point.employment_type || 'Unknown').trim() || 'Unknown',
                total: Number(point.total) || 0,
            }))
            .filter(point => point.total > 0);
        if (data.length === 0) return null;
        return {
            labels: data.map(point => point.employment_type || 'Unknown'),
            datasets: [{
                data: data.map(point => point.total),
                backgroundColor: ['#3b82f6', '#f59e0b', '#10b981', '#ef4444'],
                borderWidth: 0,
            }],
        };
    }, [analytics]);

    // No fullscreen loading splash: the Layout shell renders immediately and
    // each section shows its own inline loading state while data resolves.

    const kpi = analytics?.kpi;
    const viewBusy = viewRecord ? isIdBusy(viewRecord.id) : false;
    const canManage = user?.role !== 'staff';
    const analyticsBranchLabel = analyticsBranchId === 'all'
        ? 'All branches'
        : (branches.find(branch => String(branch.branch_id) === analyticsBranchId)?.branch_name || 'Selected branch');

    return (
        <Layout role={user?.role} user={user} onLogout={handleLogout}>
            <Head><title>Payroll Management</title></Head>

            {/* Page Header */}
            <div className={s.pageHeader}>
                <div className={s.pageTitleGroup}>
                    <h1 className={s.pageTitle}>Payroll Management</h1>
                    {canManage && (
                        <button
                            type="button"
                            className={isArchiveStorageView ? s.archiveStorageBtnActive : s.archiveStorageBtn}
                            onClick={toggleArchiveStorageView}
                            title={isArchiveStorageView ? 'Back to active payroll records' : 'Open payroll archive storage'}
                            aria-label={isArchiveStorageView ? 'Back to active payroll records' : 'Open payroll archive storage'}
                        >
                            <CrudActionIcon action="archive" size={15} />
                            {isArchiveStorageView ? 'Back to Active' : 'Archive Storage'}
                        </button>
                    )}
                </div>
                {user?.role !== 'staff' && (
                    <div style={{ display: 'flex', gap: 10 }}>
                        <button className={s.btnSecondary} onClick={openImport}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                            Import Attendance
                        </button>
                        <button className={s.btnPrimary} onClick={openAdd} title="Add Payroll" aria-label="Add Payroll">
                            Add Payroll
                        </button>
                    </div>
                )}
            </div>

            {/* KPI Cards */}
            <div className={s.kpiRow}>
                <div className={s.kpiCard}>
                    <div className={`${s.kpiIcon} ${s.kpiIconBlue}`}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
                    </div>
                    <div>
                        <div className={s.kpiLabel}>Total Payroll</div>
                        <div className={s.kpiValue}>{fmt(kpi?.total_payroll)}</div>
                    </div>
                </div>
                <div className={s.kpiCard}>
                    <div className={`${s.kpiIcon} ${s.kpiIconGreen}`}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /></svg>
                    </div>
                    <div>
                        <div className={s.kpiLabel}>Active Headcount</div>
                        <div className={s.kpiValue}>{kpi?.headcount || 0}</div>
                    </div>
                </div>
                <div className={s.kpiCard}>
                    <div className={`${s.kpiIcon} ${s.kpiIconAmber}`}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" /></svg>
                    </div>
                    <div>
                        <div className={s.kpiLabel}>Avg Salary</div>
                        <div className={s.kpiValue}>{fmt(kpi?.avg_salary)}</div>
                    </div>
                </div>
                <div className={s.kpiCard}>
                    <div className={`${s.kpiIcon} ${s.kpiIconPurple}`}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 14c0 4-3 7-7 7s-7-3-7-7" /><path d="M5 10c0-4 3-7 7-7s7 3 7 7" /><line x1="8" y1="12" x2="16" y2="12" /></svg>
                    </div>
                    <div>
                        <div className={s.kpiLabel}>Total Deductions</div>
                        <div className={s.kpiValue}>{fmt(kpi?.total_deductions)}</div>
                    </div>
                </div>
                <div className={`${s.kpiCard} ${s.kpiSwitchCard}`}>
                    <div className={s.kpiSwitchMeta}>
                        <div className={s.kpiLabel}>Dashboard View</div>
                        <div className={s.kpiSwitchHint}>Open payroll records or analytics.</div>
                    </div>
                    <div className={s.kpiSwitchTabs}>
                        <button className={activeTab === 'records' ? s.tabActive : s.tab} onClick={() => setActiveTab('records')}>
                            Payroll Records
                        </button>
                        <button className={activeTab === 'analytics' ? s.tabActive : s.tab} onClick={() => setActiveTab('analytics')}>
                            Analytics
                        </button>
                    </div>
                </div>
            </div>

            {activeTab === 'records' && (
                <div className={s.recordsFilterSection}>
                    <h2 className={s.recordsFilterHeading}>Payroll Records</h2>
                    <div className={s.recordsFilters}>
                        <div className={`${s.filterField} ${s.recordsSearchField}`}>
                            <label className={s.filterLabel}>
                                Search Employee
                            </label>
                            <SearchBar
                                storageKey="payroll:records"
                                placeholder="Search by employee name..."
                                ariaLabel="Search payroll records"
                                value={searchTerm}
                                onChange={setSearchTerm}
                                suggestions={collectSearchTerms(records, [
                                    (r: any) => r.full_employee_name || r.employee_name,
                                    (r: any) => r.status,
                                ])}
                                inputClassName={s.searchInput}
                                inputStyle={{ paddingLeft: '32px' }}
                            />
                        </div>
                        <div className={s.filterField}>
                            <label className={s.filterLabel}>Status</label>
                            <select className={s.filterSelect} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                                <option value="all">All Status</option>
                                <option value="draft">Draft</option>
                                <option value="pending">Pending</option>
                                <option value="approved">Approved</option>
                                <option value="paid">Paid</option>
                                <option value="archived">Archived</option>
                            </select>
                        </div>
                        <div className={s.filterField}>
                            <label className={s.filterLabel}>A-Z Filter</label>
                            <div className={s.azFilterWrap} ref={azFilterRef}>
                                <select
                                    className={s.filterSelect}
                                    value={azFilterMode}
                                    onClick={() => {
                                        if (azFilterMode === 'range') setAzCardOpen(true);
                                    }}
                                    onChange={e => {
                                        const next = e.target.value as 'all' | 'range';
                                        setAzFilterMode(next);
                                        setAzCardOpen(next === 'range');
                                        if (next === 'all') {
                                            setAzStart('A');
                                            setAzEnd('Z');
                                        }
                                    }}
                                >
                                    <option value="all">All</option>
                                    <option value="range">A-Z Range</option>
                                </select>
                                {azFilterMode === 'range' && azCardOpen && (
                                    <div className={s.azFilterCard}>
                                        <div className={s.azFilterHeader}>
                                            <span className={s.azFilterTitle}>A-Z Range</span>
                                            <button
                                                type="button"
                                                className={s.azFilterClose}
                                                aria-label="Close A-Z filter"
                                                onClick={() => setAzCardOpen(false)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                        <div className={s.azFilterRow}>
                                            <span className={s.azFilterLabel}>Start</span>
                                            <select
                                                className={s.azFilterSelect}
                                                value={azStart}
                                                onChange={e => setAzStart(e.target.value)}
                                            >
                                                {AZ_LETTERS.map(letter => (
                                                    <option key={letter} value={letter}>{letter}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className={s.azFilterRow}>
                                            <span className={s.azFilterLabel}>End</span>
                                            <select
                                                className={s.azFilterSelect}
                                                value={azEnd}
                                                onChange={e => setAzEnd(e.target.value)}
                                            >
                                                {AZ_LETTERS.map(letter => (
                                                    <option key={letter} value={letter}>{letter}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div className={s.azFilterHint}>
                                            Filters by last name initial.
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className={s.filterField}>
                            <label className={s.filterLabel}>Period From</label>
                            <input className={s.filterDate} type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} title="Period From" />
                        </div>
                        <div className={s.filterField}>
                            <label className={s.filterLabel}>Period To</label>
                            <input className={s.filterDate} type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} title="Period To" />
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════════════════════ RECORDS TAB ═══════════════════════ */}
            {activeTab === 'records' && (
                <>
                    {canManage && (
                        <div className={s.bulkActionsBar}>
                            <div className={s.bulkMeta}>
                                <span className={s.bulkCount}>{selectedIds.length} selected</span>
                                <span className={s.bulkHint}>
                                    {isArchiveStorageView
                                        ? (archivedIdsSorted.length > 0
                                            ? `${archivedIdsSorted.length} archived record(s) in filtered view`
                                            : 'No archived payroll records in view')
                                        : (selectableIds.length > 0
                                            ? `${selectableIds.length} selectable record(s) in view${allSelectableSelected ? ' — all pages selected' : ''}`
                                            : 'No selectable payroll records')}
                                </span>
                                {selectedIds.length > 0 && (
                                    <button type="button" className={s.bulkClearBtn} onClick={() => setSelectedIds([])}>
                                        Clear
                                    </button>
                                )}
                            </div>
                            <div className={s.bulkButtons}>
                                {isArchiveStorageView ? (
                                    <>
                                        <button
                                            type="button"
                                            className={s.bulkBtn}
                                            disabled={selectedArchivedIdsSorted.length === 0}
                                            onClick={() => void updatePayrollStatus(selectedArchivedIdsSorted, 'paid', 'bulk', 'archived')}
                                            title="Restore selected archived payroll records"
                                        >
                                            <CrudActionIcon action="restore" />
                                            Restore Selected
                                        </button>
                                        <button
                                            type="button"
                                            className={s.bulkBtn}
                                            disabled={archivedIdsSorted.length === 0}
                                            onClick={() => void updatePayrollStatus(archivedIdsSorted, 'paid', 'bulk', 'archived')}
                                            title="Restore all archived payroll records currently in view"
                                        >
                                            <CrudActionIcon action="restore" />
                                            Restore All
                                        </button>
                                    </>
                                ) : (
                                    <>
                                        <button
                                            type="button"
                                            className={s.bulkBtn}
                                            disabled={allSelectedApproved ? selectedUnreleaseIds.length === 0 : !hasReleasableSelection}
                                            onClick={() => {
                                                if (allSelectedApproved) {
                                                    void updatePayrollStatus(selectedUnreleaseIds, 'draft', 'bulk');
                                                    return;
                                                }
                                                void updatePayrollStatus(selectedReleaseIdsSorted, 'approved', 'bulk');
                                            }}
                                        >
                                            <CrudActionIcon action={allSelectedApproved ? 'cancel' : 'approve'} />
                                            {allSelectedApproved ? 'Unrelease Payslip' : 'Release Payslip'}
                                        </button>
                                        <button
                                            type="button"
                                            className={s.bulkBtn}
                                            disabled={!hasPayableSelection}
                                            onClick={() => void updatePayrollStatus(selectedIds, 'paid', 'bulk')}
                                        >
                                            <CrudActionIcon action="approve" />
                                            Mark Paid
                                        </button>
                                        <button
                                            type="button"
                                            className={s.bulkBtnDanger}
                                            disabled={!hasArchivableSelection}
                                            onClick={() => void updatePayrollStatus(selectedArchivableIds, 'archived', 'bulk')}
                                        >
                                            <CrudActionIcon action="archive" />
                                            Archive
                                        </button>
                                    </>
                                )}
                            </div>
                        </div>
                    )}

                    <div className={s.tableWrap} onScroll={() => setOpenActionsId(null)}>
                        <table className={`${s.table} llb-table llb-pin-first`}>
                            <thead>
                                <tr>
                                    {canManage && (
                                        <th className={`${s.th} ${s.selectBtnCell}`}>
                                            <button
                                                type="button"
                                                className={`${s.selectBtn} ${allSelectableSelected ? s.selectBtnActive : ''}`}
                                                disabled={selectableIds.length === 0}
                                                onClick={toggleSelectAll}
                                                title={allSelectableSelected
                                                    ? `Deselect all ${selectableIds.length} selectable record(s)`
                                                    : `Select all ${selectableIds.length} selectable record(s) across every page`}
                                            >
                                                {allSelectableSelected ? 'Deselect All' : `Select All (${selectableIds.length})`}
                                            </button>
                                        </th>
                                    )}
                                    <th className={s.th}>Employee</th>
                                    <th className={s.th}>Period</th>
                                    <th className={`${s.th} llb-num`}>Gross (Before Deductions)</th>
                                    <th className={`${s.th} llb-num`}>Deductions</th>
                                    <th className={`${s.th} llb-num`}>Net Pay</th>
                                    <th className={s.th}>Status</th>
                                    <th className={s.th} style={{ textAlign: 'center', width: canManage ? 200 : 80 }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filtered.length === 0 ? (
                                    <tr><td colSpan={canManage ? 9 : 8} className={s.emptyState}>
                                        <ZeroResults
                                            query={searchTerm}
                                            itemLabel="payroll records"
                                            alternatives={getAlternativeSuggestions(searchTerm, collectSearchTerms(records, [
                                                (r: any) => r.full_employee_name || r.employee_name,
                                            ]))}
                                            onPickAlternative={(term) => setSearchTerm(term)}
                                            onClear={() => setSearchTerm('')}
                                        />
                                    </td></tr>
                                ) : paginatedRecords.map(r => {
                                    const rowBusy = isIdBusy(r.id);
                                    const biometricName = importedBiometricName(r);
                                    const officialName = r.full_employee_name || r.employee_name;
                                    const displayedName = biometricName || officialName;
                                    return (
                                        <tr key={r.id} className={selectedIdSet.has(Number(r.id)) ? s.selectedRow : ''}>
                                        {canManage && (
                                            <td className={`${s.td} ${s.selectBtnCell}`}>
                                                <button
                                                    type="button"
                                                    className={`${s.selectBtn} ${selectedIdSet.has(Number(r.id)) ? s.selectBtnActive : ''}`}
                                                    disabled={rowBusy}
                                                    onClick={() => toggleRecordSelection(r.id)}
                                                    title={rowBusy ? 'Wait for the current action to finish' : selectedIdSet.has(Number(r.id)) ? `Deselect ${r.full_employee_name || r.employee_name}` : `Select ${r.full_employee_name || r.employee_name}`}
                                                >
                                                    {selectedIdSet.has(Number(r.id)) ? '✓' : 'Select'}
                                                </button>
                                            </td>
                                        )}
                                        <td className={`${s.td} llb-trunc`} style={{ fontWeight: 600 }} title={displayedName}>{displayedName}</td>
                                        <td className={s.td} style={{ whiteSpace: 'nowrap' }}>
                                            {new Date(r.pay_period_start).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' })} –{' '}
                                            {new Date(r.pay_period_end).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}
                                        </td>
                                        <td className={`${s.td} llb-num`}>{fmt(calcGrossBeforeAttendance(r))}</td>
                                        <td className={`${s.td} llb-num`} style={{ color: '#dc2626' }}>{fmt(calcAllDeductions(r))}</td>
                                        <td className={`${s.td} llb-num`} style={{ fontWeight: 700 }}>{fmt(r.net_pay)}</td>
                                        <td className={s.td}>
                                            {canManage && r.status === 'paid' ? (
                                                <button
                                                    type="button"
                                                    className={`${s.badge} ${badgeClass[r.status] || s.badgeDraft} ${s.badgeButton}`}
                                                    disabled={rowBusy}
                                                    title={rowBusy ? 'Working...' : 'Revert to Approved'}
                                                    aria-label={`Revert payroll for ${r.full_employee_name || r.employee_name} to approved`}
                                                    onClick={() => void updatePayrollStatus([r.id], 'approved', 'single', r.status)}
                                                >
                                                    {rowBusy ? 'Working' : r.status}
                                                </button>
                                            ) : (
                                                <span className={`${s.badge} ${badgeClass[r.status] || s.badgeDraft}`}>{r.status}</span>
                                            )}
                                        </td>
                                        <td
                                            className={`${s.td} llb-actions`}
                                            style={{ textAlign: 'center', position: 'relative', zIndex: openActionsId === r.id ? 100 : 1 }}
                                        >
                                            <div className={s.actionsCell} style={{ opacity: 1, zIndex: openActionsId === r.id ? 100 : 1 }}>
                                                <button
                                                    type="button"
                                                    className={`${s.actionMenuTrigger} ${rowBusy ? s.isWorking : ''}`}
                                                    disabled={rowBusy}
                                                    title={rowBusy ? 'Working...' : 'Open actions'}
                                                    aria-label={`Open actions for ${r.full_employee_name || r.employee_name}`}
                                                    aria-expanded={openActionsId === r.id}
                                                    onClick={(event) => {
                                                        if (openActionsId === r.id) {
                                                            setOpenActionsId(null);
                                                            setActionMenuPosition(null);
                                                            return;
                                                        }
                                                        const rect = event.currentTarget.getBoundingClientRect();
                                                        const menuHeight = r.status === 'archived' ? 124 : 174;
                                                        const menuTop = rect.bottom + 4 + menuHeight <= window.innerHeight - 8
                                                            ? rect.bottom + 4
                                                            : Math.max(8, rect.top - menuHeight - 4);
                                                        setActionMenuPosition({
                                                            top: menuTop,
                                                            left: Math.max(8, Math.min(window.innerWidth - 164, rect.right - 156)),
                                                        });
                                                        setOpenActionsId(r.id);
                                                    }}
                                                >
                                                    <span aria-hidden="true">•••</span>
                                                </button>
                                                {openActionsId === r.id && (
                                                    <div
                                                        className={s.actionMenu}
                                                        role="menu"
                                                        aria-label="Payroll actions"
                                                        style={{ position: 'fixed', top: actionMenuPosition?.top ?? 8, left: actionMenuPosition?.left ?? 8, right: 'auto' }}
                                                    >
                                                        <button
                                                            type="button"
                                                            className={s.actionMenuItem}
                                                            disabled={rowBusy}
                                                            role="menuitem"
                                                            onClick={() => { setOpenActionsId(null); setViewRecord(r); }}
                                                        >
                                                            View
                                                        </button>
                                                        {canManage && <>
                                                            <button
                                                                type="button"
                                                                className={s.actionMenuItem}
                                                                disabled={rowBusy}
                                                                role="menuitem"
                                                                onClick={() => { setOpenActionsId(null); openEdit(r); }}
                                                            >
                                                                Edit
                                                            </button>
                                                            {r.status !== 'paid' && r.status !== 'archived' && (
                                                            <button
                                                                type="button"
                                                                className={`${s.actionMenuItem} ${s.actionMenuItemSuccess}`}
                                                                disabled={rowBusy}
                                                                role="menuitem"
                                                                onClick={() => { setOpenActionsId(null); void updatePayrollStatus([r.id], 'paid', 'single'); }}
                                                            >
                                                                Mark as Paid
                                                            </button>
                                                            )}
                                                            {r.status === 'paid' && (
                                                            <button
                                                                type="button"
                                                                className={`${s.actionMenuItem} ${s.actionMenuItemDanger}`}
                                                                disabled={rowBusy}
                                                                role="menuitem"
                                                                onClick={() => { setOpenActionsId(null); void updatePayrollStatus([r.id], 'archived', 'single'); }}
                                                            >
                                                                Archive
                                                            </button>
                                                            )}
                                                            {r.status === 'archived' && (
                                                            <button
                                                                type="button"
                                                                className={`${s.actionMenuItem} ${s.actionMenuItemSuccess}`}
                                                                disabled={rowBusy}
                                                                role="menuitem"
                                                                onClick={() => { setOpenActionsId(null); void updatePayrollStatus([r.id], 'paid', 'single', r.status); }}
                                                            >
                                                                Restore
                                                            </button>
                                                            )}
                                                        </>}
                                                    </div>
                                                )}
                                            </div>
                                        </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                    <Pagination
                        currentPage={currentPage}
                        totalItems={filtered.length}
                        itemsPerPage={ITEMS_PER_PAGE}
                        onPageChange={setCurrentPage}
                        label="payroll records"
                    />
                </>
            )}

            {/* ═══════════════════════ ANALYTICS TAB ═══════════════════════ */}
            {activeTab === 'analytics' && (
                <>
                    <h2 className={s.analyticsHeading}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="20" x2="18" y2="10" /><line x1="12" y1="20" x2="12" y2="4" /><line x1="6" y1="20" x2="6" y2="14" /></svg>
                        Payroll Analytics
                    </h2>
                    <div style={{ marginTop: '-8px', marginBottom: '16px', color: '#64748b', fontSize: '13px' }}>
                        Includes approved, paid, and archived payroll records{periodStart || periodEnd ? ' within the selected period.' : '.'} Deduction analytics are calculated company-wide from each payroll deduction column. Current branch scope: {analyticsBranchLabel}.
                    </div>
                    <div className={s.toolbarRow}>
                        <div className={s.filtersBar} style={{ gridTemplateColumns: 'minmax(220px, 320px)', maxWidth: 320 }}>
                            <div className={s.filterField}>
                                <label className={s.filterLabel}>Branch Scope</label>
                                <select
                                    className={s.filterSelect}
                                    value={analyticsBranchId}
                                    onChange={e => setAnalyticsBranchId(e.target.value)}
                                >
                                    <option value="all">All Branches</option>
                                    {branches.map(branch => (
                                        <option key={branch.branch_id} value={String(branch.branch_id)}>
                                            {branch.branch_name}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    </div>
                    <div className={s.chartsGrid}>
                        {/* Monthly Trend */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Monthly Payroll Trend</h3>
                            {monthlyChart ? (
                                <Bar data={monthlyChart} options={{ responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: (v: any) => formatChartCurrencyTick(v) } } } }} />
                            ) : <div className={s.emptyState}>No data yet</div>}
                        </div>

                        {/* Breakdown */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Payroll Breakdown</h3>
                            {breakdownChart ? (
                                <div style={{ maxWidth: 280, margin: '0 auto' }}>
                                    <Doughnut data={breakdownChart} options={{ responsive: true, plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } } } }} />
                                </div>
                            ) : <div className={s.emptyState}>No data yet</div>}
                        </div>

                        {/* By Branch */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Payroll by Branch</h3>
                            {branchChart && branchChart.labels.length > 0 ? (
                                <Bar data={branchChart} options={{ indexAxis: 'y' as const, responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { callback: (v: any) => formatChartCurrencyTick(v) } } } }} />
                            ) : <div className={s.emptyState}>No data yet</div>}
                        </div>

                        {/* By Contract Type */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Payroll by Contract Type</h3>
                            {contractChart && contractChart.labels.length > 0 ? (
                                <div style={{ maxWidth: 280, margin: '0 auto' }}>
                                    <Pie data={contractChart} options={{ responsive: true, plugins: { legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } } } }} />
                                </div>
                            ) : <div className={s.emptyState}>No data yet</div>}
                        </div>

                        {/* Deduction Breakdown */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Company Deduction Breakdown</h3>
                            {deductionBreakdownChart ? (
                                <div style={{ maxWidth: 320, margin: '0 auto' }}>
                                    <Doughnut data={deductionBreakdownChart} options={{ responsive: true, plugins: { legend: { position: 'bottom', labels: { padding: 14, usePointStyle: true } } } }} />
                                </div>
                            ) : <div className={s.emptyState}>No deduction data yet</div>}
                        </div>

                        {/* Deductions by Branch */}
                        <div className={s.chartCard}>
                            <h3 className={s.chartTitle}>Deductions by Branch</h3>
                            {deductionBranchChart && deductionBranchChart.labels.length > 0 ? (
                                <Bar data={deductionBranchChart} options={{ indexAxis: 'y' as const, responsive: true, plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { callback: (v: any) => formatChartCurrencyTick(v) } } } }} />
                            ) : <div className={s.emptyState}>No deduction data yet</div>}
                        </div>
                    </div>
                </>
            )}

            {/* ═══════════════════════ ADD / EDIT MODAL ═══════════════════════ */}
            {showModal && (
                <div className={s.overlay} onClick={() => setShowModal(false)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()}>
                        <div className={s.modalHeader}>
                            <h2 className={s.modalTitle}>{editing ? 'Edit Payroll' : 'Add Payroll'}</h2>
                            <button className={s.modalClose} onClick={() => setShowModal(false)}>×</button>
                        </div>
                        <form onSubmit={handleSubmit} noValidate>
                            <div className={s.modalBody}>
                                {/* Employee & Salary */}
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Employee *</label>
                                        <select name="employee_id" value={formData.employee_id} onChange={onInput} required aria-required="true" aria-invalid={formFieldErrors.employee_id ? true : undefined} disabled={!!editing} style={formFieldErrors.employee_id ? { border: '2px solid #ef4444' } : undefined}>
                                            <option value="">-- Select Employee --</option>
                                            {employees.map(emp => (
                                                <option key={emp.employee_id} value={emp.employee_id}>
                                                    {emp.first_name} {emp.last_name}
                                                </option>
                                            ))}
                                        </select>
                                        {formFieldErrors.employee_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{formFieldErrors.employee_id}</div>}
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Basic Salary (semi-monthly)</label>
                                        <input type="text" value={fmt(formSalary)} disabled style={{ background: '#f8fafc' }} />
                                    </div>
                                </div>

                                {/* Pay Period with Quick-pick */}
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, marginBottom: 4 }}>
                                    <span className={s.formLabel} style={{ marginBottom: 0 }}>Pay Period *</span>
                                    <button type="button" onClick={() => applyPayPeriod(1)} style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>1st Half</button>
                                    <button type="button" onClick={() => applyPayPeriod(2)} style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>2nd Half</button>
                                </div>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Start</label>
                                        <input type="date" name="pay_period_start" value={formData.pay_period_start} onChange={onInput} max={today} required aria-required="true" aria-invalid={formFieldErrors.pay_period_start ? true : undefined} style={formFieldErrors.pay_period_start ? { border: '2px solid #ef4444' } : undefined} />
                                        {formFieldErrors.pay_period_start && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{formFieldErrors.pay_period_start}</div>}
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>End</label>
                                        <input type="date" name="pay_period_end" value={formData.pay_period_end} onChange={onInput} max={today} required aria-required="true" aria-invalid={formFieldErrors.pay_period_end ? true : undefined} style={formFieldErrors.pay_period_end ? { border: '2px solid #ef4444' } : undefined} />
                                        {formFieldErrors.pay_period_end && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{formFieldErrors.pay_period_end}</div>}
                                    </div>
                                </div>

                                {/* Earnings */}
                                <h3 className={s.formSection}>Earnings</h3>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Overtime Hours</label>
                                        <input type="number" name="overtime_hours" value={formData.overtime_hours} onChange={onInput} min="0" step="0.5" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>{`Overtime Rate (${PESO_SYMBOL}/hr)`}</label>
                                        <input type="number" name="overtime_rate" value={formData.overtime_rate} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                </div>

                                {/* Allowances */}
                                <h3 className={s.formSection}>Allowances</h3>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Clothing Allowance</label>
                                        <input type="number" name="clothing_allowance" value={formData.clothing_allowance} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Travel Allowance</label>
                                        <input type="number" name="travel_allowance" value={formData.travel_allowance} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Salary Adjustment</label>
                                        <input type="number" name="salary_adjustment" value={formData.salary_adjustment} onChange={onInput} step="0.01" />
                                    </div>
                                </div>

                                {/* Attendance Deductions */}
                                <h3 className={s.formSection}>Attendance Deductions</h3>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Late Deduction</label>
                                        <input type="number" name="late_deduction" value={formData.late_deduction} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Absence Deduction</label>
                                        <input type="number" name="absence_deduction" value={formData.absence_deduction} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                </div>

                                {/* Leave impact (from leave_type figures) */}
                                {leaveImpact && (
                                    <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc' }}>
                                        {leaveImpact.loading ? (
                                            <div style={{ fontSize: 12, color: '#64748b' }}>Checking leave impact…</div>
                                        ) : (
                                            <>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                                                    <div style={{ fontSize: 12.5, color: '#334155' }}>
                                                        <strong>Unpaid leave in period:</strong>{' '}
                                                        {leaveImpact.days > 0 ? (
                                                            <span>{leaveImpact.days} day(s) × {PESO_SYMBOL}{leaveImpact.daily_rate.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} = <strong style={{ color: '#dc2626' }}>{PESO_SYMBOL}{leaveImpact.amount.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></span>
                                                        ) : (
                                                            <span style={{ color: '#64748b' }}>None — no approved unpaid leaves overlap this period.</span>
                                                        )}
                                                    </div>
                                                    {leaveImpact.amount > 0 && (
                                                        <button
                                                            type="button"
                                                            onClick={applyLeaveImpact}
                                                            disabled={leaveImpact.applied}
                                                            title={leaveImpact.applied ? 'Unpaid leave amount already applied to Absence Deduction' : 'Set Absence Deduction to the unpaid leave amount'}
                                                            style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #bfdbfe', background: leaveImpact.applied ? '#f1f5f9' : '#eff6ff', color: leaveImpact.applied ? '#94a3b8' : '#1d4ed8', fontSize: 12, fontWeight: 700, cursor: leaveImpact.applied ? 'default' : 'pointer' }}
                                                        >
                                                            {leaveImpact.applied ? 'Applied ✓' : 'Apply to Absence'}
                                                        </button>
                                                    )}
                                                </div>
                                                {leaveImpact.balances.length > 0 && (
                                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                                                        {leaveImpact.balances.map((b) => (
                                                            <span
                                                                key={b.leave_type}
                                                                title={`${b.type_name}: ${b.remaining_days} remaining of ${b.total_days} (${b.is_paid ? 'paid' : 'unpaid'})`}
                                                                style={{ fontSize: 11, padding: '3px 9px', borderRadius: 999, border: '1px solid #e2e8f0', background: '#ffffff', color: '#475569', fontWeight: 600 }}
                                                            >
                                                                {b.type_name}: {b.remaining_days}/{b.total_days}{b.is_paid ? '' : ' (unpaid)'}
                                                            </span>
                                                        ))}
                                                    </div>
                                                )}
                                                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 6 }}>
                                                    Daily rate = semi-monthly basic ÷ calendar days in the period (same rate printed on the payslip). Saving with an empty Absence Deduction auto-applies the unpaid leave amount.
                                                </div>
                                            </>
                                        )}
                                    </div>
                                )}

                                {/* Government Contributions */}
                                <h3 className={s.formSection}>Government Contributions</h3>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Withholding Tax</label>
                                        <input type="number" name="tax" value={formData.tax} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>SSS</label>
                                        <input type="number" name="sss_contribution" value={formData.sss_contribution} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>PhilHealth</label>
                                        <input type="number" name="philhealth_contribution" value={formData.philhealth_contribution} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Pag-IBIG</label>
                                        <input type="number" name="pagibig_contribution" value={formData.pagibig_contribution} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                </div>

                                {/* Loan Deductions */}
                                <h3 className={s.formSection}>Loan Deductions</h3>
                                <p style={{ marginTop: -6, marginBottom: 12, color: '#64748b', fontSize: 12 }}>
                                    Approved cash advance requests are added automatically after the payroll is saved. Use the field below only for a manual adjustment if needed.
                                </p>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Manual Cash Advance Adjustment</label>
                                        <input type="number" name="cash_advance_deduction" value={formData.cash_advance_deduction} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Laptop Loan</label>
                                        <input type="number" name="laptop_loan_deduction" value={formData.laptop_loan_deduction} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Other Deductions</label>
                                        <input type="number" name="other_deductions" value={formData.other_deductions} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                </div>

                                {/* Bonus (separate from gross per client) */}
                                <h3 className={s.formSection}>Bonus</h3>
                                <div className={s.formGrid}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Bonus Amount</label>
                                        <input type="number" name="bonus" value={formData.bonus} onChange={onInput} min="0" step="0.01" />
                                    </div>
                                </div>

                                {/* Summary */}
                                <h3 className={s.formSection}>Summary</h3>
                                <div className={s.calcRow}><span>Overtime Pay</span><span className={s.calcValue}>{fmt(calc.ot_pay)}</span></div>
                                <div className={s.calcRow}><span>Gross Pay</span><span className={s.calcValue}>{fmt(calc.gross)}</span></div>
                                <div className={s.calcRow}><span>Total Deductions</span><span className={s.calcValue} style={{ color: '#dc2626' }}>{fmt(calc.total_ded)}</span></div>
                                {calc.bonus > 0 && (
                                    <div className={s.calcRow}><span>Bonus</span><span className={s.calcValue} style={{ color: '#059669' }}>+{fmt(calc.bonus)}</span></div>
                                )}
                                <div className={s.calcRowTotal}><span>Net Pay</span><span>{fmt(calc.net)}</span></div>

                                {/* Status & Notes */}
                                <div className={s.formGrid} style={{ marginTop: 16 }}>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Status</label>
                                        <select name="status" value={formData.status} onChange={onInput}>
                                            <option value="draft">Draft</option>
                                            <option value="pending">Pending</option>
                                            <option value="approved">Approved</option>
                                            <option value="paid">Paid</option>
                                        </select>
                                    </div>
                                    <div className={s.formGroup}>
                                        <label className={s.formLabel}>Notes</label>
                                        <textarea name="notes" value={formData.notes} onChange={onInput} placeholder="Optional notes..." rows={2} style={{ minHeight: 'auto' }} />
                                    </div>
                    </div>
                    {recordsLoading && <div className={s.loadingPill}>Refreshing payroll records...</div>}
                </div>
                            <div className={s.modalFooter} style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, alignItems: 'center' }}>
                                <button 
                                    type="button" 
                                    onClick={() => setShowModal(false)}
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
                                    type="submit" 
                                    title={editing ? 'Update Payroll' : 'Create Payroll'} 
                                    aria-label={editing ? 'Update Payroll' : 'Create Payroll'} 
                                    disabled={formSaving}
                                    style={{
                                        background: 'transparent',
                                        border: 'none',
                                        padding: 0,
                                        cursor: formSaving ? 'not-allowed' : 'pointer',
                                        color: formSaving ? '#94a3b8' : '#2563eb',
                                        fontWeight: 600,
                                        fontSize: 14,
                                        opacity: formSaving ? 0.6 : 1
                                    }}
                                >
                                    {formSaving ? 'Saving...' : (editing ? 'Update' : 'Save')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ═══════════════════════ VIEW MODAL ═══════════════════════ */}
            {viewRecord && (
                <div className={s.overlay} onClick={() => setViewRecord(null)}>
                    <div className={`${s.modal} ${s.detailModal}`} onClick={e => e.stopPropagation()}>
                        <div className={s.modalHeader}>
                            <h2 className={s.modalTitle}>Payroll Details</h2>
                            <button className={s.modalClose} onClick={() => setViewRecord(null)}>×</button>
                        </div>
                        <div className={s.modalBody}>
                            <div className={s.detailGrid}>
                                {/* Employee Info */}
                                <div><span className={s.detailLabel}>Employee</span><span className={s.detailValue}>{viewRecord.full_employee_name || viewRecord.employee_name}</span></div>
                                <div><span className={s.detailLabel}>Branch</span><span className={s.detailValue}>{viewRecord.branch_name || '-'}</span></div>
                                <div>
                                    <span className={s.detailLabel}>Status</span>
                                    {canManage && viewRecord.status === 'paid' ? (
                                        <button
                                            type="button"
                                            className={`${s.badge} ${badgeClass[viewRecord.status]} ${s.badgeButton}`}
                                            title="Revert to Approved"
                                            aria-label={`Revert payroll for ${viewRecord.full_employee_name || viewRecord.employee_name} to approved`}
                                            onClick={() => void updatePayrollStatus([viewRecord.id], 'paid', 'single', viewRecord.status)}
                                        >
                                            {viewRecord.status}
                                        </button>
                                    ) : (
                                        <span className={`${s.badge} ${badgeClass[viewRecord.status]}`}>{viewRecord.status}</span>
                                    )}
                                </div>
                                <div><span className={s.detailLabel}>Pay Period Start</span><span className={s.detailValue}>{new Date(viewRecord.pay_period_start).toLocaleDateString()}</span></div>
                                <div><span className={s.detailLabel}>Pay Period End</span><span className={s.detailValue}>{new Date(viewRecord.pay_period_end).toLocaleDateString()}</span></div>

                                <hr className={s.detailDivider} />

                                {/* Earnings */}
                                <div><span className={s.detailLabel}>Basic Salary</span><span className={s.detailValue}>{fmt(viewRecord.basic_salary)}</span></div>
                                <div><span className={s.detailLabel}>{`Overtime (${viewRecord.overtime_hours}h × ${PESO_SYMBOL}${Number(viewRecord.overtime_rate).toFixed(2)})`}</span><span className={s.detailValue}>{fmt(viewRecord.overtime_pay)}</span></div>

                                {/* Allowances */}
                                {(Number(viewRecord.clothing_allowance) > 0 || Number(viewRecord.travel_allowance) > 0 || Number(viewRecord.salary_adjustment) !== 0) && (
                                    <>
                                        <hr className={s.detailDivider} />
                                        {Number(viewRecord.clothing_allowance) > 0 && <div><span className={s.detailLabel}>Clothing Allowance</span><span className={s.detailValue}>{fmt(viewRecord.clothing_allowance)}</span></div>}
                                        {Number(viewRecord.travel_allowance) > 0 && <div><span className={s.detailLabel}>Travel Allowance</span><span className={s.detailValue}>{fmt(viewRecord.travel_allowance)}</span></div>}
                                        {Number(viewRecord.salary_adjustment) !== 0 && <div><span className={s.detailLabel}>Salary Adjustment</span><span className={s.detailValue}>{fmt(viewRecord.salary_adjustment)}</span></div>}
                                    </>
                                )}

                                {/* Attendance Deductions */}
                                <>
                                    <hr className={s.detailDivider} />
                                    <div><span className={s.detailLabel}>Late Deduction</span><span className={s.detailValue} style={{ color: '#dc2626' }}>-{fmt(viewRecord.late_deduction)}</span></div>
                                    <div><span className={s.detailLabel}>Absence Deduction</span><span className={s.detailValue} style={{ color: '#dc2626' }}>-{fmt(viewRecord.absence_deduction)}</span></div>
                                    {toNumber(viewRecord.unpaid_leave_days) > 0 && (
                                        <div><span className={s.detailLabel}>Unpaid Leave in Period</span><span className={s.detailValue} style={{ color: '#b45309' }}>{toNumber(viewRecord.unpaid_leave_days)} day(s) ({fmt(viewRecord.unpaid_leave_amount ?? 0)} est.)</span></div>
                                    )}
                                </>

                                <div><span className={s.detailLabel}>Gross (Before Deductions)</span><span className={s.detailValue}>{fmt(viewTotals?.grossBefore ?? 0)}</span></div>
                                <div><span className={s.detailLabel}>Gross (After Attendance)</span><span className={s.detailValue} style={{ color: '#059669', fontWeight: 700 }}>{fmt(viewRecord.gross_pay)}</span></div>

                                <hr className={s.detailDivider} />

                                {/* Government Contributions */}
                                <div><span className={s.detailLabel}>Withholding Tax</span><span className={s.detailValue}>{fmt(viewRecord.tax)}</span></div>
                                <div><span className={s.detailLabel}>SSS</span><span className={s.detailValue}>{fmt(viewRecord.sss_contribution)}</span></div>
                                <div><span className={s.detailLabel}>PhilHealth</span><span className={s.detailValue}>{fmt(viewRecord.philhealth_contribution)}</span></div>
                                <div><span className={s.detailLabel}>Pag-IBIG</span><span className={s.detailValue}>{fmt(viewRecord.pagibig_contribution)}</span></div>

                                {/* Loan Deductions */}
                                <>
                                    {viewCashAdvanceBreakdown.requestCount > 0 && (
                                        <div><span className={s.detailLabel}>{`Approved CA Requests (${viewCashAdvanceBreakdown.requestCount})`}</span><span className={s.detailValue}>{fmt(viewCashAdvanceBreakdown.requestTotal)}</span></div>
                                    )}
                                    {viewCashAdvanceBreakdown.manualTotal > 0 && (
                                        <div><span className={s.detailLabel}>Manual CA Adjustment</span><span className={s.detailValue}>{fmt(viewCashAdvanceBreakdown.manualTotal)}</span></div>
                                    )}
                                    <div><span className={s.detailLabel}>Cash Advance (CA) Total</span><span className={s.detailValue}>{fmt(viewRecord.cash_advance_deduction)}</span></div>
                                    <div><span className={s.detailLabel}>Laptop Loan</span><span className={s.detailValue}>{fmt(viewRecord.laptop_loan_deduction)}</span></div>
                                    <div><span className={s.detailLabel}>Other Deductions</span><span className={s.detailValue}>{fmt(viewRecord.other_deductions)}</span></div>
                                </>

                                <div><span className={s.detailLabel}>Total Deductions (All)</span><span className={s.detailValue} style={{ color: '#dc2626', fontWeight: 700 }}>-{fmt(viewTotals?.totalAll ?? 0)}</span></div>

                                {/* Bonus (separate line) */}
                                {Number(viewRecord.bonus) > 0 && (
                                    <>
                                        <hr className={s.detailDivider} />
                                        <div><span className={s.detailLabel}>Bonus</span><span className={s.detailValue} style={{ color: '#059669', fontWeight: 700 }}>+{fmt(viewRecord.bonus)}</span></div>
                                    </>
                                )}

                                <hr className={s.detailDivider} />

                                {/* Net Pay */}
                                <div style={{ gridColumn: '1 / -1', textAlign: 'center', padding: '8px 0' }}>
                                    <span className={s.detailLabel}>Net Pay</span>
                                    <div style={{ fontSize: 14, fontWeight: 800, color: '#1e3a8a', marginTop: 4 }}>{fmt(viewRecord.net_pay)}</div>
                                </div>

                                {viewRecord.notes && (
                                    <>
                                        <hr className={s.detailDivider} />
                                        <div style={{ gridColumn: '1 / -1' }}>
                                            <span className={s.detailLabel}>Notes</span>
                                            <span className={s.detailValue}>{displayPayrollNotes(viewRecord.notes)}</span>
                                        </div>
                                    </>
                                )}
                            </div>
                        </div>
                        <div className={s.modalFooter}>
                            {canManage && (
                                <>
                                    {viewRecord.status === 'archived' && (
                                        <button
                                            type="button"
                                            className={`${s.btnPrimary} ${viewBusy ? s.isWorking : ''}`}
                                            disabled={viewBusy}
                                            onClick={() => void updatePayrollStatus([viewRecord.id], 'paid', 'single', viewRecord.status)}
                                        >
                                            {viewBusy ? 'Working...' : 'Restore from Archive'}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        className={`${s.btnSecondary} ${viewBusy ? s.isWorking : ''}`}
                                        disabled={viewBusy || viewRecord.status === 'archived'}
                                        onClick={() => void recalcGovernmentDeductions(viewRecord.id)}
                                        title={viewRecord.status === 'archived' ? 'Archived payroll records cannot be modified.' : viewBusy ? 'Working...' : 'Recalculate deductions from settings'}
                                    >
                                        {viewBusy ? 'Working...' : 'Recalculate Gov Deductions'}
                                    </button>
                                </>
                            )}
                            <button className={s.btnSecondary} onClick={() => setViewRecord(null)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* ═══════════════════════ IMPORT MODAL ═══════════════════════ */}
            {showImportModal && (
                <div className={s.overlay} onClick={() => !importLoading && setShowImportModal(false)}>
                    <div className={s.modal} onClick={e => e.stopPropagation()} style={{ maxWidth: 560 }}>
                        <div className={s.modalHeader}>
                            <h2 className={s.modalTitle}>Import Attendance</h2>
                            <button className={s.modalClose} onClick={() => !importLoading && setShowImportModal(false)}>×</button>
                        </div>
                        <div className={s.modalBody}>
                            {/* Success result */}
                            {importResult ? (
                                <div>
                                    <div className={s.importResultCard}>
                                        <div className={s.importResultIcon}>
                                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><polyline points="22 4 12 14.01 9 11.01" /></svg>
                                        </div>
                                        <h3 style={{ margin: '12px 0 4px', color: '#1e293b' }}>Import Complete</h3>
                                        <p style={{ color: '#64748b', fontSize: 13, margin: 0 }}>Batch: {importResult.batch_id}</p>
                                        {importResult.source_system && (
                                            <p style={{ color: '#64748b', fontSize: 13, margin: '4px 0 0' }}>Source: {importResult.source_system}</p>
                                        )}
                                    </div>
                                    <div className={s.importStats}>
                                        {importCards.map((card) => (
                                            <button
                                                key={card.key}
                                                type="button"
                                                className={`${s.importStat} ${s.importStatClickable}`}
                                                style={{ background: card.bg, borderColor: card.border, textAlign: 'center' }}
                                                onClick={() => setImportDetailKey(card.key)}
                                                title={`Show the ${card.count} ${card.label.toLowerCase()} row(s)`}
                                                aria-haspopup="dialog"
                                            >
                                                <span className={s.importStatNumber} style={{ color: card.tone }}>{card.count}</span>
                                                <span className={s.importStatLabel}>{card.label}</span>
                                                <span style={{ display: 'block', fontSize: 10, color: '#94a3b8', marginTop: 4 }}>view details</span>
                                            </button>
                                        ))}
                                    </div>

                                    {importResult.warnings?.length > 0 && (
                                        <div style={{ marginTop: 12 }}>
                                            <h4 style={{ fontSize: 13, color: '#b45309', marginBottom: 6 }}>Warnings:</h4>
                                            <ul style={{ fontSize: 12, color: '#475569', paddingLeft: 18, margin: 0 }}>
                                                {importResult.warnings.map((warning: string, i: number) => <li key={i} style={{ marginBottom: 2 }}>{warning}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                    {importResult.errors?.length > 0 && (
                                        <div style={{ marginTop: 12 }}>
                                            <h4 style={{ fontSize: 13, color: '#dc2626', marginBottom: 6 }}>Errors:</h4>
                                            <ul style={{ fontSize: 12, color: '#475569', paddingLeft: 18, margin: 0 }}>
                                                {importResult.errors.map((err: string, i: number) => <li key={i} style={{ marginBottom: 2 }}>{err}</li>)}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <>
                                    {/* File Dropzone */}
                                    <div
                                        className={`${s.dropzone} upload-hover-glow ${dragOver ? s.dropzoneActive : ''} ${importFile ? s.dropzoneHasFile : ''}`}
                                        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                                        onDragLeave={() => setDragOver(false)}
                                        onDrop={handleFileDrop}
                                        onClick={() => document.getElementById('importFileInput')?.click()}
                                    >
                                        <input id="importFileInput" type="file" accept={IMPORT_FILE_EXT_LIST} onChange={handleFileSelect} style={{ display: 'none' }} />
                                        {importFile ? (
                                            <div style={{ textAlign: 'center', width: '100%', maxWidth: 380 }}>
                                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" /></svg>
                                                <p style={{ margin: '8px 0 2px', fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{importFile.name}</p>
                                                <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>{formatBytes(importFile.size)}</p>
                                                {importPhase === 'uploading' && importProgress && (
                                                    <div style={{ marginTop: 10, textAlign: 'left' }}>
                                                        <UploadProgressBar progress={importProgress} tone="uploading" />
                                                    </div>
                                                )}
                                                {importPhase === 'processing' && (
                                                    <p style={{ margin: '10px 0 0', fontSize: 12, color: '#1d4ed8', fontWeight: 700 }}>Upload complete — processing file…</p>
                                                )}
                                            </div>
                                        ) : (
                                            <div style={{ textAlign: 'center' }}>
                                                <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                                                <p style={{ margin: '10px 0 4px', fontWeight: 600, color: '#475569' }}>Drop your attendance file here</p>
                                                <p style={{ margin: 0, fontSize: 12, color: '#94a3b8' }}>or click to browse — {IMPORT_FILE_EXT_TEXT}</p>
                                            </div>
                                        )}
                                    </div>

                                    {/* Download Template */}
                                    <div style={{ textAlign: 'center', margin: '10px 0 16px' }}>
                                        <button type="button" onClick={downloadTemplate} style={{ background: 'none', border: 'none', color: '#1e3a8a', cursor: 'pointer', fontSize: 13, textDecoration: 'underline', fontWeight: 500 }}>
                                            ↓ Download blank attendance template (.csv)
                                        </button>
                                    </div>

                                    <div className={s.formGroup} style={{ marginBottom: 12 }}>
                                        <label className={s.formLabel}>File Format</label>
                                        <select value={importFileFormat} onChange={e => setImportFileFormat(e.target.value as ImportFileFormat)} required aria-required="true">
                                            {IMPORT_FILE_FORMATS.map((format) => (
                                                <option key={format.value} value={format.value}>{format.label}</option>
                                            ))}
                                        </select>
                                        <p style={{ margin: '6px 0 0', fontSize: 11, color: '#94a3b8' }}>
                                            Auto-set when you choose a file. .dat is imported as the ZKTeco source; spreadsheets as Payroll Excel.
                                        </p>
                                    </div>

                                    {/* Pay Period */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                        <span className={s.formLabel} style={{ marginBottom: 0 }}>Pay Period *</span>
                                        <button type="button" onClick={() => applyImportPeriod(1)} style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>1st Half</button>
                                        <button type="button" onClick={() => applyImportPeriod(2)} style={{ fontSize: 11, padding: '3px 10px', border: '1px solid #d1d5db', borderRadius: 6, background: '#f8fafc', cursor: 'pointer', color: '#475569' }}>2nd Half</button>
                                    </div>
                                    <div className={s.formGrid}>
                                        <div className={s.formGroup}>
                                            <label className={s.formLabel}>Start</label>
                                            <input type="date" value={importPeriodStart} onChange={e => { setImportDateHint(''); setImportPeriodStart(e.target.value); setImportFieldErrors(prev => { if (!prev.start) return prev; const next = { ...prev }; delete next.start; return next; }); }} max={today} required aria-required="true" aria-invalid={importFieldErrors.start ? true : undefined} style={importFieldErrors.start ? { border: '2px solid #ef4444' } : undefined} />
                                            {importFieldErrors.start && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{importFieldErrors.start}</div>}
                                        </div>
                                        <div className={s.formGroup}>
                                            <label className={s.formLabel}>End</label>
                                            <input type="date" value={importPeriodEnd} onChange={e => { setImportDateHint(''); setImportPeriodEnd(e.target.value); setImportFieldErrors(prev => { if (!prev.end) return prev; const next = { ...prev }; delete next.end; return next; }); }} max={today} required aria-required="true" aria-invalid={importFieldErrors.end ? true : undefined} style={importFieldErrors.end ? { border: '2px solid #ef4444' } : undefined} />
                                            {importFieldErrors.end && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{importFieldErrors.end}</div>}
                                        </div>
                                    </div>
                                    {importDateHint && (
                                        <div style={{ marginTop: 8, fontSize: 12, color: '#1e40af' }}>{importDateHint}</div>
                                    )}

                                    {/* Info box */}
                                    <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8, padding: '12px 14px', marginTop: 12, fontSize: 12, color: '#1e40af' }}>
                                        <strong>How it works:</strong> Upload your attendance {IMPORT_FILE_EXT_TEXT} file (ZKTeco export or manual). The system will match each EmployeeID, then auto-calculate basic salary, OT (DOLE 1.25×), late &amp; absence deductions, and generate <strong>draft</strong> payroll records for you to review and approve.
                                    </div>
                                    {importError && (
                                        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', marginTop: 12, fontSize: 12, color: '#b91c1c' }}>
                                            {importError}
                                            {importSessionRef.current.uploadId && (
                                                <span style={{ display: 'block', marginTop: 4, color: '#64748b' }}>Your uploaded bytes are kept — Retry continues from where it stopped, no re-upload.</span>
                                            )}
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                        <div className={s.modalFooter}>
                            {importResult ? (
                                <button className={s.btnPrimary} onClick={() => { resetImportSession(true); setShowImportModal(false); }}>Done</button>
                            ) : (
                                <>
                                    <button className={s.btnSecondary} onClick={() => { resetImportSession(true); setShowImportModal(false); }} disabled={importLoading}>Cancel</button>
                                    {importError && importSessionRef.current.uploadId && !importLoading ? (
                                        <button className={s.btnPrimary} onClick={handleImport} disabled={!importFile}>
                                            ↻ Retry Upload — Continue
                                        </button>
                                    ) : (
                                        <button className={s.btnPrimary} onClick={handleImport} disabled={importLoading || !importFile}>
                                            {importLoading
                                                ? (importPhase === 'processing'
                                                    ? 'Processing…'
                                                    : (importProgress ? `Uploading… ${importProgress.percent}%` : 'Importing…'))
                                                : 'Generate Payroll'}
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* Floating detail panel for the import result cards */}
            {activeImportCard && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label={`${activeImportCard.label} details`}
                    style={{ position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.45)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100, padding: 16 }}
                    onClick={() => setImportDetailKey(null)}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ background: '#fff', borderRadius: 12, width: 560, maxWidth: '94vw', maxHeight: '78vh', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 50px rgba(15, 23, 42, 0.35)' }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 16px', borderBottom: '1px solid #e2e8f0' }}>
                            <div>
                                <div style={{ fontSize: 15, fontWeight: 800, color: activeImportCard.tone }}>{activeImportCard.label}</div>
                                <div style={{ fontSize: 12, color: '#64748b' }}>
                                    {activeImportCard.count} item{activeImportCard.count === 1 ? '' : 's'} · batch {importResult?.batch_id}
                                </div>
                            </div>
                            <button type="button" className={s.modalClose} onClick={() => setImportDetailKey(null)} aria-label="Close details">×</button>
                        </div>
                        <div style={{ overflowY: 'auto', padding: '4px 16px 16px' }}>
                            {activeImportCard.items.length === 0 ? (
                                <p style={{ fontSize: 12, color: '#64748b', margin: '14px 0' }}>Nothing in this bucket.</p>
                            ) : (
                                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                                    {activeImportCard.items.map((item, index) => (
                                        <li key={index} style={{ borderBottom: '1px solid #f1f5f9', padding: '10px 0' }}>
                                            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>
                                                    {item.name || (item.row ? `Row ${item.row}` : `Item ${index + 1}`)}
                                                </span>
                                                {item.code ? <span style={{ fontSize: 11, color: '#64748b' }}>ID {item.code}</span> : null}
                                                {item.row && item.name ? <span style={{ fontSize: 11, color: '#94a3b8' }}>row {item.row}</span> : null}
                                                {item.payroll_id ? <span style={{ fontSize: 11, color: '#94a3b8' }}>payroll #{item.payroll_id}</span> : null}
                                            </div>
                                            {item.detail ? <div style={{ fontSize: 12, color: '#475569', marginTop: 2 }}>{item.detail}</div> : null}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                        <div style={{ padding: '0 16px 16px' }}>
                            <button type="button" className={s.btnSecondary} onClick={() => setImportDetailKey(null)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

        </Layout>
    );
}
