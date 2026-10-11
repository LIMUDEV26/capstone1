import { FormEvent, useEffect, useState } from 'react';
import PasswordInput from './PasswordInput';
import MathCaptchaGate from './MathCaptchaGate';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';

const API_BASE_URL = getApiBaseUrl();

type PasswordChangeReason = 'manual' | 'expired' | 'first_login';

type PasswordStatus = {
    expired?: boolean;
    requires_change?: boolean;
    reason?: string;
    max_age_days?: number;
    history_count?: number;
    password_changed_at?: string | null;
    password_expires_at?: string | null;
    days_remaining?: number | null;
};

type PasswordChangeModalProps = {
    open: boolean;
    user: {
        id?: number;
        email?: string;
        full_name?: string;
        username?: string;
        password_status?: PasswordStatus | null;
        [key: string]: unknown;
    } | null;
    reason?: PasswordChangeReason;
    allowClose?: boolean;
    onClose?: () => void;
    onLogout?: () => void;
    onPasswordChanged?: () => void | Promise<void>;
};

const normalizeReason = (value: unknown): PasswordChangeReason => {
    const normalized = String(value || 'manual').trim().toLowerCase();
    if (normalized === 'expired' || normalized === 'first_login') return normalized;
    return 'manual';
};

const formatPasswordDate = (value?: string | null) => {
    if (!value) return 'Not set';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
};

