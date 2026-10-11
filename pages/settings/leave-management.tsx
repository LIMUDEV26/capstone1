import { useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type FormEvent } from 'react';
import { useRouter } from 'next/router';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import SettingsToggle from '../../components/SettingsToggle';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { confirmAction, notifyError } from '@/utils/notify';
import { getBackendBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

const API_BASE = `${getBackendBaseUrl()}/api`;

interface LeaveTypeRow {
    leave_type_id: number;
    type_key: string;
    type_name: string;
    description: string | null;
    default_days: number | null;
    is_paid: number | boolean | null;
    is_active: number | boolean | null;
}

interface LeaveTypeForm {
    type_name: string;
    description: string;
    default_days: string;
    is_paid: boolean;
    is_active: boolean;
}

const createInitialForm = (): LeaveTypeForm => ({
    type_name: '',
    description: '',
    default_days: '',
    is_paid: true,
    is_active: true,
});

const formatLeaveDays = (value: number | null | undefined): string => {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    const n = Number(value);
    return Number.isInteger(n) ? String(n) : n.toFixed(1);
};

export default function LeaveManagementSettingsPage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [rows, setRows] = useState<LeaveTypeRow[]>([]);
    const [pageLoading, setPageLoading] = useState(true);
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [filtersOpen, setFiltersOpen] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [showModal, setShowModal] = useState(false);
    const [editingRow, setEditingRow] = useState<LeaveTypeRow | null>(null);
    const [viewRow, setViewRow] = useState<LeaveTypeRow | null>(null);
    const [formData, setFormData] = useState<LeaveTypeForm>(createInitialForm());
    const [error, setError] = useState('');
    const [listReloading, setListReloading] = useState(false);

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
        const loadPage = async () => {
            try {
                await fetchRows();
            } finally {
                if (active) {
                    setPageLoading(false);
                }
            }
        };

        void loadPage();
        return () => {
            active = false;
        };
    }, [authLoading, userId]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    const fetchRows = async () => {
        try {
            const res = await fetch(`${API_BASE}/leave-types.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                setRows((data.data || []) as LeaveTypeRow[]);
            }
        } catch {
            console.error('Failed to fetch leave types');
        }
    };

    const handleReloadList = async () => {
        setListReloading(true);
        try {
            await fetchRows();
        } finally {
            setListReloading(false);
        }
    };

    const resetForm = () => {
        setFormData(createInitialForm());
        setEditingRow(null);
        setError('');
    };

    const openAddModal = () => {
        resetForm();
        setShowModal(true);
    };

    const openEditModal = (row: LeaveTypeRow) => {
        setEditingRow(row);
        setFormData({
            type_name: row.type_name || '',
            description: row.description || '',
            default_days: row.default_days === null || row.default_days === undefined ? '' : String(row.default_days),
            is_paid: row.is_paid === null || row.is_paid === undefined ? true : !!Number(row.is_paid),
            is_active: !!Number(row.is_active),
        });
        setError('');
        setShowModal(true);
    };

    const handleInputChange = (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const { name, value, type } = e.target;
        const checked = type === 'checkbox' ? (e.target as HTMLInputElement).checked : false;
        setFormData((prev) => ({ ...prev, [name]: type === 'checkbox' ? checked : value }));
    };

    const handleSubmit = async (e: FormEvent) => {
        e.preventDefault();
        setError('');

        try {
            const isEdit = !!editingRow;
            const payload: {
                type_name: string;
                description: string;
                default_days: number | null;
                is_paid: number;
                is_active?: number;
                leave_type_id?: number;
            } = {
                type_name: formData.type_name,
                description: formData.description,
                default_days: formData.default_days.trim() === '' ? null : Number(formData.default_days),
                is_paid: formData.is_paid ? 1 : 0,
            };
            if (Number.isNaN(Number(payload.default_days)) && payload.default_days !== null) {
                setError('Yearly allocation must be a number between 0 and 365.');
                return;
            }
            if (isEdit) {
                payload.leave_type_id = editingRow.leave_type_id;
                payload.is_active = formData.is_active ? 1 : 0;
            }

            const res = await fetch(`${API_BASE}/leave-types.php`, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to save leave type');
                return;
            }

            setShowModal(false);
            await fetchRows();
            resetForm();
        } catch {
            setError('An error occurred');
        }
    };

    const handleArchive = async (row: LeaveTypeRow) => {
        const allowed = await confirmAction({
            title: 'Archive leave type?',
            text: `This will archive "${row.type_name}".`,
            confirmButtonText: 'Archive',
            icon: 'warning',
            danger: true,
        });
        if (!allowed) return;

        try {
            const res = await fetch(`${API_BASE}/leave-types.php?id=${row.leave_type_id}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json();
            if (data.success) await fetchRows();
            else alert(data.message || 'Failed to archive');
        } catch {
            alert('An error occurred');
        }
    };

    const handleRestore = async (row: LeaveTypeRow) => {
        const confirmed = await confirmAction({
            title: `Restore ${row.type_name || 'this leave type'}?`,
            text: 'This leave type will be returned to active leave types.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`${API_BASE}/leave-types.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    leave_type_id: row.leave_type_id,
                    is_active: 1,
                }),
            });
            const data = await res.json();
            if (data.success) await fetchRows();
            else alert(data.message || 'Failed to restore');
        } catch {
            alert('An error occurred');
        }
    };

    const displayedRows = useMemo(() => {
        return rows.filter((r) => (showArchiveView ? !Number(r.is_active) : !!Number(r.is_active)));
    }, [rows, showArchiveView]);

    const paginatedRows = displayedRows.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
    const archivedCount = rows.filter((r) => !Number(r.is_active)).length;

    useEffect(() => {
        setCurrentPage(1);
        setViewRow(null);
    }, [showArchiveView]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(displayedRows.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [displayedRows.length, currentPage]);

    if (authLoading) {
        return (
            <SettingsLayout activeSection="leave-management" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="leave-management" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <SettingsPageHeader embedded={embedded} title={showArchiveView ? 'Archived Leave Types' : 'Leave Management'} onBack={() => router.push('/settings')} />
                    <TinyReloadButton onClick={handleReloadList} loading={listReloading} title="Reload leave types" />
                    <button type="button" onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} style={{ padding: '7px 11px', border: filtersOpen ? '1px solid #1d4ed8' : '1px solid #cbd5e1', borderRadius: 8, background: filtersOpen ? '#1d4ed8' : '#fff', color: filtersOpen ? '#fff' : '#334155', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                        {filtersOpen ? 'Hide Filters' : `Filters${showArchiveView ? ' (1)' : ''}`}
                    </button>
                </div>
                {!showArchiveView && (
                    <button onClick={openAddModal} title="Add Leave Type" aria-label="Add Leave Type" style={{ padding: '4px 0', border: 'none', cursor: 'pointer', background: 'transparent', color: '#1e3a8a', fontWeight: 'bold', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'underline' }}>
                        Add Leave Type
                    </button>
                )}
            </div>

            {filtersOpen && (
                <div style={{ display: 'flex', gap: 8, margin: '-10px 0 16px', padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                    <button type="button" onClick={() => setShowArchiveView(false)} style={{ padding: '6px 11px', border: !showArchiveView ? '1px solid #1d4ed8' : '1px solid #cbd5e1', borderRadius: 999, background: !showArchiveView ? '#eff6ff' : '#fff', color: !showArchiveView ? '#1d4ed8' : '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Active ({rows.length - archivedCount})</button>
                    <button type="button" onClick={() => setShowArchiveView(true)} style={{ padding: '6px 11px', border: showArchiveView ? '1px solid #1d4ed8' : '1px solid #cbd5e1', borderRadius: 999, background: showArchiveView ? '#eff6ff' : '#fff', color: showArchiveView ? '#1d4ed8' : '#475569', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Archived ({archivedCount})</button>
                </div>
            )}

            {!showArchiveView && (
                <div style={{ marginBottom: 16, padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 6, background: '#f8fafc', color: '#475569', fontSize: 12, lineHeight: 1.6 }}>
                    Each active leave type earns its configured allocation every year. Unused credits carry forward without a limit, including when the previous balance is zero. Saturday and Sunday are excluded from charged leave days.
                </div>
            )}

            <div style={{ background: 'white', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                    <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ background: '#f8fafc' }}>
                            <tr>
                                <th style={thStyle}>Type Name</th>
                                <th style={thStyle}>Type Key</th>
                                <th style={{ ...thStyle, textAlign: 'right', width: 130 }} className="llb-num">Yearly Allocation</th>
                                <th style={{ ...thStyle, textAlign: 'center', width: 90 }}>Paid</th>
                                <th style={thStyle}>Description</th>
                                <th style={thStyle}>Status</th>
                                <th className="llb-actions-heading" style={{ ...thStyle, textAlign: 'center', width: 180 }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayedRows.length === 0 && (
                                <tr>
                                    <td colSpan={7} style={{ padding: 20, textAlign: 'center', color: '#64748b' }}>
                                        {showArchiveView ? 'No archived leave types.' : 'No leave types found.'}
                                    </td>
                                </tr>
                            )}
                            {paginatedRows.map((row) => (
                                <tr key={row.leave_type_id}>
                                    <td style={tdStyle} className="llb-trunc" title={row.type_name}>{row.type_name}</td>
                                    <td style={tdStyle}><code>{row.type_key}</code></td>
                                    <td style={{ ...tdStyle, textAlign: 'right', fontWeight: 700 }} className="llb-num" title={row.default_days === null || row.default_days === undefined ? 'No fixed figure — falls back to the system default' : `${formatLeaveDays(row.default_days)} day(s) earned yearly`}><span>{formatLeaveDays(row.default_days)}</span></td>
                                    <td style={{ ...tdStyle, textAlign: 'center' }}>
                                        <span style={{ fontWeight: 700, color: !!Number(row.is_paid) ? '#15803d' : '#64748b' }}>
                                            {!!Number(row.is_paid) ? 'Paid' : 'Unpaid'}
                                        </span>
                                    </td>
                                    <td style={tdStyle} className="llb-trunc" title={row.description?.trim() || ''}>{row.description?.trim() || '-'}</td>
                                    <td style={tdStyle}>
                                        <span style={{ fontWeight: 700, color: Number(row.is_active) ? '#15803d' : '#b91c1c' }}>
                                            {Number(row.is_active) ? 'Active' : 'Archived'}
                                        </span>
                                    </td>
                                    <td style={{ ...tdStyle, textAlign: 'center' }} className="llb-actions">
                                        <div style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                                            <button onClick={() => setViewRow(row)} title="View" aria-label={`View ${row.type_name}`} style={iconButtonStyle('#1e3a8a')}>
                                                <CrudActionIcon action="view" />
                                            </button>
                                            {!showArchiveView ? (
                                                <>
                                                    <button onClick={() => openEditModal(row)} title="Edit" aria-label={`Edit ${row.type_name}`} style={iconButtonStyle('#0f766e')}>
                                                        <CrudActionIcon action="edit" />
                                                    </button>
                                                    <button onClick={() => void handleArchive(row)} title="Archive" aria-label={`Archive ${row.type_name}`} style={iconButtonStyle('#b91c1c')}>
                                                        <CrudActionIcon action="archive" />
                                                    </button>
                                                </>
                                            ) : (
                                                <>
                                                    <button onClick={() => void handleRestore(row)} title="Restore" aria-label={`Restore ${row.type_name}`} style={iconButtonStyle('#166534')}>
                                                        <CrudActionIcon action="restore" />
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>

                <Pagination
                    currentPage={currentPage}
                    totalItems={displayedRows.length}
                    itemsPerPage={ITEMS_PER_PAGE}
                    onPageChange={setCurrentPage}
                    label={showArchiveView ? 'archived leave types' : 'leave types'}
                />

                {viewRow && (
                    <div style={overlayStyle} onClick={() => setViewRow(null)}>
                        <div style={viewModalStyle} onClick={(e) => e.stopPropagation()}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, borderBottom: '1px solid #e2e8f0', paddingBottom: 12 }}>
                                <h2 style={{ margin: 0, color: '#1e3a8a' }}>Leave Type Details</h2>
                                <button onClick={() => setViewRow(null)} style={{ background: 'none', border: 'none', fontSize: 14, lineHeight: 1, cursor: 'pointer', color: '#64748b' }}>x</button>
                            </div>
                            <div style={{ display: 'grid', gap: 10 }}>
                                <div style={detailCardStyle}><strong>Name:</strong> {viewRow.type_name}</div>
                                <div style={detailCardStyle}><strong>Key:</strong> <code>{viewRow.type_key}</code></div>
                                <div style={detailCardStyle}><strong>Yearly Allocation:</strong> {formatLeaveDays(viewRow.default_days)}{viewRow.default_days === null || viewRow.default_days === undefined ? ' (system default applies)' : ' day(s)'}</div>
                                <div style={detailCardStyle}><strong>Pay:</strong> {!!Number(viewRow.is_paid) ? 'Paid' : 'Unpaid'}</div>
                                <div style={detailCardStyle}><strong>Status:</strong> {Number(viewRow.is_active) ? 'Active' : 'Archived'}</div>
                                <div style={detailCardStyle}><strong>Description:</strong> {viewRow.description?.trim() || 'No description provided.'}</div>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
                                <button onClick={() => setViewRow(null)} style={btnSecondary}>Close</button>
                            </div>
                        </div>
                    </div>
                )}

                {showModal && (
                    <div style={overlayStyle}>
                        <div style={modalStyle}>
                            <h2 style={{ marginTop: 0 }}>{editingRow ? 'Edit Leave Type' : 'Add Leave Type'}</h2>
                            <form onSubmit={handleSubmit}>
                                <div style={{ marginBottom: 12 }}>
                                    <label style={labelStyle}>Type Name</label>
                                    <input name="type_name" value={formData.type_name} onChange={handleInputChange} required style={inputStyle} />
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                                    <div>
                                        <label style={labelStyle}>Yearly Allocation</label>
                                        <input
                                            name="default_days"
                                            type="number"
                                            min={0}
                                            max={365}
                                            step={0.5}
                                            value={formData.default_days}
                                            onChange={handleInputChange}
                                            placeholder="e.g. 5"
                                            style={inputStyle}
                                        />
                                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, lineHeight: 1.5 }}>
                                            Credits earned each year. Unused credits carry forward without a limit. Leave blank to use the system default.
                                        </div>
                                    </div>
                                    <div>
                                        <label style={labelStyle}>Pay</label>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#334155', fontSize: 13, paddingTop: 8 }}>
                                            <SettingsToggle
                                                checked={formData.is_paid}
                                                onChange={(next) => setFormData((prev) => ({ ...prev, is_paid: next }))}
                                                size="small"
                                                showStatus
                                                statusOnLabel="Paid"
                                                statusOffLabel="Unpaid"
                                                ariaLabel="Leave type paid"
                                            />
                                        </div>
                                    </div>
                                </div>
                                <div style={{ marginBottom: 12 }}>
                                    <label style={labelStyle}>Description</label>
                                    <textarea
                                        name="description"
                                        value={formData.description}
                                        onChange={handleInputChange}
                                        placeholder="Rule or regulation basis, e.g. RA 11210 — 105 days maternity."
                                        style={{ ...inputStyle, minHeight: 90 }}
                                    />
                                </div>
                                {editingRow && (
                                    <div style={{ marginBottom: 12 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#334155', fontSize: 13 }}>
                                            <SettingsToggle
                                                checked={formData.is_active}
                                                onChange={(next) => setFormData((prev) => ({ ...prev, is_active: next }))}
                                                size="small"
                                                showStatus
                                                statusOnLabel="Active"
                                                statusOffLabel="Inactive"
                                                ariaLabel="Leave type active"
                                            />
                                        </div>
                                    </div>
                                )}
                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
                                    <button 
                                        type="button" 
                                        onClick={() => { setShowModal(false); resetForm(); }} 
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
                                        style={{
                                            background: 'transparent',
                                            border: 'none',
                                            padding: 0,
                                            cursor: 'pointer',
                                            color: '#2563eb',
                                            fontWeight: 600,
                                            fontSize: 14
                                        }}
                                    >
                                        Save
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                )}
        </SettingsLayout>
    );
}

const thStyle: CSSProperties = {
    padding: '12px 15px',
    textAlign: 'left',
    borderBottom: '2px solid #e2e8f0',
    color: '#4a5568',
    fontWeight: 'bold',
};

const tdStyle: CSSProperties = {
    padding: '12px 15px',
    borderBottom: '1px solid #e2e8f0',
    color: '#2d3748',
};

const overlayStyle: CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
};

const modalStyle: CSSProperties = {
    background: 'white',
    padding: 24,
    borderRadius: 'var(--modal-radius)',
    width: 640,
    maxWidth: '95%',
    maxHeight: '90vh',
    overflowY: 'auto',
};

const viewModalStyle: CSSProperties = {
    ...modalStyle,
    width: 760,
};

const labelStyle: CSSProperties = {
    display: 'block',
    marginBottom: 4,
    color: '#555',
    fontSize: 13,
};

const inputStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid #ccc',
    color: '#333',
    backgroundColor: 'white',
};

const btnPrimary: CSSProperties = {
    borderRadius: 6,
    border: 'none',
    background: 'transparent',
    color: '#1e3a8a',
    textDecoration: 'underline',
    padding: '4px 0',
    cursor: 'pointer',
    fontWeight: 'bold',
};

const btnSecondary: CSSProperties = {
    padding: '10px 16px',
    borderRadius: 6,
    border: '1px solid #cbd5e1',
    background: 'white',
    color: '#334155',
    cursor: 'pointer',
};

const detailCardStyle: CSSProperties = {
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    background: '#f8fafc',
    padding: '10px 12px',
    color: '#1f2937',
};

function iconButtonStyle(background: string): CSSProperties {
    return {
        width: 32,
        height: 32,
        border: 'none',
        borderRadius: 7,
        background,
        color: '#fff',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 0,
    };
}
