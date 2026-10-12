import { useState, useEffect } from 'react';
import Head from 'next/head';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import PasswordInput from '../../components/PasswordInput';
import { getBackendBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import { notifyError, notifySuccess, notifyWarning, confirmAction } from '@/utils/notify';
import { useLiveSync } from '@/utils/liveSync';
import { formatGovNumber, type GovNumberField as GovNumField } from '@/utils/govNumber';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { getFlipForTrigger } from '@/utils/dropdownSystem';

const API_BASE_URL = getBackendBaseUrl();
const USER_DOC_FIELDS = [
    'document_resume',
    'document_nbi_clearance',
    'document_police_clearance',
    'document_barangay_clearance',
    'document_birth_certificate',
    'document_medical_certificate',
    'document_diploma_tor',
    'document_employment_contract',
] as const;
const USER_DOC_LABELS: Record<(typeof USER_DOC_FIELDS)[number], string> = {
    document_resume: 'Resume / CV',
    document_nbi_clearance: 'NBI Clearance',
    document_police_clearance: 'Police Clearance',
    document_barangay_clearance: 'Barangay Clearance',
    document_birth_certificate: 'Birth Certificate',
    document_medical_certificate: 'Medical Certificate',
    document_diploma_tor: 'Diploma / TOR',
    document_employment_contract: 'Signed Employment Contract',
};
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

type UserDocField = (typeof USER_DOC_FIELDS)[number];

interface Branch {
    branch_id: number;
    branch_name: string;
    status?: string;
}

type UserRecord = {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    email: string;
    role: string;
    status: string;
    created_at: string;
    date_of_birth?: string | null;
    address?: string | null;
    branch_id?: number | string | null;
    employee_id?: number | string | null;
    branch_name?: string | null;
    employee_storage_deleted_at?: string | null;
    salary?: number | string | null;
    photo?: string | null;
    sss_number?: string | null;
    pagibig_number?: string | null;
    philhealth_number?: string | null;
    tin_number?: string | null;
} & Partial<Record<UserDocField, number | boolean | null>> & {
    [key: string]: unknown;
};

type UserFormData = {
    first_name: string;
    last_name: string;
    date_of_birth: string;
    address: string;
    email: string;
    password: string;
    role: string;
    status: string;
    branch_id: string;
    salary: string;
    photo: string;
} & Record<GovNumberField, string> & Record<UserDocField, boolean>;

interface UserPayload extends Partial<UserFormData> {
    id?: number;
    photo_upload?: { name: string; data_url: string };
    photo_remove?: boolean;
    employee_id?: string | number | null;
    username?: string;
}

const createInitialFormData = (): UserFormData => ({
    first_name: '',
    last_name: '',
    date_of_birth: '',
    address: '',
    email: '',
    password: '',
    role: 'staff',
    status: 'active',
    branch_id: '',
    salary: '',
    photo: '',
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
});
const createInitialGovNumberEnabled = (): Record<GovNumberField, boolean> => ({
    sss_number: false,
    pagibig_number: false,
    philhealth_number: false,
    tin_number: false,
});

const resolveAssetUrl = (value?: string | null) => {
    return resolveBackendAssetUrl(value);
};
const isValidGmailComEmail = (value: string) => /^[^\s@]+@(gmail\.com|phinmaed\.com)$/i.test(value.trim());
const MINIMUM_USER_AGE = 18;

const computeAge = (value: string): number | null => {
    const birthDate = parseIsoDate(value);
    if (!birthDate) return null;
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) age--;
    return age;
};
const isProtectedRole = (role?: string) => {
    const normalized = String(role || '').toLowerCase();
    return normalized === 'admin';
};

const parseIsoDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (
        parsed.getFullYear() !== year ||
        parsed.getMonth() !== month - 1 ||
        parsed.getDate() !== day
    ) {
        return null;
    }
    return parsed;
};

const getLatestAllowedBirthDate = () => {
    const today = new Date();
    return new Date(today.getFullYear() - MINIMUM_USER_AGE, today.getMonth(), today.getDate());
};

const formatDateForInput = (value: Date) => {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

const MAX_BIRTHDATE = formatDateForInput(getLatestAllowedBirthDate());
const ALPHABET_FILTER_OPTIONS = Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index));

const isAtLeastMinimumAge = (value: string) => {
    const birthDate = parseIsoDate(value);
    if (!birthDate) return false;
    return birthDate <= getLatestAllowedBirthDate();
};

