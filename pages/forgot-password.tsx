import { useCallback, useEffect, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import styles from '../styles/Login.module.css';
import PasswordInput from '../components/PasswordInput';
import OtpInput from '@/components/OtpInput';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

interface ApiResponse {
  success: boolean;
  message: string;
  data?: {
    verified?: boolean;
    emailCodeSent?: boolean;
    emailVerified?: boolean;
    passwordEmailed?: boolean;
  };
  errors?: {
    retry_after_seconds?: number;
    [key: string]: unknown;
  };
}

type HcaptchaClient = {
  render?: (container: HTMLElement) => string | number;
  getResponse?: (widgetId?: string) => string;
};

type WindowWithHcaptcha = Window & typeof globalThis & {
  hcaptcha?: HcaptchaClient;
};

export default function ForgotPasswordPage() {
  const router = useRouter();
  const API_BASE_URL = getApiBaseUrl();

  const [accountEmail, setAccountEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showHcaptcha, setShowHcaptcha] = useState(false);
  const [hcaptchaReady, setHcaptchaReady] = useState(false);
  const [hcaptchaVerifying, setHcaptchaVerifying] = useState(false);
  const [hcaptchaWidgetKey, setHcaptchaWidgetKey] = useState(0);
  const [hcaptchaSiteKey, setHcaptchaSiteKey] = useState('');
  const hcaptchaContainerRef = useRef<HTMLDivElement | null>(null);
  const hcaptchaWidgetIdRef = useRef<string | null>(null);
  const [captchaTimerText, setCaptchaTimerText] = useState('Protected');
  const [captchaStatusMessage, setCaptchaStatusMessage] = useState('');
  const [pendingSendRequest, setPendingSendRequest] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<Date | null>(null);
  const [cooldownSecsLeft, setCooldownSecsLeft] = useState(0);

  // Password reset flow state (OTP for all roles).
  // NOTE: no current-password here by design — the user forgot it.
  // The emailed 6-letter code + verified session is the ownership proof.
  // Current password is only required in the authenticated
  // change-password flows (Settings / Change Password + OTP).
  const [step, setStep] = useState<'account' | 'email' | 'password'>('account');
  const [emailCode, setEmailCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Last password picked from the "suggest a strong password" picker. A copy
  // is emailed to the account Gmail only when the saved password still
  // matches this value (i.e. the user did not type over it afterwards).
  const [suggestedPassword, setSuggestedPassword] = useState('');
  const [emailNotFound, setEmailNotFound] = useState<string | null>(null);
  const [showNotFoundWarningIcon, setShowNotFoundWarningIcon] = useState(false);


  const getRawFetch = useCallback(() => {
    return fetch;
  }, []);

  useEffect(() => {
    const q = router.query.email;
    if (typeof q === 'string' && q.trim()) setAccountEmail(q.trim());
  }, [router.query.email]);

  useEffect(() => {
    let isActive = true;
    const rawFetch = getRawFetch();

    const fetchCaptchaSettings = async () => {
      try {
        const res = await rawFetch(`${API_BASE_URL}/settings_api.php?action=public_login_captcha_settings`, {
          method: 'GET',
        });
        const data = await res.json();
        if (!isActive) return;
        if (res.ok && data.success && data.data) {
          if (data.data.hcaptcha_site_key) {
            setHcaptchaSiteKey(data.data.hcaptcha_site_key);
          }
        }
      } catch {
        if (!isActive) return;
      }
    };

    void fetchCaptchaSettings();

    return () => {
      isActive = false;
    };
  }, [API_BASE_URL, getRawFetch]);

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

  // Tick the cooldown counter every second.
  useEffect(() => {
    if (!cooldownUntil) return;
    const tick = () => {
      const secs = Math.ceil((cooldownUntil.getTime() - Date.now()) / 1000);
      if (secs <= 0) {
        setCooldownUntil(null);
        setCooldownSecsLeft(0);
      } else {
        setCooldownSecsLeft(secs);
      }
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const existing = document.querySelector('script[src*="hcaptcha.com/1/api.js"]');
    if (existing) {
      setHcaptchaReady(true);
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://js.hcaptcha.com/1/api.js';
    script.async = true;
    script.defer = true;
    script.onload = () => setHcaptchaReady(true);
    script.onerror = () => setCaptchaStatusMessage('CAPTCHA failed to load. Refresh and try again.');
    document.head.appendChild(script);
  }, []);

  useEffect(() => {
    if (!showHcaptcha || !hcaptchaReady || !hcaptchaSiteKey) return;
    const container = hcaptchaContainerRef.current;
    if (!container) return;
    // Reset the widget ID before each fresh render so a stale ID is never used.
    hcaptchaWidgetIdRef.current = null;
    container.innerHTML = '';
    const widgetDiv = document.createElement('div');
    widgetDiv.className = 'h-captcha';
    widgetDiv.setAttribute('data-sitekey', hcaptchaSiteKey);
    widgetDiv.setAttribute('data-theme', 'dark');
    widgetDiv.setAttribute('data-size', 'normal');
    container.appendChild(widgetDiv);
    const hc = (window as any).hcaptcha;
    if (hc && typeof hc.render === 'function') {
      try {
        const widgetId = hc.render(widgetDiv);
        hcaptchaWidgetIdRef.current = widgetId != null ? String(widgetId) : null;
      } catch {
        // Widget may already be rendered by hCaptcha auto-render — look it up.
        try {
          const iframes = container.querySelectorAll('iframe[id^="cf-chl"]');
          if (iframes.length === 0) {
            // hCaptcha attaches data-hcaptcha-widget-id to the container div
            const wid = (widgetDiv as any)['hcaptcha-widget-id'] ?? widgetDiv.getAttribute('data-hcaptcha-widget-id');
            if (wid != null) hcaptchaWidgetIdRef.current = String(wid);
          }
        } catch { /* ignore */ }
      }
    }
  }, [showHcaptcha, hcaptchaReady, hcaptchaSiteKey, hcaptchaWidgetKey]);

  const openHcaptcha = useCallback(() => {
    setShowHcaptcha(true);
    setCaptchaTimerText('Ready');
    setCaptchaStatusMessage('Complete CAPTCHA to continue.');
    setHcaptchaWidgetKey((current) => current + 1);
  }, []);

  const handleCaptchaClose = useCallback(() => {
    if (hcaptchaVerifying) return;
    setShowHcaptcha(false);
    setPendingSendRequest(false);
    setCaptchaStatusMessage('CAPTCHA dismissed. You may try again.');
    setCaptchaTimerText('Protected');
  }, [hcaptchaVerifying]);

  const requestForgotPassword = useCallback(async (captchaToken?: string) => {
    const v = accountEmail.trim();
    if (!v) return;

    setLoading(true);
    setEmailNotFound(null);
    try {
      const rawFetch = getRawFetch();
      const res = await rawFetch(`${API_BASE_URL}/auth.php?action=forgot_password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify({ email: v, ...(captchaToken ? { captchaToken } : {}) }),
      });

      const responseText = await res.text();
      let data: ApiResponse;
      try {
        data = JSON.parse(responseText) as ApiResponse;
      } catch {
        console.error('Forgot-password API returned non-JSON response', res.status, responseText.slice(0, 500));
        setError(`The server returned an unexpected response (HTTP ${res.status}). Check the Railway API logs.`);
        return;
      }

      if (data.success) {
        if (data.data?.emailCodeSent) {
          // OTP flow — email code sent, go to email verification step
          setStep('email');
          setEmailCode('');
          setSuccess(null);
          setError(null);
        } else {
          setSuccess(data.message || 'If the account exists, a password reset email has been sent.');
        }
      } else {
        // 429 — rate limited: start the cooldown countdown.
        if (res.status === 429) {
          const retrySecs = typeof data.errors?.retry_after_seconds === 'number'
            ? data.errors.retry_after_seconds
            : 180;
          setCooldownUntil(new Date(Date.now() + retrySecs * 1000));
        }
        const msg = data.message || 'Request failed.';
        const errCode = typeof data.errors?.code === 'string' ? data.errors.code.toLowerCase() : '';
        // Unknown email: inline warning, stay on this step — no OTP is sent.
        if (res.status === 404 || errCode === 'email_not_found' || /email not found/i.test(msg)) {
          setEmailNotFound('No account found in this email.');
          return;
        }
        setError(msg);
      }
    } catch (err) {
      console.error(err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [API_BASE_URL, accountEmail, getRawFetch]);

  const verifyForgotHcaptchaToken = useCallback(async () => {
    if (typeof window === 'undefined' || !hcaptchaSiteKey) return;
    const hc = (window as WindowWithHcaptcha).hcaptcha;
    const widgetId = hcaptchaWidgetIdRef.current ?? undefined;
    // Try with the stored widget ID first; fall back to no-arg (gets the most
    // recent widget's response) in case the ID was not captured after re-render.
    const token = hc?.getResponse?.(widgetId) || hc?.getResponse?.();
    if (!token) {
      setError('Please complete the CAPTCHA challenge first.');
      return;
    }

    if (hcaptchaVerifying) return;
    setHcaptchaVerifying(true);
    setCaptchaTimerText('Verifying');
    setCaptchaStatusMessage('Validating CAPTCHA...');

    try {
      setCaptchaTimerText('Verified');
      setCaptchaStatusMessage('CAPTCHA verified. Sending request...');
      setShowHcaptcha(false);
      setPendingSendRequest(false);
      await requestForgotPassword(token);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'CAPTCHA verification failed.';
      setCaptchaTimerText('Retry required');
      setCaptchaStatusMessage(msg);
    } finally {
      setHcaptchaVerifying(false);
    }
  }, [hcaptchaSiteKey, hcaptchaVerifying, requestForgotPassword]);

  // Step 1: Submit email - show hCaptcha before request (skipped only when
  // hCaptcha is not configured on the server). Required for all users.
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setShowNotFoundWarningIcon(false);

    if (cooldownUntil && cooldownSecsLeft > 0) return;

    const v = accountEmail.trim();
    if (!v) {
      setError('Please enter your email.');
      return;
    }

    if (!hcaptchaSiteKey) {
      // hCaptcha not configured — send the request directly without the widget.
      void requestForgotPassword();
      return;
    }

    setPendingSendRequest(true);
    openHcaptcha();
  };

  // Step 2: Verify email code
  const handleVerifyEmailCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    const cleanEmailCode = emailCode.trim().toUpperCase().replace(/[^A-Z]/g, '');
    if (cleanEmailCode.length !== 6) {
      setError('Enter the 6-letter code sent to your email.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth.php?action=forgot_password_verify_email_code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: accountEmail.trim(),
          emailCode: cleanEmailCode,
        }),
      });

      const data: ApiResponse = await res.json();

      if (data.success) {
        setStep('password');
        setError(null);
        setSuccess(null);
      } else {
        setError(data.message || 'Invalid email verification code.');
      }
    } catch (err) {
      console.error(err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Step 3: Submit new password after email code verification.
  // No current password asked — the user forgot it. The verified
  // email-code session on the server is the ownership proof.
  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!newPassword || newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth.php?action=forgot_password_totp`, {  // endpoint kept for compatibility
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          email: accountEmail.trim(),
          newPassword,
          emailGeneratedPassword: suggestedPassword !== '' && suggestedPassword === newPassword,
        }),
      });

      const data: ApiResponse = await res.json();

      if (data.success) {
        setSuccess(
          (data.message || 'Password reset successfully. Redirecting to login...')
          + (data.data?.passwordEmailed ? ' A copy was sent to your Gmail.' : '')
        );
        setStep('account');
        setEmailCode('');
        setNewPassword('');
        setConfirmPassword('');
        setSuggestedPassword('');
        setTimeout(() => router.push('/'), 1500);
      } else {
        const lower = (data.message || '').toLowerCase();
        if (lower.includes('email code')) {
          setError((data.message || 'Email code verification expired.') + ' Please verify your email code again.');
          setStep('email');
          setEmailCode('');
        } else {
          setError(data.message || 'Reset failed.');
        }
      }
    } catch (err) {
      console.error(err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const resetAll = () => {
    setStep('account');
    setError(null);
    setSuccess(null);
    setShowNotFoundWarningIcon(false);
    setPendingSendRequest(false);
    setShowHcaptcha(false);
    setCaptchaTimerText('Protected');
    setCaptchaStatusMessage('');
    setEmailCode('');
    setNewPassword('');
    setConfirmPassword('');
    setSuggestedPassword('');
    setCooldownUntil(null);
    setCooldownSecsLeft(0);
  };

  const getTitle = () => {
    switch (step) {
      case 'email': return 'Verify Email Code';
      case 'password': return 'Set new password';
      default: return 'Forgot password';
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: 'transparent', position: 'relative' }}>
      <Head>
        <title>Forgot Password</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      </Head>

      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          backgroundImage: "url('/login-background.png')",
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          zIndex: -2,
        }}
      />
      <div aria-hidden style={{ position: 'fixed', inset: 0, background: 'linear-gradient(0deg, rgba(0,0,0,0.45), rgba(0,0,0,0.25))', zIndex: -1 }} />

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
        <div className={styles.card} style={{ width: '100%', maxWidth: 440, opacity: 0.9, position: 'relative', overflow: 'hidden' }}>
          <div className={styles.header}>
            <h1 style={{ lineHeight: 1.2, fontSize: '14px' }}>{getTitle()}</h1>

            {/* Step indicator */}
            {step !== 'account' && (
              <div style={{ display: 'flex', gap: 6, justifyContent: 'center', marginTop: 8 }}>
                {['Email Code', 'Password'].map((label, i) => (
                  <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{
                      width: 22, height: 22, borderRadius: '50%',
                      background: (step === 'email' && i === 0) || (step === 'password' && i <= 1)
                        ? (step === 'password' && i === 0 ? '#059669' : '#1e3a8a')
                        : '#d1d5db',
                      color: '#fff',
                      fontSize: 11, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {i + 1}
                    </div>
                    <span style={{ fontSize: 11, color: '#374151' }}>{label}</span>
                    {i < 1 && <div style={{ width: 20, height: 1, background: '#d1d5db', margin: '0 2px' }} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ====== STEP 1: Email ====== */}
          {step === 'account' && (
            <form className={styles.form} onSubmit={handleSubmit}>
              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="accountEmail">Email</label>
                <input
                  className={styles.input}
                  id="accountEmail"
                  type="email"
                  value={accountEmail}
                  onChange={(e) => {
                    setAccountEmail(e.target.value);
                    setEmailNotFound(null);
                    setShowNotFoundWarningIcon(false);
                  }}
                  placeholder="Enter your email"
                  disabled={loading}
                  aria-invalid={emailNotFound ? true : undefined}
                  style={emailNotFound ? { border: '2px solid #ef4444' } : undefined}
                />
                {emailNotFound && (
                  <div role="alert" style={{ marginTop: 6, fontSize: 12.5, color: '#dc2626', fontWeight: 600 }}>
                    {emailNotFound}
                  </div>
                )}
              </div>

              {/* Cooldown banner */}
              {cooldownUntil && cooldownSecsLeft > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: '#fef3c7', border: '1px solid #fde68a',
                  borderRadius: 8, padding: '8px 12px', marginBottom: 8, fontSize: 12, color: '#92400e',
                }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  Too many requests. Try again in <strong>{cooldownSecsLeft}s</strong>.
                </div>
              )}

              <button
                type="submit"
                className={styles.loginButton}
                disabled={loading || (cooldownUntil !== null && cooldownSecsLeft > 0)}
                style={{ opacity: (cooldownUntil && cooldownSecsLeft > 0) ? 0.5 : undefined }}
              >
                {loading
                  ? 'Checking...'
                  : (cooldownUntil && cooldownSecsLeft > 0)
                    ? `Wait ${cooldownSecsLeft}s`
                    : 'Send'}
              </button>

              <div style={{ marginTop: 12 }}>
                <button
                  type="button"
                  onClick={() => router.push('/')}
                  disabled={loading}
                  style={{
                    background: 'transparent', border: 'none', color: '#1e3a8a',
                    cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13,
                  }}
                >
                  Back to login
                </button>
              </div>
            </form>
          )}

          {/* ====== STEP 2: Email Code Verification ====== */}
          {step === 'email' && (
            <form className={styles.form} onSubmit={handleVerifyEmailCode}>
              <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 12px 0' }}>
                Enter the 6-letter code sent to your email.
              </p>

              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="adminEmailCode">Email code</label>
                <OtpInput
                  id="adminEmailCode"
                  value={emailCode}
                  onChange={(next) => setEmailCode(next.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6))}
                  length={6}
                  mode="alpha"
                  disabled={loading}
                  autoFocus
                  ariaLabel="Email code"
                  containerStyle={{ justifyContent: 'center' }}
                  inputStyle={{
                    width: 44,
                    height: 48,
                    borderRadius: 10,
                    fontSize: 18,
                    textTransform: 'uppercase',
                  }}
                />
              </div>

              <button
                type="submit"
                className={styles.loginButton}
                disabled={loading || emailCode.trim().length !== 6}
                style={{ opacity: (loading || emailCode.trim().length !== 6) ? 0.6 : 1 }}
              >
                {loading ? 'Verifying...' : 'Verify Email Code'}
              </button>

              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <button
                  type="button"
                  onClick={resetAll}
                  disabled={loading}
                  style={{
                    background: 'transparent', border: 'none', color: '#1e3a8a',
                    cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13,
                  }}
                >
                  Start over
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/')}
                  disabled={loading}
                  style={{
                    background: 'transparent', border: 'none', color: '#1e3a8a',
                    cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13,
                  }}
                >
                  Back to login
                </button>
              </div>
            </form>
          )}

          {/* ====== STEP 4: New Password (after TOTP + email verified) ====== */}
          {step === 'password' && (
            <form className={styles.form} onSubmit={handleResetPassword}>
              <div style={{
                background: '#ecfdf5',
                border: '1px solid #86efac',
                borderRadius: 8,
                padding: '8px 12px',
                marginBottom: 12,
                fontSize: 13,
                color: '#065f46',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}>
                <span>OK</span> Email code verified. Enter your new password.
              </div>

              <div className={styles.formGroup}>
                <label className={styles.label} htmlFor="newPassword">New password</label>
                <PasswordInput
                  className={styles.input}
                  id="newPassword"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Minimum 8 characters"
                  disabled={loading}
                  autoFocus
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

              {(() => {
                const pwOk = newPassword.length >= 8 && /[0-9]/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword) && /[A-Z]/.test(newPassword);
                const confirmOk = pwOk && confirmPassword === newPassword;
                const submitBlocked = loading || !confirmOk;
                return (
                  <>
                    <div className={styles.formGroup}>
                      <label className={styles.label} htmlFor="confirmPassword">Confirm password</label>
                      <PasswordInput
                        className={styles.input}
                        id="confirmPassword"
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="Re-enter new password"
                        disabled={loading || !pwOk}
                        title={!pwOk ? 'Enter a valid password first' : undefined}
                        style={confirmPassword ? { border: `1px solid ${confirmPassword === newPassword ? '#16a34a' : '#dc2626'}` } : undefined}
                      />
                      {!pwOk && newPassword.length > 0 && (
                        <span style={{ fontSize: 11.5, color: '#d97706', fontWeight: 600, marginTop: 4, display: 'block' }}>⚠ Password must be 8+ chars with a number, symbol, and capital letter.</span>
                      )}
                      {pwOk && confirmPassword && (
                        <span style={{ fontSize: 11.5, fontWeight: 600, color: confirmPassword === newPassword ? '#16a34a' : '#dc2626', display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                          {confirmPassword === newPassword ? '✓ Passwords match' : '✗ Passwords do not match'}
                        </span>
                      )}
                    </div>

                    <button type="submit" className={styles.loginButton} disabled={submitBlocked} style={{ opacity: submitBlocked ? 0.5 : 1, cursor: submitBlocked ? 'not-allowed' : 'pointer' }}>
                      {loading ? 'Resetting...' : 'Reset password'}
                    </button>
                  </>
                );
              })()}

              <div style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <button
                  type="button"
                  onClick={resetAll}
                  disabled={loading}
                  style={{
                    background: 'transparent', border: 'none', color: '#1e3a8a',
                    cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13,
                  }}
                >
                  Start over
                </button>
                <button
                  type="button"
                  onClick={() => router.push('/')}
                  disabled={loading}
                  style={{
                    background: 'transparent', border: 'none', color: '#1e3a8a',
                    cursor: 'pointer', textDecoration: 'underline', padding: 0, fontSize: 13,
                  }}
                >
                  Back to login
                </button>
              </div>
            </form>
          )}

          <div className={styles.footer}>
            <p>
              &copy; 2026 LLB Accountants. All rights reserved.
            </p>
          </div>
        </div>
      </div>

      {showHcaptcha && (
        <div className={styles.orbitCaptchaOverlay} role="dialog" aria-modal="true" aria-labelledby="forgot-hcaptcha-title">
          <div className={styles.orbitCaptchaCard}>
            <button
              type="button"
              className={styles.orbitCaptchaCloseBtn}
              onClick={() => void handleCaptchaClose()}
              aria-label="Close"
            >
              ✕
            </button>

            <div className={styles.orbitCaptchaHeader}>
              <h2 id="forgot-hcaptcha-title" className={styles.orbitCaptchaTitle}>Security Check</h2>
              <p className={styles.orbitCaptchaInstruction}>Complete verification to continue.</p>
            </div>

            <div className={styles.orbitCaptchaStatusRow}>
              <span>{captchaTimerText}</span>
              <button
                type="button"
                className={styles.refreshButton}
                onClick={() => setHcaptchaWidgetKey((current) => current + 1)}
                disabled={hcaptchaVerifying}
                title="Refresh"
              >
                ↻
              </button>
            </div>

            <div style={{ borderRadius: 20, border: '1px solid rgba(148, 163, 184, 0.22)', background: 'rgba(15, 23, 42, 0.34)', padding: 18, minHeight: 180, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {hcaptchaReady && hcaptchaSiteKey ? (
                <div key={hcaptchaWidgetKey} style={{ width: '100%', display: 'flex', justifyContent: 'center', minHeight: 78 }}>
                  <div ref={hcaptchaContainerRef} style={{ minHeight: 78 }} />
                </div>
              ) : hcaptchaReady && !hcaptchaSiteKey ? (
                <div style={{ color: '#f59e0b', fontSize: 14, textAlign: 'center' }}>CAPTCHA not configured. Contact an administrator.</div>
              ) : (
                <div style={{ color: '#cbd5e1', fontSize: 14 }}>Loading CAPTCHA...</div>
              )}
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
              <button
                type="button"
                onClick={() => void verifyForgotHcaptchaToken()}
                disabled={hcaptchaVerifying}
                className={styles.hcaptchaVerifyButton}
              >
                {hcaptchaVerifying ? 'Verifying...' : 'Verify'}
              </button>
            </div>

            <div className={styles.physicsStatus}>{captchaStatusMessage}</div>
          </div>
        </div>
      )}
    </div>
  );
}