export default function PasswordChangeModal({
    open,
    user,
    reason = 'manual',
    allowClose = true,
    onClose,
    onLogout,
    onPasswordChanged,
}: PasswordChangeModalProps) {
    const normalizedReason = normalizeReason(reason);
    const isFirstLogin = normalizedReason === 'first_login';
    const [otpRequested, setOtpRequested] = useState(false);
    const [otp, setOtp] = useState('');
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    // Same suggested-password tracking as the reset pages: email a copy only
    // when the saved password still matches the picked suggestion.
    const [suggestedPassword, setSuggestedPassword] = useState('');
    const [requestingOtp, setRequestingOtp] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    // Captcha comes first: nothing else unlocks until it is solved.
    const [captchaVerified, setCaptchaVerified] = useState(false);
    const [captchaResetSignal, setCaptchaResetSignal] = useState(0);

    const closeModal = () => {
        setOtpRequested(false);
        setOtp('');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setSuggestedPassword('');
        setMessage('');
        setError('');
        setRequestingOtp(false);
        setSubmitting(false);
        setCaptchaVerified(false);
        setCaptchaResetSignal((n) => n + 1);
        onClose?.();
    };

    if (!open || !user) {
        return null;
    }

    const status = (user.password_status || {}) as PasswordStatus;
    const email = String(user.email || '').trim();
    const daysRemaining = typeof status.days_remaining === 'number' ? status.days_remaining : null;
    const expiresAt = status.password_expires_at || '';
    const changedAt = status.password_changed_at || '';

    const requestOtp = async () => {
        setError('');
        setMessage('');
        if (!captchaVerified) {
            setError('Please complete the security check first.');
            return;
        }
        if (!currentPassword) {
            setError('Enter your current password first.');
            return;
        }
        if (!email) {
            setError('Email is not configured for this account. Please contact an administrator.');
            return;
        }

        setRequestingOtp(true);
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=request_password_change_otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ reason: normalizedReason }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to send OTP.');
            } else {
                setOtpRequested(true);
                setMessage(data.message || 'OTP sent to your email.');
            }
        } catch {
            setError('Network error. Please try again.');
        }
        setRequestingOtp(false);
    };

    const submitFirstLoginPasswordChange = async (event: FormEvent) => {
        event.preventDefault();
        setError('');
        setMessage('');

        if (!captchaVerified) {
            setError('Please complete the security check first.');
            return;
        }
        if (!currentPassword) {
            setError('Enter your current password first.');
            return;
        }
        if (!newPassword || newPassword.length < 8) {
            setError('New password must be at least 8 characters.');
            return;
        }
        if (!/[A-Z]/.test(newPassword)) {
            setError('Password must contain at least one uppercase letter.');
            return;
        }
        if (!/[0-9]/.test(newPassword)) {
            setError('Password must contain at least one number.');
            return;
        }
        if (!/[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]/.test(newPassword)) {
            setError('Password must contain at least one special character.');
            return;
        }
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }

        setSubmitting(true);
        let postSuccessCallback: (() => Promise<void> | void) | null = null;
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=first_login_change_password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    currentPassword,
                    newPassword,
                    emailGeneratedPassword: suggestedPassword !== '' && suggestedPassword === newPassword,
                }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to change password.');
            } else {
                notifySuccess(
                    (data.message || 'Password changed successfully.')
                    + (data.data?.passwordEmailed ? ' A copy was sent to your Gmail.' : '')
                );
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setSuggestedPassword('');
                setCaptchaVerified(false);
                setCaptchaResetSignal((n) => n + 1);
                if (onPasswordChanged) {
                    postSuccessCallback = onPasswordChanged;
                }
            }
        } catch {
            setError('Network error. Please try again.');
        }
        setSubmitting(false);
        if (postSuccessCallback) {
            await postSuccessCallback();
        }
    };

    const submitPasswordChange = async (event: FormEvent) => {
        event.preventDefault();
        setError('');
        setMessage('');

        if (!captchaVerified) {
            setError('Please complete the security check first.');
            return;
        }
        if (!currentPassword) {
            setError('Enter your current password first.');
            return;
        }
        if (!otpRequested) {
            setError('Request an OTP first.');
            return;
        }
        const digits = otp.replace(/\D/g, '');
        if (digits.length !== 6) {
            setError('Enter the 6-digit OTP from your email.');
            return;
        }
        if (!newPassword || newPassword.length < 8) {
            setError('New password must be at least 8 characters.');
            return;
        }
        if (!/[A-Z]/.test(newPassword)) {
            setError('Password must contain at least one uppercase letter.');
            return;
        }
        if (!/[0-9]/.test(newPassword)) {
            setError('Password must contain at least one number.');
            return;
        }
        if (!/[!@#$%^&*()\-_=+[\]{};:'",.<>/?\\|]/.test(newPassword)) {
            setError('Password must contain at least one special character.');
            return;
        }
        if (newPassword !== confirmPassword) {
            setError('Passwords do not match.');
            return;
        }

        setSubmitting(true);
        let postSuccessCallback: (() => Promise<void> | void) | null = null;
        try {
            const res = await fetch(`${API_BASE_URL}/auth.php?action=change_password_with_otp`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ otp: digits, currentPassword, newPassword }),
            });
            const data = await res.json();
            if (!data.success) {
                setError(data.message || 'Failed to change password.');
            } else {
                notifySuccess(data.message || 'Password changed successfully.');
                setOtp('');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmPassword('');
                setOtpRequested(false);
                setCaptchaVerified(false);
                setCaptchaResetSignal((n) => n + 1);
                if (onPasswordChanged) {
                    postSuccessCallback = onPasswordChanged;
                }
            }
        } catch {
            setError('Network error. Please try again.');
        }
        setSubmitting(false);
        if (postSuccessCallback) {
            await postSuccessCallback();
        }
    };

    const isExpired = normalizedReason === 'expired' || Boolean(status.expired);
    const title = normalizedReason === 'expired'
        ? 'Password Expired'
        : isFirstLogin
            ? 'Change Temporary Password'
            : 'Change Password';
    const description = normalizedReason === 'expired'
        ? 'Your password has expired. Verify your identity with an email OTP before setting a new password.'
        : isFirstLogin
            ? 'You are logged in with a temporary password. Create a new password to continue.'
            : 'Verify your identity with an email OTP before changing your password.';

    return (
        <div
            style={{
                position: 'fixed',
                inset: 0,
                background: 'rgba(15, 23, 42, 0.58)',
                backdropFilter: 'blur(4px)',
                zIndex: 30000,
                padding: '24px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="password-change-title"
        >
            <div
                style={{
                    width: 'min(560px, 100%)',
                    background: '#ffffff',
                    borderRadius: 20,
                    boxShadow: '0 30px 80px rgba(15, 23, 42, 0.28)',
                    border: '1px solid rgba(148, 163, 184, 0.28)',
                    overflow: 'hidden',
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
                        background: isExpired ? 'linear-gradient(135deg, #fef2f2 0%, #fff7ed 100%)' : 'linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)',
                    }}
                >
                    <div>
                        <h2 id="password-change-title" style={{ margin: '0 0 6px 0', fontSize: 16, color: '#0f172a' }}>{title}</h2>
                        <p style={{ margin: 0, color: '#475569', fontSize: 13, lineHeight: 1.5 }}>{description}</p>
                    </div>
                    {(allowClose || onLogout) && (
                        <button
                            type="button"
                            onClick={allowClose ? closeModal : onLogout}
                            aria-label={allowClose ? 'Close password change' : 'Logout'}
                            title={allowClose ? 'Close' : 'Logout'}
                            disabled={submitting}
                            style={{
                                width: 36,
                                height: 36,
                                borderRadius: 999,
                                border: '1px solid #cbd5e1',
                                background: '#ffffff',
                                color: '#475569',
                                cursor: submitting ? 'not-allowed' : 'pointer',
                                fontSize: 18,
                                lineHeight: 1,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                            }}
                        >
                            ×
                        </button>
                    )}
                </div>

                <form onSubmit={isFirstLogin ? submitFirstLoginPasswordChange : submitPasswordChange} style={{ padding: 24, display: 'grid', gap: 16 }}>
                    {/* Step 1 — captcha first: nothing below unlocks until solved. */}
                    <MathCaptchaGate
                        onVerifiedChange={setCaptchaVerified}
                        disabled={submitting || requestingOtp}
                        resetSignal={captchaResetSignal}
                    />

                    {/* Step 2 — current password before anything new. */}
                    <div style={{ display: 'grid', gap: 6 }}>
                        <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>
                            Current password{isFirstLogin ? ' (temporary password)' : ''}
                        </label>
                        <PasswordInput
                            value={currentPassword}
                            onChange={(event) => setCurrentPassword(event.target.value)}
                            disabled={submitting || requestingOtp || !captchaVerified}
                            title={!captchaVerified ? 'Complete the security check first' : undefined}
                            placeholder="Enter your current password"
                            autoComplete="current-password"
                            style={{ padding: '11px 12px', borderRadius: 10, border: '1px solid #cbd5e1', opacity: captchaVerified ? 1 : 0.6 }}
                        />
                    </div>

                    {(!isFirstLogin && (normalizedReason !== 'manual' || expiresAt || changedAt)) && (
                        <div style={{
                            display: 'grid',
                            gap: 6,
                            padding: 12,
                            borderRadius: 12,
                            background: isExpired ? '#fff7ed' : '#f8fafc',
                            border: isExpired ? '1px solid #fed7aa' : '1px solid #e2e8f0',
                            color: isExpired ? '#9a3412' : '#475569',
                            fontSize: 12,
                            lineHeight: 1.6,
                        }}>
                            <div><strong>Policy:</strong> Password expires every {status.max_age_days || 90} days; last {status.history_count || 5} passwords cannot be reused.</div>
                            {expiresAt && <div><strong>Expires:</strong> {formatPasswordDate(expiresAt)} {typeof daysRemaining === 'number' ? `(${daysRemaining} day${daysRemaining === 1 ? '' : 's'} remaining)` : ''}</div>}
                            {changedAt && <div><strong>Last changed:</strong> {formatPasswordDate(changedAt)}</div>}
                        </div>
                    )}

                    {isFirstLogin ? (() => {
                        const pwOk = newPassword.length >= 8 && /[0-9]/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword) && /[A-Z]/.test(newPassword);
                        const confirmOk = pwOk && confirmPassword === newPassword;
                        return (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                            <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>New password</label>
                                <PasswordInput
                                    value={newPassword}
                                    onChange={(event) => setNewPassword(event.target.value)}
                                    disabled={submitting || !captchaVerified || !currentPassword}
                                    title={!captchaVerified ? 'Complete the security check first' : (!currentPassword ? 'Enter your current password first' : undefined)}
                                    placeholder="At least 8 characters"
                                    style={{ padding: '11px 12px', borderRadius: 10, border: '1px solid #cbd5e1' }}
                                    showStrength
                                    showSuggest
                                    suggestEmailNotice
                                    onSuggestPick={(pwd) => {
                                        setSuggestedPassword(pwd);
                                        setNewPassword(pwd);
                                        setConfirmPassword(pwd);
                                    }}
                                />
                            </div>
                            <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>Confirm password</label>
                                <PasswordInput
                                    value={confirmPassword}
                                    onChange={(event) => setConfirmPassword(event.target.value)}
                                    disabled={submitting || !pwOk || !captchaVerified || !currentPassword}
                                    title={!pwOk ? 'Enter a valid password first' : undefined}
                                    placeholder="Repeat new password"
                                    style={{ padding: '11px 12px', borderRadius: 10, border: `1px solid ${confirmPassword ? (confirmPassword === newPassword ? '#16a34a' : '#dc2626') : '#cbd5e1'}` }}
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
                            <div style={{ gridColumn: '1 / -1', display: 'flex', justifyContent: 'flex-end' }}>
                                <button
                                    type="submit"
                                    disabled={submitting || !confirmOk}
                                    style={{
                                        padding: '11px 20px',
                                        borderRadius: 10,
                                        border: 'none',
                                        background: submitting || !confirmOk ? '#93c5fd' : '#1e3a8a',
                                        color: '#ffffff',
                                        fontWeight: 700,
                                        cursor: submitting || !confirmOk ? 'not-allowed' : 'pointer',
                                        opacity: submitting || !confirmOk ? 0.5 : 1,
                                    }}
                                >
                                    {submitting ? 'Saving...' : 'Set New Password'}
                                </button>
                            </div>
                        </div>
                        );
                    })() : !otpRequested ? (
                        <div style={{ display: 'grid', gap: 8 }}>
                            <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.5 }}>
                                An OTP will be sent to <strong>{email || 'the email on your account'}</strong>. Keep it private; support will never ask for it.
                            </div>
                            <button
                                type="button"
                                onClick={requestOtp}
                                disabled={requestingOtp || !captchaVerified || !currentPassword}
                                title={!captchaVerified ? 'Complete the security check first' : (!currentPassword ? 'Enter your current password first' : undefined)}
                                style={{
                                    padding: '11px 16px',
                                    borderRadius: 10,
                                    border: 'none',
                                    background: requestingOtp || !captchaVerified || !currentPassword ? '#93c5fd' : '#1e3a8a',
                                    color: '#ffffff',
                                    fontWeight: 700,
                                    cursor: requestingOtp || !captchaVerified || !currentPassword ? 'not-allowed' : 'pointer',
                                }}
                            >
                                {requestingOtp ? 'Sending OTP...' : 'Send OTP to Email'}
                            </button>
                        </div>
                    ) : (
                        <>
                            <div style={{ display: 'grid', gap: 6 }}>
                                <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>Email OTP</label>
                                <input
                                    value={otp}
                                    onChange={(event) => setOtp(event.target.value.replace(/\D/g, '').slice(0, 6))}
                                    inputMode="numeric"
                                    maxLength={6}
                                    placeholder="000000"
                                    disabled={submitting}
                                    autoComplete="one-time-code"
                                    style={{ padding: '11px 12px', borderRadius: 10, border: '1px solid #cbd5e1', fontSize: 16, letterSpacing: 4, textAlign: 'center', fontFamily: 'monospace' }}
                                />
                            </div>

                            {(() => {
                                const pwOk = newPassword.length >= 8 && /[0-9]/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword) && /[A-Z]/.test(newPassword);
                                const confirmOk = pwOk && confirmPassword === newPassword;
                                return (
                                <>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>New password</label>
                                    <PasswordInput
                                        value={newPassword}
                                        onChange={(event) => setNewPassword(event.target.value)}
                                        disabled={submitting || !captchaVerified || !currentPassword}
                                        title={!captchaVerified ? 'Complete the security check first' : (!currentPassword ? 'Enter your current password first' : undefined)}
                                        placeholder="At least 8 characters"
                                        style={{ padding: '11px 12px', borderRadius: 10, border: '1px solid #cbd5e1' }}
                                        showStrength
                                        showSuggest
                                        onSuggestPick={(pwd) => {
                                            setNewPassword(pwd);
                                            setConfirmPassword(pwd);
                                        }}
                                    />
                                </div>
                                <div style={{ display: 'grid', gap: 6 }}>
                                    <label style={{ fontSize: 13, color: '#374151', fontWeight: 700 }}>Confirm password</label>
                                    <PasswordInput
                                        value={confirmPassword}
                                        onChange={(event) => setConfirmPassword(event.target.value)}
                                        disabled={submitting || !pwOk || !captchaVerified || !currentPassword}
                                        title={!pwOk ? 'Enter a valid password first' : undefined}
                                        placeholder="Repeat new password"
                                        style={{ padding: '11px 12px', borderRadius: 10, border: `1px solid ${confirmPassword ? (confirmPassword === newPassword ? '#16a34a' : '#dc2626') : '#cbd5e1'}` }}
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
                                </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setOtpRequested(false);
                                        setOtp('');
                                        setMessage('');
                                        setError('');
                                    }}
                                    disabled={submitting}
                                    style={{
                                        padding: '10px 14px',
                                        borderRadius: 10,
                                        border: '1px solid #cbd5e1',
                                        background: '#ffffff',
                                        color: '#475569',
                                        fontWeight: 700,
                                        cursor: submitting ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    Resend OTP
                                </button>
                                <button
                                    type="submit"
                                    disabled={submitting || !confirmOk}
                                    style={{
                                        padding: '10px 18px',
                                        borderRadius: 10,
                                        border: 'none',
                                        background: submitting || !confirmOk ? '#93c5fd' : '#0f172a',
                                        color: '#ffffff',
                                        fontWeight: 700,
                                        cursor: submitting || !confirmOk ? 'not-allowed' : 'pointer',
                                        opacity: submitting || !confirmOk ? 0.5 : 1,
                                    }}
                                >
                                    {submitting ? 'Changing Password...' : 'Change Password'}
                                </button>
                            </div>
                        </>
                        );
                            })()}
                        </>
                    ) }

                    {message && (
                        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#dcfce7', color: '#166534', border: '1px solid #86efac', fontSize: 13 }}>
                            {message}
                        </div>
                    )}
                    {error && (
                        <div style={{ padding: '10px 12px', borderRadius: 10, background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', fontSize: 13 }}>
                            {error}
                        </div>
                    )}
                </form>
            </div>
        </div>
    );
}
