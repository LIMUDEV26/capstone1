import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';
import CrudActionIcon from '../components/CrudActionIcon';
import PasswordInput from '../components/PasswordInput';
import MathCaptchaGate from '../components/MathCaptchaGate';
import SettingsLayout from '../components/SettingsLayout';
import SettingsToggle from '../components/SettingsToggle';
import { settingsNavItems } from '../components/settingsNav';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import OtpInput from '@/components/OtpInput';
import PhoneInput from '@/components/PhoneInput';
import {
    DEFAULT_PHONE_COUNTRY_CODE,
    formatPhoneDisplay,
    isPhoneDraftEmpty,
    normalizeInternationalPhoneNumber,
} from '@/utils/phone';
interface SessionUser {
    id?: number;
    role?: string;
    first_name?: string;
    last_name?: string;
    full_name?: string;
    email?: string;
    username?: string;
    mobile_number?: string;
    [key: string]: unknown;
}

export default function Settings() {
    const router = useRouter();
    const { user, loading, logout, setSessionUser } = useProtectedPage({
        allowedRoles: ['admin'],
        unauthorizedRedirect: '/403',
    });

    useEffect(() => {
        const section = typeof router.query.section === 'string' ? router.query.section : '';
        if (!section) return;
        const match = settingsNavItems.find((item) => item.id === section);
        if (match && match.id !== 'profile') {
            router.replace(match.path);
        }
    }, [router, router.query.section]);

    if (loading) {
        return (
            <SettingsLayout activeSection="profile" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    return (
        <SettingsLayout activeSection="profile" user={user} onLogout={logout}>
            <AdminProfileSettings
                user={user}
                onUserUpdated={(nextUser) => {
                    setSessionUser((prev) => ({ ...(prev || {}), ...nextUser }));
                }}
            />
        </SettingsLayout>
    );
}

function AdminProfileSettings({
    user,
    onUserUpdated,
}: {
    user: SessionUser | null,
    onUserUpdated: (u: SessionUser) => void,
}) {
    const API_BASE_URL = getApiBaseUrl();
    const isValidGmailComEmail = (value: string) => /^[^\s@]+@(gmail\.com|phinmaed\.com)$/i.test(value.trim());

    const [form, setForm] = useState({
        first_name: user?.first_name || '',
        last_name: user?.last_name || '',
        email: user?.email || '',
        username: user?.username || '',
        mobile_number: (user?.mobile_number as string) || '',
    });

    const [editing, setEditing] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // Inline per-field "Required" messages for the admin profile form.
    const [profileFieldErrors, setProfileFieldErrors] = useState<Record<string, string>>({});

    const clearProfileFieldError = (name: string) => {
        setProfileFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const [success, setSuccess] = useState<string | null>(null);

    const [otpRequested, setOtpRequested] = useState(false);
    const [otp, setOtp] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [pwLoading, setPwLoading] = useState(false);
    const [pwMsg, setPwMsg] = useState<string | null>(null);
    const [pwErr, setPwErr] = useState<string | null>(null);
    // Captcha comes first: OTP + password fields stay locked until solved.
    const [captchaVerified, setCaptchaVerified] = useState(false);
    const [captchaResetSignal, setCaptchaResetSignal] = useState(0);

    // Login OTP management (emailed code on every login, for every user).
    const [loginOtpEnabled, setLoginOtpEnabled] = useState<boolean | null>(null);
    const [loginOtpSaving, setLoginOtpSaving] = useState(false);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await fetch(`${API_BASE_URL}/settings_api.php?keys=login_otp_enabled`, {
                    credentials: 'include',
                    cache: 'no-store',
                });
                const data = await res.json();
                if (active && res.ok && data.success && data.data && typeof data.data.login_otp_enabled !== 'undefined') {
                    setLoginOtpEnabled(Boolean(data.data.login_otp_enabled));
                } else if (active) {
                    setLoginOtpEnabled(true);
                }
            } catch {
                if (active) setLoginOtpEnabled(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [API_BASE_URL]);

    const handleLoginOtpToggle = async (next: boolean) => {
        const previous = loginOtpEnabled;
        setLoginOtpEnabled(next);
        setLoginOtpSaving(true);
        try {
            const res = await fetch(`${API_BASE_URL}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ settings: { login_otp_enabled: next } }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setSuccess(`Login OTP ${next ? 'enabled' : 'disabled'}.`);
            } else {
                setLoginOtpEnabled(previous);
                setError(data.message || 'Failed to update Login OTP setting.');
            }
        } catch {
            setLoginOtpEnabled(previous);
            setError('Network error while updating Login OTP setting.');
        } finally {
            setLoginOtpSaving(false);
        }
    };

    useEffect(() => {
        setForm({
            first_name: user?.first_name || '',
            last_name: user?.last_name || '',
            email: user?.email || '',
            username: user?.username || '',
            mobile_number: (user?.mobile_number as string) || '',
        });
    }, [user?.first_name, user?.last_name, user?.email, user?.username, user?.mobile_number]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError(null);
    }, [error]);

    useEffect(() => {
        if (!success) return;
        void notifySuccess(success);
        setSuccess(null);
    }, [success]);

    useEffect(() => {
        if (!pwErr) return;
        void notifyError(pwErr);
        setPwErr(null);
    }, [pwErr]);

    useEffect(() => {
        if (!pwMsg) return;
        void notifySuccess(pwMsg);
        setPwMsg(null);
    }, [pwMsg]);

    const saveProfile = async (e: React.FormEvent) => {
        e.preventDefault();
        setError(null);
        setSuccess(null);

        // Required-field check with inline per-field messages.
        const profileMissing: Record<string, string> = {};
        if (!form.first_name.trim()) profileMissing.first_name = 'Required.';
        if (!form.last_name.trim()) profileMissing.last_name = 'Required.';
        if (!form.email.trim()) profileMissing.email = 'Required.';
        if (Object.keys(profileMissing).length > 0) {
            setProfileFieldErrors(profileMissing);
            return;
        }
        setProfileFieldErrors({});

        const normalizedMobileNumber = normalizeInternationalPhoneNumber(
            form.mobile_number,
            DEFAULT_PHONE_COUNTRY_CODE,
        );
        if (!isPhoneDraftEmpty(form.mobile_number, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedMobileNumber) {
            setError('Mobile number must be a valid international number.');
            return;
        }

        const payload = {
            first_name: form.first_name.trim(),
            last_name: form.last_name.trim(),
            email: form.email.trim().toLowerCase(),
            username: form.username.trim(),
            mobile_number: normalizedMobileNumber || '',
        };

        if (!isValidGmailComEmail(payload.email)) {
            setError('Email must be a valid @gmail.com or @phinmaed.com address.');
            return;
        }

        setSaving(true);
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=admin_update_profile`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload),
            });
            const data = await res.json();
            if (data.success) {
                setSuccess(data.message || 'Profile updated.');
                const updatedUser = {
                    ...payload,
                    ...(data.data || {}),
                } as SessionUser;
                const fullName = `${updatedUser.first_name || ''} ${updatedUser.last_name || ''}`.trim();
                if (fullName) updatedUser.full_name = fullName;
                setForm({
                    first_name: String(updatedUser.first_name || ''),
                    last_name: String(updatedUser.last_name || ''),
                    email: String(updatedUser.email || ''),
                    username: String(updatedUser.username || ''),
                    mobile_number: String(updatedUser.mobile_number || ''),
                });
                onUserUpdated(updatedUser);
                setEditing(false);
            } else {
                setError(data.message || 'Failed to update profile.');
            }
        } catch (err) {
            console.error(err);
            setError('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const requestOtp = async () => {
        setPwErr(null);
        setPwMsg(null);
        if (!captchaVerified) {
            setPwErr('Please complete the security check first.');
            return;
        }
        if (!currentPassword) {
            setPwErr('Enter your current password first.');
            return;
        }
        setPwLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=request_password_change_otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reason: 'manual' }),
            });
            const data = await res.json();
            if (data.success) {
                setOtpRequested(true);
                setPwMsg(data.message || 'OTP sent to your email.');
            } else {
                setPwErr(data.message || 'Failed to send OTP.');
            }
        } catch (err) {
            console.error(err);
            setPwErr('Network error.');
        } finally {
            setPwLoading(false);
        }
    };

    const changePasswordWithOTP = async (e: React.FormEvent) => {
        e.preventDefault();
        setPwErr(null);
        setPwMsg(null);

        if (!captchaVerified) {
            setPwErr('Please complete the security check first.');
            return;
        }
        if (!currentPassword) {
            setPwErr('Enter your current password first.');
            return;
        }
        const digits = otp.replace(/\D/g, '');
        if (digits.length !== 6) {
            setPwErr('Enter the 6-digit OTP from your email.');
            return;
        }
        if (!newPassword || newPassword.length < 8) {
            setPwErr('New password must be at least 8 characters.');
            return;
        }
        if (!/[A-Z]/.test(newPassword)) {
            setPwErr('Password must contain at least one uppercase letter.');
            return;
        }
        if (!/[0-9]/.test(newPassword)) {
            setPwErr('Password must contain at least one number.');
            return;
        }
        if (!/[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]/.test(newPassword)) {
            setPwErr('Password must contain at least one special character.');
            return;
        }
        if (newPassword !== confirmPassword) {
            setPwErr('Passwords do not match.');
            return;
        }

        setPwLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=change_password_with_otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ otp: digits, currentPassword, newPassword }),
            });
            const data = await res.json();
            if (data.success) {
                setPwMsg(data.message || 'Password changed successfully.');
                setOtp('');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setOtpRequested(false);
                setCaptchaVerified(false);
                setCaptchaResetSignal((n) => n + 1);
            } else {
                setPwErr(data.message || 'Failed to change password.');
            }
        } catch (err) {
            console.error(err);
            setPwErr('Network error.');
        } finally {
            setPwLoading(false);
        }
    };

    const readonlyInputStyle: React.CSSProperties = {
        padding: '9px 11px',
        borderRadius: 10,
        border: '1px solid #e5e7eb',
        background: '#f9fafb',
        color: '#374151',
        fontSize: 13,
    };
    const editInputStyle: React.CSSProperties = {
        padding: '9px 11px',
        borderRadius: 10,
        border: '1px solid #d1d5db',
        color: '#111827',
        fontSize: 13,
    };

    return (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 14,
            alignItems: 'start',
            width: '100%',
            minWidth: 0,
        }}>
            <div style={{ display: 'grid', gap: 14, alignContent: 'start' }}>
                {/* ---- Profile ---- */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>Profile</h2>
                        {!editing && (
                            <button
                                type="button"
                                onClick={() => setEditing(true)}
                                style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '6px 14px',
                                    borderRadius: 8,
                                    border: '1px solid #bfdbfe',
                                    background: '#eff6ff',
                                    color: '#1d4ed8',
                                    fontSize: 13,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                }}
                            >
                                <CrudActionIcon action="edit" />
                                Edit
                            </button>
                        )}
                    </div>

                    {!editing ? (
                        /* ── View mode ── */
                        <div style={{ display: 'grid', gap: 10 }}>
                            <div style={{ display: 'grid', gap: 4 }}>
                                <span style={{ fontSize: 12, color: '#6b7280' }}>Email</span>
                                <div style={readonlyInputStyle}>{form.email || <span style={{ color: '#9ca3af' }}>—</span>}</div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                                <div style={{ display: 'grid', gap: 4 }}>
                                    <span style={{ fontSize: 12, color: '#6b7280' }}>First name</span>
                                    <div style={readonlyInputStyle}>{form.first_name || <span style={{ color: '#9ca3af' }}>—</span>}</div>
                                </div>
                                <div style={{ display: 'grid', gap: 4 }}>
                                    <span style={{ fontSize: 12, color: '#6b7280' }}>Last name</span>
                                    <div style={readonlyInputStyle}>{form.last_name || <span style={{ color: '#9ca3af' }}>—</span>}</div>
                                </div>
                            </div>
                            <div style={{ display: 'grid', gap: 4 }}>
                                <span style={{ fontSize: 12, color: '#6b7280' }}>Mobile number</span>
                                <div style={readonlyInputStyle}>{formatPhoneDisplay(form.mobile_number) || <span style={{ color: '#9ca3af' }}>—</span>}</div>
                            </div>
                        </div>
                    ) : (
                        /* ── Edit mode ── */
                        <form onSubmit={saveProfile} noValidate style={{ display: 'grid', gap: 10 }}>
                            <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: 13, color: '#374151' }}>Email</label>
                                <input
                                    type="email"
                                    value={form.email}
                                    onChange={(e) => { setForm((p) => ({ ...p, email: e.target.value })); clearProfileFieldError('email'); }}
                                    pattern="^[^\s@]+@(gmail\.com|phinmaed\.com)$"
                                    title="Use a valid @gmail.com or @phinmaed.com email address."
                                    placeholder="example@phinmaed.com"
                                    required
                                    aria-required="true"
                                    aria-invalid={profileFieldErrors.email ? true : undefined}
                                    style={{ ...editInputStyle, border: profileFieldErrors.email ? '2px solid #ef4444' : undefined }}
                                    disabled={saving}
                                />
                                {profileFieldErrors.email && <div style={{ fontSize: 12, color: '#b91c1c' }}>{profileFieldErrors.email}</div>}
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 13, color: '#374151' }}>First name</label>
                                    <input
                                        value={form.first_name}
                                        onChange={(e) => { setForm((p) => ({ ...p, first_name: e.target.value })); clearProfileFieldError('first_name'); }}
                                        required
                                        aria-required="true"
                                        aria-invalid={profileFieldErrors.first_name ? true : undefined}
                                        style={{ ...editInputStyle, border: profileFieldErrors.first_name ? '2px solid #ef4444' : undefined }}
                                        disabled={saving}
                                    />
                                    {profileFieldErrors.first_name && <div style={{ fontSize: 12, color: '#b91c1c' }}>{profileFieldErrors.first_name}</div>}
                                </div>
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 13, color: '#374151' }}>Last name</label>
                                    <input
                                        value={form.last_name}
                                        onChange={(e) => { setForm((p) => ({ ...p, last_name: e.target.value })); clearProfileFieldError('last_name'); }}
                                        required
                                        aria-required="true"
                                        aria-invalid={profileFieldErrors.last_name ? true : undefined}
                                        style={{ ...editInputStyle, border: profileFieldErrors.last_name ? '2px solid #ef4444' : undefined }}
                                        disabled={saving}
                                    />
                                    {profileFieldErrors.last_name && <div style={{ fontSize: 12, color: '#b91c1c' }}>{profileFieldErrors.last_name}</div>}
                                </div>
                            </div>

                            <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: 13, color: '#374151' }}>Mobile number</label>
                                <PhoneInput
                                    value={form.mobile_number}
                                    onChange={(mobile_number) => setForm((previous) => ({ ...previous, mobile_number }))}
                                    disabled={saving}
                                    ariaLabel="Administrator mobile number"
                                    countryAriaLabel="Administrator mobile country calling code"
                                    inputStyle={editInputStyle}
                                />
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setEditing(false);
                                        setForm({
                                            first_name: user?.first_name || '',
                                            last_name: user?.last_name || '',
                                            email: user?.email || '',
                                            username: user?.username || '',
                                            mobile_number: (user?.mobile_number as string) || '',
                                        });
                                    }}
                                    disabled={saving}
                                    style={{
                                        padding: '8px 14px',
                                        borderRadius: 8,
                                        border: '1px solid #d1d5db',
                                        background: 'transparent',
                                        color: '#6b7280',
                                        fontSize: 13,
                                        cursor: saving ? 'not-allowed' : 'pointer',
                                        opacity: saving ? 0.5 : 1,
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    disabled={saving}
                                    style={{
                                        padding: '8px 14px',
                                        borderRadius: 8,
                                        border: 'none',
                                        background: saving ? '#93c5fd' : '#1e3a8a',
                                        color: '#fff',
                                        fontSize: 13,
                                        fontWeight: 700,
                                        cursor: saving ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    {saving ? 'Saving...' : 'Save Changes'}
                                </button>
                            </div>
                        </form>
                    )}
                </div>

                {/* ---- Login OTP ---- */}
                <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 14, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                        <div>
                            <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#111827' }}>Login OTP</h2>
                            <p style={{ margin: '4px 0 0 0', fontSize: 12, lineHeight: 1.5, color: '#6b7280' }}>
                                {loginOtpEnabled === false
                                    ? 'Off — users sign in with email + password (+ captcha) only.'
                                    : 'On — every user must enter an emailed code on every login.'}
                            </p>
                        </div>
                        <SettingsToggle
                            checked={loginOtpEnabled !== false}
                            onChange={(next) => { void handleLoginOtpToggle(next); }}
                            disabled={loginOtpSaving || loginOtpEnabled === null}
                            showStatus
                        />
                    </div>
                </div>

            </div>

            {/* ---- Change Password ---- */}
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 12, minWidth: 0 }}>
                <h2 style={{ margin: '0 0 6px 0', fontSize: 14, fontWeight: 700, color: '#111827' }}>
                    Change Password
                </h2>

                <p style={{ marginTop: 0, marginBottom: 10, fontSize: 12, lineHeight: 1.5, color: '#6b7280' }}>
                    An OTP will be sent to your registered email address to verify your identity before changing your password.
                </p>

                <div style={{ display: 'grid', gap: 10, marginBottom: 10 }}>
                    <MathCaptchaGate
                        onVerifiedChange={setCaptchaVerified}
                        disabled={pwLoading}
                        resetSignal={captchaResetSignal}
                    />
                    <div style={{ display: 'grid', gap: 6 }}>
                        <label style={{ fontSize: 12, color: '#374151', fontWeight: 700 }}>Current password</label>
                        <PasswordInput
                            value={currentPassword}
                            onChange={(e) => setCurrentPassword(e.target.value)}
                            disabled={pwLoading || !captchaVerified}
                            title={!captchaVerified ? 'Complete the security check first' : undefined}
                            placeholder="Enter your current password"
                            autoComplete="current-password"
                            style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db', opacity: captchaVerified ? 1 : 0.6 }}
                        />
                    </div>
                </div>

                {!otpRequested ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                        <button
                            type="button"
                            onClick={requestOtp}
                            disabled={pwLoading || !captchaVerified || !currentPassword}
                            title={!captchaVerified ? 'Complete the security check first' : (!currentPassword ? 'Enter your current password first' : undefined)}
                            style={{
                                background: pwLoading || !captchaVerified || !currentPassword ? '#93c5fd' : '#1e3a8a',
                                color: '#fff',
                                border: 'none',
                                padding: '9px 14px',
                                borderRadius: 10,
                                cursor: pwLoading || !captchaVerified || !currentPassword ? 'not-allowed' : 'pointer',
                                fontWeight: 700,
                                fontSize: 13,
                                width: 'fit-content',
                            }}
                        >
                            {pwLoading ? 'Sending OTP...' : 'Send OTP to Email'}
                        </button>
                    </div>
                ) : (
                    <form onSubmit={changePasswordWithOTP} style={{ display: 'grid', gap: 10 }}>
                        <div style={{ display: 'grid', gap: 6 }}>
                            <label style={{ fontSize: 12, color: '#374151' }}>Email OTP</label>
                            <OtpInput
                                value={otp}
                                onChange={(next) => setOtp(next.replace(/\D/g, '').slice(0, 6))}
                                length={6}
                                mode="numeric"
                                disabled={pwLoading}
                                autoFocus
                                ariaLabel="Email OTP"
                                containerStyle={{ justifyContent: 'flex-start' }}
                                inputStyle={{
                                    width: 42,
                                    height: 46,
                                    borderRadius: 10,
                                    fontSize: 18,
                                    letterSpacing: 0,
                                }}
                            />
                        </div>

                        <div style={{ display: 'grid', gap: 6 }}>
                            <label style={{ fontSize: 12, color: '#374151' }}>New password</label>
                            <PasswordInput
                                value={newPassword}
                                onChange={(e) => setNewPassword(e.target.value)}
                                style={{ padding: '8px 10px', borderRadius: 10, border: '1px solid #d1d5db' }}
                                disabled={pwLoading || !captchaVerified || !currentPassword}
                                title={!captchaVerified ? 'Complete the security check first' : (!currentPassword ? 'Enter your current password first' : undefined)}
                                showStrength
                                showSuggest
                                onSuggestPick={(pwd) => {
                                    setNewPassword(pwd);
                                    setConfirmPassword(pwd);
                                }}
                                required
                            />
                        </div>

                        {(() => {
                            const pwOk = newPassword.length >= 8 && /[0-9]/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword) && /[A-Z]/.test(newPassword);
                            const confirmOk = pwOk && confirmPassword === newPassword;
                            return (
                                <>
                                    <div style={{ display: 'grid', gap: 6 }}>
                                        <label style={{ fontSize: 12, color: '#374151' }}>Confirm password</label>
                                        <PasswordInput
                                            value={confirmPassword}
                                            required
                                            onChange={(e) => setConfirmPassword(e.target.value)}
                                            style={{ padding: '8px 10px', borderRadius: 10, border: `1px solid ${confirmPassword ? (confirmPassword === newPassword ? '#16a34a' : '#dc2626') : '#d1d5db'}` }}
                                            disabled={pwLoading || !pwOk || !captchaVerified || !currentPassword}
                                            title={!pwOk ? 'Enter a valid password first' : undefined}
                                        />
                                        {!pwOk && newPassword.length > 0 && (
                                            <span style={{ fontSize: 11.5, color: '#d97706', fontWeight: 600 }}>⚠ Password must be 8+ chars with a number, symbol, and capital letter.</span>
                                        )}
                                        {pwOk && confirmPassword && (
                                            <span style={{ fontSize: 11.5, fontWeight: 600, color: confirmPassword === newPassword ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4 }}>
                                                {confirmPassword === newPassword ? '✓ Passwords match' : '✗ Passwords do not match'}
                                            </span>
                                        )}
                                    </div>

                                    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                                        <button
                                            type="button"
                                            onClick={() => { setOtpRequested(false); setOtp(''); setPwErr(null); setPwMsg(null); }}
                                            disabled={pwLoading}
                                            style={{
                                                background: 'transparent',
                                                color: '#6b7280',
                                                border: '1px solid #d1d5db',
                                                padding: '8px 11px',
                                                borderRadius: 10,
                                                cursor: 'pointer',
                                                fontSize: 12,
                                            }}
                                        >
                                            Resend OTP
                                        </button>
                                        <button
                                            type="submit"
                                            disabled={pwLoading || !confirmOk}
                                            style={{
                                                background: '#111827',
                                                color: '#fff',
                                                border: 'none',
                                                padding: '8px 11px',
                                                borderRadius: 10,
                                                cursor: pwLoading || !confirmOk ? 'not-allowed' : 'pointer',
                                                opacity: pwLoading || !confirmOk ? 0.5 : 1,
                                                fontWeight: 600,
                                                fontSize: 13,
                                            }}
                                        >
                                            {pwLoading ? 'Updating...' : 'Change Password'}
                                        </button>
                                    </div>
                                </>
                            );
                        })()}
                    </form>
                )}
            </div>
        </div>
    );
}
