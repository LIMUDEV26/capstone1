import { FormEvent, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import PasswordInput from '../../components/PasswordInput';
import { notifyError, notifySuccess, notifyWarning } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API_BASE_URL = getApiBaseUrl();

interface SessionUser {
    id?: number;
    role?: string;
    username?: string;
    [key: string]: unknown;
}

interface AdminUser {
    id: number;
    username: string;
    email: string;
    first_name: string;
    last_name: string;
    status: string;
    created_at: string;
}

interface AdminForm {
    id?: number;
    email: string;
    first_name: string;
    last_name: string;
    password: string;
    status: 'active' | 'inactive';
}

const createInitialForm = (): AdminForm => ({
    email: '',
    first_name: '',
    last_name: '',
    password: '',
    status: 'active',
});

const isValidGmailComEmail = (value: string) => /^[^\s@]+@(gmail\.com|phinmaed\.com)$/i.test(value.trim());
const formatAdminCreatedAt = (value: string) => {
    if (!value) return 'Recently created';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return value;
    return parsed.toLocaleString();
};

export default function CreateAdminPage() {
    const router = useRouter();
    const { user, loading: authLoading, logout } = useProtectedPage({
        allowedRoles: ['admin'],
        unauthorizedRedirect: '/403',
    });
    const [loading, setLoading] = useState(true);

    const [pin, setPin] = useState('');
    const [pinLoading, setPinLoading] = useState(false);
    const [pinVerified, setPinVerified] = useState(false);
    const [pinError, setPinError] = useState<string | null>(null);

    const [admins, setAdmins] = useState<AdminUser[]>([]);
    const itemsPerPage = usePaginationSetting();
    const [currentPage, setCurrentPage] = useState(1);
    const [searchTerm, setSearchTerm] = useState('');

    const [form, setForm] = useState<AdminForm>(createInitialForm());
    const [saving, setSaving] = useState(false);
    const [formError, setFormError] = useState<string | null>(null);
    const [formMsg, setFormMsg] = useState<string | null>(null);
    // Inline per-field "Required" messages for the Create/Edit Admin forms.
    const [adminFieldErrors, setAdminFieldErrors] = useState<Record<string, string>>({});

    const clearAdminFieldError = (name: string) => {
        setAdminFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const [updatingAdminId, setUpdatingAdminId] = useState<number | null>(null);
    const [editingAdmin, setEditingAdmin] = useState<AdminUser | null>(null);
    const [showEditModal, setShowEditModal] = useState(false);
    const [deletingAdminId, setDeletingAdminId] = useState<number | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [dashboardAccessPin, setDashboardAccessPin] = useState('');
    const [confirmDashboardAccessPin, setConfirmDashboardAccessPin] = useState('');
    const [dashboardPinTotpCode, setDashboardPinTotpCode] = useState('');
    const [dashboardPinLoading, setDashboardPinLoading] = useState(false);
    const [dashboardPinMsg, setDashboardPinMsg] = useState<string | null>(null);
    const [dashboardPinErr, setDashboardPinErr] = useState<string | null>(null);

    useEffect(() => {
        const role = String(user?.role || '').toLowerCase();
        if (!role) {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }
        setLoading(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [authLoading, user?.role]);

    useEffect(() => {
        if (!pinVerified) return;
        fetchAdmins();
    }, [pinVerified]);

    useEffect(() => {
        if (!pinError) return;
        void notifyError(pinError);
        setPinError(null);
    }, [pinError]);

    useEffect(() => {
        if (!formError) return;
        void notifyError(formError);
        setFormError(null);
    }, [formError]);

    useEffect(() => {
        if (!formMsg) return;
        void notifySuccess(formMsg);
        setFormMsg(null);
    }, [formMsg]);

    useEffect(() => {
        if (!dashboardPinErr) return;
        void notifyError(dashboardPinErr);
        setDashboardPinErr(null);
    }, [dashboardPinErr]);

    useEffect(() => {
        if (!dashboardPinMsg) return;
        void notifySuccess(dashboardPinMsg);
        setDashboardPinMsg(null);
    }, [dashboardPinMsg]);

    const fetchAdmins = async () => {
        setUpdatingAdminId(null);
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?role=admin`, { credentials: 'include' });
            const data = await res.json();
            if (data.success && Array.isArray(data.data)) {
                setAdmins(data.data as AdminUser[]);
            }
        } catch {
            // ignore
        }
    };

    const handleVerifyPin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setPinError(null);

        const cleanPin = pin.replace(/\D/g, '').slice(0, 4);
        if (cleanPin.length !== 4) {
            setPinError('Enter the 4-digit dashboard PIN.');
            return;
        }

        setPinLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/auth.php?action=admin_verify_dashboard_pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ pin: cleanPin }),
            });
            const data = await res.json();
            if (data.success) {
                setPinVerified(true);
                setPin('');
            } else {
                setPinError(data.message || 'Invalid PIN.');
            }
        } catch {
            setPinError('Network error.');
        } finally {
            setPinLoading(false);
        }
    };

    const handleCreateAdmin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setFormError(null);
        setFormMsg(null);

        const payload = {
            email: form.email.trim().toLowerCase(),
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            password: form.password,
            role: 'admin',
            status: form.status,
        };

        const createMissing: Record<string, string> = {};
        if (!payload.first_name) createMissing.first_name = 'Required.';
        if (!payload.last_name) createMissing.last_name = 'Required.';
        if (!payload.email) createMissing.email = 'Required.';
        if (!payload.password) createMissing.password = 'Required.';
        if (Object.keys(createMissing).length > 0) {
            setAdminFieldErrors(createMissing);
            return;
        }
        setAdminFieldErrors({});

        if (!isValidGmailComEmail(payload.email)) {
            setFormError('Email must be a valid @gmail.com or @phinmaed.com address.');
            return;
        }

        if (payload.password.length < 8) {
            setFormError('Password must be at least 8 characters.');
            return;
        }
        if (!/[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]/.test(payload.password)) {
            setFormError('Password must contain at least one special character.');
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.success) {
                setForm(createInitialForm());
                setFormMsg('New admin account created.');
                const created = data.data as AdminUser | undefined;
                if (created?.id) {
                    setAdmins(prev => [...prev, created]);
                } else {
                    setAdmins(prev => [...prev, { id: Date.now(), username: payload.email?.split('@')[0] || '', email: payload.email, first_name: payload.first_name, last_name: payload.last_name, status: payload.status || 'active', created_at: new Date().toISOString() } as AdminUser]);
                }
            } else {
                setFormError(data.message || 'Failed to create admin.');
            }
        } catch {
            setFormError('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const toggleAdminStatus = async (target: AdminUser) => {
        const nextStatus = target.status === 'active' ? 'inactive' : 'active';
        if (target.id === user?.id && nextStatus !== 'active') {
            void notifyWarning('You cannot deactivate your own account.');
            return;
        }

        setUpdatingAdminId(target.id);
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: target.id, status: nextStatus }),
            });
            const data = await res.json();
            if (data.success) {
                setAdmins(prev => prev.map(a => a.id === target.id ? { ...a, status: nextStatus } : a));
            }
        } finally {
            setUpdatingAdminId(null);
        }
    };

    const handleEditAdmin = (admin: AdminUser) => {
        setEditingAdmin(admin);
        setForm({
            id: admin.id,
            email: admin.email,
            first_name: admin.first_name,
            last_name: admin.last_name,
            password: '',
            status: admin.status as 'active' | 'inactive',
        });
        setShowEditModal(true);
    };

    const handleSaveEdit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setFormError(null);
        setFormMsg(null);

        if (!editingAdmin) return;

        const payload: Record<string, unknown> = {
            id: editingAdmin.id,
            email: form.email.trim().toLowerCase(),
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            status: form.status,
        };

        if (form.password) {
            payload.password = form.password;
        }

        const editMissing: Record<string, string> = {};
        if (!payload.first_name) editMissing.first_name = 'Required.';
        if (!payload.last_name) editMissing.last_name = 'Required.';
        if (!payload.email) editMissing.email = 'Required.';
        if (Object.keys(editMissing).length > 0) {
            setAdminFieldErrors(editMissing);
            return;
        }
        setAdminFieldErrors({});

        if (!isValidGmailComEmail(String(payload.email))) {
            setFormError('Email must be a valid @gmail.com or @phinmaed.com address.');
            return;
        }

        if (form.password && form.password.length < 8) {
            setFormError('Password must be at least 8 characters.');
            return;
        }
        if (form.password && !/[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]/.test(form.password)) {
            setFormError('Password must contain at least one special character.');
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.success) {
                setShowEditModal(false);
                setEditingAdmin(null);
                setForm(createInitialForm());
                setFormMsg('Admin account updated.');
                setAdmins(prev => prev.map(a => a.id === editingAdmin!.id ? { ...a, email: String(payload.email), first_name: String(payload.first_name), last_name: String(payload.last_name), status: String(payload.status) } : a));
            } else {
                setFormError(data.message || 'Failed to update admin.');
            }
        } catch {
            setFormError('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleDeleteAdmin = async () => {
        if (!deletingAdminId) return;

        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?id=${deletingAdminId}`, {
                method: 'DELETE',
                credentials: 'include',
            });
            const data = await res.json();
            if (data.success) {
                setShowDeleteConfirm(false);
                setDeletingAdminId(null);
                setFormMsg('Admin account deleted.');
                setAdmins(prev => prev.filter(a => a.id !== deletingAdminId));
            }
        } finally {
            // done
        }
    };

    const updateDashboardAccessPin = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setDashboardPinErr(null);
        setDashboardPinMsg(null);

        const cleanNewPin = dashboardAccessPin.replace(/\D/g, '').slice(0, 4);
        const cleanConfirmPin = confirmDashboardAccessPin.replace(/\D/g, '').slice(0, 4);
        const cleanTotpPin = dashboardPinTotpCode.replace(/\D/g, '').slice(0, 6);

        if (cleanNewPin.length !== 4) {
            setDashboardPinErr('Dashboard PIN must be exactly 4 digits.');
            return;
        }
        if (cleanNewPin !== cleanConfirmPin) {
            setDashboardPinErr('Dashboard PIN confirmation does not match.');
            return;
        }
        if (cleanTotpPin.length !== 6) {
            setDashboardPinErr('Enter a valid 6-digit authenticator code.');
            return;
        }

        setDashboardPinLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/auth.php?action=admin_update_dashboard_pin`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    newPin: cleanNewPin,
                    totpPin: cleanTotpPin,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setDashboardPinMsg(data.message || 'Dashboard PIN updated.');
                setDashboardAccessPin('');
                setConfirmDashboardAccessPin('');
                setDashboardPinTotpCode('');
            } else {
                setDashboardPinErr(data.message || 'Failed to update dashboard PIN.');
            }
        } catch {
            setDashboardPinErr('Network error.');
        } finally {
            setDashboardPinLoading(false);
        }
    };

    const displayedAdmins = useMemo(() => {
        const normalizedSearchTerm = searchTerm.trim().toLowerCase();
        return admins.filter(u => {
            const matchesSearch = normalizedSearchTerm === '' ||
                (u.first_name?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (u.last_name?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (u.username?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (u.email?.toLowerCase() || '').includes(normalizedSearchTerm);
            return matchesSearch;
        });
    }, [admins, searchTerm]);

    const paginatedAdmins = useMemo(() => {
        return displayedAdmins.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    }, [displayedAdmins, currentPage, itemsPerPage]);

    const tableHeaderStyle = { padding: '12px 15px', textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#4a5568', fontWeight: 'bold' } as const;
    const tableCellStyle = { padding: '12px 15px', borderBottom: '1px solid #e2e8f0', color: '#2d3748' };

    if (authLoading || loading) {
        return (
            <Layout role={String(user?.role || '')} user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </Layout>
        );
    }

    return (
        <Layout role={user?.role} user={user} onLogout={logout}>
            <Head>
                <title>Admin Management</title>
            </Head>

            {!pinVerified ? (
                <div style={{ maxWidth: '400px', margin: '50px auto' }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                        <h2 style={{ marginTop: 0, marginBottom: '10px' }}>Enter Dashboard PIN</h2>
                        <p style={{ marginBottom: '20px', color: '#666' }}>Enter the 4-digit PIN to access admin management.</p>

                            <form onSubmit={handleVerifyPin} noValidate>
                            <div style={{ marginBottom: '20px' }}>
                                <label htmlFor="dashboard-pin" style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>Dashboard PIN</label>
                                <input
                                    id="dashboard-pin"
                                    type="text"
                                    value={pin}
                                    onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                    placeholder="1433"
                                    inputMode="numeric"
                                    maxLength={4}
                                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #e2e8f0' }}
                                    disabled={pinLoading}
                                    required
                                    aria-required="true"
                                    aria-label="Dashboard PIN (required)"
                                />
                            </div>

                            <div style={{ display: 'flex', gap: '10px' }}>
                                <button
                                    type="button"
                                    onClick={() => router.push('/admin/dashboard')}
                                    style={{ padding: '10px 20px', border: '1px solid #e2e8f0', borderRadius: '8px', background: 'white', cursor: 'pointer' }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={pinLoading || pin.length !== 4}
                                    style={{
                                        flex: 1,
                                        padding: '10px 20px',
                                        background: '#1e3a8a',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '8px',
                                        cursor: 'pointer',
                                        fontWeight: 'bold'
                                    }}
                                >
                                    {pinLoading ? 'Verifying...' : 'Unlock'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            ) : (
                <div style={{ maxWidth: '1400px', margin: '0 auto' }}>
                    <div className="pageHeaderInline" style={{ marginBottom: '20px' }}>
                        <div className="pageHeaderText" style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap' }}>
                            <h1 style={{ fontSize: '24px', fontWeight: 'bold', color: '#1a202c', margin: 0 }}>
                                Admin Management
                            </h1>
                            <button
                                type="button"
                                onClick={() => router.push('/admin/dashboard')}
                                style={{
                                    padding: '8px 12px',
                                    border: '1px solid #e2e8f0',
                                    borderRadius: '6px',
                                    background: 'white',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '6px',
                                    fontSize: '13px'
                                }}
                            >
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="19" y1="12" x2="5" y2="12"></line>
                                    <polyline points="12 19 5 12 12 5"></polyline>
                                </svg>
                                Back to Dashboard
                            </button>
                        </div>
                        <div className="pageInlineFilters">
                            <label style={{ flex: '0 1 260px', minWidth: '200px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
                                <span style={{ fontSize: '11px', fontWeight: 800, lineHeight: 1.1, color: '#374151' }}>Search</span>
                                <SearchBar
                                    storageKey="admins:list"
                                    placeholder="Search admins..."
                                    ariaLabel="Search admins"
                                    value={searchTerm}
                                    onChange={setSearchTerm}
                                    suggestions={collectSearchTerms(admins, [
                                        (u: any) => `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                                        (u: any) => u.username,
                                        (u: any) => u.email,
                                    ])}
                                    inputStyle={{ padding: '10px 30px 10px 32px', fontSize: '14px' }}
                                />
                            </label>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '20px' }}>
                        {/* Create Admin Card */}
                        <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                            <h2 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '15px' }}>Create New Admin</h2>
                            <form onSubmit={handleCreateAdmin} noValidate>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                    <div>
                                        <label htmlFor="create-first-name" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>First Name</label>
                                        <input
                                            id="create-first-name"
                                            type="text"
                                            value={form.first_name}
                                            onChange={(e) => { setForm((prev) => ({ ...prev, first_name: e.target.value })); clearAdminFieldError('first_name'); }}
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.first_name ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                            disabled={saving}
                                            required
                                            aria-required="true"
                                            aria-invalid={adminFieldErrors.first_name ? true : undefined}
                                        />
                                        {adminFieldErrors.first_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.first_name}</div>}
                                    </div>
                                    <div>
                                        <label htmlFor="create-last-name" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Last Name</label>
                                        <input
                                            id="create-last-name"
                                            type="text"
                                            value={form.last_name}
                                            onChange={(e) => { setForm((prev) => ({ ...prev, last_name: e.target.value })); clearAdminFieldError('last_name'); }}
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.last_name ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                            disabled={saving}
                                            required
                                            aria-required="true"
                                            aria-invalid={adminFieldErrors.last_name ? true : undefined}
                                        />
                                        {adminFieldErrors.last_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.last_name}</div>}
                                    </div>
                                </div>

                                <div style={{ marginBottom: '15px' }}>
                                    <label htmlFor="create-email" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Email</label>
                                    <input
                                        id="create-email"
                                        type="email"
                                        value={form.email}
                                        onChange={(e) => { setForm((prev) => ({ ...prev, email: e.target.value })); clearAdminFieldError('email'); }}
                                        placeholder="admin@phinmaed.com"
                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.email ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                        disabled={saving}
                                        required
                                        aria-required="true"
                                        aria-invalid={adminFieldErrors.email ? true : undefined}
                                    />
                                    {adminFieldErrors.email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.email}</div>}
                                </div>

                                <div style={{ marginBottom: '15px' }}>
                                    <label htmlFor="create-password" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Password</label>
                                    <PasswordInput
                                        id="create-password"
                                        value={form.password}
                                        onChange={(e) => { setForm((prev) => ({ ...prev, password: e.target.value })); clearAdminFieldError('password'); }}
                                        placeholder="Minimum 8 characters"
                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.password ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                        disabled={saving}
                                        showStrength
                                        showSuggest
                                        onSuggestPick={(pwd) => { setForm((prev) => ({ ...prev, password: pwd })); clearAdminFieldError('password'); }}
                                        required
                                    />
                                    {adminFieldErrors.password && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.password}</div>}
                                </div>

                                <div style={{ marginBottom: '20px' }}>
                                    <label htmlFor="create-status" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Status</label>
                                    <select
                                        id="create-status"
                                        value={form.status}
                                        onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value as 'active' | 'inactive' }))}
                                        style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                        disabled={saving}
                                    >
                                        <option value="active">Active</option>
                                        <option value="inactive">Inactive</option>
                                    </select>
                                </div>

                                <button
                                    type="submit"
                                    disabled={saving}
                                    style={{ width: '100%', padding: '10px', background: '#1e3a8a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    {saving ? 'Creating...' : 'Create Admin'}
                                </button>
                            </form>
                        </div>

                        {/* PIN Rotation Card */}
                        <div style={{ background: 'white', padding: '20px', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}>
                            <h2 style={{ fontSize: '16px', fontWeight: 'bold', marginBottom: '15px' }}>Rotate Dashboard PIN</h2>
                            <form onSubmit={updateDashboardAccessPin} noValidate>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                    <div>
                                        <label htmlFor="pin-new" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>New PIN</label>
                                        <input
                                            id="pin-new"
                                            type="text"
                                            value={dashboardAccessPin}
                                            onChange={(e) => setDashboardAccessPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                            inputMode="numeric"
                                            maxLength={4}
                                            placeholder="1433"
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                            disabled={dashboardPinLoading}
                                            required
                                            aria-required="true"
                                            aria-label="New PIN (required)"
                                        />
                                    </div>
                                    <div>
                                        <label htmlFor="pin-confirm" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Confirm PIN</label>
                                        <input
                                            id="pin-confirm"
                                            type="text"
                                            value={confirmDashboardAccessPin}
                                            onChange={(e) => setConfirmDashboardAccessPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                            inputMode="numeric"
                                            maxLength={4}
                                            placeholder="1433"
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                            disabled={dashboardPinLoading}
                                            required
                                            aria-required="true"
                                            aria-label="Confirm PIN (required)"
                                        />
                                    </div>
                                </div>

                                <div style={{ marginBottom: '20px' }}>
                                    <label htmlFor="pin-totp" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Authenticator Code</label>
                                        <input
                                            id="pin-totp"
                                            type="text"
                                            value={dashboardPinTotpCode}
                                            onChange={(e) => setDashboardPinTotpCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                                            inputMode="numeric"
                                            maxLength={6}
                                            placeholder="000000"
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                            disabled={dashboardPinLoading}
                                            required
                                            aria-required="true"
                                            aria-label="Authenticator code (required)"
                                        />
                                </div>

                                <button
                                    type="submit"
                                    disabled={dashboardPinLoading}
                                    style={{ width: '100%', padding: '10px', background: '#059669', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}
                                >
                                    {dashboardPinLoading ? 'Updating...' : 'Update PIN'}
                                </button>
                            </form>
                        </div>
                    </div>

                    {/* Admin Table */}
                    <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'visible' }}>
                        <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                            <thead style={{ background: '#f8fafc' }}>
                                <tr>
                                    <th className="llb-num" style={tableHeaderStyle}>#</th>
                                    <th style={tableHeaderStyle}>Name</th>
                                    <th style={tableHeaderStyle}>Username</th>
                                    <th style={tableHeaderStyle}>Email</th>
                                    <th style={tableHeaderStyle}>Status</th>
                                    <th style={tableHeaderStyle}>Created At</th>
                                    <th style={{ ...tableHeaderStyle, textAlign: 'center', width: '180px' }}>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {displayedAdmins.length === 0 ? (
                                    <tr><td colSpan={7} style={{ padding: '8px', textAlign: 'center', color: '#666' }}>
                                        {searchTerm.trim() ? (
                                            <ZeroResults
                                                query={searchTerm}
                                                itemLabel="admins"
                                                alternatives={getAlternativeSuggestions(searchTerm, collectSearchTerms(admins, [
                                                    (u: any) => `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                                                    (u: any) => u.username,
                                                    (u: any) => u.email,
                                                ]))}
                                                onPickAlternative={(term) => setSearchTerm(term)}
                                                onClear={() => setSearchTerm('')}
                                            />
                                        ) : 'No admin accounts found.'}
                                    </td></tr>
                                ) : paginatedAdmins.map((admin, index) => {
                                    const isCurrentUser = admin.id === user?.id;
                                    const isMainAdmin = admin.id === 1;
                                    const isCurrentUserMainAdmin = user?.id === 1;
                                    const isUpdating = updatingAdminId === admin.id;
                                    const fullName = `${admin.first_name} ${admin.last_name}`.trim() || admin.username;
                                    const disableToggleAction = isUpdating || (isCurrentUser && admin.status === 'active');
                                    const canEdit = !isMainAdmin || isCurrentUserMainAdmin;
                                    const canDelete = !isMainAdmin && !isCurrentUser;

                                    return (
                                        <tr key={admin.id}>
                                            <td className="llb-num" style={tableCellStyle}>{(currentPage - 1) * itemsPerPage + index + 1}</td>
                                            <td style={tableCellStyle}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                                    <div style={{
                                                        width: 34, height: 34, borderRadius: '999px', background: isMainAdmin ? '#1e3a8a' : '#e2e8f0',
                                                        color: isMainAdmin ? 'white' : '#475569',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 'bold'
                                                    }}>
                                                        {fullName.charAt(0).toUpperCase()}
                                                    </div>
                                                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                            {fullName}
                                                            {isCurrentUser && (
                                                                <span style={{ padding: '2px 6px', borderRadius: '4px', background: '#dbeafe', color: '#1d4ed8', fontSize: '11px', fontWeight: 'bold' }}>
                                                                    You
                                                                </span>
                                                            )}
                                                            {isMainAdmin && (
                                                                <span style={{ padding: '2px 6px', borderRadius: '4px', background: '#1e3a8a', color: 'white', fontSize: '11px', fontWeight: 'bold' }}>
                                                                    Main Admin
                                                                </span>
                                                            )}
                                                        </span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td className="llb-trunc" title={`@${admin.username}`} style={tableCellStyle}>@{admin.username}</td>
                                            <td className="llb-trunc" title={admin.email} style={tableCellStyle}>{admin.email}</td>
                                            <td style={tableCellStyle}>
                                                <span
                                                    onClick={() => canEdit && !disableToggleAction && toggleAdminStatus(admin)}
                                                    style={{
                                                        padding: '4px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold', cursor: canEdit && !disableToggleAction ? 'pointer' : 'default',
                                                        background: admin.status === 'active' ? '#dcfce7' : '#fee2e2',
                                                        color: admin.status === 'active' ? '#15803d' : '#dc2626'
                                                    }}
                                                >
                                                    {admin.status}
                                                </span>
                                            </td>
                                            <td style={tableCellStyle}>{formatAdminCreatedAt(admin.created_at)}</td>
                                            <td className="llb-actions" style={{ ...tableCellStyle, textAlign: 'center' }}>
                                                <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                                    <button
                                                        type="button"
                                                        disabled={!canEdit}
                                                        onClick={() => handleEditAdmin(admin)}
                                                        title="Edit"
                                                        aria-label="Edit"
                                                        style={{
                                                            padding: '6px 12px', borderRadius: '6px', cursor: canEdit ? 'pointer' : 'not-allowed',
                                                            background: canEdit ? '#1e3a8a' : '#e2e8f0', color: canEdit ? 'white' : '#94a3b8', border: 'none'
                                                        }}
                                                    >
                                                        <CrudActionIcon action="update" size={14} />
                                                    </button>
                                                    {canDelete && (
                                                        <button
                                                            type="button"
                                                            onClick={() => {
                                                                setDeletingAdminId(admin.id);
                                                                setShowDeleteConfirm(true);
                                                            }}
                                                            title="Delete"
                                                            aria-label="Delete"
                                                            style={{ padding: '6px 12px', borderRadius: '6px', background: '#dc2626', color: 'white', border: 'none', cursor: 'pointer' }}
                                                        >
                                                            <CrudActionIcon action="archive" size={14} />
                                                        </button>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>

                        {displayedAdmins.length > itemsPerPage && (
                            <div style={{ padding: '15px' }}>
                                <Pagination
                                    totalItems={displayedAdmins.length}
                                    itemsPerPage={itemsPerPage}
                                    currentPage={currentPage}
                                    onPageChange={(page) => setCurrentPage(page)}
                                />
                            </div>
                        )}
                    </div>

                    {/* Edit Modal */}
                    {showEditModal && editingAdmin && (
                        <div style={{
                            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            zIndex: 1000
                        }}>
                            <div style={{
                                background: 'white', padding: '24px', borderRadius: '12px', width: '100%',
                                maxWidth: '500px'
                            }}>
                                <h2 style={{ marginTop: 0, marginBottom: '15px' }}>Edit Admin</h2>
                                <form onSubmit={handleSaveEdit} noValidate>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                        <div>
                                            <label htmlFor="edit-first-name" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>First Name</label>
                                            <input
                                                id="edit-first-name"
                                                type="text"
                                                value={form.first_name}
                                                onChange={(e) => { setForm((prev) => ({ ...prev, first_name: e.target.value })); clearAdminFieldError('first_name'); }}
                                                style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.first_name ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                                disabled={saving}
                                                required
                                                aria-required="true"
                                                aria-invalid={adminFieldErrors.first_name ? true : undefined}
                                            />
                                            {adminFieldErrors.first_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.first_name}</div>}
                                        </div>
                                        <div>
                                            <label htmlFor="edit-last-name" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Last Name</label>
                                            <input
                                                id="edit-last-name"
                                                type="text"
                                                value={form.last_name}
                                                onChange={(e) => { setForm((prev) => ({ ...prev, last_name: e.target.value })); clearAdminFieldError('last_name'); }}
                                                style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.last_name ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                                disabled={saving}
                                                required
                                                aria-required="true"
                                                aria-invalid={adminFieldErrors.last_name ? true : undefined}
                                            />
                                            {adminFieldErrors.last_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.last_name}</div>}
                                        </div>
                                    </div>

                                    <div style={{ marginBottom: '15px' }}>
                                        <label htmlFor="edit-email" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Email</label>
                                        <input
                                            id="edit-email"
                                            type="email"
                                            value={form.email}
                                            onChange={(e) => { setForm((prev) => ({ ...prev, email: e.target.value })); clearAdminFieldError('email'); }}
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: adminFieldErrors.email ? '2px solid #ef4444' : '1px solid #e2e8f0' }}
                                            disabled={saving}
                                            required
                                            aria-required="true"
                                            aria-invalid={adminFieldErrors.email ? true : undefined}
                                        />
                                        {adminFieldErrors.email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{adminFieldErrors.email}</div>}
                                    </div>

                                    <div style={{ marginBottom: '15px' }}>
                                        <label htmlFor="edit-password" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>
                                            New Password (leave blank to keep current)
                                        </label>
                                        <PasswordInput
                                            id="edit-password"
                                            value={form.password}
                                            onChange={(e) => setForm((prev) => ({ ...prev, password: e.target.value }))}
                                            placeholder="Minimum 8 characters"
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                            disabled={saving}
                                            showStrength
                                            showSuggest
                                            onSuggestPick={(pwd) => setForm((prev) => ({ ...prev, password: pwd }))}
                                        />
                                    </div>

                                    <div style={{ marginBottom: '20px' }}>
                                        <label htmlFor="edit-status" style={{ display: 'block', marginBottom: '5px', fontSize: '14px', fontWeight: 'bold' }}>Status</label>
                                        <select
                                            id="edit-status"
                                            value={form.status}
                                            onChange={(e) => setForm((prev) => ({ ...prev, status: e.target.value as 'active' | 'inactive' }))}
                                            style={{ width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid #e2e8f0' }}
                                            disabled={saving}
                                        >
                                            <option value="active">Active</option>
                                            <option value="inactive">Inactive</option>
                                        </select>
                                    </div>

                                    <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                                        <button
                                            type="button"
                                            onClick={() => {
                                                setShowEditModal(false);
                                                setEditingAdmin(null);
                                                setForm(createInitialForm());
                                            }}
                                            style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}
                                            disabled={saving}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={saving}
                                            style={{ padding: '8px 16px', borderRadius: '6px', background: '#1e3a8a', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
                                        >
                                            {saving ? 'Saving...' : 'Save Changes'}
                                        </button>
                                    </div>
                                </form>
                            </div>
                        </div>
                    )}

                    {/* Delete Confirm Modal */}
                    {showDeleteConfirm && deletingAdminId && (
                        <div style={{
                            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                            background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            zIndex: 1000
                        }}>
                            <div style={{
                                background: 'white', padding: '24px', borderRadius: '12px', width: '100%',
                                maxWidth: '400px', textAlign: 'center'
                            }}>
                                <h2 style={{ marginTop: 0, marginBottom: '15px' }}>Delete Admin?</h2>
                                <p style={{ marginBottom: '20px', color: '#666' }}>
                                    Are you sure you want to delete this admin account? This action cannot be undone.
                                </p>
                                <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setShowDeleteConfirm(false);
                                            setDeletingAdminId(null);
                                        }}
                                        style={{ padding: '8px 16px', borderRadius: '6px', border: '1px solid #e2e8f0', background: 'white', cursor: 'pointer' }}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleDeleteAdmin}
                                        style={{ padding: '8px 16px', borderRadius: '6px', background: '#dc2626', color: 'white', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
                                    >
                                        Delete
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            )}
        </Layout>
    );
}
