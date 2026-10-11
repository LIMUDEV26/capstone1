import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import PhoneInput from '@/components/PhoneInput';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getBackendBaseUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import {
    DEFAULT_PHONE_COUNTRY_CODE,
    formatPhoneDisplay,
    getPhoneInputDefault,
    isPhoneDraftEmpty,
    normalizeInternationalPhoneNumber,
    sanitizeInternationalPhoneDraft,
} from '@/utils/phone';
import { formatGovNumber } from '@/utils/govNumber';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API_BASE_URL = getBackendBaseUrl();

type Branch = {
    branch_id: number;
    branch_name: string;
    status?: string;
};

type UserLinkOption = {
    id: number;
    username: string;
    first_name: string;
    last_name: string;
    role?: string;
    status?: string;
    employee_id?: number | string | null;
};

type EmployeeStatus = 'active' | 'inactive' | 'on_leave' | 'terminated';
const GOV_NUMBER_FIELDS = ['sss_number', 'pagibig_number', 'philhealth_number', 'tin_number'] as const;
type GovNumberField = (typeof GOV_NUMBER_FIELDS)[number];
const GOV_NUMBER_LABELS: Record<GovNumberField, string> = {
    sss_number: 'SSS Number',
    pagibig_number: 'Pag-IBIG Number',
    philhealth_number: 'PhilHealth Number',
    tin_number: 'TIN Number',
};
const GOV_NUMBER_PLACEHOLDERS: Record<GovNumberField, string> = {
    sss_number: 'e.g. 12-3456789-0',
    pagibig_number: 'e.g. 1234-5678-9012',
    philhealth_number: 'e.g. 12-345678901-2',
    tin_number: 'e.g. 123-456-789-000',
};
const normalizeGovernmentNumberForComparison = (value: unknown) =>
    String(value || '').trim().replace(/[^A-Za-z0-9\-]/g, '');
const getDuplicateGovernmentNumberMessage = (values: Partial<Record<GovNumberField, unknown>>) => {
    const seen = new Map<string, GovNumberField>();
    for (const field of GOV_NUMBER_FIELDS) {
        const normalized = normalizeGovernmentNumberForComparison(values[field]);
        if (!normalized) continue;

        const existingField = seen.get(normalized);
        if (existingField) {
            return `${GOV_NUMBER_LABELS[field]} must not be the same as ${GOV_NUMBER_LABELS[existingField]}.`;
        }

        seen.set(normalized, field);
    }

    return '';
};

type EmployeeDocumentField =
    | 'document_resume'
    | 'document_nbi_clearance'
    | 'document_police_clearance'
    | 'document_barangay_clearance'
    | 'document_birth_certificate'
    | 'document_medical_certificate'
    | 'document_diploma_tor'
    | 'document_employment_contract';

type EmployeeDocumentItem = {
    field: EmployeeDocumentField;
    label: string;
};

type EmployeeRow = {
    employee_id: number;
    employee_date_id?: string | null;
    first_name: string;
    last_name: string;
    date_of_birth?: string | null;
    email?: string | null;
    phone_number?: string | null;
    address?: string | null;
    position?: string | null;
    department?: string | null;
    employment_type?: string | null;
    sss_number?: string | null;
    pagibig_number?: string | null;
    philhealth_number?: string | null;
    tin_number?: string | null;
    document_resume?: number | string | boolean | null;
    document_nbi_clearance?: number | string | boolean | null;
    document_police_clearance?: number | string | boolean | null;
    document_barangay_clearance?: number | string | boolean | null;
    document_birth_certificate?: number | string | boolean | null;
    document_medical_certificate?: number | string | boolean | null;
    document_diploma_tor?: number | string | boolean | null;
    document_employment_contract?: number | string | boolean | null;
    hire_date?: string | null;
    salary?: number | string | null;
    status?: EmployeeStatus | string;
    branch_id?: number | string | null;
    branch_name?: string | null;
    roles?: string | null;
    role_ids?: number[];
    linked_user_id?: number | null;
    linked_username?: string | null;
    linked_user_role?: string | null;
    linked_user_status?: string | null;
    is_admin_user?: boolean;
};

type EmployeeForm = {
    first_name: string;
    last_name: string;
    date_of_birth: string;
    email: string;
    phone_number: string;
    address: string;
    position: string;
    employment_type: string;
    sss_number: string;
    pagibig_number: string;
    philhealth_number: string;
    tin_number: string;
    document_resume: boolean;
    document_nbi_clearance: boolean;
    document_police_clearance: boolean;
    document_barangay_clearance: boolean;
    document_birth_certificate: boolean;
    document_medical_certificate: boolean;
    document_diploma_tor: boolean;
    document_employment_contract: boolean;
    hire_date: string;
    salary: string;
    status: EmployeeStatus;
    branch_id: string;
    linked_user_id: string;
};

const createInitialGovNumberEnabled = (): Record<GovNumberField, boolean> => ({
    sss_number: false,
    pagibig_number: false,
    philhealth_number: false,
    tin_number: false,
});

const MINIMUM_EMPLOYEE_AGE = 18;

const parseIsoDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
    return parsed;
};

const getLatestAllowedBirthDate = () => {
    const t = new Date();
    return new Date(t.getFullYear() - MINIMUM_EMPLOYEE_AGE, t.getMonth(), t.getDate());
};

const formatDateForInput = (value: Date) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const MAX_BIRTHDATE = formatDateForInput(getLatestAllowedBirthDate());

const isAtLeastMinimumAge = (value: string) => {
    const birthDate = parseIsoDate(value);
    if (!birthDate) return false;
    return birthDate <= getLatestAllowedBirthDate();
};

const computeAge = (value: string): number | null => {
    const birthDate = parseIsoDate(value);
    if (!birthDate) return null;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
};

const today = () => new Date().toISOString().slice(0, 10);
const initialForm = (): EmployeeForm => ({
    first_name: '',
    last_name: '',
    date_of_birth: '',
    email: '',
    phone_number: DEFAULT_PHONE_COUNTRY_CODE,
    address: '',
    position: '',
    employment_type: 'Full-Time',
    sss_number: '',
    pagibig_number: '',
    philhealth_number: '',
    tin_number: '',
    document_resume: false,
    document_nbi_clearance: false,
    document_police_clearance: false,
    document_barangay_clearance: false,
    document_birth_certificate: false,
    document_medical_certificate: false,
    document_diploma_tor: false,
    document_employment_contract: false,
    hire_date: today(),
    salary: '0',
    status: 'active',
    branch_id: '',
    linked_user_id: '',
});

const POSITION_OPTIONS = [
    'Accountant',
    'HR Officer',
    'Payroll Specialist',
    'Supervisor',
    'Manager',
    'Staff',
];

const EMPLOYMENT_TYPE_OPTIONS = [
    'Full-Time',
    'Part-Time',
    'Contract',
    'Probationary',
    'Regular',
];

const DOCUMENT_CHECKLIST_ITEMS: EmployeeDocumentItem[] = [
    { field: 'document_resume', label: 'Resume / CV' },
    { field: 'document_nbi_clearance', label: 'NBI Clearance' },
    { field: 'document_police_clearance', label: 'Police Clearance' },
    { field: 'document_barangay_clearance', label: 'Barangay Clearance' },
    { field: 'document_birth_certificate', label: 'Birth Certificate' },
    { field: 'document_medical_certificate', label: 'Medical Certificate' },
    { field: 'document_diploma_tor', label: 'Diploma / TOR' },
    { field: 'document_employment_contract', label: 'Signed Employment Contract' },
];

