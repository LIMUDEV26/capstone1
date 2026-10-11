import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../components/Layout';
import CrudActionIcon from '../components/CrudActionIcon';
import PasswordInput from '../components/PasswordInput';
import MathCaptchaGate from '../components/MathCaptchaGate';
import PhoneInput from '../components/PhoneInput';
import { getBackendBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';
import {
    PROFILE_DOCUMENT_FIELDS,
    type ProfileDocumentFieldKey,
    getProfileDocumentSummary,
    isProfileDocumentSubmitted,
} from '@/utils/profileDocuments';
import { formatGovNumber, type GovNumberField } from '@/utils/govNumber';
import { formatPhoneDisplay } from '@/utils/phone';
import {
    PROFILE_EDIT_FIELD_OPTIONS,
    type ProfileEditFieldKey,
} from '@/utils/profileEditFields';
import styles from '@/styles/Profile.module.css';

const API_BASE_URL = getBackendBaseUrl();

type ProfileData = {
    id: number;
    first_name: string;
    last_name: string;
    username: string;
    email: string;
    role: string;
    status: string;
    branch_name?: string | null;
    date_of_birth?: string | null;
    photo?: string | null;
    sss_number?: string | null;
    pagibig_number?: string | null;
    philhealth_number?: string | null;
    tin_number?: string | null;
    mobile_number?: string | null;
} & Partial<Record<ProfileDocumentFieldKey, number | boolean | null>>;

type ProfileFormState = {
    first_name: string;
    last_name: string;
    email: string;
    mobile_number: string;
    date_of_birth: string;
    sss_number: string;
    pagibig_number: string;
    philhealth_number: string;
    tin_number: string;
    currentPassword: string;
    password: string;
    confirmPassword: string;
};

type PhotoUploadPayload = {
    name: string;
    data_url: string;
};

type EditAccessRequestRecord = {
    request_id: number;
    status: string;
    created_at: string;
    approved_at?: string | null;
    access_granted_until?: string | null;
    used_at?: string | null;
    archived_at?: string | null;
    request_reason?: string | null;
    requested_fields?: string[] | null;
};

type EditAccessStatus = {
    eligible: boolean;
    active_access?: EditAccessRequestRecord | null;
    pending_request?: EditAccessRequestRecord | null;
    latest_request?: EditAccessRequestRecord | null;
};

const createInitialFormState = (): ProfileFormState => ({
    first_name: '',
    last_name: '',
    email: '',
    mobile_number: '',
    date_of_birth: '',
    sss_number: '',
    pagibig_number: '',
    philhealth_number: '',
    tin_number: '',
    currentPassword: '',
    password: '',
    confirmPassword: '',
});

const isValidGmailComEmail = (value: string) => /^[^\s@]+@(gmail\.com|phinmaed\.com)$/i.test(value.trim());
const GOV_NUMBER_LABELS = {
    sss_number: 'SSS Number',
    pagibig_number: 'Pag-IBIG Number',
    philhealth_number: 'PhilHealth Number',
    tin_number: 'TIN Number',
} as const;
const normalizeGovernmentNumberForComparison = (value: unknown) =>
    String(value || '').trim().replace(/[^A-Za-z0-9\-]/g, '');

const MINIMUM_PROFILE_AGE = 18;

const parseIsoDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
    return parsed;
};

const getLatestAllowedBirthDate = () => {
    const t = new Date();
    return new Date(t.getFullYear() - MINIMUM_PROFILE_AGE, t.getMonth(), t.getDate());
};

const formatDateForInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const MAX_BIRTHDATE = formatDateForInput(getLatestAllowedBirthDate());

const isAtLeastMinimumAge = (value: string) => {
    const b = parseIsoDate(value);
    return b ? b <= getLatestAllowedBirthDate() : false;
};

