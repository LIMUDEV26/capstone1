import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import PasswordInput from '../../components/PasswordInput';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

type ApiResponse<T = unknown> = {
    success?: boolean;
    data?: T;
    message?: string;
    error?: string;
    errors?: Record<string, unknown> | null;
};

type DataDeletionAccessStatus = {
    verified?: boolean;
    verified_until?: string | null;
    code_requested?: boolean;
    code_expires_at?: string | null;
    code_sent_at?: string | null;
    code_send_ok?: boolean | null;
    resend_available_in?: number;
    email_masked?: string;
};

type DeletionItem = {
    id: number;
    title: string;
    meta: string;
    deleteKey?: string;
    isArchived?: boolean;
    archivedAt?: string;
};

type ResourceKey =
    | 'users'
    | 'branches'
    | 'clients'
    | 'projects'
    | 'roles'
    | 'shifts'
    | 'documents'
    | 'payroll'
    | 'overtime'
    | 'backups'
    | 'activity';

type SectionState = {
    loading: boolean;
    items: DeletionItem[];
    deletingId: number | null;
    error: string;
};

type ResourceConfig = {
    label: string;
    subtitle: string;
    emptyText: string;
    load: () => Promise<DeletionItem[]>;
    deleteOne: (id: number, item?: DeletionItem) => Promise<ApiResponse<unknown>>;
    deleteAll?: () => Promise<ApiResponse<unknown>>;
    restoreOne?: (id: number, item?: DeletionItem) => Promise<ApiResponse<unknown>>;
    restoreAll?: (ids: number[]) => Promise<ApiResponse<unknown>>;
};

type ActivityLogFilters = {
    search: string;
    date_from: string;
    date_to: string;
    user_id: string;
    activity_type: string;
    action: string;
    ip_address: string;
};

const EMPTY_ACTIVITY_FILTERS: ActivityLogFilters = {
    search: '',
    date_from: '',
    date_to: '',
    user_id: '',
    activity_type: '',
    action: '',
    ip_address: '',
};

type ActivityLogMetaUser = {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    role?: string | null;
};

type ActivityLogMeta = {
    users: ActivityLogMetaUser[];
    types: string[];
    actions: string[];
};

const formatActivityUserLabel = (entry: ActivityLogMetaUser) => {
    const fullName = `${String(entry.first_name || '').trim()} ${String(entry.last_name || '').trim()}`.trim();
    const name = fullName || String(entry.username || '').trim() || `User #${entry.id}`;
    const role = String(entry.role || '').trim();
    return role ? `${name} (${role})` : name;
};

const formatReadableValue = (value?: string | null, fallback = '-') => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw.replace(/[_-]+/g, ' ');
};

const RESOURCE_ORDER: ResourceKey[] = [
    'users',
    'branches',
    'clients',
    'projects',
    'roles',
    'shifts',
    'documents',
    'payroll',
    'overtime',
    'backups',
    'activity',
];

const createInitialSections = (): Record<ResourceKey, SectionState> => ({
    users: { loading: false, items: [], deletingId: null, error: '' },
    branches: { loading: false, items: [], deletingId: null, error: '' },
    clients: { loading: false, items: [], deletingId: null, error: '' },
    projects: { loading: false, items: [], deletingId: null, error: '' },
    roles: { loading: false, items: [], deletingId: null, error: '' },
    shifts: { loading: false, items: [], deletingId: null, error: '' },
    documents: { loading: false, items: [], deletingId: null, error: '' },
    payroll: { loading: false, items: [], deletingId: null, error: '' },
    overtime: { loading: false, items: [], deletingId: null, error: '' },
    backups: { loading: false, items: [], deletingId: null, error: '' },
    activity: { loading: false, items: [], deletingId: null, error: '' },
});

const createInitialFilters = (): Record<ResourceKey, string> => ({
    users: '',
    branches: '',
    clients: '',
    projects: '',
    roles: '',
    shifts: '',
    documents: '',
    payroll: '',
    overtime: '',
    backups: '',
    activity: '',
});

const parseResourceKey = (value: string | string[] | undefined): ResourceKey | null => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (!raw) return null;
    return RESOURCE_ORDER.includes(raw as ResourceKey) ? (raw as ResourceKey) : null;
};

const getMessage = (payload: ApiResponse<unknown>, fallback: string) =>
    String(payload.message || payload.error || fallback);

const stringValue = (value: unknown) => String(value ?? '').trim();
const numberValue = (value: unknown) => Number(value ?? 0);
const objectValue = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
const inactiveDaysLabel = (archivedAt: unknown) => {
    const archivedTime = new Date(String(archivedAt ?? '')).getTime();
    if (!Number.isFinite(archivedTime)) return 'Inactive';
    const days = Math.max(1, Math.floor((Date.now() - archivedTime) / 86_400_000));
    return `Inactive · ${days} ${days === 1 ? 'day' : 'days'}`;
};

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<ApiResponse<T>> {
    const response = await fetch(url, { credentials: 'include', ...init });
    return (await response.json()) as ApiResponse<T>;
}

