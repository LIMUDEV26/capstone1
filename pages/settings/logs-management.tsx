import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/router';
import Pagination from '../../components/Pagination';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API_BASE = getApiBaseUrl();

interface ActivityLogRow {
    id: number;
    user_id: number | null;
    action: string;
    description?: string | null;
    activity_type?: string | null;
    ip_address?: string | null;
    created_at: string;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    role?: string | null;
}

interface ActivityLogMetaUser {
    id: number;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    role?: string | null;
}

type LogFilters = {
    search: string;
    date_from: string;
    date_to: string;
    user_id: string;
    activity_type: string;
    action: string;
    ip_address: string;
};

const EMPTY_FILTERS: LogFilters = {
    search: '',
    date_from: '',
    date_to: '',
    user_id: '',
    activity_type: '',
    action: '',
    ip_address: '',
};

function formatDateTime(value?: string | null) {
    if (!value) return '-';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function formatUserLabel(log: Pick<ActivityLogRow, 'first_name' | 'last_name' | 'username' | 'role'>) {
    const fullName = `${String(log.first_name || '').trim()} ${String(log.last_name || '').trim()}`.trim();
    const name = fullName || String(log.username || '').trim() || 'System';
    const role = String(log.role || '').trim();
    return role ? `${name} (${role})` : name;
}

/** @deprecated use formatUserLabel */
function getFullName(log: Pick<ActivityLogRow, 'first_name' | 'last_name' | 'username' | 'role'>) {
    return formatUserLabel(log);
}

function formatReadableValue(value?: string | null, fallback = '-') {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    return raw.replace(/[_-]+/g, ' ');
}

export default function LogsManagementSettingsPage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);
    const [loading, setLoading] = useState(false);
    const [rows, setRows] = useState<ActivityLogRow[]>([]);
    const [total, setTotal] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [draftFilters, setDraftFilters] = useState<LogFilters>(EMPTY_FILTERS);
    const [activeFilters, setActiveFilters] = useState<LogFilters>(EMPTY_FILTERS);
    const [metaUsers, setMetaUsers] = useState<ActivityLogMetaUser[]>([]);
    const [metaTypes, setMetaTypes] = useState<string[]>([]);
    const [metaActions, setMetaActions] = useState<string[]>([]);
    const [selectedLog, setSelectedLog] = useState<ActivityLogRow | null>(null);
    const [detailOpen, setDetailOpen] = useState(false);
    const [expandedViewerOpen, setExpandedViewerOpen] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [expandedFiltersOpen, setExpandedFiltersOpen] = useState(false);
    const [error, setError] = useState('');
    const [archiveOpen, setArchiveOpen] = useState(false);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    // Render the page shell immediately after auth resolves; data loads in
    // the background. Never trap on full-page "Loading..." for data fetch.
    const userId = user?.id;
    useEffect(() => {
        if (authLoading) return;
        if (!userId) {
            setPageLoading(false);
            return;
        }

        let active = true;
        const bootstrap = async () => {
            try {
                await fetchMeta();
            } finally {
                if (active) {
                    setPageLoading(false);
                }
            }
        };

        void bootstrap();
        return () => {
            active = false;
        };
    }, [authLoading, userId]);

    useEffect(() => {
        if (authLoading || !userId) return;
        void fetchLogs(currentPage, activeFilters);
    }, [activeFilters, authLoading, currentPage, userId]);

    const fetchMeta = async () => {
        try {
            const response = await fetch(`${API_BASE}/activity-logs.php?meta=1`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to load log filters.');
                return;
            }

            setMetaUsers(Array.isArray(result.users) ? result.users : []);
            setMetaTypes(Array.isArray(result.types) ? result.types : []);
            setMetaActions(Array.isArray(result.actions) ? result.actions : []);
        } catch {
            setError('Unable to load log filters right now.');
        }
    };

    const fetchLogs = async (page: number, filters: LogFilters) => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (filters.search) params.set('search', filters.search);
            if (filters.date_from) params.set('date_from', filters.date_from);
            if (filters.date_to) params.set('date_to', filters.date_to);
            if (filters.user_id) params.set('user_id', filters.user_id);
            if (filters.activity_type) params.set('activity_type', filters.activity_type);
            if (filters.action) params.set('action', filters.action);
            if (filters.ip_address) params.set('ip_address', filters.ip_address);
            params.set('limit', String(ITEMS_PER_PAGE));
            params.set('offset', String((page - 1) * ITEMS_PER_PAGE));

            const response = await fetch(`${API_BASE}/activity-logs.php?${params.toString()}`, {
                credentials: 'include',
            });
            const result = await response.json();

            if (!response.ok || !result.success) {
                setRows([]);
                setTotal(0);
                setSelectedLog(null);
                setDetailOpen(false);
                setError(result.message || 'Failed to load activity logs.');
                return;
            }

            const nextRows = Array.isArray(result.data) ? result.data as ActivityLogRow[] : [];
            const nextTotal = typeof result.total === 'number' ? result.total : nextRows.length;

            setRows(nextRows);
            setTotal(nextTotal);
            setSelectedLog((current) => {
                if (!nextRows.length) return null;
                if (current && nextRows.some((row) => row.id === current.id)) {
                    return nextRows.find((row) => row.id === current.id) || null;
                }
                return nextRows[0] || null;
            });
            if (!nextRows.length) {
                setDetailOpen(false);
            }
        } catch {
            setRows([]);
            setTotal(0);
            setSelectedLog(null);
            setDetailOpen(false);
            setError('Unable to connect to the activity log service.');
        } finally {
            setLoading(false);
        }
    };

    const showingRange = useMemo(() => {
        if (total === 0 || rows.length === 0) {
            return 'Showing 0 of 0 logs';
        }
        const start = (currentPage - 1) * ITEMS_PER_PAGE + 1;
        const end = Math.min(currentPage * ITEMS_PER_PAGE, total);
        return `Showing ${start}-${end} of ${total} logs`;
    }, [currentPage, rows.length, total]);

    const activeFilterEntries = useMemo(() => {
        const entries: string[] = [];
        if (activeFilters.search) entries.push(`Search: ${activeFilters.search}`);
        if (activeFilters.date_from) entries.push(`From: ${activeFilters.date_from}`);
        if (activeFilters.date_to) entries.push(`To: ${activeFilters.date_to}`);
        if (activeFilters.user_id) {
            const selectedUser = metaUsers.find((entry) => String(entry.id) === activeFilters.user_id);
            entries.push(`User: ${selectedUser ? formatUserLabel(selectedUser) : activeFilters.user_id}`);
        }
        if (activeFilters.activity_type) entries.push(`Type: ${formatReadableValue(activeFilters.activity_type)}`);
        if (activeFilters.action) entries.push(`Action: ${formatReadableValue(activeFilters.action)}`);
        if (activeFilters.ip_address) entries.push(`IP: ${activeFilters.ip_address}`);
        return entries;
    }, [activeFilters, metaUsers]);

    const applyFilters = () => {
        setCurrentPage(1);
        setActiveFilters({
            search: draftFilters.search.trim(),
            date_from: draftFilters.date_from,
            date_to: draftFilters.date_to,
            user_id: draftFilters.user_id,
            activity_type: draftFilters.activity_type,
            action: draftFilters.action,
            ip_address: draftFilters.ip_address.trim(),
        });
    };

    const clearFilters = () => {
        setDraftFilters(EMPTY_FILTERS);
        setCurrentPage(1);
        setActiveFilters(EMPTY_FILTERS);
    };

    const openLogDetails = (row: ActivityLogRow) => {
        setSelectedLog(row);
        setDetailOpen(true);
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="logs-management" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="logs-management" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'grid', gap: 10 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <SettingsPageHeader embedded={embedded} title="Logs Management" onBack={() => router.push('/settings')} />
                        <TinyReloadButton onClick={() => void fetchLogs(currentPage, activeFilters)} loading={loading} title="Reload logs" />
                    </div>
                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                        <button
                            type="button"
                            onClick={() => setFiltersOpen((open) => !open)}
                            aria-expanded={filtersOpen}
                            style={filtersOpen ? primaryButtonStyle : secondaryButtonStyle}
                        >
                            {filtersOpen ? 'Hide Filters' : `Filters${activeFilterEntries.length ? ` (${activeFilterEntries.length})` : ''}`}
                        </button>
                        <button
                            type="button"
                            onClick={() => setExpandedViewerOpen(true)}
                            style={{
                                border: 'none',
                                background: '#0f172a',
                                color: '#ffffff',
                                borderRadius: 10,
                                padding: '9px 14px',
                                cursor: 'pointer',
                                fontWeight: 700,
                            }}
                        >
                            Expand Viewer
                        </button>
                        <button
                            type="button"
                            onClick={() => void fetchLogs(currentPage, activeFilters)}
                            disabled={loading}
                            style={{
                                border: '1px solid #cbd5e1',
                                background: '#ffffff',
                                color: '#0f172a',
                                borderRadius: 10,
                                padding: '9px 14px',
                                cursor: 'pointer',
                                fontWeight: 600,
                                opacity: loading ? 0.7 : 1,
                            }}
                        >
                            {loading ? 'Refreshing...' : 'Refresh Logs'}
                        </button>
                        <button
                            type="button"
                            onClick={() => setArchiveOpen((open) => !open)}
                            aria-expanded={archiveOpen}
                            style={archiveOpen ? primaryButtonStyle : secondaryButtonStyle}
                        >
                            {archiveOpen ? 'Hide Archive' : 'Archive & Retention'}
                        </button>
                    </div>
                </div>

                {filtersOpen && (
                    <LogFiltersPanel
                        draftFilters={draftFilters}
                        setDraftFilters={setDraftFilters}
                        metaUsers={metaUsers}
                        metaTypes={metaTypes}
                        metaActions={metaActions}
                        onApply={applyFilters}
                        onClear={clearFilters}
                    />
                )}

                {(!filtersOpen || activeFilterEntries.length > 0) && (
                    <ActiveFilterSummary activeFilterEntries={activeFilterEntries} />
                )}

                {archiveOpen && <ActivityLogArchivePanel />}

                <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '16px 18px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <div>
                                <h2 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>Activity Log Records</h2>
                                <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 13 }}>Filter, review, and inspect the latest system audit events.</p>
                            </div>
                            <TinyReloadButton onClick={() => void fetchLogs(currentPage, activeFilters)} loading={loading} title="Reload logs" />
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{showingRange}</div>
                            <button
                                type="button"
                                onClick={() => setExpandedViewerOpen(true)}
                                style={{
                                    border: '1px solid #cbd5e1',
                                    background: '#ffffff',
                                    color: '#0f172a',
                                    borderRadius: 10,
                                    padding: '8px 12px',
                                    cursor: 'pointer',
                                    fontWeight: 700,
                                }}
                            >
                                Full Page
                            </button>
                        </div>
                    </div>

                    <LogsTable
                        rows={rows}
                        loading={loading}
                        selectedLogId={selectedLog?.id ?? null}
                        onSelect={openLogDetails}
                        searchQuery={activeFilters.search}
                        alternatives={getAlternativeSuggestions(activeFilters.search, collectSearchTerms(rows, [
                            (row: any) => row.action,
                            (row: any) => row.description,
                            (row: any) => row.ip_address,
                        ]))}
                        onPickAlternative={(term) => {
                            const next = { ...draftFilters, search: term };
                            setDraftFilters(next);
                            setCurrentPage(1);
                            setActiveFilters(next);
                        }}
                        onClearFilters={clearFilters}
                    />
                </div>

                <Pagination
                    currentPage={currentPage}
                    totalItems={total}
                    itemsPerPage={ITEMS_PER_PAGE}
                    onPageChange={setCurrentPage}
                    label="logs"
                />
            </div>

            {detailOpen && selectedLog && (
                <div style={modalOverlayStyle} onClick={() => setDetailOpen(false)}>
                    <div style={floatingCardStyle} onClick={(event) => event.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                            <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Activity Log</div>
                                <h2 style={{ margin: '6px 0 0', fontSize: 18, color: '#0f172a' }}>Log Details</h2>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setDetailOpen(false);
                                        setExpandedViewerOpen(true);
                                    }}
                                    style={secondaryButtonStyle}
                                >
                                    Expand Viewer
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setDetailOpen(false)}
                                    style={secondaryButtonStyle}
                                >
                                    Close
                                </button>
                            </div>
                        </div>

                        <LogDetailsGrid log={selectedLog} />
                    </div>
                </div>
            )}

            {expandedViewerOpen && (
                <div style={fullscreenOverlayStyle} onClick={() => setExpandedViewerOpen(false)}>
                    <div style={expandedViewerStyle} onClick={(event) => event.stopPropagation()}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #e5e7eb', flexShrink: 0, flexWrap: 'wrap' }}>
                            <div>
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: '0.08em', textTransform: 'uppercase' }}>Full Page Logs Viewer</div>
                                <h2 style={{ margin: '6px 0 0', fontSize: 20, color: '#0f172a' }}>Activity Log Records</h2>
                            </div>
                            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => setExpandedFiltersOpen((open) => !open)}
                                    aria-expanded={expandedFiltersOpen}
                                    style={expandedFiltersOpen ? primaryButtonStyle : secondaryButtonStyle}
                                >
                                    {expandedFiltersOpen ? 'Hide Filters' : `Filters${activeFilterEntries.length ? ` (${activeFilterEntries.length})` : ''}`}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void fetchLogs(currentPage, activeFilters)}
                                    disabled={loading}
                                    style={secondaryButtonStyle}
                                >
                                    {loading ? 'Refreshing...' : 'Refresh'}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setExpandedViewerOpen(false)}
                                    style={secondaryButtonStyle}
                                >
                                    Close
                                </button>
                            </div>
                        </div>

                        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 16, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto', gap: 10 }}>
                            {expandedFiltersOpen && (
                                <LogFiltersPanel
                                    draftFilters={draftFilters}
                                    setDraftFilters={setDraftFilters}
                                    metaUsers={metaUsers}
                                    metaTypes={metaTypes}
                                    metaActions={metaActions}
                                    onApply={applyFilters}
                                    onClear={clearFilters}
                                    compact
                                />
                            )}

                            {!expandedFiltersOpen && activeFilterEntries.length > 0 && (
                                <ActiveFilterSummary activeFilterEntries={activeFilterEntries} />
                            )}

                            <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', padding: '16px 18px', borderBottom: '1px solid #e5e7eb', flexWrap: 'wrap' }}>
                                    <div>
                                        <h3 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>Expanded Logs Table</h3>
                                        <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 13 }}>Click any log row to open the floating details card.</p>
                                    </div>
                                    <div style={{ fontSize: 12, fontWeight: 700, color: '#475569' }}>{showingRange}</div>
                                </div>
                                <div style={{ flex: 1, minHeight: 320, maxHeight: '100%', overflow: 'auto' }}>
                                    <LogsTable
                                        rows={rows}
                                        loading={loading}
                                        selectedLogId={selectedLog?.id ?? null}
                                        onSelect={openLogDetails}
                                        searchQuery={activeFilters.search}
                                        alternatives={getAlternativeSuggestions(activeFilters.search, collectSearchTerms(rows, [
                                            (row: any) => row.action,
                                            (row: any) => row.description,
                                            (row: any) => row.ip_address,
                                        ]))}
                                        onPickAlternative={(term) => {
                                            const next = { ...draftFilters, search: term };
                                            setDraftFilters(next);
                                            setCurrentPage(1);
                                            setActiveFilters(next);
                                        }}
                                        onClearFilters={clearFilters}
                                    />
                                </div>
                            </div>

                            <Pagination
                                currentPage={currentPage}
                                totalItems={total}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={setCurrentPage}
                                label="logs"
                            />
                        </div>
                    </div>
                </div>
            )}
        </SettingsLayout>
    );
}