const computeAge = (value: string): number | null => {
    const b = parseIsoDate(value);
    if (!b) return null;
    const t = new Date();
    let age = t.getFullYear() - b.getFullYear();
    const m = t.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && t.getDate() < b.getDate())) age--;
    return age;
};
const formatDateTimeLabel = (value?: string | null) => {
    const raw = String(value || '').trim();
    if (!raw) return 'N/A';
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? raw : parsed.toLocaleString();
};
const getDuplicateGovernmentNumberMessage = (values: Partial<Record<keyof typeof GOV_NUMBER_LABELS, unknown>>) => {
    const seen = new Map<string, keyof typeof GOV_NUMBER_LABELS>();
    for (const field of Object.keys(GOV_NUMBER_LABELS) as Array<keyof typeof GOV_NUMBER_LABELS>) {
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

export default function ProfilePage() {
    const {
        user: sessionUser,
        loading: authLoading,
        logout,
        refreshSession,
    } = useProtectedPage();
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [profile, setProfile] = useState<ProfileData | null>(null);
    const [form, setForm] = useState<ProfileFormState>(createInitialFormState());
    const [photoPreview, setPhotoPreview] = useState('');
    const [photoUpload, setPhotoUpload] = useState<PhotoUploadPayload | null>(null);
    const [photoRemoveRequested, setPhotoRemoveRequested] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    // Inline per-field "Required" messages for the Edit Profile form.
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    // Password-change gate: captcha first, then current password, then new.
    const [pwCaptchaVerified, setPwCaptchaVerified] = useState(false);
    const [pwCaptchaResetSignal, setPwCaptchaResetSignal] = useState(0);

    const clearFieldError = (name: string) => {
        setFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const [editProfileOpen, setEditProfileOpen] = useState(false);
    const [requestAccessOpen, setRequestAccessOpen] = useState(false);
    const [requestReason, setRequestReason] = useState('');
    const [requestedEditFields, setRequestedEditFields] = useState<ProfileEditFieldKey[]>([]);
    const [requestSubmitting, setRequestSubmitting] = useState(false);
    const [editAccessStatus, setEditAccessStatus] = useState<EditAccessStatus | null>(null);
    const [editAccessLoading, setEditAccessLoading] = useState(false);
    const [activeProfileTab, setActiveProfileTab] = useState<'overview' | 'documents' | 'access'>('overview');
    const normalizedRole = String(sessionUser?.role || '').toLowerCase();
    const useFloatingEditProfile = normalizedRole === 'staff' || normalizedRole === 'manager';

    const documentSummary = useMemo(() => getProfileDocumentSummary(profile), [profile]);
    const completionSummary = `${documentSummary.submittedCount}/${documentSummary.totalCount}`;
    const completionPercent = documentSummary.totalCount > 0
        ? Math.round((documentSummary.submittedCount / documentSummary.totalCount) * 100)
        : 0;

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

    useEffect(() => {
        if ((!editProfileOpen && !requestAccessOpen) || typeof window === 'undefined') return;

        const previousOverflow = document.body.style.overflow;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape' && !saving && !requestSubmitting) {
                setEditProfileOpen(false);
                setRequestAccessOpen(false);
            }
        };

        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            document.body.style.overflow = previousOverflow;
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [editProfileOpen, requestAccessOpen, requestSubmitting, saving]);

    const loadProfile = useCallback(async (userId: number) => {
        const res = await fetch(`${API_BASE_URL}/api/users.php?id=${userId}`, { credentials: 'include' });
        const data = await res.json();
        if (!data.success) {
            throw new Error(data.message || 'Failed to load profile');
        }

        const nextProfile = data.data as ProfileData;
        setProfile(nextProfile);
        setForm({
            first_name: nextProfile.first_name || '',
            last_name: nextProfile.last_name || '',
            email: nextProfile.email || '',
            mobile_number: nextProfile.mobile_number || '',
            date_of_birth: nextProfile.date_of_birth || '',
            sss_number: nextProfile.sss_number || '',
            pagibig_number: nextProfile.pagibig_number || '',
            philhealth_number: nextProfile.philhealth_number || '',
            tin_number: nextProfile.tin_number || '',
            currentPassword: '',
            password: '',
            confirmPassword: '',
        });
        setPhotoPreview(resolveBackendAssetUrl(nextProfile.photo || ''));
        setPhotoUpload(null);
        setPhotoRemoveRequested(false);
        setError('');
    }, []);

    const loadEditAccessStatus = useCallback(async () => {
        if (!useFloatingEditProfile) {
            setEditAccessStatus(null);
            return;
        }

        setEditAccessLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/edit-requests.php?action=my-access`, {
                credentials: 'include',
            });
            const data = await res.json();
            if (!data.success || !data.data) {
                throw new Error(data.message || 'Failed to load edit access status.');
            }
            setEditAccessStatus(data.data as EditAccessStatus);
        } catch {
            setEditAccessStatus(null);
            setError('Failed to load edit access status.');
        } finally {
            setEditAccessLoading(false);
        }
    }, [useFloatingEditProfile]);

    useEffect(() => {
        const userId = Number(sessionUser?.id || 0);
        if (!userId) {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }

        let active = true;

        const initialize = async () => {
            setLoading(true);
            try {
                await loadProfile(userId);
                if (useFloatingEditProfile) {
                    await loadEditAccessStatus();
                }
            } catch {
                if (active) {
                    setError('Failed to load profile');
                }
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        void initialize();

        return () => {
            active = false;
        };
    }, [authLoading, loadEditAccessStatus, loadProfile, sessionUser?.id, useFloatingEditProfile]);

    const GOV_NUMBER_FIELDS_SET = new Set<string>(['sss_number', 'pagibig_number', 'philhealth_number', 'tin_number']);

    const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = event.target;
        const nextValue = GOV_NUMBER_FIELDS_SET.has(name)
            ? formatGovNumber(name as GovNumberField, value)
            : value;
        setForm((prev) => ({ ...prev, [name]: nextValue }));
        clearFieldError(name);
    };

    const handlePhotoChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        if (!file.type.startsWith('image/')) {
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
            setPhotoPreview(dataUrl);
            setPhotoUpload({ name: file.name, data_url: dataUrl });
            setPhotoRemoveRequested(false);
            setError('');
        };
        reader.readAsDataURL(file);
    };

    const handleRemovePhoto = () => {
        setPhotoPreview('');
        setPhotoUpload(null);
        setPhotoRemoveRequested(true);
    };

    const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!profile) return;

        setError('');
        setSuccess('');

        // Required-field check with inline per-field messages.
        const missing: Record<string, string> = {};
        if (canEditProfileField('first_name') && !form.first_name.trim()) missing.first_name = 'Required.';
        if (canEditProfileField('last_name') && !form.last_name.trim()) missing.last_name = 'Required.';
        if (canEditProfileField('email') && !form.email.trim()) missing.email = 'Required.';
        if (Object.keys(missing).length > 0) {
            setFieldErrors(missing);
            return;
        }
        setFieldErrors({});

        const password = form.password.trim();
        const confirmPassword = form.confirmPassword.trim();
        const currentPassword = form.currentPassword;

        if (canEditProfileField('password') && (password || confirmPassword)) {
            if (!pwCaptchaVerified) {
                setError('Please complete the security check first.');
                return;
            }
            if (!currentPassword) {
                setError('Enter your current password first.');
                return;
            }
            if (password.length < 8) {
                setError('New password must be at least 8 characters.');
                return;
            }
            if (password !== confirmPassword) {
                setError('Password confirmation does not match.');
                return;
            }
        }

        const normalizedDob = form.date_of_birth.trim();
        if (canEditProfileField('date_of_birth') && normalizedDob && !isAtLeastMinimumAge(normalizedDob)) {
            setError(`You must be at least ${MINIMUM_PROFILE_AGE} years old.`);
            return;
        }

        const normalizedEmail = form.email.trim().toLowerCase();
        if (canEditProfileField('email') && !isValidGmailComEmail(normalizedEmail)) {
            setError('Email must be a valid @gmail.com or @phinmaed.com address.');
            return;
        }

        const payload: Record<string, unknown> = { id: profile.id };
        if (canEditProfileField('first_name')) payload.first_name = form.first_name.trim();
        if (canEditProfileField('last_name')) payload.last_name = form.last_name.trim();
        if (canEditProfileField('email')) payload.email = normalizedEmail;
        if (canEditProfileField('mobile_number')) payload.mobile_number = form.mobile_number.trim();
        if (canEditProfileField('date_of_birth')) payload.date_of_birth = form.date_of_birth || null;
        if (canEditProfileField('sss_number')) payload.sss_number = form.sss_number.trim();
        if (canEditProfileField('pagibig_number')) payload.pagibig_number = form.pagibig_number.trim();
        if (canEditProfileField('philhealth_number')) payload.philhealth_number = form.philhealth_number.trim();
        if (canEditProfileField('tin_number')) payload.tin_number = form.tin_number.trim();
        const duplicateGovernmentNumberMessage = getDuplicateGovernmentNumberMessage({
            sss_number: form.sss_number,
            pagibig_number: form.pagibig_number,
            philhealth_number: form.philhealth_number,
            tin_number: form.tin_number,
        });
        if (duplicateGovernmentNumberMessage) {
            setError(duplicateGovernmentNumberMessage);
            return;
        }

        if (canEditProfileField('password') && password) {
            payload.password = password;
            payload.current_password = currentPassword;
        }
        if (canEditProfileField('photo') && photoUpload) {
            payload.photo_upload = photoUpload;
        }
        if (canEditProfileField('photo') && photoRemoveRequested) {
            payload.photo_remove = true;
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
            if (!data.success) {
                setError(data.message || 'Failed to update profile.');
                return;
            }

            setSuccess(data.message || 'Profile updated successfully.');
            setProfile((prev) => prev ? { ...prev, first_name: form.first_name, last_name: form.last_name, email: form.email, mobile_number: form.mobile_number, date_of_birth: form.date_of_birth, sss_number: form.sss_number, pagibig_number: form.pagibig_number, philhealth_number: form.philhealth_number, tin_number: form.tin_number } : prev);
            // Never keep password material in state after a save.
            setForm((prev) => ({ ...prev, currentPassword: '', password: '', confirmPassword: '' }));
            setPwCaptchaVerified(false);
            setPwCaptchaResetSignal((n) => n + 1);
            if (useFloatingEditProfile) {
                await loadEditAccessStatus();
            }
            await refreshSession({ force: true });
            if (useFloatingEditProfile) {
                setEditProfileOpen(false);
            }
        } catch {
            setError('Failed to update profile. Please try again.');
        } finally {
            setSaving(false);
        }
    };

    const handleRequestAccessSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        if (!useFloatingEditProfile) return;
        if (requestedEditFields.length === 0) {
            setError('Select at least one profile detail you need to edit.');
            return;
        }

        setRequestSubmitting(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/edit-requests.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    request_reason: requestReason.trim(),
                    requested_fields: requestedEditFields,
                }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to submit edit access request.');
                return;
            }

            setSuccess(data.message || 'Edit access request submitted successfully.');
            const submittedReason = requestReason.trim();
            const submittedFields = [...requestedEditFields];
            setRequestReason('');
            setRequestedEditFields([]);
            setRequestAccessOpen(false);
            const requestId = Date.now();
            setEditAccessStatus((prev) => prev ? {
                ...prev,
                eligible: false,
                pending_request: { request_id: requestId, status: 'pending', created_at: new Date().toISOString(), request_reason: submittedReason, requested_fields: submittedFields } as EditAccessRequestRecord,
                latest_request: { request_id: requestId, status: 'pending', created_at: new Date().toISOString(), request_reason: submittedReason, requested_fields: submittedFields } as EditAccessRequestRecord,
            } : prev);
        } catch {
            setError('Failed to submit edit access request.');
        } finally {
            setRequestSubmitting(false);
        }
    };

    const renderEditProfileForm = (isFloating = false) => (
        <form onSubmit={handleSubmit} noValidate>
            {isFloating && (
                <div style={{ marginBottom: 14, padding: 12, border: '1px solid #bfdbfe', borderRadius: 10, background: '#eff6ff' }}>
                    <div style={{ color: '#1e3a8a', fontSize: 12, fontWeight: 800, marginBottom: 6 }}>Approved details</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {PROFILE_EDIT_FIELD_OPTIONS.filter(({ key }) => canEditProfileField(key)).map(({ key, label }) => (
                            <span key={key} style={{ padding: '4px 8px', borderRadius: 999, background: '#dbeafe', color: '#1d4ed8', fontSize: 11, fontWeight: 700 }}>
                                {label}
                            </span>
                        ))}
                    </div>
                    <div style={{ marginTop: 7, color: '#475569', fontSize: 11 }}>Fields not listed here remain locked.</div>
                </div>
            )}
            <div style={{ marginBottom: 14, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc', opacity: isFloating && !canEditProfileField('photo') ? 0.65 : 1 }}>
                <label style={{ display: 'block', marginBottom: 8, color: '#334155', fontSize: 13, fontWeight: 600 }}>Profile Picture</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ width: 68, height: 68, borderRadius: '999px', background: '#e2e8f0', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', color: '#475569', fontSize: 14, fontWeight: 700 }}>
                        {photoPreview ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={photoPreview} alt="Profile preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                            `${(form.first_name || profile?.username || 'U').charAt(0).toUpperCase()}`
                        )}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input type="file" accept="image/png,image/jpeg,image/webp" onChange={handlePhotoChange} disabled={saving || (isFloating && !canEditProfileField('photo'))} />
                        {photoPreview && (
                            <button
                                type="button"
                                onClick={handleRemovePhoto}
                                disabled={saving || (isFloating && !canEditProfileField('photo'))}
                                style={{ padding: '7px 10px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff1f2', color: '#be123c', cursor: 'pointer' }}
                            >
                                Remove
                            </button>
                        )}
                    </div>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12, marginBottom: 14 }}>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>First Name</label>
                    <input type="text" name="first_name" value={form.first_name} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('first_name'))} required aria-required="true" aria-invalid={fieldErrors.first_name ? true : undefined} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: fieldErrors.first_name ? '2px solid #ef4444' : '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('first_name') ? '#f1f5f9' : '#fff' }} />
                    {fieldErrors.first_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.first_name}</div>}
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Last Name</label>
                    <input type="text" name="last_name" value={form.last_name} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('last_name'))} required aria-required="true" aria-invalid={fieldErrors.last_name ? true : undefined} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: fieldErrors.last_name ? '2px solid #ef4444' : '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('last_name') ? '#f1f5f9' : '#fff' }} />
                    {fieldErrors.last_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.last_name}</div>}
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Email</label>
                    <input type="email" name="email" value={form.email} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('email'))} required aria-required="true" aria-invalid={fieldErrors.email ? true : undefined} pattern="^[^\s@]+@(gmail\.com|phinmaed\.com)$" title="Use a valid @gmail.com or @phinmaed.com email address." placeholder="example@phinmaed.com" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: fieldErrors.email ? '2px solid #ef4444' : '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('email') ? '#f1f5f9' : '#fff' }} />
                    {fieldErrors.email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.email}</div>}
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Mobile Number</label>
                    <PhoneInput
                        value={form.mobile_number}
                        onChange={(value) => setForm((current) => ({ ...current, mobile_number: value }))}
                        disabled={saving || (isFloating && !canEditProfileField('mobile_number'))}
                        inputStyle={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('mobile_number') ? '#f1f5f9' : '#fff' }}
                    />
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Birthdate</label>
                    <input
                        type="date"
                        name="date_of_birth"
                        value={form.date_of_birth}
                        onChange={handleInputChange}
                        disabled={saving || (isFloating && !canEditProfileField('date_of_birth'))}
                        max={MAX_BIRTHDATE}
                        style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: `1px solid ${form.date_of_birth && !isAtLeastMinimumAge(form.date_of_birth) ? '#ef4444' : '#cbd5e1'}`, color: '#0f172a', background: isFloating && !canEditProfileField('date_of_birth') ? '#f1f5f9' : '#fff' }}
                    />
                    {(() => {
                        const age = computeAge(form.date_of_birth);
                        if (age === null) return <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>Must be at least {MINIMUM_PROFILE_AGE} years old.</div>;
                        const valid = age >= MINIMUM_PROFILE_AGE;
                        return (
                            <div style={{ marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 999, backgroundColor: valid ? '#dcfce7' : '#fee2e2', color: valid ? '#15803d' : '#dc2626' }}>
                                {valid ? '✓' : '✗'} Age: {age} {valid ? '(eligible)' : `(must be ≥ ${MINIMUM_PROFILE_AGE})`}
                            </div>
                        );
                    })()}
                </div>
                <div>
                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Username</label>
                    <input type="text" value={profile?.username || ''} disabled style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#64748b', backgroundColor: '#f8fafc' }} />
                </div>
            </div>

            <div style={{ marginBottom: 14, border: '1px solid #e2e8f0', borderRadius: 10, padding: 12 }}>
                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Government Numbers</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>SSS Number</label>
                        <input type="text" name="sss_number" value={form.sss_number} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('sss_number'))} placeholder="e.g. 12-3456789-0" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('sss_number') ? '#f1f5f9' : '#fff' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Pag-IBIG Number</label>
                        <input type="text" name="pagibig_number" value={form.pagibig_number} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('pagibig_number'))} placeholder="e.g. 1234-5678-9012" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('pagibig_number') ? '#f1f5f9' : '#fff' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>PhilHealth Number</label>
                        <input type="text" name="philhealth_number" value={form.philhealth_number} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('philhealth_number'))} placeholder="e.g. 12-345678901-2" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('philhealth_number') ? '#f1f5f9' : '#fff' }} />
                    </div>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>TIN Number</label>
                        <input type="text" name="tin_number" value={form.tin_number} onChange={handleInputChange} disabled={saving || (isFloating && !canEditProfileField('tin_number'))} placeholder="e.g. 123-456-789-000" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', background: isFloating && !canEditProfileField('tin_number') ? '#f1f5f9' : '#fff' }} />
                    </div>
                </div>
            </div>

            {(!isFloating || canEditProfileField('password')) && (
            <div style={{ marginBottom: 14, border: '1px solid #e2e8f0', borderRadius: 10, padding: 12, background: '#f8fafc' }}>
                <div style={{ fontWeight: 700, color: '#1f2937', marginBottom: 10, fontSize: 13 }}>Change Password (Optional)</div>
                <div style={{ display: 'grid', gap: 12, marginBottom: 12 }}>
                    <MathCaptchaGate
                        onVerifiedChange={setPwCaptchaVerified}
                        disabled={saving}
                        resetSignal={pwCaptchaResetSignal}
                    />
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Current Password (required to set a new one)</label>
                        <PasswordInput name="currentPassword" value={form.currentPassword} onChange={handleInputChange} placeholder="Enter your current password" disabled={saving || !pwCaptchaVerified} title={!pwCaptchaVerified ? 'Complete the security check first' : undefined} autoComplete="current-password" style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a', opacity: pwCaptchaVerified ? 1 : 0.6 }} />
                    </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                    <div>
                        <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>New Password</label>
                        <PasswordInput name="password" value={form.password} onChange={handleInputChange} placeholder="At least 8 characters" disabled={saving || !pwCaptchaVerified || !form.currentPassword} title={!pwCaptchaVerified ? 'Complete the security check first' : (!form.currentPassword ? 'Enter your current password first' : undefined)} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: '1px solid #cbd5e1', color: '#0f172a' }} showStrength showSuggest onSuggestPick={(pwd) => setForm((prev) => ({ ...prev, password: pwd, confirmPassword: pwd }))} />
                    </div>
                    <div>
                        {(() => {
                            const pwOk = form.password.length === 0 || (form.password.length >= 8 && /[0-9]/.test(form.password) && /[^A-Za-z0-9]/.test(form.password) && /[A-Z]/.test(form.password));
                            const confirmDisabled = saving || !pwCaptchaVerified || !form.currentPassword || (form.password.length > 0 && !pwOk);
                            return (
                                <>
                                    <label style={{ display: 'block', marginBottom: 4, color: '#555', fontSize: 13 }}>Confirm Password</label>
                                    <PasswordInput name="confirmPassword" value={form.confirmPassword} onChange={handleInputChange} placeholder="Repeat new password" disabled={confirmDisabled} title={confirmDisabled ? 'Enter a valid password first' : undefined} style={{ width: '100%', padding: '9px 10px', borderRadius: 6, border: `1px solid ${form.confirmPassword ? (form.confirmPassword === form.password ? '#16a34a' : '#dc2626') : '#cbd5e1'}`, color: '#0f172a', opacity: confirmDisabled ? 0.5 : 1 }} />
                                    {confirmDisabled && (
                                        <span style={{ fontSize: 11.5, color: '#d97706', fontWeight: 600, marginTop: 4, display: 'block' }}>⚠ Password must be 8+ chars with a number, symbol, and capital letter.</span>
                                    )}
                                    {!confirmDisabled && form.confirmPassword && (
                                        <span style={{ fontSize: 11.5, fontWeight: 600, color: form.confirmPassword === form.password ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                                            {form.confirmPassword === form.password ? '✓ Passwords match' : '✗ Passwords do not match'}
                                        </span>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                </div>
            </div>
            )}

            <div style={{ display: 'flex', justifyContent: isFloating ? 'space-between' : 'flex-end', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                {isFloating && (
                    <button
                        type="button"
                        onClick={() => !saving && setEditProfileOpen(false)}
                        style={{ padding: '10px 18px', background: 'transparent', border: '1px solid #cbd5e1', borderRadius: 8, cursor: saving ? 'not-allowed' : 'pointer', color: '#475569', fontWeight: 700, opacity: saving ? 0.7 : 1 }}
                    >
                        Cancel
                    </button>
                )}
                <button
                    type="submit"
                    disabled={saving || (() => { const p = canEditProfileField('password') ? form.password : ''; return p.length > 0 && (p.length < 8 || !/[0-9]/.test(p) || !/[^A-Za-z0-9]/.test(p) || !/[A-Z]/.test(p) || form.confirmPassword !== p || !form.currentPassword || !pwCaptchaVerified); })()}
                    title="Save Profile Changes"
                    aria-label="Save Profile Changes"
                    style={{
                        padding: '10px 18px',
                        background: '#1e3a8a',
                        border: 'none',
                        borderRadius: 8,
                        cursor: saving ? 'not-allowed' : 'pointer',
                        color: 'white',
                        fontWeight: 700,
                        opacity: saving ? 0.7 : 1,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 8,
                    }}
                >
                    {saving ? 'Saving...' : (
                        <>
                            <CrudActionIcon action="save" />
                            <span>Save Changes</span>
                        </>
                    )}
                </button>
            </div>
        </form>
    );

    const activeEditAccess = editAccessStatus?.active_access ?? null;
    const pendingEditRequest = editAccessStatus?.pending_request ?? null;
    const latestEditRequest = editAccessStatus?.latest_request ?? null;
    const latestEditRequestStatus = String(latestEditRequest?.status || '').trim().toLowerCase();
    const latestEditRequestWasRevoked = Boolean(latestEditRequest?.archived_at) && latestEditRequestStatus === 'approved';
    const latestEditRequestWasRejected = latestEditRequestStatus === 'rejected'
        || (Boolean(latestEditRequest?.archived_at) && latestEditRequestStatus === 'pending');
    const canOpenFloatingEditProfile = !useFloatingEditProfile || Boolean(activeEditAccess);
    const approvedEditFields = useMemo(
        () => new Set(activeEditAccess?.requested_fields || []),
        [activeEditAccess?.requested_fields]
    );
    const canEditProfileField = (field: ProfileEditFieldKey) => !useFloatingEditProfile || approvedEditFields.has(field);
    const floatingActionLabel = activeEditAccess ? 'Edit Profile' : 'Request Edit Access';
    const fullName = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') || profile?.username || 'User';
    const initials = [profile?.first_name, profile?.last_name]
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => String(part).charAt(0).toUpperCase())
        .join('') || String(profile?.username || 'U').charAt(0).toUpperCase();
    const profileRole = String(profile?.role || sessionUser?.role || 'user').toLowerCase();
    const profileStatus = String(profile?.status || 'active').toLowerCase();
    const formattedBirthdate = profile?.date_of_birth
        ? new Date(`${profile.date_of_birth}T00:00:00`).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
        : 'Not set';
    const openProfileEditor = () => {
        if (canOpenFloatingEditProfile) {
            setEditProfileOpen(true);
            return;
        }
        setRequestAccessOpen(true);
    };

    if (authLoading || loading) {

      return (

        <Layout role={String(sessionUser?.role || '')} user={sessionUser} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={sessionUser?.role} user={sessionUser} onLogout={logout}>
            <Head>
                <title>My Profile</title>
            </Head>

            <div className={styles.page}>
                <div className={styles.workspace}>
                    <aside className={styles.identityRail} aria-label="Profile summary">
                        <div className={styles.identitySticky}>
                            <div className={styles.avatar}>
                                {photoPreview ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={photoPreview} alt={`${fullName} profile`} />
                                ) : initials}
                            </div>
                            <h1 className={styles.name}>{fullName}</h1>
                            <div className={styles.username}>@{profile?.username || 'user'}</div>
                            <div className={styles.roleBadge}>{profileRole}</div>
                            <div className={styles.email} title={profile?.email || ''}>{profile?.email || 'No email set'}</div>

                            <div className={styles.railDivider} />

                            <div className={styles.railMetric}>
                                <div className={styles.metricTop}>
                                    <span>Document completion</span>
                                    <strong>{completionSummary}</strong>
                                </div>
                                <div className={styles.progressTrack} aria-label={`${completionPercent}% documents complete`}>
                                    <div className={styles.progressValue} style={{ width: `${completionPercent}%` }} />
                                </div>
                            </div>

                            <div className={styles.railFacts}>
                                <div className={styles.railFact}><span>Branch</span><strong title={profile?.branch_name || 'No branch'}>{profile?.branch_name || 'No branch'}</strong></div>
                                <div className={styles.railFact}><span>Account</span><strong>{profileStatus}</strong></div>
                            </div>

                            <button
                                type="button"
                                className={styles.primaryButton}
                                disabled={editAccessLoading || Boolean(pendingEditRequest)}
                                onClick={openProfileEditor}
                            >
                                <CrudActionIcon action={canOpenFloatingEditProfile ? 'edit' : 'create'} />
                                <span>
                                    {editAccessLoading
                                        ? 'Checking access...'
                                        : pendingEditRequest
                                            ? 'Request pending'
                                            : useFloatingEditProfile
                                                ? floatingActionLabel
                                                : 'Edit profile'}
                                </span>
                            </button>
                        </div>
                    </aside>

                    <main className={styles.main}>
                        <div className={styles.topbar}>
                            <div>
                                <div className={styles.eyebrow}>My workspace</div>
                                <h2 className={styles.pageTitle}>Hello, {profile?.first_name || profile?.username || 'there'}!</h2>
                                <p className={styles.subtitle}>
                                    Review your system profile, employment records, and account access in one place.
                                </p>
                            </div>
                            <div className={styles.statusPill}>
                                <span className={styles.statusDot} />
                                {profileStatus}
                            </div>
                        </div>

                        <div className={styles.tabs} role="tablist" aria-label="Profile sections">
                            {([
                                ['overview', 'Overview'],
                                ['documents', 'Documents'],
                                ['access', 'Access & security'],
                            ] as const).map(([tab, label]) => (
                                <button
                                    key={tab}
                                    type="button"
                                    role="tab"
                                    aria-selected={activeProfileTab === tab}
                                    className={`${styles.tab} ${activeProfileTab === tab ? styles.tabActive : ''}`}
                                    onClick={() => setActiveProfileTab(tab)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        {useFloatingEditProfile && (
                            <div className={`${styles.notice} ${pendingEditRequest
                                ? styles.noticePending
                                : latestEditRequestWasRejected || latestEditRequestWasRevoked
                                    ? styles.noticeRejected
                                    : activeEditAccess
                                        ? styles.noticeApproved
                                        : ''}`}>
                                <div className={styles.noticeTitle}>
                                    {pendingEditRequest
                                        ? 'Edit access request is pending review.'
                                        : latestEditRequestWasRejected
                                            ? 'Your edit access request was rejected.'
                                            : latestEditRequestWasRevoked
                                                ? 'Your approved edit access was revoked.'
                                                : activeEditAccess
                                                    ? 'Edit access approved.'
                                                    : 'Profile edits require approval first.'}
                                </div>
                                <div>
                                    {pendingEditRequest
                                        ? `Requested on ${formatDateTimeLabel(pendingEditRequest.created_at)}. You will be notified when it is reviewed.`
                                        : latestEditRequestWasRejected
                                            ? `Your last request was rejected on ${formatDateTimeLabel(latestEditRequest?.archived_at || latestEditRequest?.created_at)}.`
                                            : latestEditRequestWasRevoked
                                                ? `Access was revoked on ${formatDateTimeLabel(latestEditRequest?.archived_at || latestEditRequest?.approved_at)}.`
                                                : activeEditAccess
                                                    ? `Your edit window is active until ${formatDateTimeLabel(activeEditAccess.access_granted_until)}.`
                                                    : latestEditRequest?.used_at
                                                        ? `Your last approved request was used on ${formatDateTimeLabel(latestEditRequest.used_at)}.`
                                                        : 'Managers and staff can view their profile, but changes require an approved edit request.'}
                                </div>
                            </div>
                        )}

                        {activeProfileTab === 'overview' && (
                            <div className={styles.contentGrid} role="tabpanel">
                                <div className={styles.stack}>
                                    <section className={styles.card}>
                                        <div className={styles.cardHeader}>
                                            <div>
                                                <h3 className={styles.cardTitle}>Profile details</h3>
                                                <p className={styles.cardCaption}>Live information from your account record</p>
                                            </div>
                                            <button
                                                type="button"
                                                className={styles.iconButton}
                                                disabled={editAccessLoading || Boolean(pendingEditRequest)}
                                                onClick={openProfileEditor}
                                                aria-label={canOpenFloatingEditProfile ? 'Edit profile' : 'Request edit access'}
                                                title={canOpenFloatingEditProfile ? 'Edit profile' : 'Request edit access'}
                                            >
                                                <CrudActionIcon action={canOpenFloatingEditProfile ? 'edit' : 'create'} />
                                            </button>
                                        </div>
                                        <dl className={styles.detailList}>
                                            <div className={styles.detailRow}><dt>Full name</dt><dd>{fullName}</dd></div>
                                            <div className={styles.detailRow}><dt>Email</dt><dd>{profile?.email || 'Not set'}</dd></div>
                                            <div className={styles.detailRow}><dt>Username</dt><dd>{profile?.username || 'Not set'}</dd></div>
                                            <div className={styles.detailRow}><dt>Mobile number</dt><dd>{formatPhoneDisplay(profile?.mobile_number) || 'Not set'}</dd></div>
                                            <div className={styles.detailRow}><dt>Date of birth</dt><dd>{formattedBirthdate}</dd></div>
                                            <div className={styles.detailRow}><dt>Branch</dt><dd>{profile?.branch_name || 'No branch assigned'}</dd></div>
                                        </dl>
                                    </section>

                                    <section className={styles.card}>
                                        <div className={styles.cardHeader}>
                                            <div>
                                                <h3 className={styles.cardTitle}>Employment records</h3>
                                                <p className={styles.cardCaption}>Submission status from the system</p>
                                            </div>
                                        </div>
                                        <div className={styles.documentGrid}>
                                            {PROFILE_DOCUMENT_FIELDS.slice(0, 4).map((item) => {
                                                const submitted = isProfileDocumentSubmitted(profile?.[item.key]);
                                                return (
                                                    <div key={item.key} className={styles.documentCard}>
                                                        <div className={styles.documentIcon}>{item.label.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}</div>
                                                        <div>
                                                            <div className={styles.documentName}>{item.label}</div>
                                                            <div className={`${styles.documentStatus} ${submitted ? styles.documentStatusSubmitted : ''}`}>
                                                                <span className={styles.documentStatusDot} />
                                                                {submitted ? 'Submitted' : 'Missing'}
                                                            </div>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </section>
                                </div>

                                <aside className={styles.stack}>
                                    <section className={styles.card}>
                                        <div className={styles.cardHeader}>
                                            <div>
                                                <h3 className={styles.cardTitle}>Account</h3>
                                                <p className={styles.cardCaption}>Your assigned access level</p>
                                            </div>
                                        </div>
                                        <dl className={styles.detailList}>
                                            <div className={styles.detailRow}><dt>Role</dt><dd style={{ textTransform: 'capitalize' }}>{profileRole}</dd></div>
                                            <div className={styles.detailRow}><dt>Status</dt><dd style={{ textTransform: 'capitalize' }}>{profileStatus}</dd></div>
                                            <div className={styles.detailRow}><dt>Documents</dt><dd>{completionPercent}% complete</dd></div>
                                        </dl>
                                    </section>

                                    <section className={styles.card}>
                                        <div className={styles.cardHeader}><h3 className={styles.cardTitle}>Actions</h3></div>
                                        <div className={styles.actionList}>
                                            <button type="button" className={styles.secondaryButton} onClick={() => setActiveProfileTab('documents')}>
                                                <span>View all documents</span><span className={styles.arrow}>›</span>
                                            </button>
                                            <button
                                                type="button"
                                                className={styles.secondaryButton}
                                                disabled={editAccessLoading || Boolean(pendingEditRequest)}
                                                onClick={openProfileEditor}
                                            >
                                                <span>{canOpenFloatingEditProfile ? 'Update profile' : 'Request edit access'}</span><span className={styles.arrow}>›</span>
                                            </button>
                                            <button type="button" className={styles.secondaryButton} onClick={() => setActiveProfileTab('access')}>
                                                <span>Account security</span><span className={styles.arrow}>›</span>
                                            </button>
                                        </div>
                                    </section>
                                </aside>
                            </div>
                        )}

                        {activeProfileTab === 'documents' && (
                            <div className={styles.stack} role="tabpanel">
                                <section className={styles.card} id="employment-documents">
                                    <div className={styles.cardHeader}>
                                        <div>
                                            <h3 className={styles.cardTitle}>Employment documents</h3>
                                            <p className={styles.cardCaption}>{completionSummary} required records submitted</p>
                                        </div>
                                    </div>
                                    <div className={styles.documentGrid}>
                                        {PROFILE_DOCUMENT_FIELDS.map((item) => {
                                            const submitted = isProfileDocumentSubmitted(profile?.[item.key]);
                                            return (
                                                <div key={item.key} className={styles.documentCard}>
                                                    <div className={styles.documentIcon}>{item.label.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}</div>
                                                    <div>
                                                        <div className={styles.documentName}>{item.label}</div>
                                                        <div className={`${styles.documentStatus} ${submitted ? styles.documentStatusSubmitted : ''}`}>
                                                            <span className={styles.documentStatusDot} />
                                                            {submitted ? 'Submitted' : 'Missing'}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </section>

                                <section className={styles.card}>
                                    <div className={styles.cardHeader}>
                                        <div>
                                            <h3 className={styles.cardTitle}>Government identifiers</h3>
                                            <p className={styles.cardCaption}>Values saved to your employee record</p>
                                        </div>
                                    </div>
                                    <div className={styles.identifierGrid}>
                                        {([
                                            ['SSS Number', profile?.sss_number],
                                            ['Pag-IBIG Number', profile?.pagibig_number],
                                            ['PhilHealth Number', profile?.philhealth_number],
                                            ['TIN Number', profile?.tin_number],
                                        ] as const).map(([label, value]) => (
                                            <div key={label} className={styles.identifier}>
                                                <div className={styles.identifierLabel}>{label}</div>
                                                <div className={`${styles.identifierValue} ${!value ? styles.emptyValue : ''}`}>{value || 'Not provided'}</div>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            </div>
                        )}

                        {activeProfileTab === 'access' && (
                            <div className={styles.stack} role="tabpanel">
                                <section className={styles.accessHero}>
                                    <h3>{useFloatingEditProfile ? 'Protected profile editing' : 'Administrator profile access'}</h3>
                                    <p>
                                        {useFloatingEditProfile
                                            ? 'Your manager or administrator must approve an edit window before profile information can be changed. Viewing your own profile remains available at all times.'
                                            : 'Administrators can update their own profile directly. Password changes still require the security check and current password verification.'}
                                    </p>
                                </section>
                                <section className={styles.card}>
                                    <div className={styles.cardHeader}>
                                        <div>
                                            <h3 className={styles.cardTitle}>Access summary</h3>
                                            <p className={styles.cardCaption}>Permissions are enforced by your system role</p>
                                        </div>
                                    </div>
                                    <dl className={styles.detailList}>
                                        <div className={styles.detailRow}><dt>Role</dt><dd style={{ textTransform: 'capitalize' }}>{profileRole}</dd></div>
                                        <div className={styles.detailRow}><dt>Profile viewing</dt><dd>Allowed</dd></div>
                                        <div className={styles.detailRow}><dt>Profile editing</dt><dd>{useFloatingEditProfile ? (activeEditAccess ? 'Temporarily approved' : 'Approval required') : 'Allowed'}</dd></div>
                                        <div className={styles.detailRow}><dt>Password change</dt><dd>Security verification required</dd></div>
                                    </dl>
                                    <button
                                        type="button"
                                        className={styles.primaryButton}
                                        disabled={editAccessLoading || Boolean(pendingEditRequest)}
                                        onClick={openProfileEditor}
                                    >
                                        <CrudActionIcon action={canOpenFloatingEditProfile ? 'edit' : 'create'} />
                                        <span>{pendingEditRequest ? 'Request pending' : canOpenFloatingEditProfile ? 'Open profile editor' : 'Request edit access'}</span>
                                    </button>
                                </section>
                            </div>
                        )}
                    </main>
                </div>
            </div>

            {useFloatingEditProfile && requestAccessOpen && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.52)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 20000,
                        padding: '24px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <div
                        style={{
                             width: 'min(720px, 100%)',
                             maxHeight: 'calc(100vh - 48px)',
                             background: '#ffffff',
                            borderRadius: 20,
                            boxShadow: '0 30px 80px rgba(15, 23, 42, 0.28)',
                            border: '1px solid rgba(148, 163, 184, 0.28)',
                             overflow: 'hidden',
                             display: 'flex',
                             flexDirection: 'column',
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                justifyContent: 'space-between',
                                gap: 16,
                                padding: '20px 24px',
                                borderBottom: '1px solid #e2e8f0',
                                background: 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
                            }}
                        >
                            <div>
                                <h2 style={{ margin: '0 0 6px 0', fontSize: 14, color: '#0f172a' }}>Request Edit Access</h2>
                                <p style={{ margin: 0, color: '#64748b', fontSize: 13 }}>
                                    Choose the exact profile details you need to change. An administrator must approve them before editing is enabled.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => !requestSubmitting && setRequestAccessOpen(false)}
                                aria-label="Close Request Access"
                                style={{
                                    width: 40,
                                    height: 40,
                                    borderRadius: 999,
                                    border: '1px solid #cbd5e1',
                                    background: '#ffffff',
                                    color: '#475569',
                                    cursor: requestSubmitting ? 'not-allowed' : 'pointer',
                                    fontSize: 14,
                                    lineHeight: 1,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                }}
                            >
                                X
                            </button>
                        </div>

                        <form onSubmit={handleRequestAccessSubmit} style={{ padding: 24, overflowY: 'auto' }}>
                            <div style={{ marginBottom: 14, padding: 12, border: '1px solid #e2e8f0', borderRadius: 10, background: '#f8fafc' }}>
                                <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 13, marginBottom: 6 }}>What happens next</div>
                                <div style={{ color: '#475569', fontSize: 12, lineHeight: 1.7 }}>
                                    Once approved, only the checked details will be editable. Every other profile field stays locked, and the approval is consumed after you save.
                                </div>
                            </div>

                            <fieldset style={{ margin: '0 0 16px', padding: 0, border: 0 }}>
                                <legend style={{ marginBottom: 8, color: '#334155', fontSize: 13, fontWeight: 700 }}>
                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                                        <span>Details to edit <span style={{ color: '#dc2626' }}>*</span></span>
                                        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: '#1d4ed8', fontSize: 12, fontWeight: 700, cursor: requestSubmitting ? 'not-allowed' : 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={requestedEditFields.length === PROFILE_EDIT_FIELD_OPTIONS.length}
                                                disabled={requestSubmitting}
                                                onChange={(event) => setRequestedEditFields(
                                                    event.target.checked
                                                        ? PROFILE_EDIT_FIELD_OPTIONS.map(({ key }) => key)
                                                        : []
                                                )}
                                            />
                                            Check all
                                        </label>
                                    </span>
                                </legend>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 8 }}>
                                    {PROFILE_EDIT_FIELD_OPTIONS.map(({ key, label, group }) => {
                                        const checked = requestedEditFields.includes(key);
                                        return (
                                            <label
                                                key={key}
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'flex-start',
                                                    gap: 9,
                                                    padding: '10px 11px',
                                                    border: `1px solid ${checked ? '#93c5fd' : '#e2e8f0'}`,
                                                    borderRadius: 9,
                                                    background: checked ? '#eff6ff' : '#ffffff',
                                                    cursor: requestSubmitting ? 'not-allowed' : 'pointer',
                                                }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    disabled={requestSubmitting}
                                                    onChange={() => setRequestedEditFields((current) => (
                                                        current.includes(key)
                                                            ? current.filter((field) => field !== key)
                                                            : [...current, key]
                                                    ))}
                                                    style={{ marginTop: 2 }}
                                                />
                                                <span>
                                                    <span style={{ display: 'block', color: '#0f172a', fontSize: 13, fontWeight: 650 }}>{label}</span>
                                                    <span style={{ display: 'block', marginTop: 2, color: '#94a3b8', fontSize: 11 }}>{group}</span>
                                                </span>
                                            </label>
                                        );
                                    })}
                                </div>
                                {requestedEditFields.length === 0 && (
                                    <div style={{ marginTop: 7, color: '#b45309', fontSize: 12 }}>Select at least one detail.</div>
                                )}
                            </fieldset>

                            <div style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', marginBottom: 6, color: '#334155', fontSize: 13, fontWeight: 600 }}>
                                    Reason or notes for the reviewer
                                </label>
                                <textarea
                                    value={requestReason}
                                    onChange={(event) => setRequestReason(event.target.value)}
                                    rows={5}
                                    placeholder="Optional: explain what details you need to update."
                                    style={{
                                        width: '100%',
                                        padding: '10px 12px',
                                        borderRadius: 10,
                                        border: '1px solid #cbd5e1',
                                        color: '#0f172a',
                                        resize: 'vertical',
                                    }}
                                />
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => !requestSubmitting && setRequestAccessOpen(false)}
                                    style={{
                                        padding: '10px 18px',
                                        background: 'transparent',
                                        border: '1px solid #cbd5e1',
                                        borderRadius: 8,
                                        cursor: requestSubmitting ? 'not-allowed' : 'pointer',
                                        color: '#475569',
                                        fontWeight: 700,
                                        opacity: requestSubmitting ? 0.7 : 1,
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={requestSubmitting || requestedEditFields.length === 0}
                                    style={{
                                        padding: '10px 18px',
                                        background: '#1e3a8a',
                                        border: 'none',
                                        borderRadius: 8,
                                        cursor: requestSubmitting || requestedEditFields.length === 0 ? 'not-allowed' : 'pointer',
                                        color: 'white',
                                        fontWeight: 700,
                                        opacity: requestSubmitting || requestedEditFields.length === 0 ? 0.6 : 1,
                                    }}
                                >
                                    {requestSubmitting ? 'Submitting...' : 'Submit Request'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {editProfileOpen && (
                <div
                    style={{
                        position: 'fixed',
                        inset: 0,
                        background: 'rgba(15, 23, 42, 0.52)',
                        backdropFilter: 'blur(4px)',
                        zIndex: 20000,
                        padding: '24px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}
                >
                    <div
                        style={{
                            width: 'min(1120px, 100%)',
                            maxHeight: 'calc(100vh - 48px)',
                            background: '#ffffff',
                            borderRadius: 20,
                            boxShadow: '0 30px 80px rgba(15, 23, 42, 0.28)',
                            border: '1px solid rgba(148, 163, 184, 0.28)',
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                        }}
                    >
                        <div
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                justifyContent: 'space-between',
                                gap: 16,
                                padding: '20px 24px',
                                borderBottom: '1px solid #e2e8f0',
                                background: 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
                            }}
                        >
                            <div>
                                <h2 style={{ margin: '0 0 6px 0', fontSize: 14, color: '#0f172a' }}>Edit Profile</h2>
                                <p style={{ margin: 0, color: '#64748b', fontSize: 14 }}>
                                    Update your personal details, profile picture, government IDs, and password.
                                </p>
                            </div>
                            <button
                                type="button"
                                onClick={() => !saving && setEditProfileOpen(false)}
                                aria-label="Close Edit Profile"
                                style={{
                                    width: 40,
                                    height: 40,
                                    borderRadius: 999,
                                    border: '1px solid #cbd5e1',
                                    background: '#ffffff',
                                    color: '#475569',
                                    cursor: saving ? 'not-allowed' : 'pointer',
                                    fontSize: 14,
                                    lineHeight: 1,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    flexShrink: 0,
                                }}
                            >
                                ×
                            </button>
                        </div>

                        <div style={{ padding: 24, overflowY: 'auto' }}>
                            {renderEditProfileForm(true)}
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