export default function Users() {
    const itemsPerPage = usePaginationSetting();
    const { user, loading: authLoading, logout } = useProtectedPage({
        allowedRoles: ['admin'],
        unauthorizedRedirect: '/403',
    });
    const [users, setUsers] = useState<UserRecord[]>([]);
    const [branches, setBranches] = useState<Branch[]>([]);
    const [loading, setLoading] = useState(true);
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);

    // Modals & Action States
    const [showModal, setShowModal] = useState(false);
    const [editingUser, setEditingUser] = useState<UserRecord | null>(null);
    const [viewUser, setViewUser] = useState<UserRecord | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [userToDelete, setUserToDelete] = useState<UserRecord | null>(null);
    const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
    // System dropdown standard — Rule 2: flip the row action menu on viewport edge.
    const [rowMenuFlipUp, setRowMenuFlipUp] = useState(false);
    const [credentialReceipt, setCredentialReceipt] = useState<{ email: string; temporary_password: string; full_name: string; role: string; email_sent?: boolean } | null>(null);

    // Filters & Search
    const [searchTerm, setSearchTerm] = useState('');
    const [firstNameFilter, setFirstNameFilter] = useState('');
    const [lastNameFilter, setLastNameFilter] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');
    const [branchFilter, setBranchFilter] = useState('all');

    const [formData, setFormData] = useState<UserFormData>(createInitialFormData());
    // Current password is required when changing your OWN password here
    // (admin resets of other users don't need it — they can't know it).
    const [selfCurrentPassword, setSelfCurrentPassword] = useState('');
    const [photoPreview, setPhotoPreview] = useState('');
    const [photoUpload, setPhotoUpload] = useState<{ name: string; data_url: string } | null>(null);
    const [photoRemoveRequested, setPhotoRemoveRequested] = useState(false);
    const [govNumberEnabled, setGovNumberEnabled] = useState<Record<GovNumberField, boolean>>(createInitialGovNumberEnabled());
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    // Inline per-field "Required" messages for the Add/Edit form.
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const clearFieldError = (name: string) => {
        setFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const occupiedManagerBranchIds = new Set(
        users
            .filter((record) => String(record.role || '').toLowerCase() === 'manager')
            .filter((record) => Number(record.branch_id || 0) > 0)
            .filter((record) => !editingUser || Number(record.id) !== Number(editingUser.id))
            .map((record) => Number(record.branch_id || 0))
    );
    const isManagerRoleSelected = String(formData.role || '').toLowerCase() === 'manager';
    // Add mode: every fillable field is required; checkbox-gated government
    // numbers are required only while their checkbox is on.
    const isAddMode = !editingUser;
    const reqStar = (on: boolean) => (on ? <span style={{ color: '#dc2626' }}> *</span> : null);

    const isSelfUser = (record?: { id?: number } | null) => {
        const sessionId = Number(user?.id || 0);
        const targetId = Number(record?.id || 0);
        return sessionId > 0 && targetId > 0 && sessionId === targetId;
    };
    const canEditProtectedSelf = (record?: UserRecord | null) => {
        if (!record) return false;
        if (!isSelfUser(record)) return false;
        const sessionRole = String(user?.role || '').toLowerCase();
        const targetRole = String(record.role || '').toLowerCase();
        return sessionRole === 'admin' && targetRole === 'admin';
    };

    // Live-sync: silently refresh users in background.
    useLiveSync(async () => {
        if (!user?.role) return;
        await fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    // This page bootstraps once the shared auth state is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    useEffect(() => {
        const role = String(user?.role || '').toLowerCase();
        if (!role) {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }

        let active = true;

        const loadUsersPage = async () => {
            setLoading(true);
            try {
                await Promise.all([fetchData()]);
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        void loadUsersPage();

        return () => {
            active = false;
        };
    }, [authLoading, user?.role]);

    useEffect(() => {
        const handleClickOutside = () => setActiveDropdown(null);
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, []);

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

    const fetchData = async () => { await Promise.all([fetchUsers(), fetchBranches()]); };

    const fetchUsers = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                credentials: 'include',
                cache: 'no-store',
            });
            const data = await res.json();
            if (data.success) setUsers(data.data);
        } catch { console.error('Failed to fetch users'); }
    };

    const fetchUserById = async (userId: number) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?id=${userId}`, {
                credentials: 'include',
                cache: 'no-store',
            });
            const data = await res.json();
            if (data.success && data.data) return data.data as UserRecord;
        } catch {
            // ignore fetch detail failure
        }
        return null;
    };

    const syncUserRecord = (nextUser: UserRecord) => {
        setUsers((prev) => prev.map((u) => (u.id === nextUser.id ? { ...u, ...nextUser } : u)));
        setViewUser((prev) => (prev && prev.id === nextUser.id ? { ...prev, ...nextUser } : prev));
        setEditingUser((prev) => (prev && prev.id === nextUser.id ? { ...prev, ...nextUser } : prev));
    };

    const refreshUserRecord = async (userId: number) => {
        const fresh = await fetchUserById(userId);
        if (fresh) syncUserRecord(fresh);
    };

    const fetchBranches = async () => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/branches.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setBranches(data.data);
        } catch { console.error('Failed to fetch branches'); }
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
        const target = e.target;
        const { name } = target;
        const isCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox';
        const rawValue = isCheckbox ? target.checked : target.value;
        const govFields: readonly string[] = GOV_NUMBER_FIELDS;
        const nextValue = !isCheckbox && govFields.includes(name)
            ? formatGovNumber(name as GovNumField, String(rawValue))
            : rawValue;
        setFormData((prev) => {
            const nextFormData = { ...prev, [name]: nextValue } as UserFormData;
            if (name === 'role' && String(nextValue).toLowerCase() === 'manager') {
                const selectedBranchId = Number(prev.branch_id || 0);
                if (selectedBranchId > 0 && occupiedManagerBranchIds.has(selectedBranchId)) {
                    nextFormData.branch_id = '';
                }
            }
            return nextFormData;
        });
        clearFieldError(name);
    };

    const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target?.files?.[0];
        if (!file) return;
        if (!file.type?.startsWith('image/')) {
            setError('Please select a valid image file for profile picture.');
            return;
        }
        if (file.size > 5 * 1024 * 1024) {
            setError('Profile picture must be 5MB or less.');
            return;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = String(reader.result || '');
            if (!dataUrl.startsWith('data:image/')) {
                setError('Failed to read image file.');
                return;
            }
            setError('');
            setPhotoPreview(dataUrl);
            setPhotoUpload({ name: file.name, data_url: dataUrl });
            setPhotoRemoveRequested(false);
        };
        reader.readAsDataURL(file);
    };

    const handleRemovePhoto = () => {
        setPhotoPreview('');
        setPhotoUpload(null);
        setPhotoRemoveRequested(true);
        setFormData((prev) => ({ ...prev, photo: '' }));
    };

    const resetForm = () => {
        setFormData(createInitialFormData());
        setSelfCurrentPassword('');
        setPhotoPreview('');
        setPhotoUpload(null);
        setPhotoRemoveRequested(false);
        setGovNumberEnabled(createInitialGovNumberEnabled());
        setEditingUser(null); setError(''); setSuccess(''); setFieldErrors({});
    };

    const openAddModal = () => { resetForm(); setShowModal(true); };

    const openEditModal = (u: UserRecord) => {
        if (isProtectedRole(u.role) && !canEditProtectedSelf(u)) {
            void notifyWarning('Admin and manager accounts cannot be edited here.', 4000);
            setActiveDropdown(null);
            return;
        }
        void refreshUserRecord(u.id);
        setEditingUser(u);
        setFormData({
            first_name: u.first_name || '', last_name: u.last_name || '', date_of_birth: u.date_of_birth || '',
            address: u.address || '',
            email: u.email || '', password: '', role: u.role || 'staff',
            status: u.status || 'active', branch_id: u.branch_id ? String(u.branch_id) : '',
            salary: String(u.salary ?? '0'),
            photo: u.photo || '',
            sss_number: u.sss_number || '',
            pagibig_number: u.pagibig_number || '',
            philhealth_number: u.philhealth_number || '',
            tin_number: u.tin_number || '',
            document_resume: !!Number(u.document_resume || 0),
            document_nbi_clearance: !!Number(u.document_nbi_clearance || 0),
            document_police_clearance: !!Number(u.document_police_clearance || 0),
            document_barangay_clearance: !!Number(u.document_barangay_clearance || 0),
            document_birth_certificate: !!Number(u.document_birth_certificate || 0),
            document_medical_certificate: !!Number(u.document_medical_certificate || 0),
            document_diploma_tor: !!Number(u.document_diploma_tor || 0),
            document_employment_contract: !!Number(u.document_employment_contract || 0),
        });
        setPhotoPreview(resolveAssetUrl(u.photo));
        setPhotoUpload(null);
        setPhotoRemoveRequested(false);
        setGovNumberEnabled({
            sss_number: !!String(u.sss_number || '').trim(),
            pagibig_number: !!String(u.pagibig_number || '').trim(),
            philhealth_number: !!String(u.philhealth_number || '').trim(),
            tin_number: !!String(u.tin_number || '').trim(),
        });
        setSelfCurrentPassword('');
        setError(''); setSuccess(''); setFieldErrors({}); setShowModal(true); setActiveDropdown(null);
    };

    const handleGovNumberToggle = (field: GovNumberField, checked: boolean) => {
        setGovNumberEnabled((prev) => ({ ...prev, [field]: checked }));
        if (!checked) {
            setFormData((prev) => ({ ...prev, [field]: '' }));
        }
        clearFieldError(field);
    };

    const openViewModal = (u: UserRecord) => {
        setViewUser(u);
        setActiveDropdown(null);
        void refreshUserRecord(u.id);
    };

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault(); setError(''); setSuccess('');
        try {
            const isEdit = !!editingUser;
            if (isEdit && editingUser && isProtectedRole(editingUser.role) && !canEditProtectedSelf(editingUser)) {
                setError('Only the admin account owner can edit this profile.');
                return;
            }
            const payload: UserPayload = isEdit && editingUser ? { ...formData, id: editingUser.id } : { ...formData };
            const normalizedEmail = String(payload.email || '').trim().toLowerCase();
            if (!isValidGmailComEmail(normalizedEmail)) {
                setError('Email must be a valid @gmail.com or @phinmaed.com address.');
                return;
            }
            payload.email = normalizedEmail;

            // Add mode: every fillable field is required (inline per-field
            // messages). Checkbox-gated government numbers are required
            // only while enabled.
            if (!String(formData.email || '').trim()) {
                setFieldErrors({ email: 'Required.' });
                return;
            }
            if (!isEdit) {
                const missing: Record<string, string> = {};
                if (!String(formData.first_name || '').trim()) missing.first_name = 'Required.';
                if (!String(formData.last_name || '').trim()) missing.last_name = 'Required.';
                if (!String(formData.date_of_birth || '').trim()) missing.date_of_birth = 'Required.';
                if (!String(formData.address || '').trim()) missing.address = 'Required.';
                if (!String(formData.branch_id || '').trim()) missing.branch_id = 'Required.';
                // Profile picture is optional — backend stores NULL when absent.
                for (const field of GOV_NUMBER_FIELDS) {
                    if (govNumberEnabled[field] && !String(formData[field] || '').trim()) {
                        missing[field] = 'Required.';
                    }
                }
                if (Object.keys(missing).length > 0) {
                    setFieldErrors(missing);
                    return;
                }
            }
            setFieldErrors({});

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

            const normalizedDob = String(formData.date_of_birth || '').trim();
            if (normalizedDob && !isAtLeastMinimumAge(normalizedDob)) {
                setError('Employee must be at least 18 years old.');
                return;
            }
            const selectedBranchId = Number(formData.branch_id || 0);
            if (String(payload.role || '').toLowerCase() === 'manager' && selectedBranchId > 0 && occupiedManagerBranchIds.has(selectedBranchId)) {
                setError('This branch already has a manager assigned. Only one manager is allowed per branch.');
                return;
            }

            if (isEdit && !payload.password) delete payload.password;
            if (isEdit && editingUser && isSelfUser(editingUser) && payload.password) {
                if (!selfCurrentPassword) {
                    setError('Enter your current password first.');
                    return;
                }
                (payload as Record<string, unknown>).current_password = selfCurrentPassword;
            }
            if (!isEdit && (payload.role === 'manager' || payload.role === 'staff')) {
                delete payload.password;
            }
            // Compensation is maintained by the payroll process, not from the
            // employee profile form. Do not overwrite an existing employee's
            // stored payroll rate when their profile is edited.
            delete payload.salary;
            if (photoUpload) payload.photo_upload = photoUpload;
            if (photoRemoveRequested) payload.photo_remove = true;

            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const responseText = await res.text();
            let data: { success?: boolean; message?: string; data?: Record<string, unknown> } = {};
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch {
                throw new Error(responseText.trim() || `Request failed with status ${res.status}`);
            }

            if (res.ok && data.success) {
                setShowModal(false); resetForm();

                // Show receipt for new onboarded users (manager/staff) instead of email
                const creds = (data?.data as Record<string, unknown> | undefined)?.onboarding_credentials as
                    | { email: string; temporary_password: string; full_name: string; role: string; email_sent?: boolean }
                    | undefined;
                if (!isEdit && creds?.temporary_password) {
                    setCredentialReceipt(creds);
                } else {
                    setSuccess(data.message || (isEdit ? 'Employee updated!' : 'Employee created!'));
                }

                if (isEdit && editingUser) {
                    // Optimistic update for PUT
                    setUsers((prev) =>
                        (prev || []).map((u) =>
                            u.id === editingUser.id ? { ...u, ...payload } : u
                        )
                    );
                } else {
                    // Optimistic insert for POST
                    const newUser: UserRecord = {
                        id: Number(data?.data?.id || 0),
                        first_name: payload.first_name as string,
                        last_name: payload.last_name as string,
                        username: '',
                        email: payload.email as string,
                        role: payload.role as string,
                        status: payload.status as string || 'active',
                        created_at: new Date().toISOString(),
                        date_of_birth: payload.date_of_birth as string | null,
                        branch_id: payload.branch_id ? Number(payload.branch_id) : null,
                        employee_id: payload.employee_id ? Number(payload.employee_id) : null,
                        branch_name: '',
                        salary: payload.salary ? Number(payload.salary) : null,
                        photo: null,
                        sss_number: payload.sss_number as string | null,
                        pagibig_number: payload.pagibig_number as string | null,
                        philhealth_number: payload.philhealth_number as string | null,
                        tin_number: payload.tin_number as string | null,
                    };
                    setUsers((prev) => [newUser, ...(prev || [])]);
                }
            } else { setError(data.message || (isEdit ? 'Failed to update employee.' : 'Failed to create employee.')); }
        } catch (err) {
            setError(err instanceof Error && err.message ? err.message : 'An error occurred');
        }
    };

    // Archive user (soft delete)
    const handleArchiveClick = (u: UserRecord) => {
        if (isProtectedRole(u.role)) {
            void notifyWarning('Admin and manager accounts cannot be archived.', 4000);
            setActiveDropdown(null);
            return;
        }
        setUserToDelete(u); setShowDeleteConfirm(true); setActiveDropdown(null);
    };

    const handleDeleteConfirm = async () => {
        if (!userToDelete) return;
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?id=${userToDelete.id}`, { method: 'DELETE', credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                setUsers((prev) =>
                    (prev || []).map((u) =>
                        u.id === userToDelete.id ? { ...u, status: 'inactive' } : u
                    )
                );
            }
            setShowDeleteConfirm(false); setUserToDelete(null);
        } catch (err) { console.error('Failed to delete user', err); }
    };

    // Restore user (silent core — callers confirm first)
    const doRestoreUser = async (userId: number) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?action=restore`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-No-Toast': '1' },
                credentials: 'include',
                body: JSON.stringify({ id: userId })
            });
            const responseText = await res.text();
            let data: { success?: boolean; message?: string } = {};
            try {
                data = responseText ? JSON.parse(responseText) : {};
            } catch {
                throw new Error(responseText.trim() || `Request failed (${res.status})`);
            }
            if (!res.ok || !data.success) throw new Error(data.message || `Request failed (${res.status})`);
            setUsers((prev) => (prev || []).map((u) => u.id === userId ? { ...u, status: 'active' } : u));
            void notifySuccess(data.message || 'User restored successfully.');
        } catch (err) {
            console.error('Failed to restore user', err);
            void notifyError(err instanceof Error ? err.message : 'Failed to restore user.');
        }
    };

    const handleRestore = async (userId: number) => {
        const target = users.find(u => u.id === userId);
        const label = target ? `${target.first_name} ${target.last_name}`.trim() || target.email : 'this user';
        const confirmed = await confirmAction({
            title: `Restore ${label}?`,
            text: 'This user will be returned to active users.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        await doRestoreUser(userId);
    };

    const handleMoveArchivedEmployeeToStorage = async (target: UserRecord) => {
        const employeeId = Number(target.employee_id || 0);
        if (employeeId <= 0) {
            void notifyError('This archived account is not linked to an employee record, so it cannot be moved to Employee Data Storage.');
            return;
        }

        const label = `${target.first_name} ${target.last_name}`.trim() || target.email || 'this employee';
        const confirmed = await confirmAction({
            title: `Remove ${label} from Archived Employees?`,
            text: 'The employee will move to Settings > Data Storage, where you can restore the record later. Employee and payroll history will be kept.',
            confirmButtonText: 'Move to Data Storage',
            cancelButtonText: 'Cancel',
            icon: 'warning',
        });
        if (!confirmed) return;

        try {
            const response = await fetch(`${API_BASE_URL}/api/employees.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ employee_id: employeeId, remove_to_storage: true }),
            });
            const payload = await response.json();
            if (!response.ok || !payload.success) {
                throw new Error(payload.message || 'Failed to move employee to Data Storage.');
            }
            await fetchUsers();
            void notifySuccess(payload.message || 'Employee moved to Data Storage.');
        } catch (err) {
            void notifyError(err instanceof Error ? err.message : 'Failed to move employee to Data Storage.');
        }
    };

    // Toggle status (active/inactive) - not for locked users
    const handleToggleStatus = async (target: UserRecord) => {
        if (isProtectedRole(target.role)) {
            await notifyWarning('Admin and manager accounts cannot be deactivated.', 4000);
            return;
        }
        const currentStatus = String(target.status || '').toLowerCase();
        if (currentStatus === 'locked') return; // don't toggle locked users this way
        const newStatus = currentStatus === 'active' ? 'inactive' : 'active';
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: target.id, status: newStatus })
            });
            const data = await res.json();
            if (data.success) {
                setUsers((prev) =>
                    (prev || []).map((u) =>
                        u.id === target.id ? { ...u, status: newStatus } : u
                    )
                );
            }
        } catch (err) { console.error('Failed to update user status', err); }
    };

    // Unlock user
    const handleUnlock = async (userId: number) => {
        try {
            const res = await fetch(`${API_BASE_URL}/api/users.php?action=unlock&id=${userId}`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (data.success) {
                setUsers((prev) =>
                    (prev || []).map((u) =>
                        u.id === userId ? { ...u, status: 'active' } : u
                    )
                );
            }
        } catch (err) { console.error('Failed to unlock user', err); }
    };

    // Bulk actions
    const handleArchiveAll = async () => {
        const active = users.filter(u => u.status === 'active' || u.status === 'locked');
        const protectedUsers = active.filter(u => isProtectedRole(u.role));
        const eligibleUsers = active.filter(u => !isProtectedRole(u.role));

        if (eligibleUsers.length === 0) {
            void notifyWarning('No users available to archive.', 3000);
            return;
        }

        const protectedMsg = protectedUsers.length > 0
            ? `\n\nNote: ${protectedUsers.length} admin/manager account(s) will be skipped.`
            : '';

        const confirmed = await confirmAction({
            title: 'Archive all users?',
            text: `This will archive ${eligibleUsers.length} user(s).${protectedMsg}`,
            confirmButtonText: 'Archive All',
            icon: 'warning',
        });

        if (!confirmed) return;

        for (const u of eligibleUsers) {
            try {
                const res = await fetch(`${API_BASE_URL}/api/users.php?id=${u.id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
                const data = await res.json();
                if (data.success) {
                    // Continue with next user
                }
            } catch (err) {
                console.error('Failed to archive user', u.id, err);
            }
        }
        setUsers((prev) =>
            (prev || []).map((u) =>
                eligibleUsers.some((e) => e.id === u.id) ? { ...u, status: 'inactive' } : u
            )
        );
    };

    const handleRestoreAll = async () => {
        const archived = users.filter(u => u.status === 'inactive');
        if (archived.length === 0) {
            void notifyWarning('No archived users to restore.', 3000);
            return;
        }
        const confirmed = await confirmAction({
            title: `Restore all archived users?`,
            text: `This will restore ${archived.length} archived user(s) to active.`,
            confirmButtonText: 'Yes, restore all',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        for (const u of archived) { await doRestoreUser(u.id); }
        setUsers((prev) =>
            (prev || []).map((u) =>
                archived.some((a) => a.id === u.id) ? { ...u, status: 'active' } : u
            )
        );
    };

    const toggleDropdown = (e: React.MouseEvent, userId: number) => {
        e.stopPropagation();
        const next = activeDropdown === userId ? null : userId;
        // Rule 2 — flip the row menu upward when it would hit the viewport bottom.
        if (next !== null) {
            setRowMenuFlipUp(getFlipForTrigger(e.currentTarget as HTMLElement, 200));
        }
        setActiveDropdown(next);
    };

    // Filter users
    const visibleUsers = users.filter((u) => !String(u.employee_storage_deleted_at || '').trim());
    const activeUsers = visibleUsers.filter(u => u.status === 'active' || u.status === 'locked');
    const archivedUsers = visibleUsers.filter(u => u.status === 'inactive');

    const displayedUsers = (showArchiveView ? archivedUsers : activeUsers).filter(u => {
        const normalizedSearchTerm = searchTerm.trim().toLowerCase();
        const normalizedFirstNameFilter = firstNameFilter.trim().toLowerCase();
        const normalizedLastNameFilter = lastNameFilter.trim().toLowerCase();
        const matchesSearch = normalizedSearchTerm === '' ||
            (u.first_name?.toLowerCase() || '').includes(normalizedSearchTerm) ||
            (u.last_name?.toLowerCase() || '').includes(normalizedSearchTerm) ||
            (u.username?.toLowerCase() || '').includes(normalizedSearchTerm) ||
            (u.email?.toLowerCase() || '').includes(normalizedSearchTerm);
        const matchesFirstName = normalizedFirstNameFilter === '' || (u.first_name?.trim().toLowerCase() || '').startsWith(normalizedFirstNameFilter);
        const matchesLastName = normalizedLastNameFilter === '' || (u.last_name?.trim().toLowerCase() || '').startsWith(normalizedLastNameFilter);
        const matchesRole = roleFilter === 'all' || u.role === roleFilter;
        const matchesBranch = branchFilter === 'all'
            ? true
            : branchFilter === 'none'
                ? !u.branch_id
                : String(u.branch_id || '') === branchFilter;
        return matchesSearch && matchesFirstName && matchesLastName && matchesRole && matchesBranch;
    });
    const paginatedUsers = displayedUsers.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
    const getCompletedDocCount = (u: UserRecord) => USER_DOC_FIELDS.filter((field) => !!Number(u?.[field] ?? 0) || u?.[field] === true).length;
    const getPersonalAndGovernmentRequirementItems = (u: UserRecord) => [
        { label: 'First Name', complete: !!String(u.first_name || '').trim() },
        { label: 'Last Name', complete: !!String(u.last_name || '').trim() },
        { label: 'Email', complete: !!String(u.email || '').trim() },
        { label: 'Address', complete: !!String(u.address || '').trim() },
        { label: 'Birthdate', complete: !!String(u.date_of_birth || '').trim() },
        { label: 'SSS Number', complete: !!String(u.sss_number || '').trim() },
        { label: 'Pag-IBIG Number', complete: !!String(u.pagibig_number || '').trim() },
        { label: 'PhilHealth Number', complete: !!String(u.philhealth_number || '').trim() },
        { label: 'TIN Number', complete: !!String(u.tin_number || '').trim() },
    ];
    const getPayrollReadinessMissingItems = (u: UserRecord) => {
        const missing = getPersonalAndGovernmentRequirementItems(u)
            .filter((item) => !item.complete)
            .map((item) => item.label);
        USER_DOC_FIELDS.forEach((field) => {
            if (!(!!Number(u[field] ?? 0) || u[field] === true)) missing.push(USER_DOC_LABELS[field]);
        });
        return missing;
    };
    const formatCurrency = (value: number | string | null | undefined) => {
        const amount = Number(value ?? 0);
        const safe = Number.isFinite(amount) ? amount : 0;
        return `PHP ${safe.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    };

    useEffect(() => {
        setCurrentPage(1);
    }, [showArchiveView, searchTerm, firstNameFilter, lastNameFilter, roleFilter, branchFilter]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(displayedUsers.length / itemsPerPage));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [displayedUsers.length, currentPage, itemsPerPage]);

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
            <Head><title>{showArchiveView ? 'Archived Employees' : 'Employees'}</title></Head>

            <div style={{ marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '15px', flexWrap: 'wrap', marginBottom: '12px', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <h1 style={{ fontSize: '14px', fontWeight: 'bold', color: '#1a202c', margin: 0 }}>
                            {showArchiveView ? 'Archived Employees' : 'Employees'}
                        </h1>
                        {!showArchiveView && user?.role !== 'staff' && (
                            <button onClick={openAddModal} title="Add Employee" aria-label="Add Employee" style={{ height: '40px', padding: '0 18px', background: '#1e3a8a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                Add Employee
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                            onClick={() => setShowArchiveView(!showArchiveView)}
                            title={showArchiveView ? 'Back to Active Employees' : 'View Archived Employees'}
                            style={{
                                background: showArchiveView ? '#1e3a8a' : '#f1f5f9',
                                color: showArchiveView ? 'white' : '#64748b',
                                border: 'none', borderRadius: '6px', height: '36px', padding: '0 12px',
                                cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', whiteSpace: 'nowrap'
                            }}
                        >
                            <CrudActionIcon action="archive" />
                            {showArchiveView ? 'Back to Active' : `Archive (${archivedUsers.length})`}
                        </button>
                        {!showArchiveView ? (
                            user?.role !== 'staff' && (
                                <>
                                    {activeUsers.length > 0 && (
                                        <button
                                            onClick={handleArchiveAll}
                                            title="Archive All"
                                            aria-label="Archive All"
                                            style={{
                                                height: '36px',
                                                padding: '0 16px',
                                                background: '#dc2626',
                                                color: 'white',
                                                border: 'none',
                                                borderRadius: '6px',
                                                cursor: 'pointer',
                                                fontWeight: 'bold',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                whiteSpace: 'nowrap'
                                            }}
                                        >
                                            <CrudActionIcon action="archive" />
                                            Archive All
                                        </button>
                                    )}
                                </>
                            )
                        ) : archivedUsers.length > 0 && (
                            <button onClick={handleRestoreAll} title="Restore All" aria-label="Restore All" style={{ height: '36px', padding: '0 16px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }}>
                                <CrudActionIcon action="restore" />
                            </button>
                        )}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(250px, 2fr) repeat(4, minmax(100px, 1fr))', gap: 12, alignItems: 'flex-end', background: '#fff', padding: '14px 16px', borderRadius: 12, border: '1px solid #e2e8f0', marginBottom: 12 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                            Search Employees
                        </label>
                        <SearchBar
                            storageKey="users:list"
                            placeholder="Search employees..."
                            ariaLabel="Search employees"
                            value={searchTerm}
                            onChange={setSearchTerm}
                            suggestions={collectSearchTerms(users, [
                                (u: any) => `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                                (u: any) => u.username,
                                (u: any) => u.email,
                                (u: any) => u.role,
                            ])}
                            inputStyle={{ height: '36px', fontSize: '14px' }}
                        />
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>First Name</label>
                        <select
                            id="first-name-filter"
                            value={firstNameFilter}
                            onChange={(e) => setFirstNameFilter(e.target.value)}
                            style={{ width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px', color: '#333', backgroundColor: '#fff' }}
                        >
                            <option value="">All Letters</option>
                            {ALPHABET_FILTER_OPTIONS.map((letter) => (
                                <option key={letter} value={letter}>{letter}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Last Name</label>
                        <select
                            id="last-name-filter"
                            value={lastNameFilter}
                            onChange={(e) => setLastNameFilter(e.target.value)}
                            style={{ width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '14px', color: '#333', backgroundColor: '#fff' }}
                        >
                            <option value="">All Letters</option>
                            {ALPHABET_FILTER_OPTIONS.map((letter) => (
                                <option key={letter} value={letter}>{letter}</option>
                            ))}
                        </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Role</label>
                        <select id="role-filter" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} style={{ width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: 'white', color: '#333' }}>
                            <option value="all">All Roles</option>
                            <option value="admin">Admin</option>
                            <option value="manager">Manager</option>
                            <option value="staff">Staff</option>
                        </select>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <label style={{ fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Branch</label>
                        <select id="branch-filter" value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} style={{ width: '100%', height: '36px', padding: '0 10px', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: 'white', color: '#333' }}>
                            <option value="all">All Branches</option>
                            <option value="none">No Branch</option>
                            {branches.map((b) => (
                                <option key={b.branch_id} value={String(b.branch_id)}>{b.branch_name}</option>
                            ))}
                        </select>
                    </div>
                </div>
            </div>

            {/* Users Table */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'visible' }}>
                <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead style={{ background: '#f8fafc' }}>
                        <tr>
                            <th style={tableHeaderStyle}></th>
                            <th style={tableHeaderStyle}>Name</th>
                            <th style={tableHeaderStyle}>Email</th>
                            <th style={tableHeaderStyle}>Branch</th>
                            <th style={tableHeaderStyle}>Role</th>
                            {!showArchiveView && <th style={tableHeaderStyle}>Status</th>}
                            <th style={tableHeaderStyle}>Hired Date</th>
                            <th style={{ ...tableHeaderStyle, textAlign: 'center', width: showArchiveView ? '150px' : '60px' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {displayedUsers.length === 0 ? (
                            <tr><td colSpan={showArchiveView ? 7 : 8} style={{ padding: '8px', textAlign: 'center', color: '#666' }}>
                                {showArchiveView && !searchTerm.trim() ? 'No archived employees.' : (
                                    <ZeroResults
                                        query={searchTerm}
                                        itemLabel="employees"
                                        alternatives={getAlternativeSuggestions(searchTerm, collectSearchTerms(users, [
                                            (u: any) => `${u.first_name || ''} ${u.last_name || ''}`.trim(),
                                            (u: any) => u.username,
                                            (u: any) => u.email,
                                        ]))}
                                        onPickAlternative={(term) => setSearchTerm(term)}
                                        onClear={() => setSearchTerm('')}
                                    />
                                )}
                            </td></tr>
                        ) : paginatedUsers.map((u, index) => {
                            const isProtected = isProtectedRole(u.role);
                            const isLocked = u.status === 'locked';
                            const canToggleStatus = !isProtected && !isLocked;
                            const canEditRow = !isProtected || canEditProtectedSelf(u);
                            const canManageArchive = user?.role !== 'staff' && !isProtected;
                            const canUnlock = user?.role !== 'staff' && isLocked;
                            const missingPayrollRequirements = getPayrollReadinessMissingItems(u);

                            return (
                            <tr key={u.id}>
                                <td style={tableCellStyle}>{(currentPage - 1) * itemsPerPage + index + 1}</td>
                                <td style={tableCellStyle}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                        <div style={{ width: 34, height: 34, borderRadius: '999px', background: '#e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', fontWeight: 700 }}>
                                            {u.photo ? (
                                                <img src={resolveAssetUrl(u.photo)} alt={`${u.first_name} ${u.last_name}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                            ) : (
                                                `${(u.first_name || u.username || 'U').charAt(0).toUpperCase()}`
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', flexDirection: 'column' }}>
                                            <span>{u.first_name} {u.last_name}</span>
                                            <span style={{ fontSize: 12, color: missingPayrollRequirements.length === 0 ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
                                                {missingPayrollRequirements.length === 0 ? 'Requirements Complete' : `Missing Requirements (${missingPayrollRequirements.length})`}
                                            </span>
                                        </div>
                                    </div>
                                </td>
                                <td style={tableCellStyle} className="llb-trunc" title={u.email}>{u.email}</td>
                                <td style={tableCellStyle}>{u.branch_name || '-'}</td>
                                <td style={tableCellStyle}>
                                    <span style={{
                                        padding: '4px 8px', borderRadius: '12px', fontSize: '12px', fontWeight: 'bold',
                                        background: u.role === 'manager' ? '#fef3c7' : '#dcfce7',
                                        color: u.role === 'manager' ? '#d97706' : '#15803d', textTransform: 'capitalize'
                                    }}>{u.role}</span>
                                </td>
                                {!showArchiveView && (
                                    <td style={tableCellStyle}>
                                        <span
                                            onClick={() => canToggleStatus && handleToggleStatus(u)}
                                            title={
                                                isProtected
                                                    ? 'Admin and manager accounts cannot be deactivated.'
                                                    : isLocked
                                                        ? 'Account is locked - use Unlock action'
                                                        : `Click to ${u.status === 'active' ? 'deactivate' : 'activate'} this user`
                                            }
                                            style={{
                                                color: u.status === 'active' ? 'green' : u.status === 'locked' ? '#d97706' : 'red',
                                                fontWeight: 'bold',
                                                padding: '4px 8px',
                                                borderRadius: '12px',
                                                background: u.status === 'active' ? '#dcfce7' : u.status === 'locked' ? '#fef3c7' : '#fee2e2',
                                                textTransform: 'capitalize',
                                                cursor: canToggleStatus ? 'pointer' : 'not-allowed',
                                                transition: 'opacity 0.2s',
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                gap: '4px',
                                            }}
                                            onMouseOver={(e) => canToggleStatus && (e.currentTarget.style.opacity = '0.7')}
                                            onMouseOut={(e) => (e.currentTarget.style.opacity = '1')}
                                        >
                                            {u.status === 'locked' && (
                                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                                </svg>
                                            )}
                                            {u.status}
                                        </span>
                                    </td>
                                )}
                                <td style={tableCellStyle}>{new Date(u.created_at).toLocaleDateString()}</td>
                                <td style={{ ...tableCellStyle, textAlign: 'center', position: 'relative' }} className={`llb-actions${showArchiveView ? ' llb-actions-always-visible' : ''}`}>
                                    {showArchiveView ? (
                                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                            <button onClick={() => handleRestore(u.id)} title="Restore" aria-label={`Restore ${u.first_name} ${u.last_name}`} style={{ padding: '6px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                                <CrudActionIcon action="restore" />
                                            </button>
                                            {String(user?.role || '').toLowerCase() === 'admin' && Number(u.employee_id || 0) > 0 && (
                                                <button onClick={() => void handleMoveArchivedEmployeeToStorage(u)} title="Move to Data Storage" aria-label={`Remove ${u.first_name} ${u.last_name} from Archived Employees`} style={{ padding: '6px 10px', background: '#fff1f2', color: '#be123c', border: '1px solid #fecaca', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                                    Remove
                                                </button>
                                            )}
                                        </div>
                                    ) : (
                                        <>
                                            <button
                                                onClick={(e) => toggleDropdown(e, u.id)}
                                                aria-label={`Row actions for ${u.first_name} ${u.last_name}`}
                                                aria-expanded={activeDropdown === u.id}
                                                aria-haspopup="menu"
                                                title="Row actions"
                                                style={{ background: 'transparent', border: '1px solid transparent', borderRadius: 8, cursor: 'pointer', padding: '5px', minWidth: 48, minHeight: 48, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: 1 }}
                                                onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = '#f1f5f9'; (e.currentTarget as HTMLButtonElement).style.borderColor = '#cbd5e1'; }}
                                                onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; (e.currentTarget as HTMLButtonElement).style.borderColor = 'transparent'; }}
                                            >
                                                <svg width="20" height="20" viewBox="0 0 24 24" fill="#666"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                                            </button>
                                            {activeDropdown === u.id && (
                                                <div className={`app-anim-menu app-row-menu${rowMenuFlipUp ? ' app-flip-up' : ''}`} style={{ position: 'absolute', right: '10px', top: rowMenuFlipUp ? 'auto' : '100%', bottom: rowMenuFlipUp ? '100%' : 'auto', background: 'white', border: '1px solid #e2e8f0', borderRadius: '8px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100, minWidth: '120px' }}>
                                                    <button onClick={() => openViewModal(u)} title="View" aria-label={`View ${u.first_name} ${u.last_name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}>
                                                        <CrudActionIcon action="view" /> View
                                                    </button>
                                                    {user?.role !== 'staff' && canEditRow && (
                                                        <button onClick={() => openEditModal(u)} title="Edit" aria-label={`Edit ${u.first_name} ${u.last_name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}>
                                                            <CrudActionIcon action="edit" /> Edit
                                                        </button>
                                                    )}
                                                    {canUnlock ? (
                                                        <button onClick={() => handleUnlock(u.id)} style={{ display: 'block', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: '#d97706', fontWeight: 'bold' }}>
                                                            Unlock
                                                        </button>
                                                    ) : canManageArchive ? (
                                                        <button onClick={() => handleArchiveClick(u)} title="Archive" aria-label={`Archive ${u.first_name} ${u.last_name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'red' }}>
                                                            <CrudActionIcon action="archive" /> Archive
                                                        </button>
                                                    ) : null}
                                                </div>
                                            )}
                                        </>
                                    )}
                                </td>
                            </tr>
                        );
                        })}
                    </tbody>
                </table>
            </div>
            <Pagination
                currentPage={currentPage}
                totalItems={displayedUsers.length}
                itemsPerPage={itemsPerPage}
                onPageChange={setCurrentPage}
                label={showArchiveView ? 'archived employees' : 'employees'}
            />

            {/* View Employee Modal */}
            {viewUser && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', width: '860px', maxWidth: '95%', maxHeight: '88vh', overflowY: 'auto' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, borderBottom: '1px solid #eee', paddingBottom: 12 }}>
                            <h2 style={{ margin: 0, color: '#1e3a8a' }}>Employee Details</h2>
                            <button onClick={() => setViewUser(null)} style={{ background: 'none', border: 'none', fontSize: '14px', cursor: 'pointer', color: '#999' }}>x</button>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, padding: '10px 12px', border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc' }}>
                            <div style={{ width: 64, height: 64, borderRadius: '999px', background: '#e2e8f0', color: '#475569', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', fontSize: 14, fontWeight: 800 }}>
                                {viewUser.photo ? (
                                    <img src={resolveAssetUrl(viewUser.photo)} alt={`${viewUser.first_name} ${viewUser.last_name}`} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                ) : (
                                    `${(viewUser.first_name || viewUser.username || 'U').charAt(0).toUpperCase()}`
                                )}
                            </div>
                            <div>
                                <div style={{ fontSize: 14, fontWeight: 700, color: '#1f2937' }}>{viewUser.first_name} {viewUser.last_name}</div>
                                <div style={{ color: '#64748b', fontSize: 12 }}>{viewUser.username}</div>
                                <div style={{ marginTop: 6, fontSize: 12, fontWeight: 700, color: getPayrollReadinessMissingItems(viewUser).length === 0 ? '#166534' : '#991b1b', background: getPayrollReadinessMissingItems(viewUser).length === 0 ? '#dcfce7' : '#fee2e2', border: `1px solid ${getPayrollReadinessMissingItems(viewUser).length === 0 ? '#bbf7d0' : '#fecaca'}`, borderRadius: 999, padding: '3px 10px', display: 'inline-block' }}>
                                    {getPayrollReadinessMissingItems(viewUser).length === 0 ? 'Requirements Complete' : `Missing Requirements: ${getPayrollReadinessMissingItems(viewUser).length}`}
                                </div>
                            </div>
                        </div>
                        {getPayrollReadinessMissingItems(viewUser).length > 0 && (
                            <div style={{ marginBottom: 12, padding: '10px 12px', border: '1px solid #fecaca', borderRadius: 10, background: '#fff7f7', color: '#991b1b', fontSize: 12 }}>
                                <strong>Missing requirements:</strong> {getPayrollReadinessMissingItems(viewUser).join(', ')}
                            </div>
                        )}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12 }}>
                            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
                                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Employee Account</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Full Name</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.first_name} {viewUser.last_name}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Username</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.username}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Email</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.email}</div></div>
                                    <div style={{ gridColumn: '1 / -1' }}><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Address</label><div style={{ fontWeight: 500, color: '#333', whiteSpace: 'pre-wrap' }}>{viewUser.address || '-'}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Role</label><span style={{ padding: '3px 8px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: viewUser.role === 'manager' ? '#fef3c7' : '#dcfce7', color: viewUser.role === 'manager' ? '#d97706' : '#15803d', textTransform: 'capitalize' }}>{viewUser.role}</span></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Branch</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.branch_name || 'No Branch'}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Status</label><span style={{ color: viewUser.status === 'active' ? 'green' : 'red', fontWeight: 'bold', textTransform: 'capitalize' }}>{viewUser.status}</span></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Salary</label><div style={{ fontWeight: 500, color: '#333' }}>{formatCurrency(viewUser.salary)}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>SSS Number</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.sss_number || '-'}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>Pag-IBIG Number</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.pagibig_number || '-'}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>PhilHealth Number</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.philhealth_number || '-'}</div></div>
                                    <div><label style={{ display: 'block', color: '#64748b', fontSize: 12, marginBottom: 4 }}>TIN Number</label><div style={{ fontWeight: 500, color: '#333' }}>{viewUser.tin_number || '-'}</div></div>
                                </div>
                                <div style={{ marginTop: 14 }}>
                                    <label style={{ display: 'block', color: '#1f2937', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Personal &amp; Government Requirements</label>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 8 }}>
                                        {getPersonalAndGovernmentRequirementItems(viewUser).map((item) => (
                                            <div key={item.label} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 9px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
                                                <span style={{ color: '#334155', fontSize: 12 }}>{item.label}</span>
                                                <span style={{ fontSize: 11, fontWeight: 700, color: item.complete ? '#166534' : '#991b1b', background: item.complete ? '#dcfce7' : '#fee2e2', borderRadius: 999, padding: '2px 7px' }}>
                                                    {item.complete ? 'Complete' : 'Missing'}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            </div>
                            <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
                                <label style={{ display: 'block', color: '#1f2937', fontWeight: 700, fontSize: 13, marginBottom: 10 }}>Employment Documents</label>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
                                    {USER_DOC_FIELDS.map((field) => {
                                        const submitted = !!Number(viewUser[field] ?? 0) || viewUser[field] === true;
                                        return (
                                            <div key={field} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 9px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                                <span style={{ color: '#334155', fontSize: 12 }}>{USER_DOC_LABELS[field]}</span>
                                                <span style={{ fontSize: 11, fontWeight: 700, color: submitted ? '#166534' : '#991b1b', background: submitted ? '#dcfce7' : '#fee2e2', borderRadius: 999, padding: '2px 7px' }}>
                                                    {submitted ? 'Submitted' : 'Missing'}
                                                </span>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #eee', display: 'flex', justifyContent: 'flex-end', gap: 10, background: 'white', position: 'sticky', bottom: 0 }}>
                            {user?.role !== 'staff' && (!isProtectedRole(viewUser.role) || canEditProtectedSelf(viewUser)) && (
                                <button
                                    onClick={() => {
                                        const selectedUser = viewUser;
                                        setViewUser(null);
                                        openEditModal(selectedUser);
                                    }}
                                    title="Edit"
                                    aria-label="Edit employee"
                                    style={{ padding: '10px 20px', background: '#1e3a8a', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 700, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                >
                                    <CrudActionIcon action="edit" />
                                </button>
                            )}
                            <button onClick={() => setViewUser(null)} style={{ padding: '10px 20px', background: '#f1f5f9', border: 'none', borderRadius: '6px', cursor: 'pointer', color: '#475569', fontWeight: '500' }}>Close</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add/Edit Modal */}
            {showModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ background: 'white', padding: '20px', borderRadius: '12px', width: '860px', maxWidth: '95%', maxHeight: '88vh', overflowY: 'auto' }}>
                        <h2 style={{ marginTop: 0, marginBottom: '14px', color: '#333' }}>{editingUser ? 'Edit Employee' : 'Add Employee'}</h2>
                        <form onSubmit={handleSubmit} noValidate>
                            <div style={{ marginBottom: 14, padding: 12, border: '2px solid #cbd5e1', borderRadius: 10, background: '#f8fafc' }}>
                                <label style={{ display: 'block', marginBottom: 8, color: '#334155', fontSize: 13, fontWeight: 600 }}>Profile Picture <span style={{ fontWeight: 400, color: '#64748b' }}>(optional)</span></label>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                                    <div style={{ width: 64, height: 64, borderRadius: '999px', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', color: '#475569', fontSize: 14, fontWeight: 700 }}>
                                        {photoPreview ? (
                                            <img src={photoPreview} alt="Profile preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                                        ) : (
                                            `${(formData.first_name || formData.email || 'U').charAt(0).toUpperCase()}`
                                        )}
                                    </div>
                                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => { handlePhotoChange(e); clearFieldError('photo'); }} style={{ color: '#334155' }} />
                                        {(photoPreview || formData.photo) && (
                                            <button type="button" onClick={handleRemovePhoto} style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff1f2', color: '#be123c', cursor: 'pointer' }}>Remove</button>
                                        )}
                                    </div>
                                    {fieldErrors.photo && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.photo}</div>}
                                </div>
                            </div>

                            <div style={{ marginBottom: 14, border: '2px solid #cbd5e1', borderRadius: 10, padding: 12 }}>
                                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Personal Details</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', columnGap: 12, rowGap: 10, alignItems: 'start' }}>
                                <div><label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>First Name{reqStar(isAddMode)}</label><input type="text" name="first_name" value={formData.first_name} onChange={handleInputChange} required aria-required="true" aria-invalid={fieldErrors.first_name ? true : undefined} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.first_name ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white' }} />{fieldErrors.first_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.first_name}</div>}</div>
                                <div><label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Last Name{reqStar(isAddMode)}</label><input type="text" name="last_name" value={formData.last_name} onChange={handleInputChange} required={isAddMode} aria-required={isAddMode ? 'true' : undefined} aria-invalid={fieldErrors.last_name ? true : undefined} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.last_name ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white' }} />{fieldErrors.last_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.last_name}</div>}</div>
                                <div><label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Email{reqStar(isAddMode)}</label><input type="email" name="email" value={formData.email} onChange={handleInputChange} required aria-required="true" aria-invalid={fieldErrors.email ? true : undefined} pattern="^[^\s@]+@(gmail\.com|phinmaed\.com)$" title="Use a valid @gmail.com or @phinmaed.com email address." placeholder="example@phinmaed.com" style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.email ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white' }} />{fieldErrors.email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.email}</div>}</div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Birthdate{reqStar(isAddMode)}</label>
                                    <input
                                        type="date"
                                        name="date_of_birth"
                                        value={formData.date_of_birth}
                                        onChange={handleInputChange}
                                        required={isAddMode}
                                        aria-required={isAddMode ? 'true' : undefined}
                                        aria-invalid={fieldErrors.date_of_birth ? true : undefined}
                                        max={MAX_BIRTHDATE}
                                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.date_of_birth ? '2px solid #ef4444' : `1px solid ${formData.date_of_birth && !isAtLeastMinimumAge(formData.date_of_birth) ? '#ef4444' : '#ccc'}`, color: '#333', backgroundColor: 'white' }}
                                    />
                                    {fieldErrors.date_of_birth && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.date_of_birth}</div>}
                                    {(() => {
                                        const age = computeAge(formData.date_of_birth);
                                        if (age === null) return <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>Must be at least {MINIMUM_USER_AGE} years old.</div>;
                                        const valid = age >= MINIMUM_USER_AGE;
                                        return (
                                            <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, backgroundColor: valid ? '#dcfce7' : '#fee2e2', color: valid ? '#15803d' : '#dc2626' }}>
                                                {valid ? '✓' : '✗'} Age: {age} {valid ? '(eligible)' : `(must be ≥ ${MINIMUM_USER_AGE})`}
                                            </div>
                                        );
                                    })()}
                                </div>
                                <div style={{ gridColumn: '1 / -1' }}>
                                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Address{reqStar(isAddMode)}</label>
                                    <textarea
                                        name="address"
                                        value={formData.address}
                                        onChange={handleInputChange}
                                        required={isAddMode}
                                        aria-required={isAddMode ? 'true' : undefined}
                                        aria-invalid={fieldErrors.address ? true : undefined}
                                        rows={3}
                                        maxLength={255}
                                        placeholder="House/Unit, Street, Barangay, City/Municipality, Province"
                                        style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.address ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white', resize: 'vertical' }}
                                    />
                                    {fieldErrors.address && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.address}</div>}
                                </div>
                                </div>
                            </div>

                            <div style={{ marginBottom: 14, border: '2px solid #cbd5e1', borderRadius: 10, padding: 12 }}>
                                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Account &amp; Employment Details</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', columnGap: 12, rowGap: 10, alignItems: 'start' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>
                                        Password
                                        {editingUser ? (
                                            <span style={{ color: '#999', fontSize: 11 }}> (leave blank to keep)</span>
                                        ) : (
                                            <span style={{ color: '#999', fontSize: 11 }}> (auto-generated — will also be emailed to the user)</span>
                                        )}
                                    </label>
                                    <PasswordInput
                                        name="password"
                                        value={formData.password}
                                        onChange={handleInputChange}
                                        required={false}
                                        disabled={!editingUser}
                                        placeholder={editingUser ? 'Optional password update' : 'Temporary password will be generated automatically'}
                                        style={{
                                            width: '100%',
                                            padding: '8px 10px',
                                            borderRadius: 6,
                                            border: '1px solid #ccc',
                                            color: editingUser ? '#333' : '#94a3b8',
                                            backgroundColor: editingUser ? 'white' : '#f8fafc',
                                            cursor: editingUser ? 'text' : 'not-allowed'
                                        }}
                                        showStrength={!!editingUser}
                                        showSuggest={!!editingUser}
                                        showVisibilityToggle={!!editingUser}
                                        onSuggestPick={(pwd) => setFormData((prev) => ({ ...prev, password: pwd }))}
                                    />
                                    {editingUser && isSelfUser(editingUser) && (
                                        <div style={{ marginTop: 8 }}>
                                            <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>
                                                Current Password
                                                <span style={{ color: '#999', fontSize: 11 }}> (required to change your own password)</span>
                                            </label>
                                            <PasswordInput
                                                name="selfCurrentPassword"
                                                value={selfCurrentPassword}
                                                onChange={(e) => setSelfCurrentPassword(e.target.value)}
                                                placeholder="Enter your current password first"
                                                autoComplete="current-password"
                                                style={{
                                                    width: '100%',
                                                    padding: '8px 10px',
                                                    borderRadius: 6,
                                                    border: '1px solid #ccc',
                                                    color: '#333',
                                                    backgroundColor: 'white',
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div><label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Role</label><select name="role" value={formData.role} onChange={handleInputChange} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}><option value="staff">Staff</option><option value="manager">Manager</option></select></div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Branch{reqStar(isAddMode)}</label>
                                    <select name="branch_id" value={formData.branch_id} onChange={handleInputChange} required={isAddMode} aria-required={isAddMode ? 'true' : undefined} aria-invalid={fieldErrors.branch_id ? true : undefined} style={{ width: '100%', padding: '8px 10px', borderRadius: 6, border: fieldErrors.branch_id ? '2px solid #ef4444' : '1px solid #ccc', backgroundColor: 'white', color: '#333' }}>
                                        <option value="">-- Select Branch --</option>
                                        {branches.filter(b => b.status === 'active').map((b) => {
                                            const managerAssigned = occupiedManagerBranchIds.has(Number(b.branch_id));
                                            const disabled = isManagerRoleSelected && managerAssigned;
                                            const label = disabled ? `${b.branch_name} (Manager assigned)` : b.branch_name;
                                            return <option key={b.branch_id} value={b.branch_id} disabled={disabled}>{label}</option>;
                                        })}
                                    </select>
                                    {fieldErrors.branch_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.branch_id}</div>}
                                    {isManagerRoleSelected && (
                                        <div style={{ marginTop: 6, color: '#64748b', fontSize: 12 }}>
                                            Each branch can only have one manager. Staff accounts can still be assigned to any branch.
                                        </div>
                                    )}
                                </div>
                                </div>
                            </div>

                            <div style={{ marginBottom: 14, border: '2px solid #cbd5e1', borderRadius: 10, padding: 12 }}>
                                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Philippine Government Numbers</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10 }}>
                                    {GOV_NUMBER_FIELDS.map((field) => (
                                        <div key={field}>
                                            <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, color: '#555', fontSize: 12, fontWeight: 600 }}>
                                                <input
                                                    type="checkbox"
                                                    checked={!!govNumberEnabled[field]}
                                                    onChange={(e) => handleGovNumberToggle(field, e.target.checked)}
                                                />
                                                <span>{GOV_NUMBER_LABELS[field]}{reqStar(isAddMode && !!govNumberEnabled[field])}</span>
                                            </label>
                                            <input
                                                type="text"
                                                name={field}
                                                value={formData[field]}
                                                onChange={handleInputChange}
                                                disabled={!govNumberEnabled[field]}
                                                required={isAddMode && !!govNumberEnabled[field]}
                                                aria-required={isAddMode && !!govNumberEnabled[field] ? 'true' : undefined}
                                                aria-invalid={fieldErrors[field] ? true : undefined}
                                                placeholder={GOV_NUMBER_PLACEHOLDERS[field]}
                                                style={{
                                                    width: '100%',
                                                    padding: '8px 10px',
                                                    borderRadius: 6,
                                                    border: fieldErrors[field] ? '2px solid #ef4444' : '1px solid #ccc',
                                                    color: govNumberEnabled[field] ? '#333' : '#94a3b8',
                                                    backgroundColor: govNumberEnabled[field] ? 'white' : '#f8fafc',
                                                    cursor: govNumberEnabled[field] ? 'text' : 'not-allowed'
                                                }}
                                            />
                                            {fieldErrors[field] && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors[field]}</div>}
                                        </div>
                                    ))}
                                </div>
                            </div>

                            <div style={{ marginBottom: 14, border: '2px solid #cbd5e1', borderRadius: 10, padding: 12 }}>
                                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Employment Document Checklist</div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(185px, 1fr))', gap: 8 }}>
                                    {USER_DOC_FIELDS.map((field) => (
                                        <label key={field} style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#334155', fontSize: 12, padding: '7px 9px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}>
                                            <input type="checkbox" name={field} checked={formData[field]} onChange={handleInputChange} />
                                            <span>{USER_DOC_LABELS[field]}</span>
                                        </label>
                                    ))}
                                </div>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12, alignItems: 'center', borderTop: '1px solid #e5e7eb', padding: '12px 4px 0', marginTop: 14, background: 'white', boxSizing: 'border-box', width: '100%' }}>
                                <button 
                                    type="button" 
                                    onClick={() => { setShowModal(false); resetForm(); }} 
                                    style={{ 
                                        background: 'transparent', 
                                        border: 'none', 
                                        padding: '9px 14px', 
                                        borderRadius: 7,
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
                                    title={editingUser ? 'Update Employee' : 'Create Employee'} 
                                    aria-label={editingUser ? 'Update Employee' : 'Create Employee'} 
                                    style={{ 
                                        background: '#2563eb', 
                                        border: '1px solid #1d4ed8', 
                                        padding: '9px 16px', 
                                        borderRadius: 7,
                                        cursor: 'pointer', 
                                        color: '#fff',
                                        fontWeight: 600,
                                        fontSize: 14
                                    }}
                                >
                                    {editingUser ? 'Update' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Delete/Archive Confirmation Modal */}
            {showDeleteConfirm && userToDelete && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '400px', maxWidth: '90%', textAlign: 'center' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>Archive Employee?</h3>
                        <p style={{ margin: '0 0 20px 0', color: '#666' }}>
                            Are you sure you want to archive <strong>{userToDelete.first_name} {userToDelete.last_name}</strong>?
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
                            <button onClick={() => { setShowDeleteConfirm(false); setUserToDelete(null); }} style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', color: '#666' }}>Cancel</button>
                            <button onClick={handleDeleteConfirm} title="Archive" aria-label="Archive employee" style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CrudActionIcon action="archive" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Credential Receipt Modal */}
            {credentialReceipt && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
                    <div style={{ background: '#fff', borderRadius: '14px', width: '500px', maxWidth: '96%', boxShadow: '0 24px 64px rgba(0,0,0,0.28)', overflow: 'hidden' }}>

                        {/* Header */}
                        <div style={{ background: 'linear-gradient(135deg,#1e3a8a 0%,#1d4ed8 100%)', padding: '22px 28px', color: '#fff' }}>
                            <div style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', opacity: 0.7, marginBottom: '6px' }}>LLB Accountants — New Account</div>
                            <div style={{ fontSize: '22px', fontWeight: 800, lineHeight: 1.2 }}>Credential Receipt</div>
                            <div style={{ fontSize: '13px', opacity: 0.85, marginTop: '4px' }}>
                                {credentialReceipt.full_name} &nbsp;·&nbsp; <span style={{ textTransform: 'capitalize' }}>{credentialReceipt.role}</span>
                            </div>
                        </div>

                        {/* Body */}
                         <div style={{ padding: '24px 28px' }}>
                             <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#374151', lineHeight: 1.65 }}>
                                  The account has been created successfully. The credentials below are also being emailed to the user&apos;s email address. They are required to change their password on first login.
                             </p>
                             {credentialReceipt.email_sent === false && (
                                 <div style={{ background: '#fef3c7', border: '1px solid #fcd34d', borderRadius: '7px', padding: '9px 12px', marginBottom: '12px', fontSize: '12px', color: '#92400e', lineHeight: 1.55 }}>
                                     ⚠ The welcome email could not be sent (SMTP may not be configured). Please hand these credentials to the user directly.
                                 </div>
                             )}
                             {credentialReceipt.email_sent === true && (
                                 <div style={{ background: '#dcfce7', border: '1px solid #86efac', borderRadius: '7px', padding: '9px 12px', marginBottom: '12px', fontSize: '12px', color: '#166534', lineHeight: 1.55 }}>
                                     ✓ Welcome email with login credentials was sent to <strong>{credentialReceipt.email}</strong>.
                                 </div>
                             )}

                            {/* EMAIL field */}
                            <div style={{ marginBottom: '12px' }}>
                                <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#475569', marginBottom: '5px' }}>EMAIL:</div>
                                <div style={{ background: '#f1f5f9', borderRadius: '8px', padding: '12px 16px', fontSize: '15px', fontWeight: 600, color: '#0f172a', fontFamily: 'Consolas,Monaco,monospace', wordBreak: 'break-all', border: '1px solid #e2e8f0' }}>
                                    {credentialReceipt.email}
                                </div>
                            </div>

                            {/* PASSWORD field */}
                            <div style={{ marginBottom: '16px' }}>
                                <div style={{ fontSize: '10px', fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#b45309', marginBottom: '5px' }}>
                                    PASSWORD: <span style={{ fontWeight: 600, color: '#92400e', fontSize: '9px' }}>(temporary)</span>
                                </div>
                                <div style={{ background: '#111827', borderRadius: '8px', padding: '14px 18px', fontSize: '22px', fontWeight: 700, color: '#f9fafb', fontFamily: 'Consolas,Monaco,monospace', letterSpacing: '0.14em', textAlign: 'center', border: '2px solid #374151' }}>
                                    {credentialReceipt.temporary_password}
                                </div>
                                <div style={{ fontSize: '11px', color: '#92400e', marginTop: '6px', lineHeight: 1.5 }}>
                                    For first login only — the user must set a new password immediately after signing in.
                                </div>
                            </div>

                            {/* Warning banner */}
                            <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', padding: '11px 14px', marginBottom: '22px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                                <span style={{ fontSize: '15px', flexShrink: 0 }}>⚠</span>
                                <div style={{ fontSize: '12px', color: '#991b1b', lineHeight: 1.6 }}>
                                    Save or print this receipt now. The temporary password <strong>cannot be retrieved</strong> after closing this dialog.
                                </div>
                            </div>

                            {/* Actions */}
                            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                                <button
                                    onClick={() => setCredentialReceipt(null)}
                                    style={{ padding: '9px 18px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '7px', cursor: 'pointer', color: '#374151', fontSize: '13px' }}
                                >
                                    Close
                                </button>
                                <button
                                    onClick={() => {
                                        const cred = credentialReceipt;
                                        const safeEmail = cred.email.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safePw = cred.temporary_password.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safeName = cred.full_name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safeRole = cred.role.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Credential Receipt</title><style>*{box-sizing:border-box}body{font-family:system-ui,Arial,sans-serif;background:#fff;padding:48px 40px;max-width:560px;margin:0 auto;color:#111}.org{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#1e3a8a;margin-bottom:2px}.title{font-size:22px;font-weight:800;color:#111;margin:0 0 4px 0}.subtitle{font-size:13px;color:#475569;margin:0 0 28px 0}.label{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:5px}.field{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:7px;padding:11px 14px;font-family:Consolas,Monaco,monospace;font-size:15px;font-weight:600;color:#0f172a;word-break:break-all;margin-bottom:16px}.pw-label{color:#b45309}.pw-field{background:#111827;border:2px solid #374151;border-radius:7px;padding:14px 18px;font-family:Consolas,Monaco,monospace;font-size:24px;font-weight:700;color:#f9fafb;letter-spacing:.14em;text-align:center;margin-bottom:6px}.pw-note{font-size:11px;color:#92400e;margin-bottom:20px}.warn{background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:11px 14px;font-size:12px;color:#991b1b;line-height:1.6;margin-bottom:28px}hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}footer{font-size:11px;color:#9ca3af;text-align:center}@media print{body{padding:30px}}</style></head><body><div class="org">LLB Accountants</div><h1 class="title">Credential Receipt</h1><p class="subtitle">New account for: <strong>${safeName}</strong> &nbsp;(${safeRole})</p><hr><div class="label">EMAIL:</div><div class="field">${safeEmail}</div><div class="label pw-label">PASSWORD: <span style="font-weight:600;font-size:9px;color:#92400e">(temporary)</span></div><div class="pw-field">${safePw}</div><div class="pw-note">For first login only — user must set a new password immediately after signing in.</div><div class="warn">⚠ Keep this receipt confidential. The temporary password cannot be retrieved from the system after this point.</div><hr><footer>Generated by LLB Accountants system &mdash; confidential</footer></body></html>`;
                                        const blob = new Blob([html], { type: 'text/html' });
                                        const url = URL.createObjectURL(blob);
                                        const a = document.createElement('a');
                                        a.href = url;
                                        a.download = `credential-receipt-${cred.email.split('@')[0]}.html`;
                                        a.click();
                                        URL.revokeObjectURL(url);
                                    }}
                                    style={{ padding: '9px 18px', background: '#0f172a', color: '#fff', border: 'none', borderRadius: '7px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
                                >
                                    Download Receipt
                                </button>
                                <button
                                    onClick={() => {
                                        const cred = credentialReceipt;
                                        const safeEmail = cred.email.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safePw = cred.temporary_password.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safeName = cred.full_name.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const safeRole = cred.role.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
                                        const w = window.open('', '_blank', 'width=620,height=580');
                                        if (!w) return;
                                        w.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Credential Receipt</title><style>*{box-sizing:border-box}body{font-family:system-ui,Arial,sans-serif;background:#fff;padding:48px 40px;max-width:560px;margin:0 auto;color:#111}.org{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#1e3a8a;margin-bottom:2px}.title{font-size:22px;font-weight:800;color:#111;margin:0 0 4px 0}.subtitle{font-size:13px;color:#475569;margin:0 0 28px 0}.label{font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#475569;margin-bottom:5px}.field{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:7px;padding:11px 14px;font-family:Consolas,Monaco,monospace;font-size:15px;font-weight:600;color:#0f172a;word-break:break-all;margin-bottom:16px}.pw-label{color:#b45309}.pw-field{background:#111827;border:2px solid #374151;border-radius:7px;padding:14px 18px;font-family:Consolas,Monaco,monospace;font-size:24px;font-weight:700;color:#f9fafb;letter-spacing:.14em;text-align:center;margin-bottom:6px}.pw-note{font-size:11px;color:#92400e;margin-bottom:20px}.warn{background:#fef2f2;border:1px solid #fca5a5;border-radius:7px;padding:11px 14px;font-size:12px;color:#991b1b;line-height:1.6;margin-bottom:28px}hr{border:none;border-top:1px solid #e5e7eb;margin:20px 0}footer{font-size:11px;color:#9ca3af;text-align:center}@media print{body{padding:30px}}</style></head><body><div class="org">LLB Accountants</div><h1 class="title">Credential Receipt</h1><p class="subtitle">New account for: <strong>${safeName}</strong> &nbsp;(${safeRole})</p><hr><div class="label">EMAIL:</div><div class="field">${safeEmail}</div><div class="label pw-label">PASSWORD: <span style="font-weight:600;font-size:9px;color:#92400e">(temporary)</span></div><div class="pw-field">${safePw}</div><div class="pw-note">For first login only — user must set a new password immediately after signing in.</div><div class="warn">⚠ Keep this receipt confidential. The temporary password cannot be retrieved from the system after this point.</div><hr><footer>Generated by LLB Accountants system &mdash; confidential</footer></body></html>`);
                                        w.document.close();
                                        w.focus();
                                        w.print();
                                    }}
                                    style={{ padding: '9px 18px', background: '#1e3a8a', color: '#fff', border: 'none', borderRadius: '7px', cursor: 'pointer', fontSize: '13px', fontWeight: 600 }}
                                >
                                    Print / Save as PDF
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