function LogFiltersPanel({
    draftFilters,
    setDraftFilters,
    metaUsers,
    metaTypes,
    metaActions,
    onApply,
    onClear,
    compact = false,
}: {
    draftFilters: LogFilters;
    setDraftFilters: React.Dispatch<React.SetStateAction<LogFilters>>;
    metaUsers: ActivityLogMetaUser[];
    metaTypes: string[];
    metaActions: string[];
    onApply: () => void;
    onClear: () => void;
    compact?: boolean;
}) {
    const fieldStyle = compact
        ? { display: 'grid', gap: 4, minWidth: 118, flex: '1 1 118px' }
        : { display: 'grid', gap: 6 };
    return (
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: compact ? 12 : 16, padding: compact ? 10 : 18 }}>
            <div style={compact
                ? { display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'nowrap', overflowX: 'auto', paddingBottom: 2 }
                : { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
                <div style={compact ? { ...fieldStyle, minWidth: 180, flexBasis: 180 } : fieldStyle}>
                    <label style={filterLabelStyle}>Search</label>
                    <SearchBar
                        storageKey="logs:filters"
                        placeholder="Action, description, or IP"
                        ariaLabel="Search activity logs"
                        value={draftFilters.search}
                        onChange={(value) => setDraftFilters((prev) => ({ ...prev, search: value }))}
                        onSearch={() => onApply()}
                        suggestions={collectSearchTerms(
                            [...metaActions, ...metaTypes],
                            [(t: string) => t]
                        )}
                        inputStyle={{ ...filterInputStyle, width: '100%' }}
                    />
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>From</label>
                    <input
                        type="date"
                        value={draftFilters.date_from}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, date_from: event.target.value }))}
                        style={filterInputStyle}
                    />
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>To</label>
                    <input
                        type="date"
                        value={draftFilters.date_to}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, date_to: event.target.value }))}
                        style={filterInputStyle}
                    />
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>User</label>
                    <select
                        value={draftFilters.user_id}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, user_id: event.target.value }))}
                        style={filterInputStyle}
                    >
                        <option value="">All users</option>
                        {metaUsers.map((metaUser) => (
                            <option key={metaUser.id} value={metaUser.id}>
                                {formatUserLabel(metaUser) || `User #${metaUser.id}`}
                            </option>
                        ))}
                    </select>
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>Type</label>
                    <select
                        value={draftFilters.activity_type}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, activity_type: event.target.value }))}
                        style={filterInputStyle}
                    >
                        <option value="">All types</option>
                        {metaTypes.map((type) => (
                            <option key={type} value={type}>
                                {formatReadableValue(type)}
                            </option>
                        ))}
                    </select>
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>Action</label>
                    <select
                        value={draftFilters.action}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, action: event.target.value }))}
                        style={filterInputStyle}
                    >
                        <option value="">All actions</option>
                        {metaActions.map((action) => (
                            <option key={action} value={action}>
                                {formatReadableValue(action)}
                            </option>
                        ))}
                    </select>
                </div>

                <div style={fieldStyle}>
                    <label style={filterLabelStyle}>IP Address</label>
                    <input
                        type="text"
                        value={draftFilters.ip_address}
                        onChange={(event) => setDraftFilters((prev) => ({ ...prev, ip_address: event.target.value }))}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') onApply();
                        }}
                        placeholder="192.168..."
                        style={filterInputStyle}
                    />
                </div>

                <div style={{ display: 'flex', gap: 6, flexWrap: 'nowrap', flex: '0 0 auto' }}>
                    <button type="button" onClick={onApply} style={primaryButtonStyle}>
                        Apply
                    </button>
                    <button type="button" onClick={onClear} style={secondaryButtonStyle}>
                        Clear
                    </button>
                </div>
            </div>
        </div>
    );
}

