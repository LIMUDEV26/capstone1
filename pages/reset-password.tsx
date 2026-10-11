import { useEffect, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import styles from '../styles/Login.module.css';
import CrudActionIcon from '../components/CrudActionIcon';
import PasswordInput from '../components/PasswordInput';
import { useAuth } from '@/components/AuthProvider';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

interface ApiResponse {
  success: boolean;
  message: string;
  data?: {
    role?: string;
    [key: string]: unknown;
  } | null;
}

export default function ResetPasswordPage() {
  const router = useRouter();
  const { logout } = useAuth();
  const API_BASE_URL = getApiBaseUrl();

  const [token, setToken] = useState<string>('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  // Same suggested-password tracking as forgot-password: email a copy only
  // when the saved password still matches the picked suggestion.
  const [suggestedPassword, setSuggestedPassword] = useState('');
  const [mode, setMode] = useState<'token' | 'first_login'>('token');
  const [checkingAccess, setCheckingAccess] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    const qMode = typeof router.query.mode === 'string' ? router.query.mode : '';
    const isFirstLoginMode = qMode === 'first_login';
    setMode(isFirstLoginMode ? 'first_login' : 'token');

    if (!isFirstLoginMode) {
      const t = router.query.token;
      setToken(typeof t === 'string' ? t : '');
      return;
    }

    let cancelled = false;
    setCheckingAccess(true);
    setError(null);

    (async () => {
      try {
        const res = await fetch(`${API_BASE_URL}/auth.php?action=session`, {
          method: 'GET',
          credentials: 'include',
        });
        const data: ApiResponse = await res.json();

        if (cancelled) return;

        if (!data.success) {
          setError('Please log in first to change your temporary password.');
          setTimeout(() => router.push('/'), 1000);
          return;
        }
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setError('Please log in first to change your temporary password.');
          setTimeout(() => router.push('/'), 1000);
        }
      } finally {
        if (!cancelled) setCheckingAccess(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [API_BASE_URL, router, router.query.mode, router.query.token]);

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

  const handleBackToLogin = async () => {
    if (loading || checkingAccess) return;
    if (mode === 'first_login') {
      // A plain router.push('/') would bounce straight back: AuthProvider's
      // must-reset guard redirects any must_reset_password=1 session to this
      // page. Log out first to destroy the temporary session, then go to login.
      try {
        await logout();
      } catch {
        router.push('/');
      }
      return;
    }
    router.push('/');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (mode === 'token' && !token) {
      setError('Missing or invalid token.');
      return;
    }
    if (mode === 'first_login' && checkingAccess) {
      setError('Please wait while we verify your session.');
      return;
    }
    if (!newPassword || newPassword.length < 8) {
      setError('Password must be at least 8 characters.');
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

    setLoading(true);
    try {
      const action = mode === 'first_login' ? 'first_login_change_password' : 'reset_password';
      const emailGeneratedPassword = suggestedPassword !== '' && suggestedPassword === newPassword;
      const body = mode === 'first_login'
        ? { newPassword, emailGeneratedPassword }
        : { token, newPassword, emailGeneratedPassword };

      const res = await fetch(`${API_BASE_URL}/auth.php?action=${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      const data: ApiResponse = await res.json();

      if (data.success) {
        const emailedNote = (data.data as { passwordEmailed?: boolean } | null)?.passwordEmailed
          ? ' A copy was sent to your Gmail.'
          : '';
        if (mode === 'first_login') {
          setSuccess((data.message || 'Password updated. Redirecting to login...') + emailedNote);
          // End the temporary session and send the user to login so they
          // sign in fresh with the new password (logout() routes to '/').
          setTimeout(() => { void logout().catch(() => router.push('/')); }, 1200);
        } else {
          setSuccess((data.message || 'Password updated. Redirecting to login...') + emailedNote);
          setTimeout(() => router.replace('/'), 1200);
        }
      } else {
        setError(data.message || 'Reset failed.');
      }
    } catch (err) {
      console.error(err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', background: 'transparent', position: 'relative' }}>
      <Head>
        <title>{mode === 'first_login' ? 'Change Temporary Password' : 'Reset Password'}</title>
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
        <div className={styles.card} style={{ width: '100%', maxWidth: 420, opacity: 0.9, position: 'relative', overflow: 'hidden' }}>
          <div className={styles.header}>
            <h1 style={{ lineHeight: 1.2, fontSize: '14px' }}>
              {mode === 'first_login' ? 'Change temporary password' : 'Reset password'}
            </h1>
          </div>

          <form className={styles.form} onSubmit={handleSubmit}>
            {mode === 'first_login' && (
              <div style={{ marginBottom: 12, fontSize: 13, lineHeight: 1.6, color: '#334155' }}>
                You are logged in with a temporary password. Create a new password to continue.
              </div>
            )}
            {checkingAccess && (
              <div style={{ marginBottom: 12, fontSize: 13, color: '#1e3a8a' }}>
                Verifying your login session...
              </div>
            )}
            <div className={styles.formGroup}>
              <label className={styles.label} htmlFor="newPassword">New password</label>
              <PasswordInput
                className={styles.input}
                id="newPassword"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Enter a new password"
                disabled={loading || checkingAccess}
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
              const submitBlocked = loading || checkingAccess || !confirmOk;
              return (
                <>
                  <div className={styles.formGroup}>
                    <label className={styles.label} htmlFor="confirmPassword">Confirm password</label>
                    <PasswordInput
                      className={styles.input}
                      id="confirmPassword"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter the new password"
                      disabled={loading || checkingAccess || !pwOk}
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

                  <button type="submit" className={styles.loginButton} disabled={submitBlocked} title="Update password" aria-label="Update password" style={{ opacity: submitBlocked ? 0.5 : 1, cursor: submitBlocked ? 'not-allowed' : 'pointer' }}>
                    {loading ? 'Saving...' : 'Submit'}
                  </button>
                </>
              );
            })()}

            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                onClick={() => { void handleBackToLogin(); }}
                disabled={loading || checkingAccess}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: '#1e3a8a',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                  fontSize: 13,
                }}
              >
                Back to login
              </button>
            </div>
          </form>

          <div className={styles.footer}>
            <p>
              &copy; 2026 LLB Accountants. All rights reserved.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