const toNumber = (value: unknown, fallback = 0) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const toChecked = (value: unknown) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value > 0;
    const normalized = String(value ?? '').trim().toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(normalized);
};

const getPayrollReadinessMissingItems = (employee: EmployeeRow) => {
    const missing: string[] = [];
    const requiredProfileFields: Array<[keyof EmployeeRow, string]> = [
        ['email', 'Email'],
        ['address', 'Address'],
        ['date_of_birth', 'Birthdate'],
        ['sss_number', 'SSS Number'],
        ['pagibig_number', 'Pag-IBIG Number'],
        ['philhealth_number', 'PhilHealth Number'],
        ['tin_number', 'TIN Number'],
    ];
    requiredProfileFields.forEach(([field, label]) => {
        if (!String(employee[field] || '').trim()) missing.push(label);
    });
    DOCUMENT_CHECKLIST_ITEMS.forEach((item) => {
        if (!toChecked(employee[item.field])) missing.push(item.label);
    });
    return missing;
};

const money = (value: unknown) =>
    `PHP ${toNumber(value, 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isProtectedEmployeeRow = (row?: EmployeeRow | null) => {
    if (!row) return false;
    if (row.is_admin_user) return true;
    const linkedRole = String(row.linked_user_role || '').toLowerCase();
    if (linkedRole === 'admin') return true;
    const roleLabels = String(row.roles || '').toLowerCase();
    if (roleLabels.includes('admin')) return true;
    const position = String(row.position || '').toLowerCase();
    return position === 'administrator';
};

export default function EmployeesPage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const { user, loading: authLoading, logout } = useProtectedPage({
        allowedRoles: ['admin', 'manager'],
        unauthorizedRedirect: '/403',
    });

    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<EmployeeRow[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [usersForLink, setUsersForLink] = useState<UserLinkOption[]>([]);

    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState<'all' | EmployeeStatus>('all');
    const [branchFilter, setBranchFilter] = useState('all');
    const [positionFilter, setPositionFilter] = useState('all');
    const [employmentTypeFilter, setEmploymentTypeFilter] = useState('all');
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [page, setPage] = useState(1);

    const [formOpen, setFormOpen] = useState(false);
    const [viewOpen, setViewOpen] = useState(false);
    const [editing, setEditing] = useState<EmployeeRow | null>(null);
    const [viewRow, setViewRow] = useState<EmployeeRow | null>(null);
    const [form, setForm] = useState<EmployeeForm>(initialForm());
    const [linkUserEnabled, setLinkUserEnabled] = useState(false);
    const [govNumberEnabled, setGovNumberEnabled] = useState<Record<GovNumberField, boolean>>(createInitialGovNumberEnabled());

    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    // Inline per-field "Required" messages for the Add/Edit Employee form.
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const clearFieldError = (name: string) => {
        setFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    const role = String(user?.role || '').toLowerCase();
    const isAdmin = role === 'admin';
    const isManager = role === 'manager';

    // Live-sync: silently refresh employees in background.
    const silentRefreshEmployees = useCallback(async () => {
        if (!user?.role) return;
        const nextRole = String(user.role || '').toLowerCase();
        await Promise.all([
            fetchEmployees(),
            fetchBranches(),
            nextRole === 'admin' ? fetchUsersForLink() : Promise.resolve(),
        ]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.role]);

    useLiveSync(silentRefreshEmployees);

    useEffect(() => {
        const nextRole = String(user?.role || '').toLowerCase();
        if (!nextRole) {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }

        let active = true;

        const loadEmployeesPage = async () => {
            setLoading(true);
            try {
                await Promise.all([
                    fetchEmployees(),
                    fetchBranches(),
                    nextRole === 'admin' ? fetchUsersForLink() : Promise.resolve(),
                ]);
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        void loadEmployeesPage();

        return () => {
            active = false;
        };
    }, [authLoading, user?.role]);

    useEffect(() => {
        setPage(1);
    }, [search, statusFilter, branchFilter, positionFilter, employmentTypeFilter, showArchiveView]);

    const fetchEmployees = async () => {
        const res = await fetch(`${API_BASE_URL}/api/employees.php`, { credentials: 'include' });
        const data = await res.json();
        if (data.success) setRows((data.data || []) as EmployeeRow[]);
    };

    const fetchBranches = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/branches.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setBranches((data.data || []) as Branch[]);
        } catch {
            // Keep page functional without branch options.
        }
    };

    const fetchUsersForLink = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setUsersForLink((data.data || []) as UserLinkOption[]);
        } catch {
            // Keep employee form usable even if user list fails.
        }
    };

    const rowsWithAdmins = useMemo(() => {
        const baseRows = rows || [];
        if (!usersForLink || usersForLink.length === 0) return baseRows;

        const existingEmployeeIds = new Set(
            baseRows
                .map((row) => Number(row.employee_id || 0))
                .filter((id) => id > 0)
        );

        const adminRows: EmployeeRow[] = usersForLink
            .filter((u) => String(u.role || '').toLowerCase() === 'admin')
            .filter((u) => {
                const linkedEmployeeId = Number(u.employee_id || 0);
                return linkedEmployeeId <= 0 || !existingEmployeeIds.has(linkedEmployeeId);
            })
            .map((u) => ({
                employee_id: -Number(u.id || 0),
                first_name: u.first_name || 'Admin',
                last_name: u.last_name || '',
                email: u.username || '',
                position: 'Administrator',
                employment_type: 'System',
                salary: 0,
                status: u.status || 'active',
                branch_id: null,
                branch_name: null,
                linked_user_id: Number(u.id || 0) || null,
                linked_username: u.username || null,
                linked_user_role: u.role || 'admin',
                linked_user_status: u.status || 'active',
                is_admin_user: true,
            }));

        return adminRows.length > 0 ? [...baseRows, ...adminRows] : baseRows;
    }, [rows, usersForLink]);

    const archivedRows = useMemo(
        () => rowsWithAdmins.filter((row) => String(row.status || '').toLowerCase() === 'inactive'),
        [rowsWithAdmins]
    );
    const activeRows = useMemo(
        () => rowsWithAdmins.filter((row) => String(row.status || '').toLowerCase() !== 'inactive'),
        [rowsWithAdmins]
    );

    const positionOptions = useMemo(() => {
        const values = new Map<string, string>();
        rows.forEach((row) => {
            const label = String(row.position || '').trim();
            if (!label) return;
            const key = label.toLowerCase();
            if (!values.has(key)) values.set(key, label);
        });
        return Array.from(values.entries())
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([value, label]) => ({ value, label }));
    }, [rows]);

    const employmentTypeOptions = useMemo(() => {
        const values = new Map<string, string>();
        rows.forEach((row) => {
            const label = String(row.employment_type || '').trim();
            if (!label) return;
            const key = label.toLowerCase();
            if (!values.has(key)) values.set(key, label);
        });
        return Array.from(values.entries())
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([value, label]) => ({ value, label }));
    }, [rows]);

    useEffect(() => {
        if (positionFilter !== 'all' && !positionOptions.some((opt) => opt.value === positionFilter)) {
            setPositionFilter('all');
        }
    }, [positionFilter, positionOptions]);

    useEffect(() => {
        if (employmentTypeFilter !== 'all' && !employmentTypeOptions.some((opt) => opt.value === employmentTypeFilter)) {
            setEmploymentTypeFilter('all');
        }
    }, [employmentTypeFilter, employmentTypeOptions]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    useEffect(() => {
        if (!success) return;
        void notifySuccess(success);
        setSuccess('');
    }, [success]);

    const filtered = useMemo(() => {
        const term = search.trim().toLowerCase();
        const sourceRows = showArchiveView ? archivedRows : activeRows;
        return sourceRows.filter((row) => {
            const byStatus = showArchiveView || statusFilter === 'all' || String(row.status || '').toLowerCase() === statusFilter;
            const byBranch = branchFilter === 'all' || String(row.branch_id || '') === branchFilter;
            const byPosition = positionFilter === 'all' || String(row.position || '').trim().toLowerCase() === positionFilter;
            const byEmploymentType = employmentTypeFilter === 'all' || String(row.employment_type || '').trim().toLowerCase() === employmentTypeFilter;
            const haystack = [
                row.first_name,
                row.last_name,
                row.email,
                row.position,
                row.branch_name,
                row.linked_username,
            ]
                .map((v) => String(v || '').toLowerCase())
                .join(' ');
            const bySearch = !term || haystack.includes(term);
            return byStatus && byBranch && byPosition && byEmploymentType && bySearch;
        });
    }, [activeRows, archivedRows, showArchiveView, search, statusFilter, branchFilter, positionFilter, employmentTypeFilter]);

    const paged = useMemo(() => {
        const start = (page - 1) * ITEMS_PER_PAGE;
        return filtered.slice(start, start + ITEMS_PER_PAGE);
    }, [filtered, page]);

    const employeeSearchCorpus = useMemo(() => collectSearchTerms(rows, [
        (row: any) => `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        (row: any) => row.email,
        (row: any) => row.position,
        (row: any) => row.branch_name,
        (row: any) => row.linked_username,
    ]), [rows]);

    useEffect(() => {
        const maxPage = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
        if (page > maxPage) setPage(maxPage);
    }, [filtered.length, page]);

    const openAdd = () => {
        setEditing(null);
        setForm(initialForm());
        setLinkUserEnabled(false);
        setGovNumberEnabled(createInitialGovNumberEnabled());
        setError('');
        setFieldErrors({});
        setFormOpen(true);
    };

    const openEdit = (row: EmployeeRow) => {
        setEditing(row);
        setForm({
            first_name: row.first_name || '',
            last_name: row.last_name || '',
            date_of_birth: row.date_of_birth || '',
            email: row.email || '',
            phone_number: getPhoneInputDefault(row.phone_number),
            address: row.address || '',
            position: row.position || '',
            employment_type: row.employment_type || 'Full-Time',
            sss_number: row.sss_number || '',
            pagibig_number: row.pagibig_number || '',
            philhealth_number: row.philhealth_number || '',
            tin_number: row.tin_number || '',
            document_resume: toChecked(row.document_resume),
            document_nbi_clearance: toChecked(row.document_nbi_clearance),
            document_police_clearance: toChecked(row.document_police_clearance),
            document_barangay_clearance: toChecked(row.document_barangay_clearance),
            document_birth_certificate: toChecked(row.document_birth_certificate),
            document_medical_certificate: toChecked(row.document_medical_certificate),
            document_diploma_tor: toChecked(row.document_diploma_tor),
            document_employment_contract: toChecked(row.document_employment_contract),
            hire_date: row.hire_date || today(),
            salary: String(row.salary ?? '0'),
            status: (row.status as EmployeeStatus) || 'active',
            branch_id: row.branch_id ? String(row.branch_id) : '',
            linked_user_id: row.linked_user_id ? String(row.linked_user_id) : '',
        });
        setGovNumberEnabled({
            sss_number: !!String(row.sss_number || '').trim(),
            pagibig_number: !!String(row.pagibig_number || '').trim(),
            philhealth_number: !!String(row.philhealth_number || '').trim(),
            tin_number: !!String(row.tin_number || '').trim(),
        });
        setLinkUserEnabled(!!row.linked_user_id);
        setError('');
        setFieldErrors({});
        setFormOpen(true);
    };

    const submit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        // Required-field check: every required input gets an inline "Required" message.
        const missing: Record<string, string> = {};
        const first = form.first_name.trim();
        const last = form.last_name.trim();
        if (!first) missing.first_name = 'Required.';
        if (!last) missing.last_name = 'Required.';
        if (!form.email.trim()) missing.email = 'Required.';
        if (isPhoneDraftEmpty(form.phone_number, DEFAULT_PHONE_COUNTRY_CODE)) missing.phone_number = 'Required.';
        if (!form.date_of_birth.trim()) missing.date_of_birth = 'Required.';
        if (!form.hire_date.trim()) missing.hire_date = 'Required.';
        if (!form.position.trim()) missing.position = 'Required.';
        if (String(form.salary ?? '').trim() === '') missing.salary = 'Required.';
        (Object.keys(govNumberEnabled) as GovNumberField[]).forEach((field) => {
            if (govNumberEnabled[field] && !String(form[field] || '').trim()) missing[field] = 'Required.';
        });
        if (Object.keys(missing).length > 0) {
            setFieldErrors(missing);
            return;
        }
        setFieldErrors({});

        const salary = toNumber(form.salary, 0);
        if (salary < 0) {
            setError('Salary cannot be negative.');
            return;
        }

        const normalizedPhoneNumber = normalizeInternationalPhoneNumber(form.phone_number, DEFAULT_PHONE_COUNTRY_CODE);
        if (!isPhoneDraftEmpty(form.phone_number, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedPhoneNumber) {
            setError('Phone number must be a valid international number with a country code, like +63985 323 4710.');
            return;
        }

        const normalizedDob = form.date_of_birth.trim();
        if (normalizedDob && !isAtLeastMinimumAge(normalizedDob)) {
            setError(`Employee must be at least ${MINIMUM_EMPLOYEE_AGE} years old.`);
            return;
        }

        const payload: Record<string, unknown> = {
            first_name: first,
            last_name: last,
            date_of_birth: form.date_of_birth || null,
            email: form.email.trim() || null,
            phone_number: normalizedPhoneNumber || null,
            address: form.address.trim() || null,
            position: form.position.trim() || null,
            employment_type: form.employment_type.trim() || 'Full-Time',
            sss_number: govNumberEnabled.sss_number ? (form.sss_number.trim() || null) : null,
            pagibig_number: govNumberEnabled.pagibig_number ? (form.pagibig_number.trim() || null) : null,
            philhealth_number: govNumberEnabled.philhealth_number ? (form.philhealth_number.trim() || null) : null,
            tin_number: govNumberEnabled.tin_number ? (form.tin_number.trim() || null) : null,
            document_resume: form.document_resume ? 1 : 0,
            document_nbi_clearance: form.document_nbi_clearance ? 1 : 0,
            document_police_clearance: form.document_police_clearance ? 1 : 0,
            document_barangay_clearance: form.document_barangay_clearance ? 1 : 0,
            document_birth_certificate: form.document_birth_certificate ? 1 : 0,
            document_medical_certificate: form.document_medical_certificate ? 1 : 0,
            document_diploma_tor: form.document_diploma_tor ? 1 : 0,
            document_employment_contract: form.document_employment_contract ? 1 : 0,
            hire_date: form.hire_date || null,
            salary,
            status: editing ? form.status : 'active',
            branch_id: form.branch_id ? Number(form.branch_id) : null,
        };
        const duplicateGovernmentNumberMessage = getDuplicateGovernmentNumberMessage({
            sss_number: payload.sss_number,
            pagibig_number: payload.pagibig_number,
            philhealth_number: payload.philhealth_number,
            tin_number: payload.tin_number,
        });
        if (duplicateGovernmentNumberMessage) {
            setError(duplicateGovernmentNumberMessage);
            return;
        }
        if (isAdmin) {
            payload.linked_user_id = linkUserEnabled && form.linked_user_id ? Number(form.linked_user_id) : null;
        }
        if (editing) payload.employee_id = editing.employee_id;

        try {
            const res = await fetch(`${API_BASE_URL}/api/employees.php`, {
                method: editing ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to save employee.');
                return;
            }
            setFormOpen(false);
            setEditing(null);
            setForm(initialForm());
            setLinkUserEnabled(false);
            setGovNumberEnabled(createInitialGovNumberEnabled());
            setFieldErrors({});
            setSuccess(data.message || 'Employee saved.');

            if (editing) {
                // Optimistic update for PUT: merge response with existing row
                setRows((prev) =>
                    (prev || []).map((row) =>
                        row.employee_id === editing.employee_id
                            ? { ...row, ...payload, employee_id: editing.employee_id }
                            : row
                    )
                );
            } else {
                // Optimistic insert for POST: prepend new employee
                const newEmployee: EmployeeRow = {
                    employee_id: data.data?.employee_id ?? 0,
                    employee_date_id: data.data?.employee_date_id ?? '',
                    first_name: payload.first_name as string,
                    last_name: payload.last_name as string,
                    date_of_birth: payload.date_of_birth as string | null,
                    email: payload.email as string | null,
                    phone_number: payload.phone_number as string | null,
                    address: payload.address as string | null,
                    position: payload.position as string | null,
                    department: payload.department as string | null,
                    employment_type: payload.employment_type as string | null,
                    sss_number: payload.sss_number as string | null,
                    pagibig_number: payload.pagibig_number as string | null,
                    philhealth_number: payload.philhealth_number as string | null,
                    tin_number: payload.tin_number as string | null,
                    document_resume: payload.document_resume as number,
                    document_nbi_clearance: payload.document_nbi_clearance as number,
                    document_police_clearance: payload.document_police_clearance as number,
                    document_barangay_clearance: payload.document_barangay_clearance as number,
                    document_birth_certificate: payload.document_birth_certificate as number,
                    document_medical_certificate: payload.document_medical_certificate as number,
                    document_diploma_tor: payload.document_diploma_tor as number,
                    document_employment_contract: payload.document_employment_contract as number,
                    hire_date: payload.hire_date as string | null,
                    salary: payload.salary as number,
                    status: payload.status as EmployeeStatus,
                    branch_id: payload.branch_id as number | null,
                    linked_user_id: data.data?.linked_user_id ?? null,
                    roles: '',
                    role_ids: [],
                };
                setRows((prev) => [newEmployee, ...(prev || [])]);
            }

            if (isAdmin) {
                void fetchUsersForLink();
            }
        } catch {
            setError('Network error while saving employee.');
        }
    };

    const archiveEmployee = async (row: EmployeeRow) => {
        const ok = await confirmAction({
            title: 'Archive employee?',
            text: `Move ${row.first_name} ${row.last_name} to archived employees.`,
            confirmButtonText: 'Archive',
            icon: 'warning',
            danger: true,
        });
        if (!ok) return;

        try {
            const res = await fetch(`${API_BASE_URL}/api/employees.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    employee_id: row.employee_id,
                    status: 'inactive',
                }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to archive employee.');
                return;
            }
            setSuccess(data.message || 'Employee archived.');
            setRows((prev) =>
                (prev || []).map((r) =>
                    r.employee_id === row.employee_id ? { ...r, status: 'inactive' as EmployeeStatus } : r
                )
            );
        } catch {
            setError('Network error while archiving employee.');
        }
    };

    const restoreEmployee = async (row: EmployeeRow) => {
        const label = `${row.first_name} ${row.last_name}`.trim() || 'this employee';
        const ok = await confirmAction({
            title: `Restore ${label}?`,
            text: 'This employee will be returned to active employees.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!ok) return;
        try {
            const res = await fetch(`${API_BASE_URL}/api/employees.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    employee_id: row.employee_id,
                    status: 'active',
                }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to restore employee.');
                return;
            }
            setSuccess(data.message || 'Employee restored.');
            setRows((prev) =>
                (prev || []).map((r) =>
                    r.employee_id === row.employee_id ? { ...r, status: 'active' as EmployeeStatus } : r
                )
            );
        } catch {
            setError('Network error while restoring employee.');
        }
    };

    const archiveAllEmployees = async () => {
        if (activeRows.length === 0) return;
        const ok = await confirmAction({
            title: 'Archive all employees?',
            text: `This will archive ${activeRows.length} employee(s). This action cannot be undone.`,
            confirmButtonText: 'Archive All',
            icon: 'warning',
            danger: true,
        });
        if (!ok) return;

        try {
            const results = await Promise.all(
                activeRows.map((row) =>
                    fetch(`${API_BASE_URL}/api/employees.php`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            employee_id: row.employee_id,
                            status: 'inactive',
                        }),
                    }).then((res) => res.json())
                )
            );

            const failed = results.filter((r) => !r?.success).length;
            if (failed > 0) {
                setError(`${failed} employee(s) could not be archived.`);
            } else {
                setSuccess('All employees archived successfully.');
            }
            setRows((prev) =>
                (prev || []).map((r) =>
                    activeRows.some((a) => a.employee_id === r.employee_id)
                        ? { ...r, status: 'inactive' as EmployeeStatus }
                        : r
                )
            );
        } catch {
            setError('Network error while archiving employees.');
        }
    };

    const restoreAllArchived = async () => {
        if (archivedRows.length === 0) return;
        const ok = await confirmAction({
            title: 'Restore all archived employees?',
            text: `Restore ${archivedRows.length} archived employee(s) to active.`,
            confirmButtonText: 'Restore All',
            icon: 'question',
        });
        if (!ok) return;

        try {
            const results = await Promise.all(
                archivedRows.map((row) =>
                    fetch(`${API_BASE_URL}/api/employees.php`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            employee_id: row.employee_id,
                            status: 'active',
                        }),
                    }).then((res) => res.json())
                )
            );

            const failed = results.filter((r) => !r?.success).length;
            if (failed > 0) {
                setError(`${failed} employee(s) could not be restored.`);
            } else {
                setSuccess('All archived employees restored.');
            }
            await fetchEmployees();
        } catch {
            setError('Network error while restoring archived employees.');
        }
    };

    const handleGovNumberToggle = (field: GovNumberField, checked: boolean) => {
        setGovNumberEnabled((prev) => ({ ...prev, [field]: checked }));
        if (!checked) {
            setForm((prev) => ({ ...prev, [field]: '' }));
        }
        clearFieldError(field);
    };

    const linkableUsers = useMemo(() => {
        const selectedUserId = Number(form.linked_user_id || 0);
        return usersForLink
            .filter((u) => {
                const roleName = String(u.role || '').toLowerCase();
                if (roleName === 'admin') return false;
                const userStatus = String(u.status || '').toLowerCase();
                if (userStatus === 'inactive') return false;

                const linkedEmployeeId = Number(u.employee_id || 0);
                const userId = Number(u.id || 0);
                const isSelected = selectedUserId > 0 && userId === selectedUserId;
                const isUnlinked = linkedEmployeeId <= 0;
                const isLinkedToCurrentEmployee = editing ? linkedEmployeeId === editing.employee_id : false;
                return isUnlinked || isSelected || isLinkedToCurrentEmployee;
            })
            .sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`));
    }, [usersForLink, form.linked_user_id, editing]);

    if (authLoading || loading) {

      return (

        <Layout role={role} user={user} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={role} user={user} onLogout={logout}>
            <Head>
                <title>{showArchiveView ? 'Archived Employees' : 'Employees'}</title>
            </Head>

            <div style={{ maxWidth: 1400, margin: '0 auto', padding: 20 }}>
                <div className="pageHeaderInline" style={{ marginBottom: 14 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', width: '100%' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                <h1 style={{ margin: 0, color: '#0f172a' }}>{showArchiveView ? 'Archived Employees' : 'Employees'}</h1>
                                <button
                                    onClick={() => setShowArchiveView((prev) => !prev)}
                                    title={showArchiveView ? 'Back to Active Employees' : 'View Archived Employees'}
                                    style={{
                                        ...btnNeutral,
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        borderColor: showArchiveView ? '#bfdbfe' : '#cbd5e1',
                                        background: showArchiveView ? '#eff6ff' : '#fff',
                                        color: showArchiveView ? '#1d4ed8' : '#334155',
                                    }}
                                >
                                    <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                        <polyline points='21 8 21 21 3 21 3 8'></polyline>
                                        <rect x='1' y='3' width='22' height='5'></rect>
                                        <line x1='10' y1='12' x2='14' y2='12'></line>
                                    </svg>
                                    {showArchiveView ? 'Back to Active' : `Archive (${archivedRows.length})`}
                                </button>
                            </div>
                         <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>Integrated with payroll, leave, attendance, and linked user accounts.</p>
                         </div>
                     </div>
                     <div style={{ marginBottom: 14 }}>
                         <h2 style={{ margin: '0 0 12px 0', fontSize: 14, color: '#1f2937', fontWeight: 700 }}>Employees</h2>
                         <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px, 2fr) repeat(4, minmax(100px, 1fr))', gap: 12, alignItems: 'flex-end', background: '#fff', padding: '14px 16px', borderRadius: 12, border: '1px solid #e2e8f0' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                  <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                      Search Employee
                                  </label>
                                  <SearchBar
                                      storageKey="employees:list"
                                      placeholder='Search employee'
                                      ariaLabel='Search employee'
                                      value={search}
                                      onChange={setSearch}
                                      suggestions={employeeSearchCorpus}
                                      inputStyle={{ ...input, minWidth: 0, width: '100%' }}
                                  />
                              </div>
                             {!showArchiveView && (
                                 <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                     <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</label>
                                     <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as 'all' | EmployeeStatus)} style={{ ...input, minWidth: 0 }}>
                                         <option value='all'>All Statuses</option>
                                         <option value='active'>Active</option>
                                         <option value='on_leave'>On Leave</option>
                                     </select>
                                 </div>
                             )}
                             <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                 <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Branch</label>
                                 <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} style={{ ...input, minWidth: 0 }}>
                                     <option value='all'>All Branches</option>
                                     {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
                                 </select>
                             </div>
                             <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                 <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Position</label>
                                 <select value={positionFilter} onChange={(e) => setPositionFilter(e.target.value)} style={{ ...input, minWidth: 0 }}>
                                     <option value='all'>All Positions</option>
                                     {positionOptions.map((option) => (
                                         <option key={option.value} value={option.value}>{option.label}</option>
                                     ))}
                                 </select>
                             </div>
                             <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                                 <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Employment Type</label>
                                 <select value={employmentTypeFilter} onChange={(e) => setEmploymentTypeFilter(e.target.value)} style={{ ...input, minWidth: 0 }}>
                                     <option value='all'>All Employment Types</option>
                                     {employmentTypeOptions.map((option) => (
                                         <option key={option.value} value={option.value}>{option.label}</option>
                                     ))}
                                 </select>
                             </div>
                         </div>
                     </div>
                     <div style={{ display: 'flex', gap: '10px', marginBottom: 14, flexWrap: 'wrap' }}>
                         {!showArchiveView && isAdmin && (
                             <>
                                 {activeRows.length > 0 && (
                                     <button 
                                         onClick={archiveAllEmployees} 
                                         title="Archive All" 
                                         aria-label="Archive all employees" 
                                         style={{ 
                                             ...btnPrimary, 
                                             background: '#dc2626', 
                                             display: 'inline-flex', 
                                             alignItems: 'center', 
                                             justifyContent: 'center',
                                             gap: '6px'
                                         }}
                                     >
                                         <CrudActionIcon action="archive" />
                                         Archive All
                                     </button>
                                 )}
                                 <button onClick={openAdd} title="Add Employee" aria-label="Add Employee" style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '8px 14px' }}>Add Employee</button>
                             </>
                         )}
                         {showArchiveView && isAdmin && archivedRows.length > 0 && (
                             <button onClick={restoreAllArchived} title="Restore All" aria-label="Restore all employees" style={{ ...btnPrimary, background: '#16a34a', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                 <CrudActionIcon action="restore" />
                             </button>
                         )}
                     </div>
                </div>

                <div style={card}>
                    <div style={{ overflowX: 'auto' }}>
                        <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
                            <thead style={{ background: '#f8fafc' }}>
                                <tr>
                                    {['ID Count', 'Employee', 'Position', 'Type', 'Salary', 'Branch', 'Status', 'Payroll Readiness', 'Actions'].map((h) => (
                                        <th key={h} style={th} className={h === 'ID Count' || h === 'Salary' ? 'llb-num' : undefined}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {paged.length === 0 && (
                                    <tr>
                                        <td colSpan={9} style={{ ...td, textAlign: 'center', color: '#64748b' }}>
                                            {showArchiveView && !search.trim() ? 'No archived employees.' : (
                                                <ZeroResults
                                                    query={search}
                                                    itemLabel="employees"
                                                    alternatives={getAlternativeSuggestions(search, employeeSearchCorpus)}
                                                    onPickAlternative={(term) => setSearch(term)}
                                                    onClear={() => setSearch('')}
                                                />
                                            )}
                                        </td>
                                    </tr>
                                )}
                                {paged.map((row, index) => {
                                    const rowStatus = String(row.status || '').toLowerCase();
                                    const isAdminUserRow = !!row.is_admin_user;
                                    const isPrivilegedRow = isProtectedEmployeeRow(row);
                                    const canArchive = !showArchiveView && !['inactive', 'terminated'].includes(rowStatus) && !isPrivilegedRow;
                                    const canRestore = showArchiveView && rowStatus === 'inactive' && !isAdminUserRow;
                                    const rowNumber = (page - 1) * ITEMS_PER_PAGE + index + 1;
                                    const missingRequirements = getPayrollReadinessMissingItems(row);
                                    const payrollReady = missingRequirements.length === 0;

                                    return (
                                    <tr key={row.employee_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                        <td style={td} className="llb-num">{rowNumber}</td>
                                        <td style={td}>
                                            <div style={{ fontWeight: 700 }}>{row.first_name} {row.last_name}</div>
                                            <div style={{ fontSize: 12, color: '#64748b' }}>{row.email || 'No email'}</div>
                                        </td>
                                        <td style={td}>{row.position || '-'}</td>
                                        <td style={td}>{row.employment_type || '-'}</td>
                                        <td style={td} className="llb-num">{money(row.salary)}</td>
                                        <td style={td}>{row.branch_name || 'Unassigned'}</td>
                                        <td style={td}><span style={statusPill(String(row.status || 'inactive'))}>{String(row.status || 'inactive').replace('_', ' ')}</span></td>
                                        <td style={td}>
                                            <button
                                                type="button"
                                                onClick={() => { setViewRow(row); setViewOpen(true); }}
                                                title={payrollReady ? 'All payroll requirements are complete.' : `Missing: ${missingRequirements.join(', ')}`}
                                                aria-label={`${row.first_name} ${row.last_name}: ${payrollReady ? 'Payroll ready' : `${missingRequirements.length} payroll requirements missing`}`}
                                                style={{
                                                    border: 'none', borderRadius: 999, cursor: 'pointer', fontSize: 12, fontWeight: 700,
                                                    padding: '5px 9px', whiteSpace: 'nowrap',
                                                    color: payrollReady ? '#166534' : '#991b1b',
                                                    background: payrollReady ? '#dcfce7' : '#fee2e2',
                                                }}
                                            >
                                                {payrollReady ? 'Payroll Ready' : `Missing (${missingRequirements.length})`}
                                            </button>
                                        </td>
                                        <td style={td} className="llb-actions">
                                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                                <button
                                                    onClick={() => { setViewRow(row); setViewOpen(true); }}
                                                    style={actionBtnView}
                                                    title='View'
                                                    aria-label={`View ${row.first_name} ${row.last_name}`}
                                                >
                                                    <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                                        <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'></path>
                                                        <circle cx='12' cy='12' r='3'></circle>
                                                    </svg>
                                                </button>
                                                {isAdmin && !showArchiveView && !isPrivilegedRow && (
                                                    <button
                                                        onClick={() => openEdit(row)}
                                                        style={actionBtnEdit}
                                                        title='Edit'
                                                        aria-label={`Edit ${row.first_name} ${row.last_name}`}
                                                    >
                                                        <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                                            <path d='M12 20h9'></path>
                                                            <path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'></path>
                                                        </svg>
                                                    </button>
                                                )}
                                                {isAdmin && canArchive && (
                                                    <button
                                                        onClick={() => archiveEmployee(row)}
                                                        style={actionBtnArchive}
                                                        title='Archive'
                                                        aria-label={`Archive ${row.first_name} ${row.last_name}`}
                                                    >
                                                        <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                                            <polyline points='21 8 21 21 3 21 3 8'></polyline>
                                                            <rect x='1' y='3' width='22' height='5'></rect>
                                                            <line x1='10' y1='12' x2='14' y2='12'></line>
                                                        </svg>
                                                    </button>
                                                )}
                                                {isAdmin && canRestore && (
                                                    <button
                                                        onClick={() => restoreEmployee(row)}
                                                        style={actionBtnRestore}
                                                        title='Restore'
                                                        aria-label={`Restore ${row.first_name} ${row.last_name}`}
                                                    >
                                                        <svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
                                                            <polyline points='1 4 1 10 7 10'></polyline>
                                                            <path d='M3.51 15a9 9 0 1 0 2.13-9.36L1 10'></path>
                                                        </svg>
                                                    </button>
                                                )}
                                            </div>
                                        </td>
                                    </tr>
                                )})}
                            </tbody>
                        </table>
                    </div>
                    <Pagination
                        currentPage={page}
                        totalItems={filtered.length}
                        itemsPerPage={ITEMS_PER_PAGE}
                        onPageChange={setPage}
                        label={showArchiveView ? 'archived employees' : 'employees'}
                    />
                </div>
            </div>

            {viewOpen && viewRow && (
                <div style={backdrop}>
                    <div style={modal}>
                        <h3 style={{ marginTop: 0 }}>Employee Details</h3>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
                            <Info label='ID' value={viewRow.employee_date_id || `EMP#${viewRow.employee_id}`} />
                            <Info label='Name' value={`${viewRow.first_name} ${viewRow.last_name}`} />
                            <Info label='Email' value={viewRow.email || '-'} />
                            <Info label='Phone' value={formatPhoneDisplay(viewRow.phone_number) || '-'} />
                            <Info label='Position' value={viewRow.position || '-'} />
                            <Info label='Employment Type' value={viewRow.employment_type || '-'} />
                            <Info label='Hire Date' value={viewRow.hire_date || '-'} />
                            <Info label='Birthdate' value={viewRow.date_of_birth || '-'} />
                            <Info label='Status' value={String(viewRow.status || 'inactive').replace('_', ' ')} />
                            <Info label='Salary' value={money(viewRow.salary)} />
                            <Info label='Branch' value={viewRow.branch_name || 'Unassigned'} />
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <label style={fieldLabel}>Philippine Government Numbers</label>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 8 }}>
                                <Info label='SSS Number' value={viewRow.sss_number || '-'} />
                                <Info label='Pag-IBIG Number' value={viewRow.pagibig_number || '-'} />
                                <Info label='PhilHealth Number' value={viewRow.philhealth_number || '-'} />
                                <Info label='TIN Number' value={viewRow.tin_number || '-'} />
                            </div>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <label style={fieldLabel}>Employment Document Checklist</label>
                            <div style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '7px 9px' }}>
                                {DOCUMENT_CHECKLIST_ITEMS.map((item) => (
                                    <div
                                        key={item.field}
                                        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 6, fontSize: 13, color: '#334155' }}
                                    >
                                        <span>{item.label}</span>
                                        <span style={{ fontWeight: 700, color: toChecked(viewRow[item.field]) ? '#166534' : '#991b1b' }}>
                                            {toChecked(viewRow[item.field]) ? 'Submitted' : 'Missing'}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        </div>
                        <div style={{ marginTop: 8 }}>
                            <label style={fieldLabel}>Address</label>
                            <div style={fieldValue}>{viewRow.address || '-'}</div>
                        </div>
                        <div style={modalActions}>
                            {isAdmin && !isProtectedEmployeeRow(viewRow) && <button title="Edit" aria-label="Edit employee" style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }} onClick={() => { const target = viewRow; setViewOpen(false); openEdit(target); }}><CrudActionIcon action="edit" /></button>}
                            <button style={btnNeutral} onClick={() => setViewOpen(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {formOpen && (
                <div style={backdrop}>
                    <div style={modalLarge}>
                        <h3 style={{ marginTop: 0 }}>{editing ? 'Edit Employee' : 'Add Employee'}</h3>
                        <form onSubmit={submit} noValidate>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                                <TextField label='First Name *' name='first_name' value={form.first_name} onChange={setForm} required error={fieldErrors.first_name} onClearError={() => clearFieldError('first_name')} />
                                <TextField label='Last Name *' name='last_name' value={form.last_name} onChange={setForm} required error={fieldErrors.last_name} onClearError={() => clearFieldError('last_name')} />
                                <TextField label='Email *' name='email' value={form.email} onChange={setForm} type='email' required error={fieldErrors.email} onClearError={() => clearFieldError('email')} />
                                <div>
                                    <label style={fieldLabel}>Phone *</label>
                            <PhoneInput
                                value={form.phone_number}
                                onChange={(phone_number) => { setForm((prev) => ({ ...prev, phone_number })); clearFieldError('phone_number'); }}
                                required
                                invalid={!!fieldErrors.phone_number}
                                ariaLabel="Employee phone number"
                                countryAriaLabel="Employee phone country calling code"
                                inputStyle={{ ...input, width: undefined }}
                            />
                            {fieldErrors.phone_number && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.phone_number}</div>}
                            <div style={{ marginTop: 4, color: '#64748b', fontSize: 12 }}>
                                Choose a country code, then enter the local number. Philippines (+63) is the default.
                                </div>
                                </div>
                                <div>
                                    <label style={fieldLabel}>Birthdate *</label>
                                    <input
                                        type="date"
                                        value={form.date_of_birth}
                                        max={MAX_BIRTHDATE}
                                        required
                                        aria-required='true'
                                        aria-invalid={fieldErrors.date_of_birth ? true : undefined}
                                        onChange={(e) => { setForm((prev) => ({ ...prev, date_of_birth: e.target.value })); clearFieldError('date_of_birth'); }}
                                        style={{ ...input, borderColor: fieldErrors.date_of_birth || (form.date_of_birth && !isAtLeastMinimumAge(form.date_of_birth)) ? '#ef4444' : '#cbd5e1' }}
                                    />
                                    {fieldErrors.date_of_birth && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.date_of_birth}</div>}
                                    {(() => {
                                        const age = computeAge(form.date_of_birth);
                                        if (age === null) return <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>Must be at least {MINIMUM_EMPLOYEE_AGE} years old.</div>;
                                        const valid = age >= MINIMUM_EMPLOYEE_AGE;
                                        return (
                                            <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, backgroundColor: valid ? '#dcfce7' : '#fee2e2', color: valid ? '#15803d' : '#dc2626' }}>
                                                {valid ? '✓' : '✗'} Age: {age} {valid ? '(eligible)' : `(must be ≥ ${MINIMUM_EMPLOYEE_AGE})`}
                                            </div>
                                        );
                                    })()}
                                </div>
                                <TextField label='Hire Date *' name='hire_date' value={form.hire_date} onChange={setForm} type='date' required error={fieldErrors.hire_date} onClearError={() => clearFieldError('hire_date')} />
                                <div>
                                    <label style={fieldLabel}>Position *</label>
                                    <select
                                        name='position'
                                        value={form.position}
                                        required
                                        aria-required='true'
                                        aria-invalid={fieldErrors.position ? true : undefined}
                                        onChange={(e) => { setForm((prev) => ({ ...prev, position: e.target.value })); clearFieldError('position'); }}
                                        style={{ ...input, borderColor: fieldErrors.position ? '#ef4444' : '#cbd5e1', borderWidth: fieldErrors.position ? 2 : 1 }}
                                    >
                                        <option value=''>Select Position</option>
                                        {form.position && !POSITION_OPTIONS.includes(form.position) && (
                                            <option value={form.position}>{form.position}</option>
                                        )}
                                        {POSITION_OPTIONS.map((option) => (
                                            <option key={option} value={option}>{option}</option>
                                        ))}
                                    </select>
                                    {fieldErrors.position && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.position}</div>}
                                </div>
                                <div>
                                    <label style={fieldLabel}>Employment Type</label>
                                    <select
                                        name='employment_type'
                                        value={form.employment_type}
                                        onChange={(e) => setForm((prev) => ({ ...prev, employment_type: e.target.value }))}
                                        style={input}
                                    >
                                        {form.employment_type && !EMPLOYMENT_TYPE_OPTIONS.includes(form.employment_type) && (
                                            <option value={form.employment_type}>{form.employment_type}</option>
                                        )}
                                        {EMPLOYMENT_TYPE_OPTIONS.map((option) => (
                                            <option key={option} value={option}>{option}</option>
                                        ))}
                                    </select>
                                </div>
                                <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                                    <h4 style={{ margin: 0, color: '#0f172a', fontSize: 14 }}>Philippine Government Numbers</h4>
                                </div>
                                {GOV_NUMBER_FIELDS.map((field) => (
                                    <div key={field}>
                                        <label style={{ ...fieldLabel, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, fontWeight: 600, color: '#475569' }}>
                                            <input
                                                type='checkbox'
                                                checked={!!govNumberEnabled[field]}
                                                onChange={(e) => handleGovNumberToggle(field, e.target.checked)}
                                            />
                                            <span>{GOV_NUMBER_LABELS[field]}</span>
                                        </label>
                                        <input
                                            type='text'
                                            value={form[field]}
                                            onChange={(e) => { setForm((prev) => ({ ...prev, [field]: formatGovNumber(field, e.target.value) })); clearFieldError(field); }}
                                            disabled={!govNumberEnabled[field]}
                                            placeholder={GOV_NUMBER_PLACEHOLDERS[field]}
                                            required={govNumberEnabled[field]}
                                            aria-required={govNumberEnabled[field] ? 'true' : undefined}
                                            aria-invalid={fieldErrors[field] ? true : undefined}
                                            style={{
                                                ...input,
                                                color: govNumberEnabled[field] ? '#0f172a' : '#94a3b8',
                                                backgroundColor: govNumberEnabled[field] ? '#fff' : '#f8fafc',
                                                cursor: govNumberEnabled[field] ? 'text' : 'not-allowed',
                                                borderColor: fieldErrors[field] ? '#ef4444' : '#cbd5e1',
                                                borderWidth: fieldErrors[field] ? 2 : 1,
                                            }}
                                        />
                                        {fieldErrors[field] && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors[field]}</div>}
                                    </div>
                                ))}
                                <TextField label='Salary *' name='salary' value={form.salary} onChange={setForm} type='number' min='0' step='0.01' required error={fieldErrors.salary} onClearError={() => clearFieldError('salary')} />
                                {editing && !isProtectedEmployeeRow(editing) && (
                                    <div>
                                        <label style={fieldLabel}>Status</label>
                                        <select name='status' value={form.status} onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value as EmployeeStatus }))} style={input}>
                                            <option value='active'>Active</option>
                                            <option value='inactive'>Inactive</option>
                                            <option value='on_leave'>On Leave</option>
                                            <option value='terminated'>Terminated</option>
                                        </select>
                                    </div>
                                )}
                                <div>
                                    <label style={fieldLabel}>Branch</label>
                                    <select name='branch_id' value={form.branch_id} onChange={(e) => setForm((prev) => ({ ...prev, branch_id: e.target.value }))} style={input}>
                                        <option value=''>No Branch</option>
                                        {branches.map((b) => <option key={b.branch_id} value={b.branch_id}>{b.branch_name}</option>)}
                                    </select>
                                </div>
                                <div style={{ gridColumn: '1 / -1', marginTop: 4 }}>
                                    <h4 style={{ margin: 0, color: '#0f172a', fontSize: 14 }}>Employment Document Checklist</h4>
                                </div>
                                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: 6 }}>
                                    {DOCUMENT_CHECKLIST_ITEMS.map((item) => (
                                        <label
                                            key={item.field}
                                            style={{ border: '1px solid #e2e8f0', borderRadius: 7, padding: '7px 9px', display: 'flex', gap: 8, alignItems: 'center' }}
                                        >
                                            <input
                                                type='checkbox'
                                                checked={form[item.field]}
                                                onChange={(e) => setForm((prev) => ({ ...prev, [item.field]: e.target.checked }))}
                                            />
                                            <span>{item.label}</span>
                                        </label>
                                    ))}
                                </div>
                                {isAdmin && (
                                    <div style={{ gridColumn: '1 / -1' }}>
                                        <label style={{ ...fieldLabel, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                                            <input
                                                type='checkbox'
                                                checked={linkUserEnabled}
                                                onChange={(e) => {
                                                    const checked = e.target.checked;
                                                    setLinkUserEnabled(checked);
                                                    if (!checked) {
                                                        setForm((prev) => ({ ...prev, linked_user_id: '' }));
                                                    }
                                                }}
                                            />
                                            <span>Link this employee to an existing user account</span>
                                        </label>
                                        <select
                                            name='linked_user_id'
                                            value={form.linked_user_id}
                                            onChange={(e) => setForm((prev) => ({ ...prev, linked_user_id: e.target.value }))}
                                            style={input}
                                            disabled={!linkUserEnabled}
                                        >
                                            <option value=''>{linkUserEnabled ? 'Select user' : 'Enable link first'}</option>
                                            {linkableUsers.map((u) => (
                                                <option key={u.id} value={u.id}>
                                                    {u.first_name} {u.last_name} (@{u.username})
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                )}
                            </div>

                            <div style={{ marginTop: 8 }}>
                                <label style={fieldLabel}>Address</label>
                                <textarea
                                    value={form.address}
                                    onChange={(e) => setForm((prev) => ({ ...prev, address: e.target.value }))}
                                    rows={3}
                                    style={{ ...input, resize: 'vertical' }}
                                />
                            </div>

                            <div style={modalActions}>
                                <button type='button' style={btnNeutral} onClick={() => { setFormOpen(false); setEditing(null); setForm(initialForm()); setLinkUserEnabled(false); setGovNumberEnabled(createInitialGovNumberEnabled()); setFieldErrors({}); }}>Cancel</button>
                                <button type='submit' title={editing ? 'Update Employee' : 'Create Employee'} aria-label={editing ? 'Update Employee' : 'Create Employee'} style={{ ...btnPrimary, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>Submit</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {isManager && <div style={managerNote}>Manager access is read-only for employee records.</div>}
        </Layout>
    );
}

type FieldProps = {
    label: string;
    value: string;
};

function Info({ label, value }: FieldProps) {
    return (
        <div>
            <label style={fieldLabel}>{label}</label>
            <div style={fieldValue}>{value}</div>
        </div>
    );
}

type TextFieldProps = {
    label: string;
    name:
        | 'first_name'
        | 'last_name'
        | 'date_of_birth'
        | 'email'
        | 'phone_number'
        | 'address'
        | 'position'
        | 'employment_type'
        | 'sss_number'
        | 'pagibig_number'
        | 'philhealth_number'
        | 'tin_number'
        | 'hire_date'
        | 'salary';
    value: string;
    onChange: React.Dispatch<React.SetStateAction<EmployeeForm>>;
    type?: string;
    min?: string;
    step?: string;
    placeholder?: string;
    required?: boolean;
    error?: string;
    onClearError?: () => void;
};

function TextField({ label, name, value, onChange, type = 'text', min, step, placeholder, required, error, onClearError }: TextFieldProps) {
    return (
        <div>
            <label style={fieldLabel}>{label}</label>
            <input
                type={type}
                value={value}
                min={min}
                step={step}
                placeholder={placeholder}
                required={required}
                aria-required={required ? 'true' : undefined}
                aria-invalid={error ? true : undefined}
                onChange={(e) => {
                    onChange((prev) => ({ ...prev, [name]: e.target.value }));
                    if (error && onClearError) onClearError();
                }}
                style={{ ...input, borderColor: error ? '#ef4444' : '#cbd5e1', borderWidth: error ? 2 : 1 }}
            />
            {error && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{error}</div>}
        </div>
    );
}

const card: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: '#fff' };
const input: React.CSSProperties = { width: '100%', border: '1px solid #cbd5e1', borderRadius: 7, padding: '9px 10px', color: '#0f172a', background: '#fff', boxSizing: 'border-box' };
const th: React.CSSProperties = { textAlign: 'left', padding: '11px 12px', fontSize: 12, color: '#475569', borderBottom: '1px solid #e2e8f0' };
const td: React.CSSProperties = { padding: '11px 12px', fontSize: 13, color: '#334155' };
const fieldLabel: React.CSSProperties = { display: 'block', marginBottom: 4, color: '#64748b', fontSize: 12 };
const fieldValue: React.CSSProperties = { border: '1px solid #e2e8f0', borderRadius: 7, padding: '7px 9px', minHeight: 34, color: '#334155' };
const backdrop: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modal: React.CSSProperties = { width: 760, maxWidth: '94%', maxHeight: '90vh', overflowY: 'auto', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 'var(--modal-radius)', padding: 14 };
const modalLarge: React.CSSProperties = { width: 920, maxWidth: '95%', maxHeight: '90vh', overflowY: 'auto', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 'var(--modal-radius)', padding: 14 };
const modalActions: React.CSSProperties = { marginTop: 10, display: 'flex', justifyContent: 'flex-end', gap: 8 };
const managerNote: React.CSSProperties = { position: 'fixed', right: 12, bottom: 12, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 7, padding: '7px 9px', fontSize: 12, color: '#334155' };
const btnBase: React.CSSProperties = { borderRadius: 7, padding: '7px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, border: 'none' };
const btnPrimary: React.CSSProperties = { ...btnBase, background: '#1e3a8a', color: '#fff' };
const btnNeutral: React.CSSProperties = { ...btnBase, background: '#fff', color: '#334155', border: '1px solid #cbd5e1' };
const btnInfo: React.CSSProperties = { ...btnBase, background: '#eff6ff', color: '#1d4ed8', border: '1px solid #bfdbfe' };
const btnDanger: React.CSSProperties = { ...btnBase, background: '#fff1f2', color: '#be123c', border: '1px solid #fecaca' };
const actionBtnBase: React.CSSProperties = {
    width: 30,
    height: 30,
    borderRadius: 8,
    border: '1px solid #dbe3ef',
    background: '#fff',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 0,
};
const actionBtnView: React.CSSProperties = { ...actionBtnBase, color: '#334155' };
const actionBtnEdit: React.CSSProperties = { ...actionBtnBase, color: '#1d4ed8', border: '1px solid #bfdbfe', background: '#eff6ff' };
const actionBtnArchive: React.CSSProperties = { ...actionBtnBase, color: '#be123c', border: '1px solid #fecaca', background: '#fff1f2' };
const actionBtnRestore: React.CSSProperties = { ...actionBtnBase, color: '#166534', border: '1px solid #86efac', background: '#dcfce7' };

function statusPill(status: string): React.CSSProperties {
    const value = status.toLowerCase();
    if (value === 'active') return { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '4px 8px', background: '#dcfce7', color: '#166534', textTransform: 'capitalize' };
    if (value === 'on_leave') return { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '4px 8px', background: '#fef9c3', color: '#854d0e', textTransform: 'capitalize' };
    if (value === 'terminated') return { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '4px 8px', background: '#fee2e2', color: '#991b1b', textTransform: 'capitalize' };
    return { fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '4px 8px', background: '#e2e8f0', color: '#334155', textTransform: 'capitalize' };
}