function ActiveFilterSummary({ activeFilterEntries }: { activeFilterEntries: string[] }) {
    return (
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 }}>
                Current Filters
            </div>
            {activeFilterEntries.length === 0 ? (
                <div style={{ color: '#94a3b8', fontSize: 13 }}>No specific filters applied. Showing the latest available logs.</div>
            ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {activeFilterEntries.map((entry) => (
                        <span key={entry} style={summaryChipStyle}>
                            {entry}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function LogsTable({
    rows,
    loading,
    selectedLogId,
    onSelect,
    searchQuery,
    alternatives,
    onPickAlternative,
    onClearFilters,
}: {
    rows: ActivityLogRow[];
    loading: boolean;
    selectedLogId: number | null;
    onSelect: (row: ActivityLogRow) => void;
    searchQuery: string;
    alternatives: string[];
    onPickAlternative: (term: string) => void;
    onClearFilters: () => void;
}) {
    return (
        <div style={{ overflowX: 'auto' }}>
            <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead style={{ background: '#f8fafc' }}>
                    <tr>
                        <th style={headerCellStyle}>Time</th>
                        <th style={headerCellStyle}>User</th>
                        <th style={headerCellStyle}>Action</th>
                        <th style={headerCellStyle}>Description</th>
                        <th style={headerCellStyle}>Type</th>
                        <th style={headerCellStyle}>IP Address</th>
                    </tr>
                </thead>
                <tbody>
                    {loading && rows.length === 0 ? (
                        <tr>
                            <td colSpan={6} style={emptyCellStyle}>Loading logs...</td>
                        </tr>
                    ) : rows.length === 0 ? (
                        <tr>
                            <td colSpan={6} style={{ ...emptyCellStyle, padding: 12 }}>
                                <ZeroResults
                                    query={searchQuery}
                                    itemLabel="activity logs"
                                    alternatives={alternatives}
                                    onPickAlternative={onPickAlternative}
                                    onClear={onClearFilters}
                                    clearLabel="Clear all filters"
                                />
                            </td>
                        </tr>
                    ) : (
                        rows.map((row) => {
                            const isSelected = selectedLogId === row.id;
                            return (
                                <tr
                                    key={row.id}
                                    onClick={() => onSelect(row)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter' || event.key === ' ') {
                                            event.preventDefault();
                                            onSelect(row);
                                        }
                                    }}
                                    tabIndex={0}
                                    role="button"
                                    aria-label={`Open log ${row.id}`}
                                    style={{
                                        borderTop: '1px solid #eef2f7',
                                        background: isSelected ? '#eff6ff' : '#ffffff',
                                        cursor: 'pointer',
                                        boxShadow: isSelected ? 'inset 3px 0 0 #1d4ed8' : 'none',
                                    }}
                                >
                                    <td style={bodyCellMutedStyle}>{formatDateTime(row.created_at)}</td>
                                    <td style={bodyCellStyle} className="llb-trunc" title={formatUserLabel(row)}>{formatUserLabel(row)}</td>
                                    <td style={bodyCellStyle}>
                                        <span style={actionPillStyle}>{row.action || '-'}</span>
                                    </td>
                                    <td style={{ ...bodyCellStyle, maxWidth: 360 }} className="llb-trunc" title={row.description || ''}>
                                        <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            {row.description || '-'}
                                        </div>
                                    </td>
                                    <td style={bodyCellStyle}>
                                        <span style={typePillStyle}>{formatReadableValue(row.activity_type)}</span>
                                    </td>
                                    <td style={bodyCellMonospaceStyle}>{row.ip_address || '-'}</td>
                                </tr>
                            );
                        })
                    )}
                </tbody>
            </table>
        </div>
    );
}

function LogDetailsGrid({ log }: { log: ActivityLogRow }) {
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Time</div>
                <div style={detailValueStyle}>{formatDateTime(log.created_at)}</div>
            </div>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>User</div>
                <div style={detailValueStyle}>{formatUserLabel(log)}</div>
            </div>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Action</div>
                <div style={detailValueStyle}>{formatReadableValue(log.action)}</div>
            </div>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Type</div>
                <div style={detailValueStyle}>{formatReadableValue(log.activity_type)}</div>
            </div>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>IP Address</div>
                <div style={{ ...detailValueStyle, fontFamily: 'monospace' }}>{log.ip_address || '-'}</div>
            </div>
            <div style={detailCardStyle}>
                <div style={detailLabelStyle}>Log ID</div>
                <div style={{ ...detailValueStyle, fontFamily: 'monospace' }}>{log.id}</div>
            </div>
            <div style={{ ...detailCardStyle, gridColumn: '1 / -1' }}>
                <div style={detailLabelStyle}>Description</div>
                <div style={{ ...detailValueStyle, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                    {log.description || 'No description provided.'}
                </div>
            </div>
        </div>
    );
}

interface ArchivePolicy {
    retention_days: number;
    cutoff_at: string;
    live_count: number;
    stale_count: number;
    archived_count: number;
    batch_count: number;
}

interface ArchiveBatch {
    batch_id: number;
    file_name: string | null;
    row_count: number;
    checksum_sha256: string | null;
    retention_days: number;
    cutoff_at: string;
    source: string;
    created_at: string;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
}

interface ArchivedLogRow {
    archive_id: number;
    log_id: number;
    archive_batch_id: number | null;
    action: string;
    description?: string | null;
    activity_type?: string | null;
    ip_address?: string | null;
    created_at: string;
    archived_at: string;
    first_name?: string | null;
    last_name?: string | null;
    username?: string | null;
    role?: string | null;
}

/**
 * Retention + archive panel. Backs onto api/activity-log-archive.php (admin only):
 * logs past the retention window are MOVED out of activity_log into the archive
 * (CSV artifact + database) and can be viewed / re-imported. Never hard-deleted.
 */
function ActivityLogArchivePanel() {
    const [policy, setPolicy] = useState<ArchivePolicy | null>(null);
    const [retention, setRetention] = useState('90');
    const [batches, setBatches] = useState<ArchiveBatch[]>([]);
    const [activeBatch, setActiveBatch] = useState<number | null>(null);
    const [archivedRows, setArchivedRows] = useState<ArchivedLogRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    const loadPolicy = async () => {
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=policy`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to load the retention policy.');
                return;
            }
            const data = result.data as ArchivePolicy;
            setPolicy(data);
            setRetention(String(data.retention_days));
        } catch {
            setError('Unable to load the retention policy.');
        }
    };

    const loadBatches = async () => {
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=list_batches`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to load archive batches.');
                return;
            }
            setBatches(Array.isArray(result.data) ? result.data as ArchiveBatch[] : []);
        } catch {
            setError('Unable to load archive batches.');
        }
    };

    useEffect(() => {
        void loadPolicy();
        void loadBatches();
    }, []);

    const savePolicy = async () => {
        const days = Number.parseInt(retention, 10);
        if (Number.isNaN(days) || days < 1 || days > 3650) {
            setError('Retention must be between 1 and 3650 days.');
            return;
        }
        setBusy(true);
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=set_policy`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ retention_days: days }),
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to save the retention policy.');
                return;
            }
            await notifySuccess(result.message || `Retention set to ${days} day(s).`);
            await loadPolicy();
        } catch {
            setError('Unable to save the retention policy.');
        } finally {
            setBusy(false);
        }
    };

    const archiveNow = async () => {
        const accepted = await confirmAction({
            title: 'Archive old activity logs?',
            text: `Logs older than ${retention} day(s) are moved out of the live table into the archive (CSV artifact + database). Nothing is deleted.`,
            confirmButtonText: 'Archive now',
        });
        if (!accepted) return;
        setBusy(true);
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=archive_now`, {
                method: 'POST',
                credentials: 'include',
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to archive activity logs.');
                return;
            }
            await notifySuccess(result.message || 'Activity logs archived.');
            await loadPolicy();
            await loadBatches();
        } catch {
            setError('Unable to archive activity logs.');
        } finally {
            setBusy(false);
        }
    };

    const viewBatch = async (batchId: number) => {
        setBusy(true);
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=list&batch=${batchId}&limit=500`, { credentials: 'include' });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to load archived logs.');
                return;
            }
            setActiveBatch(batchId);
            setArchivedRows(Array.isArray(result.data?.data) ? result.data.data as ArchivedLogRow[] : []);
        } catch {
            setError('Unable to load archived logs.');
        } finally {
            setBusy(false);
        }
    };

    const downloadBatch = (batch: ArchiveBatch) => {
        if (!batch.file_name) {
            setError('This batch has no CSV file on disk.');
            return;
        }
        window.open(`${API_BASE}/activity-log-archive.php?action=download&batch=${batch.batch_id}`, '_blank', 'noopener');
    };

    const importCsv = async (file: File) => {
        const form = new FormData();
        form.append('file', file);
        setBusy(true);
        try {
            const response = await fetch(`${API_BASE}/activity-log-archive.php?action=import`, {
                method: 'POST',
                credentials: 'include',
                body: form,
            });
            const result = await response.json();
            if (!response.ok || !result.success) {
                setError(result.message || 'Failed to import the archive CSV.');
                return;
            }
            await notifySuccess(result.message || 'Archive CSV imported.');
            await loadPolicy();
            await loadBatches();
            const importedBatch = Number(result.data?.batch_id ?? 0);
            if (importedBatch > 0) await viewBatch(importedBatch);
        } catch {
            setError('Unable to import the archive CSV.');
        } finally {
            setBusy(false);
        }
    };

    const summaryItems: Array<[string, number | string]> = policy
        ? [
            ['Live logs', policy.live_count],
            ['Archivable now', policy.stale_count],
            ['Archived', policy.archived_count],
            ['Batches', policy.batch_count],
            ['Cutoff', formatDateTime(policy.cutoff_at)],
        ]
        : [];

    return (
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: 16, padding: 18, display: 'grid', gap: 16 }}>
            <div>
                <h3 style={{ margin: 0, fontSize: 16, color: '#0f172a' }}>Archive &amp; Retention</h3>
                <p style={{ margin: '6px 0 0', color: '#64748b', fontSize: 13 }}>
                    Logs older than the retention window are moved into the archive (CSV artifact + database) — never deleted. View or re-import archived logs here.
                </p>
            </div>

            {summaryItems.length > 0 && (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {summaryItems.map(([label, value]) => (
                        <span key={label} style={summaryChipStyle}>{label}: {value}</span>
                    ))}
                </div>
            )}

            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <div style={{ display: 'grid', gap: 6 }}>
                    <label style={filterLabelStyle}>Retention (days)</label>
                    <input
                        type="number"
                        min={1}
                        max={3650}
                        value={retention}
                        onChange={(event) => setRetention(event.target.value)}
                        style={{ ...filterInputStyle, width: 140 }}
                    />
                </div>
                <button type="button" onClick={() => void savePolicy()} disabled={busy} style={primaryButtonStyle}>
                    Save Retention
                </button>
                <button type="button" onClick={() => void archiveNow()} disabled={busy} style={secondaryButtonStyle}>
                    Archive Now
                </button>
                <label style={{ ...secondaryButtonStyle, display: 'inline-flex', alignItems: 'center', gap: 8, opacity: busy ? 0.7 : 1 }}>
                    Import CSV
                    <input
                        type="file"
                        accept=".csv,text/csv"
                        style={{ display: 'none' }}
                        disabled={busy}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            if (file) void importCsv(file);
                        }}
                    />
                </label>
                <span style={{ fontSize: 12, color: '#64748b' }}>Default 90 days. Logs are moved, not deleted.</span>
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    Archive Batches
                </div>
                <div style={{ overflowX: 'auto' }}>
                    <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#f8fafc' }}>
                            <tr>
                                <th style={headerCellStyle}>Batch</th>
                                <th style={headerCellStyle}>Source</th>
                                <th style={headerCellStyle}>Rows</th>
                                <th style={headerCellStyle}>Retention</th>
                                <th style={headerCellStyle}>Archived By</th>
                                <th style={headerCellStyle}>Created</th>
                                <th style={headerCellStyle}>CSV</th>
                                <th style={headerCellStyle}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {batches.length === 0 ? (
                                <tr>
                                    <td colSpan={8} style={emptyCellStyle}>No archive batches yet.</td>
                                </tr>
                            ) : batches.map((batch) => (
                                <tr key={batch.batch_id} style={{ borderTop: '1px solid #eef2f7' }}>
                                    <td style={bodyCellMonospaceStyle}>#{batch.batch_id}</td>
                                    <td style={bodyCellStyle}>{formatReadableValue(batch.source)}</td>
                                    <td style={bodyCellStyle}>{batch.row_count}</td>
                                    <td style={bodyCellMutedStyle}>{batch.retention_days}d</td>
                                    <td style={bodyCellStyle}>{`${String(batch.first_name || '').trim()} ${String(batch.last_name || '').trim()}`.trim() || batch.username || 'System'}</td>
                                    <td style={bodyCellMutedStyle}>{formatDateTime(batch.created_at)}</td>
                                    <td style={bodyCellStyle}>
                                        {batch.file_name ? (
                                            <button
                                                type="button"
                                                onClick={() => downloadBatch(batch)}
                                                style={{ ...secondaryButtonStyle, padding: '6px 10px', fontSize: 12 }}
                                            >
                                                Download
                                            </button>
                                        ) : (
                                            <span style={{ color: '#94a3b8' }}>—</span>
                                        )}
                                    </td>
                                    <td style={bodyCellStyle}>
                                        <button
                                            type="button"
                                            onClick={() => void viewBatch(batch.batch_id)}
                                            disabled={busy}
                                            style={{ ...primaryButtonStyle, padding: '6px 10px', fontSize: 12 }}
                                        >
                                            View
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {activeBatch !== null && (
                <div style={{ display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                            Archived Logs — Batch #{activeBatch} ({archivedRows.length})
                        </div>
                        <button
                            type="button"
                            onClick={() => { setActiveBatch(null); setArchivedRows([]); }}
                            style={{ ...secondaryButtonStyle, padding: '6px 10px', fontSize: 12 }}
                        >
                            Close
                        </button>
                    </div>
                    <div style={{ overflowX: 'auto', maxHeight: 420, border: '1px solid #e5e7eb', borderRadius: 12 }}>
                        <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead style={{ background: '#f8fafc' }}>
                                <tr>
                                    <th style={headerCellStyle}>Original Time</th>
                                    <th style={headerCellStyle}>Log ID</th>
                                    <th style={headerCellStyle}>User</th>
                                    <th style={headerCellStyle}>Action</th>
                                    <th style={headerCellStyle}>Description</th>
                                    <th style={headerCellStyle}>Type</th>
                                    <th style={headerCellStyle}>IP Address</th>
                                    <th style={headerCellStyle}>Archived</th>
                                </tr>
                            </thead>
                            <tbody>
                                {archivedRows.length === 0 ? (
                                    <tr>
                                        <td colSpan={8} style={emptyCellStyle}>No archived rows in this batch.</td>
                                    </tr>
                                ) : archivedRows.map((row) => (
                                    <tr key={row.archive_id} style={{ borderTop: '1px solid #eef2f7' }}>
                                        <td style={bodyCellMutedStyle}>{formatDateTime(row.created_at)}</td>
                                        <td style={bodyCellMonospaceStyle}>{row.log_id}</td>
                                        <td style={bodyCellStyle} className="llb-trunc" title={formatUserLabel(row)}>{formatUserLabel(row)}</td>
                                        <td style={bodyCellStyle}>
                                            <span style={actionPillStyle}>{row.action || '-'}</span>
                                        </td>
                                        <td style={{ ...bodyCellStyle, maxWidth: 360 }} className="llb-trunc" title={row.description || ''}>
                                            {row.description || '-'}
                                        </td>
                                        <td style={bodyCellStyle}>
                                            <span style={typePillStyle}>{formatReadableValue(row.activity_type)}</span>
                                        </td>
                                        <td style={bodyCellMonospaceStyle}>{row.ip_address || '-'}</td>
                                        <td style={bodyCellMutedStyle}>{formatDateTime(row.archived_at)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
}

const headerCellStyle = {
    padding: '12px 14px',
    textAlign: 'left' as const,
    color: '#475569',
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap' as const,
};

const bodyCellStyle = {
    padding: '12px 14px',
    color: '#0f172a',
    fontSize: 13,
    verticalAlign: 'top' as const,
};

const bodyCellMutedStyle = {
    ...bodyCellStyle,
    color: '#64748b',
    whiteSpace: 'nowrap' as const,
};

const bodyCellMonospaceStyle = {
    ...bodyCellStyle,
    color: '#64748b',
    fontFamily: 'monospace',
    whiteSpace: 'nowrap' as const,
};

const emptyCellStyle = {
    padding: '24px 16px',
    textAlign: 'center' as const,
    color: '#64748b',
    fontSize: 13,
};

const actionPillStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 9px',
    borderRadius: 999,
    background: '#eff6ff',
    color: '#1d4ed8',
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '0.03em',
    textTransform: 'uppercase' as const,
};

const typePillStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '4px 9px',
    borderRadius: 999,
    background: '#f0fdf4',
    color: '#166534',
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'capitalize' as const,
};

const detailCardStyle = {
    background: '#f8fafc',
    border: '1px solid #e2e8f0',
    borderRadius: 12,
    padding: '12px 14px',
};

const detailLabelStyle = {
    fontSize: 11,
    color: '#64748b',
    fontWeight: 700,
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
    marginBottom: 6,
};

const detailValueStyle = {
    fontSize: 13,
    color: '#0f172a',
    fontWeight: 500,
};

const primaryButtonStyle = {
    border: 'none',
    background: '#1d4ed8',
    color: '#ffffff',
    borderRadius: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    fontWeight: 700,
};

const secondaryButtonStyle = {
    border: '1px solid #cbd5e1',
    background: '#ffffff',
    color: '#334155',
    borderRadius: 10,
    padding: '10px 14px',
    cursor: 'pointer',
    fontWeight: 600,
};

const filterLabelStyle = {
    fontSize: 12,
    color: '#475569',
    fontWeight: 700,
};

const filterInputStyle = {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid #d1d5db',
    fontSize: 14,
    background: '#fff',
};

const summaryChipStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: 999,
    background: '#eff6ff',
    color: '#1d4ed8',
    fontSize: 12,
    fontWeight: 700,
};

const modalOverlayStyle = {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    zIndex: 20000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
};

const fullscreenOverlayStyle = {
    position: 'fixed' as const,
    inset: 0,
    background: 'rgba(15, 23, 42, 0.45)',
    zIndex: 20000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
};

const floatingCardStyle = {
    width: 'min(860px, 96%)',
    maxHeight: '86vh',
    overflow: 'auto',
    background: '#ffffff',
    borderRadius: 18,
    border: '1px solid #dbeafe',
    boxShadow: '0 24px 60px rgba(15, 23, 42, 0.28)',
    padding: 20,
};

const expandedViewerStyle = {
    width: 'min(1320px, 96vw)',
    height: 'min(860px, 92vh)',
    background: '#f8fafc',
    borderRadius: 18,
    border: '1px solid #dbeafe',
    boxShadow: '0 28px 80px rgba(15, 23, 42, 0.32)',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
};