export default function DataDeletionSettingsPage() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [loadingPage, setLoadingPage] = useState(true);
    const [sections, setSections] = useState<Record<ResourceKey, SectionState>>(createInitialSections());
    const [filters, setFilters] = useState<Record<ResourceKey, string>>(createInitialFilters());
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [accessGranted, setAccessGranted] = useState(false);
    const [codeRequested, setCodeRequested] = useState(false);
    const [emailMasked, setEmailMasked] = useState('');
    const [passwordInput, setPasswordInput] = useState('');
    const [codeInput, setCodeInput] = useState('');
    const [accessBusy, setAccessBusy] = useState(false);
    const [accessError, setAccessError] = useState('');
    const [accessMessage, setAccessMessage] = useState('');
    // Inline per-field "Required" messages for the verification gate.
    const [gateFieldErrors, setGateFieldErrors] = useState<Record<string, string>>({});
    // Resend throttle + mailer verdict mirror of the server state.
    const [resendAvailableIn, setResendAvailableIn] = useState(0);
    const [codeSendFailed, setCodeSendFailed] = useState(false);

    // Countdown for the resend throttle (30s server-side).
    useEffect(() => {
        if (resendAvailableIn <= 0) return;
        const timer = window.setTimeout(
            () => setResendAvailableIn((prev) => Math.max(0, prev - 1)),
            1000
        );
        return () => window.clearTimeout(timer);
    }, [resendAvailableIn]);

    const clearGateFieldError = (name: string) => {
        setGateFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    // Activity-log filters (mirrors Logs Management: search, dates, user, type, action, IP).
    // Draft edits inputs; ref holds the applied values the loader reads.
    const [activityDraft, setActivityDraft] = useState<ActivityLogFilters>(EMPTY_ACTIVITY_FILTERS);
    const activityActiveRef = useRef<ActivityLogFilters>(EMPTY_ACTIVITY_FILTERS);
    const [activityMeta, setActivityMeta] = useState<ActivityLogMeta>({ users: [], types: [], actions: [] });
    const activityMetaLoadedRef = useRef(false);
    const [activityRetentionDays, setActivityRetentionDays] = useState(90);

    const fetchActivityMeta = useCallback(async () => {
        if (activityMetaLoadedRef.current) return;
        activityMetaLoadedRef.current = true;
        try {
            const response = await fetch(`${API_BASE}/activity-logs.php?meta=1`, { credentials: 'include' });
            const result = await response.json();
            if (result?.success) {
                setActivityMeta({
                    users: Array.isArray(result.users) ? result.users : [],
                    types: Array.isArray(result.types) ? result.types : [],
                    actions: Array.isArray(result.actions) ? result.actions : [],
                });
            }
        } catch {
            // Meta is only for dropdown options — the list still loads without it.
        }
    }, []);

    const resources = useMemo<Record<ResourceKey, ResourceConfig>>(
        () => ({
            users: {
                label: 'Users',
                subtitle: 'Inactive accounts',
                emptyText: 'No inactive users available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/users.php?status=inactive`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.id);
                        const firstName = stringValue(row.first_name);
                        const lastName = stringValue(row.last_name);
                        const username = stringValue(row.username);
                        const email = stringValue(row.email);

                        return {
                            id,
                            title: `${firstName} ${lastName}`.trim() || username || `User #${id}`,
                            meta: [username ? `@${username}` : null, email || null].filter(Boolean).join(' | '),
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/users.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            branches: {
                label: 'Branches',
                subtitle: 'Inactive branches',
                emptyText: 'No inactive branches available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/branches.php?status=inactive`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.branch_id);
                        return {
                            id,
                            title: stringValue(row.branch_name) || `Branch #${id}`,
                            meta: stringValue(row.location) || 'No location',
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/branches.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            clients: {
                label: 'Clients',
                subtitle: 'Inactive clients',
                emptyText: 'No inactive clients available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/clients.php?status=inactive`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.client_id);
                        const contactPerson = stringValue(row.contact_person);
                        const email = stringValue(row.email);

                        return {
                            id,
                            title: stringValue(row.client_name) || `Client #${id}`,
                            meta: [contactPerson || null, email || null].filter(Boolean).join(' | '),
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/clients.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            projects: {
                label: 'Projects',
                subtitle: 'Archived projects',
                emptyText: 'No archived projects available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/projects.php?status=archived`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.id);
                        return {
                            id,
                            title: stringValue(row.name) || `Project #${id}`,
                            meta: stringValue(row.client_name) || 'No client',
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/projects.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            roles: {
                label: 'Roles',
                subtitle: 'Archived roles',
                emptyText: 'No archived roles available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/roles.php?status=archived`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.role_id);
                        return {
                            id,
                            title: stringValue(row.role_name) || `Role #${id}`,
                            meta: `${numberValue(row.employee_count)} assigned employees`,
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/roles.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            shifts: {
                label: 'Shift Schedules',
                subtitle: 'Cancelled shifts',
                emptyText: 'No cancelled shifts available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/shift-schedules.php?status=cancelled`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.shift_schedule_id);
                        const employeeName = stringValue(row.employee_name);
                        const employeeId = numberValue(row.employee_id);
                        const shiftDate = stringValue(row.shift_date);
                        const shiftStart = stringValue(row.shift_start).slice(0, 5);
                        const shiftEnd = stringValue(row.shift_end).slice(0, 5);

                        return {
                            id,
                            title: `${employeeName || `Employee #${employeeId}`}${shiftDate ? ` | ${shiftDate}` : ''}`,
                            meta: `${shiftStart} - ${shiftEnd}`,
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/shift-schedules.php?id=${id}&permanent=1`, { method: 'DELETE' }),
            },
            documents: {
                label: 'Documents',
                subtitle: 'Archived document records',
                emptyText: 'No archived document records available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/documents.php?action=list_received&status=archived`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.document_id);
                        const clientName = stringValue(row.client_name);
                        const receivedDate = stringValue(row.received_date);

                        return {
                            id,
                            title: stringValue(row.document_name) || `Document #${id}`,
                            meta: [clientName || null, receivedDate || null].filter(Boolean).join(' | '),
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/documents.php?action=delete_received`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ document_id: id }),
                    }),
            },
            payroll: {
                label: 'Payroll',
                subtitle: 'Archived payroll records',
                emptyText: 'No archived payroll records available to restore.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/payroll.php?storage_deleted=1`);
                    if (!payload.success) throw new Error(getMessage(payload, 'Failed to load archived payroll records.'));
                    if (!Array.isArray(payload.data)) throw new Error('The payroll storage response was invalid.');
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.id);
                        const fullName = stringValue(row.full_employee_name);
                        const employeeName = stringValue(row.employee_name);
                        const periodStart = stringValue(row.pay_period_start) || '-';
                        const periodEnd = stringValue(row.pay_period_end) || '-';
                        const archivedAt = stringValue(row.archived_at);

                        return {
                            id,
                            title: fullName || employeeName || `Payroll #${id}`,
                            meta: `${periodStart} to ${periodEnd}`,
                            isArchived: true,
                            archivedAt: stringValue(row.storage_deleted_at) || archivedAt,
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/payroll.php?id=${id}&permanent=1`, { method: 'DELETE' }),
                restoreOne: (id: number) =>
                    requestJson(`${API_BASE}/payroll.php`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id, status: 'paid' }),
                    }),
                restoreAll: (ids: number[]) =>
                    requestJson(`${API_BASE}/payroll.php`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ ids, status: 'paid' }),
                    }),
            },
            overtime: {
                label: 'Overtime Requests',
                subtitle: 'Archived rejected overtime requests',
                emptyText: 'No archived overtime requests available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/overtime-requests.php?archived=1`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data.map((entry) => {
                        const row = objectValue(entry);
                        const id = numberValue(row.overtime_request_id);
                        const employeeName = stringValue(row.employee_name);
                        const employeeId = numberValue(row.employee_id);
                        const workDate = stringValue(row.work_date);
                        const archivedAt = stringValue(row.archived_at);

                        return {
                            id,
                            title: `${employeeName || `Employee #${employeeId}`}${workDate ? ` | ${workDate}` : ''}`,
                            meta: [stringValue(row.status) || null, archivedAt ? `Archived ${archivedAt}` : null].filter(Boolean).join(' | '),
                        };
                    });
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/overtime-requests.php?id=${id}`, { method: 'DELETE' }),
            },
            backups: {
                label: 'Backup Archives',
                subtitle: 'Archived database backup files',
                emptyText: 'No archived backups available for permanent deletion.',
                load: async () => {
                    const payload = await requestJson<Record<string, unknown>[]>(`${API_BASE}/backup.php?action=list`);
                    if (!payload.success || !Array.isArray(payload.data)) return [];
                    return payload.data
                        .filter((entry) => stringValue(objectValue(entry).status) === 'archived')
                        .map((entry, index) => {
                            const row = objectValue(entry);
                            const filename = stringValue(row.filename);
                            const bytes = numberValue(row.size);
                            const archivedAt = stringValue(row.archived_at);
                            return {
                                id: index + 1,
                                title: filename || `Archived backup #${index + 1}`,
                                meta: [`${(bytes / (1024 * 1024)).toFixed(2)} MB`, archivedAt ? `Archived ${archivedAt}` : null].filter(Boolean).join(' | '),
                                deleteKey: filename,
                            };
                        });
                },
                deleteOne: (_id: number, item?: DeletionItem) =>
                    requestJson(`${API_BASE}/backup.php?action=delete`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ filename: item?.deleteKey || '' }),
                    }),
            },
            activity: {
                label: 'Activity Logs',
                subtitle: 'System activity trail and archived logs',
                emptyText: 'No activity logs found.',
                load: async () => {
                    await fetchActivityMeta();
                    const f = activityActiveRef.current;
                    const params = new URLSearchParams();
                    if (f.search) params.set('search', f.search);
                    if (f.date_from) params.set('date_from', f.date_from);
                    if (f.date_to) params.set('date_to', f.date_to);
                    if (f.user_id) params.set('user_id', f.user_id);
                    if (f.activity_type) params.set('activity_type', f.activity_type);
                    if (f.action) params.set('action', f.action);
                    if (f.ip_address) params.set('ip_address', f.ip_address);
                    params.set('limit', '200');
                    const [liveResult, archiveResult, policyResult] = await Promise.allSettled([
                        requestJson<Record<string, unknown>[]>(`${API_BASE}/activity-logs.php?${params.toString()}`),
                        requestJson<{ data?: Record<string, unknown>[] }>(`${API_BASE}/activity-log-archive.php?action=list&limit=500`),
                        requestJson<{ retention_days?: number }>(`${API_BASE}/activity-log-archive.php?action=policy`),
                    ]);
                    const mapLog = (entry: Record<string, unknown>, isArchived: boolean): DeletionItem => {
                        const row = objectValue(entry);
                        const id = numberValue(isArchived ? row.archive_id : row.id);
                        const action = stringValue(row.action);
                        const firstName = stringValue(row.first_name);
                        const lastName = stringValue(row.last_name);
                        const username = stringValue(row.username);
                        const who = `${firstName} ${lastName}`.trim() || username || 'System';
                        const type = stringValue(row.activity_type);
                        const when = stringValue(row.created_at);
                        return {
                            id,
                            title: `${action || `Log #${id}`} — ${who}`,
                            meta: [type || null, when || null, isArchived && row.archived_at ? `Archived ${stringValue(row.archived_at)}` : null].filter(Boolean).join(' | '),
                            isArchived,
                            archivedAt: isArchived ? stringValue(row.archived_at) : undefined,
                        };
                    };
                    const livePayload = liveResult.status === 'fulfilled' ? liveResult.value : null;
                    const archivePayload = archiveResult.status === 'fulfilled' ? archiveResult.value : null;
                    const policyPayload = policyResult.status === 'fulfilled' ? policyResult.value : null;
                    const retentionDays = Number(policyPayload?.data?.retention_days);
                    if (Number.isFinite(retentionDays) && retentionDays > 0) setActivityRetentionDays(retentionDays);
                    const liveLogs = livePayload?.success && Array.isArray(livePayload.data) ? livePayload.data.map((entry) => mapLog(entry, false)) : [];
                    const archivedLogs = archivePayload?.success && Array.isArray(archivePayload.data?.data) ? archivePayload.data.data.map((entry) => mapLog(entry, true)) : [];
                    return [...liveLogs, ...archivedLogs];
                },
                deleteOne: (id: number) =>
                    requestJson(`${API_BASE}/activity-log-archive.php?action=restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archive_id: id }) }),
                deleteAll: () =>
                    requestJson(`${API_BASE}/activity-log-archive.php?action=restore_all`, { method: 'POST' }),
            },
        }),
        []
    );

    const loadSection = useCallback(async (key: ResourceKey) => {
        setSections((prev) => ({
            ...prev,
            [key]: { ...prev[key], loading: true, error: '' },
        }));

        try {
            const items = await resources[key].load();
            setSections((prev) => ({
                ...prev,
                [key]: { ...prev[key], loading: false, items, error: '' },
            }));
        } catch {
            setSections((prev) => ({
                ...prev,
                [key]: {
                    ...prev[key],
                    loading: false,
                    error: `Failed to load ${resources[key].label.toLowerCase()}.`,
                },
            }));
        }
    }, [resources]);

    const loadAllSections = useCallback(async () => {
        await Promise.all(RESOURCE_ORDER.map(async (key) => {
            await loadSection(key);
        }));
    }, [loadSection]);

    const loadAccessStatus = useCallback(async () => {
        const payload = await requestJson<DataDeletionAccessStatus>(`${API_BASE}/auth.php?action=data_deletion_access_status`);
        if (!payload.success) {
            setAccessGranted(false);
            setCodeRequested(false);
            setEmailMasked('');
            return false;
        }

        const verified = !!payload.data?.verified;
        setAccessGranted(verified);
        setCodeRequested(!!payload.data?.code_requested);
        setEmailMasked(String(payload.data?.email_masked || ''));
        setResendAvailableIn(Math.max(0, Number(payload.data?.resend_available_in || 0)));
        // null means "still sending" — only a real false is a failure.
        setCodeSendFailed(payload.data?.code_send_ok === false);
        return verified;
    }, []);

    // Render the page shell immediately after auth resolves; data loads in
    // the background. Never trap on full-page "Loading..." for data fetch.
    const userId = user?.id;
    useEffect(() => {
        if (authLoading) return;
        if (!userId) {
            setLoadingPage(false);
            return;
        }

        let active = true;
        const loadPage = async () => {
            try {
                const verified = await loadAccessStatus();
                if (verified) {
                    await loadAllSections();
                }
            } finally {
                if (active) {
                    setLoadingPage(false);
                }
            }
        };

        void loadPage();
        return () => {
            active = false;
        };
    }, [authLoading, loadAccessStatus, loadAllSections, userId]);

    useEffect(() => {
        if (!accessError) return;
        void notifyError(accessError);
        setAccessError('');
    }, [accessError]);

    useEffect(() => {
        if (!accessMessage) return;
        void notifySuccess(accessMessage);
        setAccessMessage('');
    }, [accessMessage]);

    useEffect(() => {
        const sectionErrors = RESOURCE_ORDER
            .map((key) => sections[key].error)
            .filter((message): message is string => Boolean(message));
        if (sectionErrors.length === 0) return;

        sectionErrors.forEach((message) => {
            void notifyError(message);
        });

        setSections((prev) => {
            const next = { ...prev };
            RESOURCE_ORDER.forEach((key) => {
                if (!next[key].error) return;
                next[key] = { ...next[key], error: '' };
            });
            return next;
        });
    }, [sections]);

    const activeResource = useMemo<ResourceKey>(
        () => parseResourceKey(router.query.resource) || RESOURCE_ORDER[0],
        [router.query.resource]
    );

    useEffect(() => {
        if (!router.isReady) return;
        if (parseResourceKey(router.query.resource)) return;

        void router.replace(
            {
                pathname: router.pathname,
                query: { ...router.query, resource: RESOURCE_ORDER[0] },
            },
            undefined,
            { shallow: true }
        );
    }, [router.isReady, router.pathname, router.query, router]);

    const selectResource = (key: ResourceKey) => {
        if (key === activeResource) return;

        void router.push(
            {
                pathname: router.pathname,
                query: { ...router.query, resource: key },
            },
            undefined,
            { shallow: true }
        );
    };

    const applyActivityFilters = () => {
        const next: ActivityLogFilters = {
            ...activityDraft,
            search: activityDraft.search.trim(),
            ip_address: activityDraft.ip_address.trim(),
        };
        setActivityDraft(next);
        activityActiveRef.current = next;
        void loadSection('activity');
    };

    const clearActivityFilters = () => {
        setActivityDraft(EMPTY_ACTIVITY_FILTERS);
        activityActiveRef.current = EMPTY_ACTIVITY_FILTERS;
        void loadSection('activity');
    };

    /**
     * The API answers before the mailer runs, so poll the status endpoint to
     * learn whether the code email actually left the server. Without this the
     * gate could only ever claim "code sent", even when SMTP rejected it.
     */
    const pollCodeSendResult = useCallback((attempts = 6) => {
        let remaining = attempts;
        const tick = async () => {
            remaining -= 1;
            try {
                await loadAccessStatus();
            } catch {
                // Transient polling failures are not worth surfacing.
            }
            if (remaining > 0) {
                window.setTimeout(() => void tick(), 3000);
            }
        };
        window.setTimeout(() => void tick(), 2500);
    }, [loadAccessStatus]);

    const handleRequestAccessCode = async () => {
        if (!passwordInput.trim()) {
            setGateFieldErrors({ password: 'Required.' });
            return;
        }
        if (resendAvailableIn > 0) return;
        setGateFieldErrors({});

        setAccessBusy(true);
        setAccessError('');
        setAccessMessage('');
        try {
            const payload = await requestJson<{ email_masked?: string; resend_available_in?: number }>(`${API_BASE}/auth.php?action=data_deletion_request_code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: passwordInput }),
            });

            if (!payload.success) {
                const retryAfter = Number(payload.errors?.retry_after ?? 0);
                if (retryAfter > 0) setResendAvailableIn(retryAfter);
                setAccessError(getMessage(payload, 'Failed to send verification code.'));
                return;
            }

            setCodeRequested(true);
            setCodeSendFailed(false);
            setResendAvailableIn(Math.max(1, Number(payload.data?.resend_available_in || 30)));
            setEmailMasked(String(payload.data?.email_masked || emailMasked));
            setAccessMessage('A new 8-digit verification code is on its way. It can take up to a minute to arrive.');
            pollCodeSendResult();
        } catch {
            setAccessError('Network error while requesting the verification code.');
        } finally {
            setAccessBusy(false);
        }
    };

    const handleVerifyAccessCode = async () => {
        const cleanCode = codeInput.replace(/\D/g, '').slice(0, 8);
        if (cleanCode.length !== 8) {
            setGateFieldErrors({ code: cleanCode.length === 0 ? 'Required.' : 'Enter the 8-digit verification code.' });
            return;
        }
        setGateFieldErrors({});

        setAccessBusy(true);
        setAccessError('');
        setAccessMessage('');
        try {
            const payload = await requestJson(`${API_BASE}/auth.php?action=data_deletion_verify_code`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: cleanCode }),
            });

            if (!payload.success) {
                setAccessError(getMessage(payload, 'Failed to verify code.'));
                return;
            }

            setAccessGranted(true);
            setCodeRequested(false);
            setPasswordInput('');
            setCodeInput('');
            setAccessMessage('Verification successful. Data Storage is now unlocked.');
            await loadAllSections();
        } catch {
            setAccessError('Network error while verifying code.');
        } finally {
            setAccessBusy(false);
        }
    };

    const handleDeleteOne = async (key: ResourceKey, item: DeletionItem, operation?: 'restore' | 'delete') => {
        const isRestore = operation ? operation === 'restore' : key === 'activity';
        const confirmed = await confirmAction({
            title: isRestore ? `Restore this ${key === 'activity' ? 'activity log' : 'payroll record'}?` : `Delete ${resources[key].label.toLowerCase()} permanently?`,
            text: isRestore
                ? key === 'activity'
                    ? `${item.title} will be returned to the active activity log.`
                    : `${item.title} will return to active payroll records with Paid status.`
                : `${item.title} will be deleted permanently. This cannot be undone.`,
            confirmButtonText: isRestore ? 'Restore' : 'Delete Permanently',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        setSections((prev) => ({
            ...prev,
            [key]: { ...prev[key], deletingId: item.id },
        }));

        try {
            const payload = isRestore && resources[key].restoreOne
                ? await resources[key].restoreOne(item.id, item)
                : await resources[key].deleteOne(item.id, item);
            if (!payload.success) {
                alert(getMessage(payload, `${isRestore ? 'Failed to restore' : 'Failed to delete'} ${resources[key].label.toLowerCase()}.`));
                return;
            }
            await loadSection(key);
        } catch {
            alert(`Network error while ${isRestore ? 'restoring' : 'deleting'} ${resources[key].label.toLowerCase()}.`);
        } finally {
            setSections((prev) => ({
                ...prev,
                [key]: { ...prev[key], deletingId: null },
            }));
        }
    };

    const handleDeleteAll = async (key: ResourceKey) => {
        const isRestore = key === 'activity' || key === 'payroll';
        const items = isRestore
            ? sections[key].items.filter((item) => item.isArchived)
            : sections[key].items;
        if (items.length === 0) return;

        const bulkDelete = resources[key].deleteAll;
        const confirmed = await confirmAction({
            title: isRestore ? `Restore all archived ${resources[key].label.toLowerCase()}?` : bulkDelete
                ? `Clear all ${resources[key].label.toLowerCase()}?`
                : `Delete all ${resources[key].label.toLowerCase()} records?`,
            text: key === 'activity'
                ? 'All archived activity logs will be restored to the active activity log.'
                : key === 'payroll'
                    ? `All ${items.length} archived payroll record(s) will be restored as Paid.`
                    : bulkDelete
                ? `Every ${resources[key].label.toLowerCase()} record will be permanently deleted. This cannot be undone.`
                : `${items.length} record(s) will be permanently deleted. This cannot be undone.`,
            confirmButtonText: isRestore ? 'Restore All' : bulkDelete ? 'Clear All Permanently' : 'Delete All Permanently',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        setSections((prev) => ({
            ...prev,
            [key]: { ...prev[key], deletingId: -1 },
        }));

        let failed = 0;
        if (key === 'payroll' && resources[key].restoreAll) {
            try {
                const payload = await resources[key].restoreAll(items.map((item) => item.id));
                if (!payload.success) failed = items.length;
            } catch {
                failed = items.length;
            }
        } else if (bulkDelete) {
            try {
                const payload = await bulkDelete();
                if (!payload.success) failed = items.length;
            } catch {
                failed = items.length;
            }
        } else {
            for (const item of items) {
                try {
                    const payload = isRestore && resources[key].restoreOne
                        ? await resources[key].restoreOne(item.id, item)
                        : await resources[key].deleteOne(item.id, item);
                    if (!payload.success) failed += 1;
                } catch {
                    failed += 1;
                }
            }
        }

        await loadSection(key);
        setSections((prev) => ({
            ...prev,
            [key]: { ...prev[key], deletingId: null },
        }));

        if (failed > 0) {
            alert(`${failed} record(s) could not be ${isRestore ? 'restored' : 'deleted'}. Review dependencies and try again.`);
        }
    };

    const totalCandidates = RESOURCE_ORDER.reduce(
        (sum, key) => sum + sections[key].items.length,
        0
    );
    const activeState = sections[activeResource];
    const activeConfig = resources[activeResource];
    const activeFilter = filters[activeResource];
    const currentResourceSupportsRestore = activeResource === 'activity' || activeResource === 'payroll';
    const currentArchivedCount = activeState.items.filter((item) => item.isArchived).length;
    const filteredItems = activeState.items.filter((item) =>
        `${item.title} ${item.meta}`.toLowerCase().includes(activeFilter.trim().toLowerCase())
    );
    const deletingAll = activeState.deletingId === -1;

    if (authLoading) {
        return (
            <SettingsLayout activeSection="data-storage" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }
    if (!user) return null;

    return (
        <SettingsLayout activeSection="data-storage" user={user} onLogout={logout}>
            {loadingPage && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 8, gap: 10, flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0, flex: '1 1 320px' }}>
                        <SettingsPageHeader embedded={embedded} title="Data Storage" onBack={() => router.push('/settings')} />
                        <p style={{ margin: '6px 0 0 0', color: '#6b7280', fontSize: 13 }}>
                            Review archived records and restore them when needed. Archived records: <strong>{totalCandidates}</strong>
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: '0 0 auto', marginLeft: 'auto' }}>
                        {accessGranted && (
                            <>
                                <TinyReloadButton onClick={() => void loadAllSections()} title="Reload all lists" />
                                <button
                                    type="button"
                                    onClick={() => selectResource('payroll')}
                                    style={{ padding: '8px 14px', border: '1px solid #1d4ed8', borderRadius: 8, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 700 }}
                                >
                                    Payroll
                                </button>
                                <button
                                    type="button"
                                    onClick={() => selectResource('overtime')}
                                    style={{ padding: '8px 14px', border: '1px solid #1d4ed8', borderRadius: 8, background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 700 }}
                                >
                                    Overtime
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void loadAllSections()}
                                    style={{ padding: '8px 14px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#374151', cursor: 'pointer', fontWeight: 600 }}
                                >
                                    Refresh All
                                </button>
                            </>
                        )}
                    </div>
                </div>

                {!accessGranted ? (
                    <>
                        <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 10, padding: '12px 14px', marginBottom: 10, fontSize: 13 }}>
                            This page is locked. Enter your admin password, then verify using the 8-digit code sent to your admin email.
                        </div>

                        <section style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, padding: 16, maxWidth: 620 }}>
                            <h2 style={{ margin: 0, fontSize: 14, color: '#111827' }}>Admin Verification Required</h2>
                            <p style={{ margin: '8px 0 14px 0', fontSize: 11, color: '#6b7280' }}>
                                Step 1: confirm your password. Step 2: enter the 8-digit code from {emailMasked || 'your admin email'}.
                            </p>

                            <div style={{ display: 'grid', gap: 10 }}>
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 12, color: '#374151' }}>Admin password</label>
                                    <PasswordInput
                                        value={passwordInput}
                                        onChange={(event) => { setPasswordInput(event.target.value); clearGateFieldError('password'); }}
                                        placeholder="Enter admin password"
                                        disabled={accessBusy}
                                        required
                                        style={{ padding: '8px 10px', border: gateFieldErrors.password ? '2px solid #ef4444' : '1px solid #d1d5db', borderRadius: 8, fontSize: 13 }}
                                    />
                                    {gateFieldErrors.password && <div style={{ fontSize: 12, color: '#b91c1c' }}>{gateFieldErrors.password}</div>}
                                </div>

                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={() => void handleRequestAccessCode()}
                                        disabled={accessBusy || resendAvailableIn > 0}
                                        style={{ padding: '8px 12px', border: '1px solid #1d4ed8', background: '#1d4ed8', color: '#ffffff', borderRadius: 8, fontWeight: 600, cursor: accessBusy || resendAvailableIn > 0 ? 'default' : 'pointer', opacity: accessBusy || resendAvailableIn > 0 ? 0.7 : 1 }}
                                    >
                                        {accessBusy ? 'Sending...' : codeRequested ? 'Resend 8-digit Code' : 'Send 8-digit Code'}
                                    </button>
                                    {resendAvailableIn > 0 && (
                                        <span style={{ fontSize: 12, color: '#6b7280' }}>
                                            You can request another code in {resendAvailableIn}s
                                        </span>
                                    )}
                                </div>

                                {codeRequested && codeSendFailed && (
                                    <div role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                                        The code email could not be sent. Check the server mail settings, then request a new code.
                                    </div>
                                )}

                                {codeRequested && (
                                    <div style={{ display: 'grid', gap: 10, marginTop: 6 }}>
                                        <div style={{ display: 'grid', gap: 6 }}>
                                            <label style={{ fontSize: 12, color: '#374151' }}>Verification code</label>
                                            <input
                                                type="text"
                                                value={codeInput}
                                                onChange={(event) => { setCodeInput(event.target.value.replace(/\D/g, '').slice(0, 8)); clearGateFieldError('code'); }}
                                                inputMode="numeric"
                                                maxLength={8}
                                                placeholder="Enter 8-digit code"
                                                disabled={accessBusy}
                                                required
                                                aria-required="true"
                                                aria-invalid={gateFieldErrors.code ? true : undefined}
                                                style={{ padding: '8px 10px', border: gateFieldErrors.code ? '2px solid #ef4444' : '1px solid #d1d5db', borderRadius: 8, fontSize: 14, letterSpacing: 2 }}
                                            />
                                            {gateFieldErrors.code && <div style={{ fontSize: 12, color: '#b91c1c' }}>{gateFieldErrors.code}</div>}
                                        </div>
                                        <div>
                                            <button
                                                type="button"
                                                onClick={() => void handleVerifyAccessCode()}
                                                disabled={accessBusy}
                                                style={{ padding: '8px 12px', border: '1px solid #111827', background: '#111827', color: '#ffffff', borderRadius: 8, fontWeight: 600, cursor: accessBusy ? 'default' : 'pointer', opacity: accessBusy ? 0.7 : 1 }}
                                            >
                                                {accessBusy ? 'Verifying...' : 'Verify and Unlock'}
                                            </button>
                                        </div>
                                    </div>
                                )}

                            </div>
                        </section>
                    </>
                ) : (
                    <>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16, width: '100%' }}>
                            {RESOURCE_ORDER.map((key) => {
                                const config = resources[key];
                                const isActive = key === activeResource;
                                const count = sections[key].items.length;

                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        onClick={() => selectResource(key)}
                                        style={{
                                            padding: '8px 12px',
                                            borderRadius: 8,
                                            border: isActive ? '1px solid #1d4ed8' : '1px solid #d1d5db',
                                            background: isActive ? '#eff6ff' : '#ffffff',
                                            color: isActive ? '#1d4ed8' : '#374151',
                                            fontWeight: 600,
                                            fontSize: 13,
                                            cursor: 'pointer',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 6,
                                            flexShrink: 0,
                                        }}
                                    >
                                        <span>{config.label}</span>
                                        <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 999, background: isActive ? '#dbeafe' : '#f3f4f6' }}>
                                            {count}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>

                        <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', color: '#1e40af', borderRadius: 10, padding: '12px 14px', marginBottom: 10, fontSize: 13 }}>
                            Activity Logs shows the live system trail and archived entries. Logs older than the current {activityRetentionDays}-day window are archived and can be restored for 180 days; archived logs are then permanently removed automatically. Employee and payroll records use a 5-year (1,825-day) retention period.
                        </div>

                        <section style={{ background: 'white', border: '1px solid #e5e7eb', borderRadius: 12, overflow: 'hidden', minWidth: 0 }}>
                            <div style={{ padding: '14px 16px', borderBottom: '1px solid #f1f5f9', display: 'grid', gap: 10 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <div>
                                            <h2 style={{ margin: 0, fontSize: 14, color: '#111827' }}>{activeConfig.label}</h2>
                                            <p style={{ margin: '4px 0 0 0', fontSize: 12, color: '#6b7280' }}>{activeConfig.subtitle}</p>
                                        </div>
                                        <TinyReloadButton onClick={() => void loadSection(activeResource)} loading={activeState.loading} title={`Reload ${activeConfig.label}`} />
                                    </div>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: 12, color: '#6b7280' }}>
                                            Showing {filteredItems.length} of {activeState.items.length} item(s)
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => setFiltersOpen((open) => !open)}
                                            aria-expanded={filtersOpen}
                                            style={{ padding: '7px 11px', border: filtersOpen ? '1px solid #1d4ed8' : '1px solid #cbd5e1', borderRadius: 8, background: filtersOpen ? '#1d4ed8' : '#fff', color: filtersOpen ? '#fff' : '#334155', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                                        >
                                            {filtersOpen ? 'Hide Filters' : `Filters${activeFilter ? ' (1)' : ''}`}
                                        </button>
                                    </div>
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: '0 0 auto' }}>
                                        <TinyReloadButton onClick={() => void loadSection(activeResource)} loading={!!activeState.loading} title={`Reload ${activeConfig.label}`} />
                                        <button
                                            type="button"
                                            onClick={() => void loadSection(activeResource)}
                                            disabled={activeState.loading || deletingAll}
                                            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#374151', cursor: activeState.loading || deletingAll ? 'default' : 'pointer', opacity: activeState.loading || deletingAll ? 0.6 : 1 }}
                                        >
                                            Refresh
                                        </button>
                                        {activeResource !== 'activity' && (
                                            <button
                                                type="button"
                                                onClick={() => void handleDeleteAll(activeResource)}
                                                disabled={(currentResourceSupportsRestore ? currentArchivedCount === 0 : activeState.items.length === 0) || activeState.loading || deletingAll}
                                                title={currentResourceSupportsRestore ? 'Restore All' : 'Delete All'}
                                                aria-label={`${currentResourceSupportsRestore ? 'Restore all' : 'Delete all'} ${activeConfig.label}`}
                                                style={{ padding: '6px 14px', border: 'none', borderRadius: 8, background: currentResourceSupportsRestore ? '#1d4ed8' : '#b91c1c', color: 'white', cursor: activeState.items.length === 0 || activeState.loading || deletingAll ? 'default' : 'pointer', opacity: (currentResourceSupportsRestore ? currentArchivedCount === 0 : activeState.items.length === 0) || activeState.loading || deletingAll ? 0.6 : 1, fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                            >
                                                {deletingAll ? (currentResourceSupportsRestore ? 'Restoring...' : 'Deleting...') : currentResourceSupportsRestore ? 'Restore All' : 'Delete All'}
                                            </button>
                                        )}
                                    </div>
                                </div>

                                {filtersOpen && (
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', minWidth: 0, flex: '1 1 260px' }}>
                                        <input
                                            type="text"
                                            value={activeFilter}
                                            onChange={(event) =>
                                                setFilters((prev) => ({ ...prev, [activeResource]: event.target.value }))
                                            }
                                            placeholder={`Filter ${activeConfig.label.toLowerCase()}...`}
                                            style={{ minWidth: 0, width: 'min(100%, 290px)', padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827' }}
                                        />
                                        <button
                                            type="button"
                                            onClick={() => setFilters((prev) => ({ ...prev, [activeResource]: '' }))}
                                            disabled={!activeFilter}
                                            style={{ padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 8, background: 'white', color: '#374151', cursor: activeFilter ? 'pointer' : 'default', opacity: activeFilter ? 1 : 0.6 }}
                                        >
                                            Clear
                                        </button>
                                    </div>

                                </div>
                                )}
                            </div>

                            {activeResource === 'activity' && filtersOpen && (
                                <div style={{ padding: '14px 16px', borderBottom: '1px solid #f1f5f9', background: '#f8fafc' }}>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, alignItems: 'end' }}>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>Search</label>
                                            <input
                                                type="text"
                                                value={activityDraft.search}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, search: e.target.value }))}
                                                onKeyDown={(e) => { if (e.key === 'Enter') applyActivityFilters(); }}
                                                placeholder="Action or description"
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            />
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>From</label>
                                            <input
                                                type="date"
                                                value={activityDraft.date_from}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, date_from: e.target.value }))}
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            />
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>To</label>
                                            <input
                                                type="date"
                                                value={activityDraft.date_to}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, date_to: e.target.value }))}
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            />
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>User</label>
                                            <select
                                                value={activityDraft.user_id}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, user_id: e.target.value }))}
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            >
                                                <option value="">All users</option>
                                                {activityMeta.users.map((metaUser) => (
                                                    <option key={metaUser.id} value={metaUser.id}>
                                                        {formatActivityUserLabel(metaUser)}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>Type</label>
                                            <select
                                                value={activityDraft.activity_type}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, activity_type: e.target.value }))}
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            >
                                                <option value="">All types</option>
                                                {activityMeta.types.map((type) => (
                                                    <option key={type} value={type}>
                                                        {formatReadableValue(type)}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>Action</label>
                                            <select
                                                value={activityDraft.action}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, action: e.target.value }))}
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            >
                                                <option value="">All actions</option>
                                                {activityMeta.actions.map((action) => (
                                                    <option key={action} value={action}>
                                                        {formatReadableValue(action)}
                                                    </option>
                                                ))}
                                            </select>
                                        </div>
                                        <div style={{ display: 'grid', gap: 5 }}>
                                            <label style={{ fontSize: 11, fontWeight: 700, color: '#374151' }}>IP Address</label>
                                            <input
                                                type="text"
                                                value={activityDraft.ip_address}
                                                onChange={(e) => setActivityDraft((prev) => ({ ...prev, ip_address: e.target.value }))}
                                                onKeyDown={(e) => { if (e.key === 'Enter') applyActivityFilters(); }}
                                                placeholder="192.168..."
                                                style={{ padding: '7px 10px', border: '1px solid #d1d5db', borderRadius: 8, fontSize: 13, color: '#111827', background: '#fff' }}
                                            />
                                        </div>
                                        <div style={{ display: 'flex', gap: 8 }}>
                                            <button
                                                type="button"
                                                onClick={applyActivityFilters}
                                                style={{ padding: '7px 16px', border: 'none', borderRadius: 8, background: '#1d4ed8', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                                            >
                                                Apply
                                            </button>
                                            <button
                                                type="button"
                                                onClick={clearActivityFilters}
                                                style={{ padding: '7px 16px', border: '1px solid #d1d5db', borderRadius: 8, background: '#fff', color: '#374151', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                                            >
                                                Clear
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}

                            {activeState.loading ? (
                                <div style={{ padding: 16, color: '#6b7280', fontSize: 13 }}>Loading...</div>
                            ) : activeState.items.length === 0 ? (
                                <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>{activeConfig.emptyText}</div>
                            ) : filteredItems.length === 0 ? (
                                <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
                                    No records match the current filter.
                                </div>
                            ) : (
                                <div style={{ width: '100%', overflowX: 'auto' }}>
                                    <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead style={{ background: '#f8fafc' }}>
                                            <tr>
                                                <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 12, color: '#6b7280' }}>Record</th>
                                                <th style={{ textAlign: 'left', padding: '10px 16px', fontSize: 12, color: '#6b7280' }}>Details</th>
                                                <th className="llb-actions-heading" style={{ textAlign: 'right', padding: '10px 16px', fontSize: 12, color: '#6b7280' }}>Action</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {filteredItems.map((item) => (
                                                <tr key={`${activeResource}-${item.isArchived ? 'archived' : 'active'}-${item.id}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                                                    <td style={{ padding: '10px 16px', fontSize: 13, color: '#111827', fontWeight: 600 }} className="llb-trunc" title={item.title}>{item.title}</td>
                                                    <td style={{ padding: '10px 16px', fontSize: 11, color: '#6b7280' }} className="llb-trunc" title={item.meta || ''}>{item.meta || '-'}</td>
                                                    <td style={{ padding: '10px 16px', textAlign: 'right' }} className="llb-actions">
                                                        {activeResource === 'activity' && !item.isArchived ? (
                                                            <span style={{ color: '#64748b', fontSize: 12, fontWeight: 600 }}>Active</span>
                                                        ) : activeResource === 'activity' || activeResource === 'payroll' ? (
                                                            <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                                                                <span style={{ color: '#64748b', fontSize: 12, fontWeight: 600 }}>{inactiveDaysLabel(item.archivedAt)}</span>
                                                                <button
                                                                    type="button"
                                                                    onClick={() => void handleDeleteOne(activeResource, item, 'restore')}
                                                                    disabled={activeState.deletingId === item.id || deletingAll}
                                                                    title={`Restore archived ${activeResource === 'payroll' ? 'payroll record' : 'activity log'}`}
                                                                    aria-label={`Restore ${item.title}`}
                                                                    style={{ padding: '6px 14px', border: 'none', borderRadius: 8, background: '#1d4ed8', color: 'white', cursor: activeState.deletingId === item.id || deletingAll ? 'default' : 'pointer', opacity: activeState.deletingId === item.id || deletingAll ? 0.6 : 1, fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                                                >
                                                                    {activeState.deletingId === item.id ? 'Restoring...' : 'Restore'}
                                                                </button>
                                                                {activeResource === 'payroll' && (
                                                                    <button
                                                                        type="button"
                                                                        onClick={() => void handleDeleteOne(activeResource, item, 'delete')}
                                                                        disabled={activeState.deletingId === item.id || deletingAll}
                                                                        title="Permanently delete this payroll record"
                                                                        aria-label={`Permanently delete ${item.title}`}
                                                                        style={{ padding: '6px 14px', border: 'none', borderRadius: 8, background: '#dc2626', color: 'white', cursor: activeState.deletingId === item.id || deletingAll ? 'default' : 'pointer', opacity: activeState.deletingId === item.id || deletingAll ? 0.6 : 1, fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                                                    >
                                                                        {activeState.deletingId === item.id ? 'Working...' : 'Delete'}
                                                                    </button>
                                                                )}
                                                            </div>
                                                        ) : (
                                                            <button
                                                                type="button"
                                                                onClick={() => void handleDeleteOne(activeResource, item, 'delete')}
                                                                disabled={activeState.deletingId === item.id || deletingAll}
                                                                title="Delete Permanently"
                                                                aria-label={`Delete ${item.title} permanently`}
                                                                style={{ padding: '6px 14px', border: 'none', borderRadius: 8, background: '#dc2626', color: 'white', cursor: activeState.deletingId === item.id || deletingAll ? 'default' : 'pointer', opacity: activeState.deletingId === item.id || deletingAll ? 0.6 : 1, fontWeight: 700, fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                                            >
                                                                {activeState.deletingId === item.id ? 'Deleting...' : 'Delete'}
                                                            </button>
                                                        )}
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </section>
                    </>
                )}
            </div>
        </SettingsLayout>
    );
}
