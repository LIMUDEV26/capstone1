import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useAuth } from '@/components/AuthProvider';
import OtpInput from '@/components/OtpInput';
import styles from '../styles/Login.module.css';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError, notifySuccess } from '@/utils/notify';
import { warmRoute } from '@/utils/routeWarmup';
import type { SessionUser } from '@/components/AuthProvider';
import Swal from 'sweetalert2';

interface ApiResponse<T> {
  success: boolean;
  data: T;
  message: string;
}

type LoginResponse = ApiResponse<{
  id: number;
  role: string;
  username: string;
  otp_required?: number | boolean;
  ended_other_session?: number | boolean;
  expires_in?: number;
  must_reset_password?: number | string;
  password_change_reason?: string;
  password_status?: {
    expired?: boolean;
    requires_change?: boolean;
    reason?: string;
    days_remaining?: number | null;
    password_expires_at?: string | null;
  };
}>;

type LoginErrorResponse = {
  success: boolean;
  message: string;
  errors?: {
    attempts_remaining?: number | null;
    failed_attempts?: number | null;
    lockout_threshold?: number | null;
    lockout_triggered?: boolean;
    retry_after_seconds?: number | null;
    browser_blocked?: boolean;
    field?: string | null;
    code?: string | null;
  };
};

type PublicLoginCaptchaSettingsResponse = ApiResponse<Record<string, unknown>>;

type LoginNetworkSnapshot = {
  online?: boolean;
  effective_type?: string;
  downlink?: number;
  rtt?: number;
};

type LoginPrecheckResponse = ApiResponse<{
  otp_required?: number | boolean;
  captcha_required?: boolean;
  captcha_mode?: 'custom' | 'auto';
  expires_in?: number;
  auto_check_delay_ms?: number;
  risk_score?: number;
  manual_reason?: string;
}>;

type LoginVerifyOtpResponse = ApiResponse<{
  otp_verified?: number | boolean;
  captcha_required?: boolean;
  captcha_mode?: 'custom' | 'auto';
  expires_in?: number;
  auto_check_delay_ms?: number;
}>;

type LoginRequestOtpResponse = ApiResponse<{
  otp_required?: number | boolean;
  expires_in?: number;
}>;

const OTP_RESEND_SECONDS = 30;

// Server-issued single-digit math image captcha. The answer never leaves
// the server — the browser only renders the image and submits the guess.
type ServerMathChallenge = {
  id: string;
  image: string;
  expiresIn: number;
};

class LoginRequestError extends Error {
  attemptsRemaining: number | null;
  retryAfterSeconds: number | null;
  browserBlocked: boolean;
  errorField: string | null;
  errorCode: string | null;

  constructor(message: string, attemptsRemaining?: number | null, retryAfterSeconds?: number | null, browserBlocked?: boolean, errorField?: string | null, errorCode?: string | null) {
    super(message);
    this.name = 'LoginRequestError';
    this.attemptsRemaining = typeof attemptsRemaining === 'number' ? attemptsRemaining : null;
    this.retryAfterSeconds = typeof retryAfterSeconds === 'number' ? retryAfterSeconds : null;
    this.browserBlocked = Boolean(browserBlocked);
    this.errorField = typeof errorField === 'string' && errorField.length > 0 ? errorField : null;
    this.errorCode = typeof errorCode === 'string' && errorCode.length > 0 ? errorCode : null;
  }
}

function getRememberedEmail() {
  if (typeof window === 'undefined') return '';

  try {
    return localStorage.getItem('remember_email') || localStorage.getItem('remember_username') || '';
  } catch {
    return '';
  }
}

function buildUnexpectedApiResponseMessage(fallbackMessage: string, status: number, body: string): string {
  const normalizedBody = body.replace(/\s+/g, ' ').trim();
  const preview = normalizedBody.slice(0, 120);
  const looksHtml = /^<!doctype html\b|^<html\b|^</i.test(normalizedBody);

  if (looksHtml) {
    return `${fallbackMessage} The server returned HTML instead of JSON (HTTP ${status}). This usually means the tunnel is not reaching the PHP backend route correctly.`;
  }

  if (preview) {
    return `${fallbackMessage} Server response preview: ${preview}`;
  }

  return `${fallbackMessage} HTTP ${status}.`;
}

async function readJsonResponse<T>(res: Response, fallbackMessage: string): Promise<T> {
  const body = await res.text();

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(buildUnexpectedApiResponseMessage(fallbackMessage, res.status, body));
  }
}

function getLoginNetworkSnapshot(): LoginNetworkSnapshot {
  if (typeof window === 'undefined') {
    return {};
  }

  const nav = window.navigator as Navigator & {
    connection?: {
      effectiveType?: string;
      downlink?: number;
      rtt?: number;
    };
  };

  const connection = nav.connection;
  const downlink = connection?.downlink;
  const rtt = connection?.rtt;

  return {
    online: typeof nav.onLine === 'boolean' ? nav.onLine : undefined,
    effective_type: typeof connection?.effectiveType === 'string' ? connection.effectiveType : undefined,
    downlink: typeof downlink === 'number' && Number.isFinite(downlink) ? downlink : undefined,
    rtt: typeof rtt === 'number' && Number.isFinite(rtt) ? rtt : undefined,
  };
}

export default function Login() {
  const router = useRouter();
  const { refreshSession, setSessionUser } = useAuth();
  const assetBasePath = router.basePath || '';
  // Init with deterministic SSR-safe values; browser-specific values
  // (localStorage, Math.random) are loaded in a mount effect below so the
  // first client render matches server HTML (avoids hydration mismatches).
  const [email, setEmail] = useState('');
  const [emailTouched, setEmailTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // Plain form-level credential label. Deliberately NOT pinned to the email
  // or password field: saying which half is wrong would let attackers
  // enumerate registered accounts.
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [rememberPulse, setRememberPulse] = useState(false);
  const [captchaLoading, setCaptchaLoading] = useState(false);
  const [captchaVerified, setCaptchaVerified] = useState(false);
  const [captchaTimerText, setCaptchaTimerText] = useState('Protected');
  const [captchaStatusMessage, setCaptchaStatusMessage] = useState('');
  const [captchaSettingsReady, setCaptchaSettingsReady] = useState(false);
  const [showRobotCheck, setShowRobotCheck] = useState(false);
  const [robotCheckError, setRobotCheckError] = useState('');
  // Server-issued single-digit math image for theCaptcha-enabled login path.
  const [robotMathChallenge, setRobotMathChallenge] = useState<ServerMathChallenge | null>(null);
  const [robotMathLoading, setRobotMathLoading] = useState(false);
  const [robotMathInput, setRobotMathInput] = useState('');
  const [robotMathVerifying, setRobotMathVerifying] = useState(false);
  // Login OTP: required on every login for every user once credentials verify.
  const [otpStep, setOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpResendIn, setOtpResendIn] = useState(0);
  const robotCheckFinishingRef = useRef(false);
  const loginCardRef = useRef<HTMLDivElement | null>(null);
  const [loginCardCenter, setLoginCardCenter] = useState({ left: 0, top: 0 });
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const cooldownTimerRef = useRef<number | null>(null);

  // Intruder / browser lockout state
  const [browserBlocked, setBrowserBlocked] = useState(false);
  const [showUnauthorizedOverlay, setShowUnauthorizedOverlay] = useState(false);
  const [unauthorizedOverlayExiting, setUnauthorizedOverlayExiting] = useState(false);

  const loginTitleLines = [
    'Lope Laranjo Bato & Co., CPAs',
  ];

  // API Base URL
  const API_BASE_URL = getApiBaseUrl();

  const getRawFetch = useCallback(() => {
    if (typeof window !== 'undefined' && typeof window.__nativeFetch === 'function') {
      return window.__nativeFetch.bind(window);
    }
    return fetch;
  }, []);

  // ── Hydration-safe browser values: load after mount so SSR HTML matches ──
  useEffect(() => {
    const remembered = getRememberedEmail();
    if (remembered) {
      setEmail(remembered);
      setRemember(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!error) return;
    void notifyError(error);
  }, [error]);

  // ── Browser-lockout: check on mount ──────────────────────────────────────
  useEffect(() => {
    let active = true;
    const rawFetch = typeof window !== 'undefined' && typeof (window as Window & typeof globalThis & { __nativeFetch?: typeof fetch }).__nativeFetch === 'function'
      ? ((window as Window & typeof globalThis & { __nativeFetch?: typeof fetch }).__nativeFetch as typeof fetch).bind(window)
      : fetch;

    // Show blocked UI immediately if the flag is cached, but always verify
    // with the server so an admin unblock is reflected without a manual cache clear.
    const cachedBlocked = typeof window !== 'undefined' && (() => {
      try { return localStorage.getItem('__llb_browser_blocked') === '1'; } catch { return false; }
    })();
    if (cachedBlocked) setBrowserBlocked(true);

    rawFetch(`${API_BASE_URL}/browser-lockout.php?action=check`, {
      method: 'GET',
      credentials: 'include',
    })
      .then((res) => res.json())
      .then((data: { data?: { blocked?: boolean } }) => {
        if (!active) return;
        if (data?.data?.blocked) {
          setBrowserBlocked(true);
          try { localStorage.setItem('__llb_browser_blocked', '1'); } catch { /* ignore */ }
        } else {
          // Server says not blocked — clear stale local flag and unblock UI
          setBrowserBlocked(false);
          try { localStorage.removeItem('__llb_browser_blocked'); } catch { /* ignore */ }
        }
      })
      .catch(() => {
        // Network error: fall back to the cached flag already applied above
      });

    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_BASE_URL]);

  // Remove success notification for login - we'll show a checkmark animation instead

  useEffect(() => {
    let isActive = true;
    const rawFetch = getRawFetch();

    const fetchLoginCaptchaSettings = async () => {
      try {
        const res = await rawFetch(`${API_BASE_URL}/settings_api.php?action=public_login_captcha_settings`, {
          method: 'GET',
        });
        const data = await readJsonResponse<PublicLoginCaptchaSettingsResponse>(
          res,
          'Failed to read the captcha settings.'
        );
        if (!isActive) return;
        if (!res.ok || !data.success) {
          throw new Error(data.message || 'Failed to read the captcha settings.');
        }
      } catch {
        if (!isActive) return;
      } finally {
        if (isActive) {
          setCaptchaSettingsReady(true);
        }
      }
    };

    void fetchLoginCaptchaSettings();

    return () => {
      isActive = false;
    };
  }, [API_BASE_URL, getRawFetch]);

  useEffect(() => {
    if (!captchaSettingsReady) return;

    const timer = window.setTimeout(() => {
      setCaptchaLoading(false);
      setCaptchaVerified(false);
      setCaptchaTimerText('Protected');
      setCaptchaStatusMessage('');
    }, 0);

    return () => {
      window.clearTimeout(timer);
    };
  }, [captchaSettingsReady]);

  useLayoutEffect(() => {
    if (!showRobotCheck) return;

    const updateLoginCardCenter = () => {
      const cardBounds = loginCardRef.current?.getBoundingClientRect();
      if (!cardBounds) return;

      setLoginCardCenter({
        left: cardBounds.left + cardBounds.width / 2,
        top: cardBounds.top + cardBounds.height / 2,
      });
    };

    updateLoginCardCenter();
    window.addEventListener('resize', updateLoginCardCenter);
    window.addEventListener('scroll', updateLoginCardCenter, true);

    const resizeObserver = new ResizeObserver(updateLoginCardCenter);
    if (loginCardRef.current) {
      resizeObserver.observe(loginCardRef.current);
    }

    return () => {
      window.removeEventListener('resize', updateLoginCardCenter);
      window.removeEventListener('scroll', updateLoginCardCenter, true);
      resizeObserver.disconnect();
    };
  }, [showRobotCheck]);

  const persistRememberPreference = useCallback(() => {
    try {
      if (typeof window !== 'undefined') {
        if (remember) {
          localStorage.setItem('remember_email', email);
          localStorage.removeItem('remember_username');
        } else {
          localStorage.removeItem('remember_email');
          localStorage.removeItem('remember_username');
        }
      }
    } catch {
      // Ignore storage persistence errors.
    }
  }, [email, remember]);

  const performLogin = useCallback(async () => {
    const rawFetch = getRawFetch();

    const res = await rawFetch(`${API_BASE_URL}/auth.php?action=login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        email,
        password,
      }),
    });

    let data: LoginResponse | LoginErrorResponse;
    try {
      data = await readJsonResponse<LoginResponse | LoginErrorResponse>(
        res,
        'Login failed because the server returned an unexpected response.'
      );
    } catch {
      // Non-JSON / HTTP 500 during credential check should read as invalid credentials.
      // No field pointer: pinning this to a field would leak account existence.
      throw new LoginRequestError('Invalid email or password.', null, null, false, null);
    }

    if (!res.ok || !data.success) {
      const errorPayload = data as LoginErrorResponse;
      throw new LoginRequestError(
        errorPayload.message || 'Invalid email or password.',
        errorPayload.errors?.attempts_remaining,
        errorPayload.errors?.retry_after_seconds,
        errorPayload.errors?.browser_blocked,
        errorPayload.errors?.field,
        errorPayload.errors?.code
      );
    }

    return data as LoginResponse;
  }, [API_BASE_URL, email, getRawFetch, password]);

  const performLoginPrecheck = useCallback(async () => {
    const rawFetch = getRawFetch();

    const res = await rawFetch(`${API_BASE_URL}/auth.php?action=login_precheck`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({
        email,
        password,
        network: getLoginNetworkSnapshot(),
      }),
    });

    let data: LoginPrecheckResponse | LoginErrorResponse;
    try {
      data = await readJsonResponse<LoginPrecheckResponse | LoginErrorResponse>(
        res,
        'Credential check failed because the server returned an unexpected response.'
      );
    } catch {
      // Non-JSON / HTTP 500 during credential check should read as invalid credentials.
      // No field pointer: pinning this to a field would leak account existence.
      throw new LoginRequestError('Invalid email or password.', null, null, false, null);
    }

    if (!res.ok || !data.success) {
      const errorPayload = data as LoginErrorResponse;
      throw new LoginRequestError(
        errorPayload.message || 'Invalid email or password.',
        errorPayload.errors?.attempts_remaining,
        errorPayload.errors?.retry_after_seconds,
        errorPayload.errors?.browser_blocked,
        errorPayload.errors?.field,
        errorPayload.errors?.code
      );
    }

    return data as LoginPrecheckResponse;
  }, [API_BASE_URL, email, getRawFetch, password]);

  const performLoginComplete = useCallback(async () => {
    const rawFetch = getRawFetch();

    const res = await rawFetch(`${API_BASE_URL}/auth.php?action=login_complete`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({}),
    });

    let data: LoginResponse | LoginErrorResponse;
    try {
      data = await readJsonResponse<LoginResponse | LoginErrorResponse>(
        res,
        'Login could not be completed because the server returned an unexpected response.'
      );
    } catch {
      // Non-JSON / HTTP 500 while finishing login should also read as invalid credentials.
      // No field pointer: pinning this to a field would leak account existence.
      throw new LoginRequestError('Invalid email or password.', null, null, false, null);
    }

    if (!res.ok || !data.success) {
      const errorPayload = data as LoginErrorResponse;
      throw new LoginRequestError(
        errorPayload.message || 'Login could not be completed.',
        errorPayload.errors?.attempts_remaining,
        errorPayload.errors?.retry_after_seconds,
        errorPayload.errors?.browser_blocked,
        errorPayload.errors?.field,
        errorPayload.errors?.code
      );
    }

    return data as LoginResponse;
  }, [API_BASE_URL, getRawFetch]);

  const performLoginVerifyOtp = useCallback(async (code: string) => {
    const rawFetch = getRawFetch();

    const res = await rawFetch(`${API_BASE_URL}/auth.php?action=login_verify_otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({ otp: code }),
    });

    let data: LoginVerifyOtpResponse | LoginErrorResponse;
    try {
      data = await readJsonResponse<LoginVerifyOtpResponse | LoginErrorResponse>(
        res,
        'Code verification failed because the server returned an unexpected response.'
      );
    } catch {
      throw new LoginRequestError('Could not verify the code. Please try again.', null, null, false, 'otp');
    }

    if (!res.ok || !data.success) {
      const errorPayload = data as LoginErrorResponse;
      throw new LoginRequestError(
        errorPayload.message || 'Incorrect verification code.',
        errorPayload.errors?.attempts_remaining,
        errorPayload.errors?.retry_after_seconds,
        errorPayload.errors?.browser_blocked,
        errorPayload.errors?.field || 'otp',
        errorPayload.errors?.code
      );
    }

    return data as LoginVerifyOtpResponse;
  }, [API_BASE_URL, getRawFetch]);

  const performLoginRequestOtp = useCallback(async () => {
    const rawFetch = getRawFetch();

    const res = await rawFetch(`${API_BASE_URL}/auth.php?action=login_request_otp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify({}),
    });

    let data: LoginRequestOtpResponse | LoginErrorResponse;
    try {
      data = await readJsonResponse<LoginRequestOtpResponse | LoginErrorResponse>(
        res,
        'Code resend failed because the server returned an unexpected response.'
      );
    } catch {
      throw new LoginRequestError('Could not resend the code. Please try again.', null, null, false, 'otp');
    }

    if (!res.ok || !data.success) {
      const errorPayload = data as LoginErrorResponse;
      throw new LoginRequestError(
        errorPayload.message || 'Could not resend the code.',
        errorPayload.errors?.attempts_remaining,
        errorPayload.errors?.retry_after_seconds,
        errorPayload.errors?.browser_blocked,
        errorPayload.errors?.field || 'otp',
        errorPayload.errors?.code
      );
    }

    return data as LoginRequestOtpResponse;
  }, [API_BASE_URL, getRawFetch]);

  const resetOtpStep = useCallback(() => {
    setOtpStep(false);
    setOtpCode('');
    setOtpError(null);
    setOtpLoading(false);
    setOtpResendIn(0);
  }, []);

  const completeSuccessfulLogin = useCallback(async (data: LoginResponse) => {
    // Single-session rule: this sign-in directly ends the account's other
    // active session — no approval prompt, no waiting.
    persistRememberPreference();

    const role = String(data.data.role || '').toLowerCase();
    const mustResetPassword = Number(data?.data?.must_reset_password ?? 0) === 1;
    const passwordChangeReason = String(data?.data?.password_change_reason || 'expired').trim();
    const nextRaw = typeof router.query.next === 'string' ? router.query.next : '';
    const hasSafeNext = nextRaw.startsWith('/') && !nextRaw.startsWith('//');
    const nextPath = mustResetPassword
      ? passwordChangeReason === 'first_login'
        ? '/reset-password?mode=first_login'
        : `/change-password?reason=${passwordChangeReason === 'expired' ? 'expired' : 'manual'}`
      : hasSafeNext
        ? nextRaw
        : role === 'admin'
          ? '/admin/dashboard'
          : role === 'manager'
            ? '/manager/dashboard'
            : '/dashboard';

    warmRoute(router, nextPath);
    setSessionUser(data.data as SessionUser);

    notifySuccess('Login successful!');

    // Wait for checkmark animation to complete before redirecting
    setTimeout(() => {
      void refreshSession({ force: true });
      void router.replace(nextPath);
    }, 1500);
  }, [persistRememberPreference, refreshSession, router, setSessionUser]);

  const startCooldown = useCallback((seconds: number) => {
    const safe = Math.max(1, Math.min(86400, Math.trunc(seconds)));
    setCooldownSeconds(safe);
    if (cooldownTimerRef.current) window.clearInterval(cooldownTimerRef.current);
    let remaining = safe;
    cooldownTimerRef.current = window.setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        if (cooldownTimerRef.current) window.clearInterval(cooldownTimerRef.current);
        cooldownTimerRef.current = null;
        setCooldownSeconds(0);
      } else {
        setCooldownSeconds(remaining);
      }
    }, 1000);
  }, []);

  useEffect(() => {
    return () => {
      if (cooldownTimerRef.current) window.clearInterval(cooldownTimerRef.current);
    };
  }, []);

  // ── Record failed login attempt for browser-lockout tracking ─────────────
  const recordFailedAttempt = useCallback(async () => {
    try {
      const rawFetch = getRawFetch();
      const res = await rawFetch(`${API_BASE_URL}/browser-lockout.php?action=record_attempt`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json()) as { data?: { blocked?: boolean; just_blocked?: boolean; attempt_count?: number } };
      if (data?.data?.blocked) {
        // Persist so that even after page refresh the block is enforced immediately
        try { localStorage.setItem('__llb_browser_blocked', '1'); } catch { /* ignore */ }

        if (data?.data?.just_blocked) {
          // Show the floating "Unauthorized Access Detected" banner first, then hard-block
          setShowUnauthorizedOverlay(true);
          window.setTimeout(() => {
            setUnauthorizedOverlayExiting(true);
            window.setTimeout(() => {
              setShowUnauthorizedOverlay(false);
              setUnauthorizedOverlayExiting(false);
              setBrowserBlocked(true);
            }, 600);
          }, 3500);
        } else {
          setBrowserBlocked(true);
        }
      }
    } catch { /* silently ignore */ }
  }, [API_BASE_URL, getRawFetch]);

  const handleLoginError = useCallback((err: unknown) => {
    console.error('Login error:', err);

    // If the server already says browser_blocked, show the block wall immediately
    // and don't bother recording (the server already knows it's blocked).
    if (err instanceof LoginRequestError && err.browserBlocked) {
      try { localStorage.setItem('__llb_browser_blocked', '1'); } catch { /* ignore */ }
      setBrowserBlocked(true);
      setPassword('');
      return;
    }

    // Record the failed attempt for browser-lockout tracking
    void recordFailedAttempt();

    setPassword('');

    if (err instanceof LoginRequestError && typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds > 0) {
      const secs = Math.max(1, Math.trunc(err.retryAfterSeconds));
      startCooldown(secs);
      // Rate-limit notice uses the single plain credential label too — never
      // a field-pinned error (that would leak account existence).
      setEmailError(null);
      setPasswordError(null);
      setCredentialError(`Too many request, please try again after ${secs} seconds.`);
      void Swal.fire({
        icon: 'warning',
        title: 'Too Many Requests',
        html: `<p style="font-size:15.5px;color:#475569;margin:0;line-height:1.6">Too many request, please try again after ${secs} seconds.</p>`,
        timer: 3000,
        timerProgressBar: true,
        showConfirmButton: false,
        background: '#ffffff',
        color: '#0f172a',
        width: 'min(600px, 94vw)',
      });
      return;
    }

    if (err instanceof LoginRequestError) {
      const code = (err.errorCode || '').toLowerCase();
      const field = (err.errorField || '').toLowerCase();
      const msgLower = err.message.toLowerCase();

      // Generic credential failure: ONE plain label, never pinned to the
      // email or password field, with no "wrong password / locked / inactive
      // / attempts left" detail — any of that would tell an attacker whether
      // the account exists. (Legacy codes/messages included for older
      // responses; locked/inactive are folded in here on purpose.)
      const isCredentialFailure =
        code === 'invalid_credentials' ||
        code === 'email_not_found' ||
        code === 'invalid_password' ||
        code === 'account_locked' ||
        code === 'account_inactive' ||
        msgLower.includes('invalid email or password') ||
        msgLower.includes('your email is not valid') ||
        msgLower.includes('unknown identifier') ||
        msgLower.includes('locked') ||
        msgLower.includes('not active') ||
        msgLower.includes('inactive') ||
        msgLower.includes('disabled');
      if (isCredentialFailure && field !== 'otp') {
        setEmailError(null);
        setPasswordError(null);
        setCredentialError('Invalid email or password.');
        return;
      }
    }

    // Any other login failure (including legacy locked/attempt-count shapes)
    // still renders as the same single plain label — never a locked toast,
    // never attempt counters, never a field-pinned error.
    {
      const rawMsg = err instanceof Error ? err.message : 'Network error. Please try again.';
      const rawLower = rawMsg.toLowerCase();
      // Mask technical server failures during credential check as invalid credentials.
      if (
        rawLower.includes('unexpected response') ||
        rawLower.includes('credential check failed') ||
        rawLower.includes('server returned') ||
        rawLower.includes('internal server error') ||
        rawLower.includes('server error') ||
        rawLower.includes('something went wrong') ||
        rawLower.includes('http 500') ||
        rawLower.includes('http 502') ||
        rawLower.includes('http 503') ||
        rawLower.includes('failed to fetch') ||
        rawLower.includes('networkerror') ||
        rawLower.includes('locked') ||
        rawLower.includes('not active') ||
        rawLower.includes('inactive')
      ) {
        setEmailError(null);
        setPasswordError(null);
        setCredentialError('Invalid email or password.');
        return;
      }
      setEmailError(null);
      setPasswordError(null);
      setCredentialError(rawMsg);
    }
  }, [recordFailedAttempt, startCooldown]);

  const enterOtpStep = useCallback(() => {
    setOtpCode('');
    setOtpError(null);
    setOtpStep(true);
    setOtpResendIn(OTP_RESEND_SECONDS);
    setLoading(false);
    setCaptchaStatusMessage('A verification code has been sent to your email.');
  }, []);

  const finishRobotVerification = useCallback(async () => {
    if (robotCheckFinishingRef.current) return;
    robotCheckFinishingRef.current = true;

    setCaptchaVerified(true);
    setCaptchaTimerText('Verified');
    setCaptchaStatusMessage('Verification passed. Requesting email code...');
    setShowRobotCheck(false);
    setLoading(true);

    try {
      // Captcha passed — now request the emailed OTP (server enforces the
      // check ran first). Retry once if the server-side check is still settling.
      let otpRes: LoginRequestOtpResponse | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          otpRes = await performLoginRequestOtp();
          break;
        } catch (requestError) {
          const message = requestError instanceof Error ? requestError.message : '';
          if (attempt === 0 && /still running|wait a moment|retry_after/i.test(message)) {
            await new Promise((resolve) => window.setTimeout(resolve, 600));
            continue;
          }
          throw requestError;
        }
      }
      if (!otpRes) {
        throw new Error('Could not send the verification code. Please try again.');
      }
      if (Number(otpRes?.data?.otp_required ?? 1) === 1) {
        enterOtpStep();
        return;
      }
      // Login OTP is switched off — finish login straight away.
      const loginData = await performLoginComplete();
      await completeSuccessfulLogin(loginData);
    } catch (err) {
      setCaptchaVerified(false);
      setCaptchaLoading(false);
      setRobotCheckError('Verification could not be completed. Please try again.');
      setShowRobotCheck(false);
      setLoading(false);
      handleLoginError(err);
    } finally {
      robotCheckFinishingRef.current = false;
    }
  }, [completeSuccessfulLogin, enterOtpStep, handleLoginError, performLoginComplete, performLoginRequestOtp]);

  const fetchRobotMathChallenge = useCallback(async () => {
    setRobotMathLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/auth.php?action=math_challenge`, {
        method: 'GET',
        credentials: 'include',
      });
      const data = await readJsonResponse<{
        success?: boolean;
        data?: { challenge_id?: string; image?: string; expires_in?: number };
        message?: string;
      }>(res, 'Could not load the verification image.');
      if (res.ok && data.success && data.data?.challenge_id && data.data?.image) {
        setRobotMathChallenge({
          id: String(data.data.challenge_id),
          image: String(data.data.image),
          expiresIn: Number(data.data.expires_in) || 120,
        });
        setRobotMathInput('');
        setRobotCheckError('');
      } else {
        setRobotCheckError('Could not load the verification image. Press New to retry.');
      }
    } catch {
      setRobotCheckError('Could not load the verification image. Press New to retry.');
    } finally {
      setRobotMathLoading(false);
    }
  }, [API_BASE_URL]);

  const verifyRobotMath = useCallback(async () => {
    const given = robotMathInput.trim();
    if (!given) {
      setRobotCheckError('Please answer the math image to continue.');
      return;
    }
    if (!robotMathChallenge) {
      setRobotCheckError('Verification image is still loading. Press New to retry.');
      return;
    }
    setRobotMathVerifying(true);
    setRobotCheckError('');
    try {
      const res = await fetch(`${API_BASE_URL}/auth.php?action=math_verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ challenge_id: robotMathChallenge.id, answer: given }),
      });
      const data = await readJsonResponse<{ success?: boolean; message?: string; errors?: { code?: string } }>(
        res,
        'Math verification failed.'
      );
      if (!res.ok || !data.success) {
        // Expired images refresh silently with no warning.
        if (data.errors?.code === 'captcha_expired') {
          setRobotCheckError('');
          void fetchRobotMathChallenge();
          return;
        }
        setRobotCheckError(String(data.message || 'Incorrect answer. A new image was generated — try again.'));
        void fetchRobotMathChallenge();
        return;
      }
      // Solved on the server — proceed to the OTP step.
      await finishRobotVerification();
    } catch {
      setRobotCheckError('Could not verify the answer. A new image was generated — try again.');
      void fetchRobotMathChallenge();
    } finally {
      setRobotMathVerifying(false);
    }
  }, [API_BASE_URL, finishRobotVerification, fetchRobotMathChallenge, robotMathChallenge, robotMathInput]);

  const closeRobotCheck = useCallback(() => {
    if (robotMathVerifying) return;

    setShowRobotCheck(false);
    setRobotCheckError('');
    setCaptchaLoading(false);
    setLoading(false);
    setCaptchaStatusMessage('Verification cancelled. You may try again.');
    setCaptchaTimerText('Protected');
  }, [robotMathVerifying]);

  const isCooldownActive = cooldownSeconds > 0;
  // Do not disable submission solely from the anonymous browser check. The
  // server must inspect the entered account because administrators are exempt
  // from browser lockout; disabling here prevented them from even attempting
  // to sign in from a browser previously flagged by another account.
  const isFormDisabled = loading || isCooldownActive || otpStep;
  const loginIdentifier = email.trim();
  const emailFormatInvalid = emailTouched
    && loginIdentifier.includes('@')
    && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(loginIdentifier);
  // Keep the submit button available at all times. Validation and security
  // checks run in handleLogin, where the user receives a useful message
  // instead of being left with an unexplained disabled control.
  const loginButtonBlocked = false;

  // OTP resend cooldown ticker.
  useEffect(() => {
    if (otpResendIn <= 0) return;
    const t = window.setTimeout(() => {
      setOtpResendIn((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearTimeout(t);
  }, [otpResendIn]);

  const showRobotCheckStep = useCallback(() => {
    setLoading(false);
    setShowRobotCheck(true);
    setRobotMathInput('');
    setRobotCheckError('');
    setCaptchaLoading(false);
    setCaptchaTimerText('Verification needed');
    setCaptchaStatusMessage('Please answer the math image to continue login.');
    void fetchRobotMathChallenge();
  }, [fetchRobotMathChallenge]);

  const finishLoginViaComplete = useCallback(async (autoCheckDelayMs: number) => {
    const safeDelay = Math.max(0, Math.min(5000, Number(autoCheckDelayMs ?? 0)));
    setCaptchaLoading(true);
    setCaptchaTimerText('Checking...');
    setCaptchaStatusMessage('Running server-side security checks...');

    await new Promise((resolve) => {
      window.setTimeout(resolve, safeDelay);
    });

    setCaptchaVerified(true);
    setCaptchaTimerText('Verified');
    setCaptchaStatusMessage('Security check passed. Finishing login...');
    setCaptchaLoading(false);

    let loginData: LoginResponse | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        loginData = await performLoginComplete();
        break;
      } catch (completeError) {
        const message = completeError instanceof Error ? completeError.message : '';
        if (attempt === 0 && /still running|wait a moment|retry_after/i.test(message)) {
          await new Promise((resolve) => window.setTimeout(resolve, 500));
          continue;
        }
        throw completeError;
      }
    }

    if (!loginData) {
      throw new Error('Login could not be completed. Please try again.');
    }

    await completeSuccessfulLogin(loginData);
  }, [completeSuccessfulLogin, performLoginComplete]);

  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setError(null);
    setEmailError(null);
    setPasswordError(null);
    setCredentialError(null);
    setSuccess(null);

    if (!email.trim() && !password) {
      setEmailError('Please enter your email or username.');
      setPasswordError('Please enter your password.');
      return;
    }

    if (!email.trim()) {
      setEmailError('Please enter your email or username.');
      return;
    }

    if (!password) {
      setPasswordError('Please enter your password.');
      return;
    }

    const identifier = email.trim();
    const emailFormatValid = !identifier.includes('@') || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
    if (!emailFormatValid) {
      setEmailError('Your email is not valid');
      return;
    }

    if (!captchaSettingsReady) {
      setError('Security settings are still loading. Please wait a moment.');
      return;
    }

    if (isCooldownActive) {
      setError(`Please wait ${cooldownSeconds}s before trying again.`);
      return;
    }

    setLoading(true);

    try {
      setCaptchaVerified(false);
      setCaptchaStatusMessage('');

      let precheck: LoginPrecheckResponse;
      try {
        precheck = await performLoginPrecheck();
      } catch (precheckError) {
        console.warn('Precheck failed:', precheckError);
        throw precheckError;
      }

      // Captcha comes before OTP: run the verification check first, then
      // request the emailed code.
      if (precheck.data?.captcha_required) {
        showRobotCheckStep();
        return;
      }

      const autoCheckDelayMs = Math.max(0, Math.min(5000, Number(precheck.data?.auto_check_delay_ms ?? 0)));
      setCaptchaLoading(true);
      setCaptchaTimerText('Checking...');
      setCaptchaStatusMessage('Running server-side security checks...');

      await new Promise((resolve) => {
        window.setTimeout(resolve, autoCheckDelayMs);
      });

      setCaptchaStatusMessage('Requesting email code...');
      const otpRes = await performLoginRequestOtp();
      if (Number(otpRes?.data?.otp_required ?? 1) === 1) {
        enterOtpStep();
        return;
      }
      // Login OTP is switched off — finish login straight away.
      await finishLoginViaComplete(0);
    } catch (err) {
      setCaptchaLoading(false);
      handleLoginError(err);
      setLoading(false);
    }
  };

  const backToLoginForm = useCallback(() => {
    resetOtpStep();
    setLoading(false);
    setCaptchaLoading(false);
    setCaptchaStatusMessage('');
  }, [resetOtpStep]);

  const handleOtpVerify = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const code = otpCode.replace(/\D/g, '');
    if (code.length !== 6) {
      setOtpError('Enter the 6-digit code sent to your email.');
      return;
    }

    setOtpError(null);
    setOtpLoading(true);

    try {
      await performLoginVerifyOtp(code);
      resetOtpStep();

      // Captcha already passed before the code was issued — finish login.
      setLoading(true);
      await finishLoginViaComplete(0);
    } catch (err) {
      if (err instanceof LoginRequestError) {
        // Expired/locked sessions can't continue — send the user back to login.
        if (/expired|too many|locked|session/i.test(err.message)) {
          resetOtpStep();
          setPassword('');
          setError(err.message);
          setLoading(false);
          return;
        }
        if (typeof err.attemptsRemaining === 'number' && err.attemptsRemaining > 0) {
          const label = err.attemptsRemaining === 1 ? 'attempt' : 'attempts';
          setOtpError(`Incorrect code. ${err.attemptsRemaining} ${label} remaining.`);
        } else {
          setOtpError(err.message || 'Incorrect verification code.');
        }
        setOtpLoading(false);
        return;
      }
      setOtpError(err instanceof Error ? err.message : 'Could not verify the code.');
      setOtpLoading(false);
    }
  };

  const handleOtpResend = async () => {
    if (otpResendIn > 0 || otpLoading) return;
    setOtpError(null);
    setOtpLoading(true);

    try {
      await performLoginRequestOtp();
      setOtpResendIn(OTP_RESEND_SECONDS);
    } catch (err) {
      if (err instanceof LoginRequestError && typeof err.retryAfterSeconds === 'number' && err.retryAfterSeconds > 0) {
        const secs = Math.max(1, Math.trunc(err.retryAfterSeconds));
        setOtpResendIn(secs);
        setOtpError(`Please wait ${secs} seconds before requesting a new code.`);
      } else if (err instanceof LoginRequestError && /expired|too many|locked|session|already verified/i.test(err.message)) {
        if (/already verified/i.test(err.message)) {
          setOtpError(err.message);
        } else {
          resetOtpStep();
          setPassword('');
          setError(err instanceof Error ? err.message : 'Could not resend the code.');
          setLoading(false);
        }
      } else {
        setOtpError(err instanceof Error ? err.message : 'Could not resend the code.');
      }
    } finally {
      setOtpLoading(false);
    }
  };

  return (
    <div className="login-page" style={{ position: 'fixed', inset: 0 }}>
      <Head>
        <title>{loginTitleLines.join(' ')}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="description" content="Secure client and employee portal for Lope Laranjo Bato & Co., CPAs, providing access to accounting, assurance, and advisory services." />
        <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1,max-video-preview:-1" />
        <link rel="canonical" href="https://llb-accountant.vercel.app/" />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Lope Laranjo Bato & Co., CPAs" />
        <meta property="og:title" content="Lope Laranjo Bato & Co., CPAs" />
        <meta property="og:description" content="Secure client and employee portal for accounting, assurance, and advisory services." />
        <meta property="og:url" content="https://llb-accountant.vercel.app/" />
        <meta property="og:image" content="https://llb-accountant.vercel.app/logo.png" />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Lope Laranjo Bato & Co., CPAs" />
        <meta name="twitter:description" content="Secure client and employee portal for accounting, assurance, and advisory services." />
        <meta name="twitter:image" content="https://llb-accountant.vercel.app/logo.png" />
        <style>{`
          html, body, #__next {
            height: 100%;
            margin: 0;
            padding: 0;
          }
          .grecaptcha-badge,
          iframe[src*="recaptcha"],
          iframe[title*="reCAPTCHA"],
          iframe[title*="recaptcha"],
          div[aria-label*="reCAPTCHA"],
          div[aria-label*="recaptcha"] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
          }
          @keyframes slideInUp {
            from { opacity: 0; transform: translate(-50%, calc(-50% + 20px)); }
            to { opacity: 1; transform: translate(-50%, -50%); }
          }
          .robot-check-loader {
            width: var(--robot-loader-size, 50px);
            aspect-ratio: 1;
            display: grid;
            animation: l14 4s infinite linear;
            transform-origin: 50% 50%;
            will-change: transform;
          }
          .robot-check-loader::before,
          .robot-check-loader::after {
            content: "";
            grid-area: 1 / 1;
            border: var(--robot-loader-border, 8px) solid;
            border-radius: 50%;
            border-color: red red #0000 #0000;
            mix-blend-mode: darken;
            animation: l14 1s infinite linear;
            transform-origin: 50% 50%;
            will-change: transform;
          }
          .robot-check-loader::after {
            border-color: #0000 #0000 blue blue;
            animation-direction: reverse;
          }
          @keyframes l14 {
            100% { transform: rotate(1turn); }
          }
          @keyframes fadeIn {
            from { opacity: 0; }
            to { opacity: 1; }
          }
          @keyframes pwdFloatIn {
            from { opacity: 0; transform: translateY(-4px) scale(0.98); }
            to { opacity: 1; transform: translateY(0) scale(1); }
          }
          @keyframes paperUnfold {
            0% { transform: rotateX(-86deg); opacity: 0; }
            55% { transform: rotateX(14deg); opacity: 1; }
            80% { transform: rotateX(-5deg); }
            100% { transform: rotateX(0deg); opacity: 1; }
          }
          @keyframes paperFold {
            0% { transform: rotateX(0deg); opacity: 1; }
            28% { transform: rotateX(16deg); opacity: 1; }
            100% { transform: rotateX(-88deg); opacity: 0; }
          }
          @keyframes checkmarkPop {
            0% {
              transform: scale(0);
              opacity: 0;
            }
            50% {
              transform: scale(1.1);
              opacity: 1;
            }
            100% {
              transform: scale(1);
              opacity: 1;
            }
          }
          @keyframes checkmarkDraw {
            0% {
              stroke-dasharray: 0, 100;
              stroke-dashoffset: 0;
            }
            100% {
              stroke-dasharray: 100, 100;
              stroke-dashoffset: 0;
            }
          }
          @keyframes loginSuccessBannerIn {
            0%   { opacity: 0; transform: translate(-50%, -50%) scale(0.88); }
            60%  { opacity: 1; transform: translate(-50%, -50%) scale(1.03); }
            100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
          @keyframes unauthorizedSlideIn {
            from { opacity: 0; transform: translate(-50%, -40%) scale(0.92); }
            to   { opacity: 1; transform: translate(-50%, -50%) scale(1); }
          }
          @keyframes unauthorizedSlideOut {
            from { opacity: 1; transform: translate(-50%, -50%) scale(1); }
            to   { opacity: 0; transform: translate(-50%, -60%) scale(0.94); }
          }
          @keyframes warningPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.5); }
            50% { box-shadow: 0 0 0 16px rgba(239,68,68,0); }
          }
          .go-website-btn {
            transition: background 0.2s ease, border-color 0.2s ease, transform 0.2s ease, box-shadow 0.2s ease;
          }
          .go-website-btn:hover {
            background: rgba(240, 160, 58, 0.18) !important;
            border-color: rgba(240, 160, 58, 0.75) !important;
            transform: translateY(-1px);
            box-shadow: 0 8px 20px rgba(2, 10, 22, 0.35);
          }
          .go-website-btn:focus-visible {
            outline: 2px solid #f0a03a;
            outline-offset: 2px;
          }
          @media (max-width: 820px) {
            .login-page { position: absolute !important; overflow-x: hidden !important; overflow-y: auto !important; }
            .split-wrap { flex-direction: column !important; height: auto !important; min-height: 100vh !important; }
            .left-pane { width: 100% !important; min-width: 0 !important; box-sizing: border-box !important; clip-path: none !important; min-height: auto !important; height: auto !important; padding: 76px 20px 30px !important; }
            .go-website-btn { top: 12px !important; left: 12px !important; padding: 7px 12px !important; font-size: 11px !important; }
            .right-pane { width: 100% !important; min-width: 0 !important; box-sizing: border-box !important; position: relative !important; right: auto !important; top: auto !important; transform: none !important; justify-content: center !important; max-height: none !important; overflow: visible !important; padding: 20px !important; margin: 0 auto 24px !important; }
            .bottom-icons-wrap { position: relative !important; left: auto !important; bottom: auto !important; margin-top: 24px !important; flex-direction: column !important; align-items: flex-start !important; }
            .feature-item + .feature-item { padding-left: 0 !important; border-left: none !important; }
          }
        `}</style>
      </Head>

      {/* Logo-matched blue background */}
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: `
            radial-gradient(circle at 18% 22%, rgba(255, 255, 255, 0.05), transparent 40%),
            radial-gradient(circle at 85% 85%, rgba(3, 15, 30, 0.55), transparent 52%),
            linear-gradient(135deg, #071c33 0%, #0d3055 52%, #14456f 100%)`,
          zIndex: -2,
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          background: `
            radial-gradient(circle at 72% 24%, rgba(255, 255, 255, 0.05), transparent 24%),
            radial-gradient(circle at 22% 78%, rgba(231, 132, 39, 0.05), transparent 30%),
            linear-gradient(180deg, rgba(2, 10, 22, 0.20) 0%, rgba(2, 10, 22, 0.38) 100%)`,
          pointerEvents: 'none',
          zIndex: -1,
        }}
      />

      {/* Gold analytics line-art spanning the full page — flows under the login card */}
      <svg
        aria-hidden
        viewBox="0 0 1440 800"
        preserveAspectRatio="xMidYMax slice"
        style={{
          position: 'fixed',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 0,
          opacity: 0.42,
        }}
      >
        <defs>
          <linearGradient id="llbGoldLine" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.14" />
            <stop offset="45%" stopColor="#ffffff" stopOpacity="0.38" />
            <stop offset="100%" stopColor="#f0a03a" stopOpacity="0.58" />
          </linearGradient>
          <linearGradient id="llbBarFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0.03" />
          </linearGradient>
        </defs>

        {/* Flowing curves across the full page */}
        <path d="M-40 760 C 220 690, 420 790, 660 715 S 1080 600, 1480 655" stroke="url(#llbGoldLine)" strokeWidth="1.2" fill="none" />
        <path d="M-40 700 C 200 630, 440 730, 700 655 S 1120 540, 1480 595" stroke="url(#llbGoldLine)" strokeWidth="1" fill="none" opacity="0.7" />
        <path d="M-40 645 C 190 580, 460 670, 740 590 S 1140 480, 1480 535" stroke="url(#llbGoldLine)" strokeWidth="0.8" fill="none" opacity="0.45" />

        {/* Rising analytics line chart with nodes — extends beyond the form */}
        <polyline
          points="60,640 170,600 265,618 380,520 470,545 590,430 700,455 820,320 930,365 1040,255 1160,300 1290,185 1400,225"
          fill="none"
          stroke="url(#llbGoldLine)"
          strokeWidth="1.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {[[60, 640], [170, 600], [265, 618], [380, 520], [470, 545], [590, 430], [700, 455], [820, 320], [930, 365], [1040, 255], [1160, 300], [1290, 185], [1400, 225]].map(([x, y]) => (
          <g key={`node-${x}-${y}`}>
            <circle cx={x} cy={y} r="7" fill="#ffffff" opacity="0.14" />
            <circle cx={x} cy={y} r="3" fill="#f0a03a" opacity="0.95" />
          </g>
        ))}

        {/* Faint bar chart silhouette across the base */}
        {[120, 180, 240, 300, 360, 420, 480, 540, 600, 660, 720, 780, 840, 900, 960, 1020, 1080, 1140, 1200, 1260].map((x, i) => {
          const h = 46 + ((i * 37) % 130);
          return <rect key={`bar-${x}`} x={x} y={800 - h - 60} width="34" height={h} rx="3" fill="url(#llbBarFill)" />;
        })}
      </svg>



      <div className="split-wrap" style={{ display: 'flex', width: '100%', height: '100vh', justifyContent: 'flex-start', alignItems: 'stretch', position: 'relative', zIndex: 1 }}>

        {/* Left panel */}
        <div
          className="left-pane"
          style={{
            width: '58%',
            minWidth: 320,
            height: '100%',
            padding: '40px 50px 40px 60px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            textAlign: 'center',
            position: 'relative',
            zIndex: 2,
          }}
        >
          <div className={styles.brandPanel}>
            <div className={styles.companyName}>
              Lope Laranjo Bato &amp; Co., CPAs
            </div>

            <div className={styles.brandStatement}>
              Certified Public Accountant
            </div>
          </div>
        </div>

        {/* Right form pane */}
        <div className="right-pane" style={{ width: '42%', minWidth: 300, display: 'flex', alignItems: 'center', justifyContent: 'flex-start', padding: '16px 16px 16px 60px', position: 'relative', zIndex: 3, maxHeight: '100vh', overflowY: 'auto' }}>
          <div className={styles.flipShell} style={{ width: '100%', maxWidth: 340 }}>
            <div className={styles.flipCard}>
              <div className={[styles.flipFace, styles.flipFront].join(' ')}>
                  <div
                    ref={loginCardRef}
                  style={{
                    width: '100%',
                    maxWidth: 400,
                    position: 'relative',
                    overflow: 'visible',
                    padding: '20px 24px 18px',
                    border: '1px solid rgba(240, 160, 58, 0.55)',
                    borderRadius: 16,
                    background: 'linear-gradient(160deg, rgba(12, 32, 56, 0.92) 0%, rgba(8, 22, 40, 0.94) 100%)',
                    backdropFilter: 'blur(14px) saturate(140%)',
                    WebkitBackdropFilter: 'blur(14px) saturate(140%)',
                    boxShadow: 'none',
                  }}
                >
                  {/* Company logo — logo-blue tint */}
                  <div style={{ textAlign: 'center', marginBottom: 8, display: 'flex', justifyContent: 'center' }}>
                    <div
                      style={{
                        width: 60,
                        height: 60,
                        borderRadius: '50%',
                        border: '1px solid rgba(255,255,255,0.12)',
                        background: 'radial-gradient(circle at 50% 32%, rgba(255,255,255,0.10), rgba(255,255,255,0.015) 72%)',
                        boxShadow: '0 8px 22px rgba(0,0,0,0.22)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        overflow: 'hidden',
                        padding: 6,
                      }}
                    >
                      <Image
                        src={`${assetBasePath}/logo-ui.webp`}
                        alt="LLB Logo"
                        width={48}
                        height={48}
                        priority
                        unoptimized
                        style={{ width: 48, height: 48, objectFit: 'contain', filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.25))' }}
                      />
                    </div>
                  </div>

                  <div style={{
                    fontFamily: 'Georgia, "Times New Roman", serif',
                    textAlign: 'center',
                    fontSize: 21,
                    textTransform: 'none',
                    color: '#f8f9fa',
                    marginBottom: 4,
                    letterSpacing: 0.5,
                    fontWeight: 600,
                  }}>
                    Welcome Back!
                  </div>





                  {otpStep ? (
                  <form className="system-form-compact" onSubmit={handleOtpVerify} noValidate>
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 13, color: '#e2e8f0', lineHeight: 1.6, marginBottom: 4, textAlign: 'center' }}>
                        We sent a 6-digit code to<br />
                        <strong style={{ color: '#ffffff' }}>{email.trim()}</strong>
                      </div>
                      <div style={{ fontSize: 11.5, color: '#94a3b8', textAlign: 'center', marginBottom: 12 }}>
                        Enter it below to continue. The code expires in 10 minutes.
                      </div>
                      <label style={{ display: 'block', fontSize: 12, color: '#e2e8f0', marginBottom: 6, fontWeight: 500 }} htmlFor="otpCode">
                        Verification code
                      </label>
                        <OtpInput
                        id="otpCode"
                        value={otpCode}
                        onChange={(next) => {
                          setOtpCode(next.replace(/\D/g, '').slice(0, 6));
                          if (otpError) setOtpError(null);
                        }}
                        length={6}
                        mode="numeric"
                        disabled={otpLoading}
                        autoFocus
                        ariaLabel="Verification code"
                        containerStyle={{ justifyContent: 'center' }}
                        inputStyle={{
                          width: 44,
                          height: 48,
                          borderRadius: 12,
                          border: otpError ? '1px solid rgba(239,68,68,0.7)' : '1px solid rgba(35, 102, 162, 0.18)',
                          background: '#f8fafe',
                          color: '#000000',
                          fontSize: 20,
                          fontFamily: 'monospace',
                        }}
                      />
                      {otpError && (
                        <p style={{ margin: '4px 0 0 4px', fontSize: 11.5, color: '#f87171', lineHeight: 1.4 }}>
                          {otpError}
                        </p>
                      )}
                    </div>

                    <button
                      type="submit"
                      disabled={otpLoading || otpCode.replace(/\D/g, '').length !== 6}
                      style={{
                        width: '100%',
                        height: 44,
                        border: '1px solid rgba(255,255,255,0.88)',
                        borderRadius: 12,
                        background: 'linear-gradient(135deg, #3aa0e6 0%, #1e6aa8 55%, #174a82 100%)',
                        color: '#ffffff',
                        fontSize: 14,
                        fontWeight: 800,
                        letterSpacing: 2,
                        textTransform: 'uppercase',
                        cursor: otpLoading || otpCode.replace(/\D/g, '').length !== 6 ? 'not-allowed' : 'pointer',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.28), 0 3px 10px rgba(17,56,98,0.35), inset 0 1px 0 rgba(255,255,255,0.28)',
                        opacity: otpLoading || otpCode.replace(/\D/g, '').length !== 6 ? 0.6 : 1,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      {otpLoading ? 'VERIFYING...' : 'VERIFY CODE'}
                    </button>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14, gap: 10 }}>
                      <button
                        type="button"
                        onClick={() => { void handleOtpResend(); }}
                        disabled={otpLoading || otpResendIn > 0}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: otpResendIn > 0 || otpLoading ? '#64748b' : '#f0a03a',
                          fontSize: 12,
                          cursor: otpResendIn > 0 || otpLoading ? 'not-allowed' : 'pointer',
                          textDecorationLine: 'underline',
                          textDecorationStyle: 'solid',
                          textDecorationColor: 'rgba(240, 160, 58, 0.45)',
                          padding: 0,
                          fontWeight: 500,
                        }}
                      >
                        {otpResendIn > 0 ? `Resend code in ${otpResendIn}s` : 'Resend code'}
                      </button>
                      <button
                        type="button"
                        onClick={backToLoginForm}
                        disabled={otpLoading}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#e2e8f0',
                          fontSize: 12,
                          cursor: otpLoading ? 'not-allowed' : 'pointer',
                          textDecoration: 'underline',
                          padding: 0,
                          fontWeight: 500,
                        }}
                      >
                        ← Back to login
                      </button>
                    </div>
                  </form>
                  ) : (
                  <form className="system-form-compact" onSubmit={handleLogin} noValidate>
                    {/* Login identifier field */}
                    <div style={{ marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 12, color: '#e2e8f0', marginBottom: 5, fontWeight: 500 }} htmlFor="email">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }}>
                          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                          <circle cx="12" cy="7" r="4" />
                        </svg>
                        Email or username
                      </label>
                      <div style={{ position: 'relative' }}>
                        <input
                          type="text"
                          id="email"
                          value={email}
                          onChange={(e) => {
                            setEmail(e.target.value);
                            if (emailError) setEmailError(null);
                            if (credentialError) setCredentialError(null);
                          }}
                          placeholder="Enter your email or username"
                          disabled={isFormDisabled}
                          required
                          aria-required="true"
                          aria-invalid={emailError ? true : undefined}
                          style={{
                            width: '100%',
                            height: 40,
                            borderRadius: 12,
                            border: (emailError || emailFormatInvalid) ? '1px solid rgba(239,68,68,0.7)' : '1px solid rgba(35, 102, 162, 0.18)',
                            background: '#f8fafe',
                            color: '#000000',
                            padding: '0 16px',
                            outline: 'none',
                            fontSize: 13.5,
                            boxSizing: 'border-box',
                            transition: 'all 0.2s ease',
                          }}
                          onFocus={(e) => {
                            e.target.style.borderColor = 'rgba(35, 102, 162, 0.45)';
                            e.target.style.background = '#ffffff';
                            (e.target.style as unknown as Record<string,string>).boxShadow = '0 0 0 3px rgba(35, 102, 162, 0.13)';
                          }}
                          onBlur={(e) => {
                            setEmailTouched(true);
                            e.target.style.borderColor = (emailError || emailFormatInvalid) ? 'rgba(239,68,68,0.7)' : 'rgba(35, 102, 162, 0.18)';
                            e.target.style.background = '#f8fafe';
                            (e.target.style as unknown as Record<string,string>).boxShadow = 'none';
                          }}
                        />
                        {(emailError || emailFormatInvalid) && (
                          <p style={{ margin: '4px 0 0 4px', fontSize: 11.5, color: '#f87171', lineHeight: 1.4 }}>
                            {emailError || 'Your email is not valid'}
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Password Field */}
                    <div style={{ position: 'relative', marginBottom: 10 }}>
                      <label style={{ display: 'block', fontSize: 12, color: '#e2e8f0', marginBottom: 5, fontWeight: 500 }} htmlFor="password">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }}>
                          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                        </svg>
                        Password
                      </label>
                      <div style={{ position: 'relative', width: '100%', height: 40 }}>
                        <input
                          type={showPassword ? 'text' : 'password'}
                          id="password"
                          value={password}
                          onChange={(e) => {
                            setPassword(e.target.value);
                            if (passwordError) setPasswordError(null);
                            if (credentialError) setCredentialError(null);
                          }}
                          placeholder="Enter your password"
                          disabled={isFormDisabled}
                          required
                          aria-required="true"
                          aria-invalid={passwordError ? true : undefined}
                          style={{
                            width: '100%',
                            height: '100%',
                            borderRadius: 12,
                            border: passwordError ? '1px solid rgba(239,68,68,0.7)' : '1px solid rgba(35, 102, 162, 0.18)',
                            background: '#f8fafe',
                            color: '#000000',
                            padding: '0 44px 0 16px',
                            outline: 'none',
                            fontSize: 13.5,
                            boxSizing: 'border-box',
                            transition: 'all 0.2s ease',
                            lineHeight: '40px',
                          }}
                          onFocus={(e) => {
                            e.target.style.borderColor = 'rgba(35, 102, 162, 0.45)';
                            e.target.style.background = '#ffffff';
                            (e.target.style as unknown as Record<string,string>).boxShadow = '0 0 0 3px rgba(35, 102, 162, 0.13)';
                          }}
                          onBlur={(e) => {
                            e.target.style.borderColor = passwordError ? 'rgba(239,68,68,0.7)' : 'rgba(35, 102, 162, 0.18)';
                            e.target.style.background = '#f8fafe';
                            (e.target.style as unknown as Record<string,string>).boxShadow = 'none';
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword((p) => !p)}
                          aria-label={showPassword ? 'Hide password' : 'Show password'}
                          title={showPassword ? 'Hide password' : 'Show password'}
                          disabled={isFormDisabled}
                          style={{
                            position: 'absolute',
                            top: 0,
                            right: 0,
                            bottom: 0,
                            width: 44,
                            margin: 0,
                            padding: 0,
                            border: 'none',
                            background: 'transparent',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            cursor: isFormDisabled ? 'not-allowed' : 'pointer',
                            opacity: isFormDisabled ? 0.5 : 0.85,
                            color: '#94a3b8',
                            lineHeight: 0,
                            zIndex: 2,
                          }}
                        >
                          {showPassword ? (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
                              <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.11 1 12c.74-1.64 1.82-3.1 3.17-4.28" />
                              <path d="M22.54 11.88A10.94 10.94 0 0 0 12 4c-1.61 0-3.13.31-4.5.86" />
                              <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
                              <line x1="1" y1="1" x2="23" y2="23" />
                            </svg>
                          ) : (
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ display: 'block' }}>
                              <path d="M1.5 12s4-7 10.5-7 10.5 7 10.5 7-4 7-10.5 7S1.5 12 1.5 12z" />
                              <circle cx="12" cy="12" r="3" />
                            </svg>
                          )}
                        </button>
                      </div>
                      {passwordError && (
                        <p style={{ margin: '4px 0 0 4px', fontSize: 11.5, color: '#f87171', lineHeight: 1.4 }}>
                          {passwordError}
                        </p>
                      )}
                    </div>

                    {/* Remember me + Forgot password */}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '10px 0 12px', gap: 10 }}>
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 7, color: '#e2e8f0', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}>
                          <input
                            type="checkbox"
                            checked={remember}
                            disabled={isFormDisabled}
                            onChange={(e) => {
                              const v = e.target.checked;
                              setRemember(v);
                              if (v) {
                                setRememberPulse(true);
                                setTimeout(() => setRememberPulse(false), 500);
                              }
                            }}
                            style={{ width: 15, height: 15, accentColor: '#2166a5', cursor: 'pointer' }}
                          />
                          Remember me
                        </label>
                        <span
                          aria-hidden="true"
                          style={{
                            position: 'absolute',
                            left: '110%',
                            marginLeft: 8,
                            padding: '3px 10px',
                            borderRadius: 999,
                            fontSize: 10,
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: '#10b981',
                            border: '1px solid rgba(16, 185, 129, 0.3)',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                            opacity: rememberPulse ? 1 : 0,
                            transform: rememberPulse ? 'translateY(0) scale(1)' : 'translateY(-6px) scale(0.95)',
                            transition: 'opacity 200ms ease, transform 200ms ease',
                            pointerEvents: 'none',
                            fontWeight: 600,
                          }}
                        >
                          Saved
                        </span>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          const e = (email || '').trim();
                          if (!e) {
                            setEmailError('Enter your email first.');
                            return;
                          }
                          setError(null);
                          setEmailError(null);
                          setPasswordError(null);
                          setSuccess(null);
                          router.push(`/forgot-password?email=${encodeURIComponent(e)}`);
                        }}
                        disabled={isFormDisabled}
                        style={{
                          background: 'transparent',
                          border: 'none',
                          color: '#f0a03a',
                          fontSize: 12,
                          cursor: isFormDisabled ? 'not-allowed' : 'pointer',
                          textDecorationLine: 'underline',
                          textDecorationStyle: 'solid',
                          textDecorationColor: 'rgba(240, 160, 58, 0.45)',
                          padding: 0,
                          fontWeight: 500,
                          transition: 'color 0.2s ease',
                        }}
                        onMouseEnter={(e) => {
                          if (!isFormDisabled) {
                            e.currentTarget.style.color = '#ffd8a0';
                          }
                        }}
                        onMouseLeave={(e) => {
                          if (!isFormDisabled) {
                            e.currentTarget.style.color = '#f0a03a';
                          }
                        }}
                      >
                        Forgot password?
                      </button>
                    </div>

                    {/* Plain credential label: one generic message, never pinned
                        to a field, so login failures reveal nothing about
                        which half was wrong. */}
                    {credentialError && (
                      <p role="alert" style={{ margin: '0 0 12px 0', fontSize: 12.5, color: '#f87171', lineHeight: 1.5, textAlign: 'center' }}>
                        {credentialError}
                      </p>
                    )}

                    {/* Login button */}
                    <button
                      type="submit"
                      data-login-button="true"
                      disabled={loginButtonBlocked}
                      style={{
                        width: '100%',
                        height: 42,
                        border: '1px solid rgba(255,255,255,0.88)',
                        borderRadius: 12,
                        background: 'linear-gradient(135deg, #3aa0e6 0%, #1e6aa8 55%, #174a82 100%)',
                        color: '#ffffff',
                        fontSize: 14,
                        fontWeight: 800,
                        letterSpacing: 2,
                        textTransform: 'uppercase',
                        cursor: loginButtonBlocked ? 'not-allowed' : 'pointer',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.28), 0 3px 10px rgba(17,56,98,0.35), inset 0 1px 0 rgba(255,255,255,0.28)',
                        opacity: loginButtonBlocked ? 0.6 : 1,
                        transition: 'all 0.2s ease',
                      }}
                      onMouseEnter={(e) => {
                        if (!loginButtonBlocked) {
                          e.currentTarget.style.background = 'linear-gradient(135deg, #4ab0f0 0%, #2577ba 55%, #1e5a90 100%)';
                          e.currentTarget.style.transform = 'translateY(-1px)';
                          e.currentTarget.style.boxShadow = '0 10px 28px rgba(0,0,0,0.32), 0 4px 12px rgba(17,56,98,0.40), inset 0 1px 0 rgba(255,255,255,0.32)';
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!loginButtonBlocked) {
                          e.currentTarget.style.background = 'linear-gradient(135deg, #3aa0e6 0%, #1e6aa8 55%, #174a82 100%)';
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = '0 8px 24px rgba(0,0,0,0.28), 0 3px 10px rgba(17,56,98,0.35), inset 0 1px 0 rgba(255,255,255,0.28)';
                        }
                      }}
                    >
                      {loading ? 'LOGGING IN...' : isCooldownActive ? `WAIT ${cooldownSeconds}S` : 'LOG IN'}
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ display: 'inline-block', marginLeft: 8, verticalAlign: 'middle', opacity: isCooldownActive ? 0.5 : 1 }}>
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                    {isCooldownActive && (
                      <div style={{ marginTop: 10, padding: '9px 10px', borderRadius: 10, background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.30)', color: '#fecaca', fontSize: 12, textAlign: 'center', lineHeight: 1.4 }}>
                        Too many request, please try again after {cooldownSeconds} seconds.
                      </div>
                    )}
                  </form>
                  )}



                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showRobotCheck && (
        <div
          className="robot-check-floating"
          role="dialog"
          aria-modal="true"
          aria-labelledby="robot-check-title"
          style={{
            position: 'fixed',
            left: loginCardCenter.left,
            top: loginCardCenter.top,
            transform: 'translate(-50%, -50%)',
            zIndex: 90,
            width: 'min(92vw, 330px)',
            animation: 'slideInUp 0.28s ease-out',
          }}
        >
          <div
            style={{
              position: 'relative',
              overflow: 'hidden',
              borderRadius: 22,
              border: '1px solid rgba(240, 160, 58, 0.30)',
              background:
                'radial-gradient(circle at 12% 12%, rgba(46, 126, 184, 0.14), transparent 32%), linear-gradient(145deg, rgba(18, 54, 95, 0.97), rgba(23, 73, 123, 0.96))',
              boxShadow: "none",
              color: '#e5edff',
              padding: 18,
            }}
          >
            <button
              type="button"
              aria-label="Close verification"
              title="Close verification"
              onClick={closeRobotCheck}
              disabled={robotMathVerifying}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                width: 28,
                height: 28,
                borderRadius: 999,
                border: '1px solid rgba(148, 163, 184, 0.26)',
                background: 'rgba(15, 23, 42, 0.54)',
                color: '#cbd5e1',
                cursor: robotMathVerifying ? 'not-allowed' : 'pointer',
              }}
            >
              ×
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingRight: 28 }}>
              <div
                aria-hidden="true"
                style={{
                  width: 42,
                  height: 42,
                  borderRadius: 16,
                  display: 'grid',
                  placeItems: 'center',
                  background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.22), rgba(240, 160, 58, 0.18))',
                  border: '1px solid rgba(147, 197, 253, 0.28)',
                }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f0a03a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                  <path d="m9 12 2 2 4-5" />
                </svg>
              </div>

              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h2 id="robot-check-title" style={{ margin: 0, fontSize: 14, fontWeight: 800, letterSpacing: '0.01em' }}>
                    Quick security check
                  </h2>
                  <span
                    style={{
                      borderRadius: 999,
                      padding: '2px 8px',
                      fontSize: 10,
                      fontWeight: 800,
                      color: captchaVerified ? '#bbf7d0' : captchaLoading ? '#bfdbfe' : '#fed7aa',
                      background: captchaVerified
                        ? 'rgba(34, 197, 94, 0.16)'
                        : captchaLoading
                          ? 'rgba(59, 130, 246, 0.18)'
                          : 'rgba(249, 115, 22, 0.15)',
                      border: `1px solid ${captchaVerified ? 'rgba(74, 222, 128, 0.28)' : captchaLoading ? 'rgba(96, 165, 250, 0.28)' : 'rgba(251, 146, 60, 0.28)'}`,
                    }}
                  >
                    {captchaTimerText}
                  </span>
                </div>
                <p style={{ margin: '4px 0 0', fontSize: 12, color: '#a9b8d7', lineHeight: 1.35 }}>
                  Please verify you&apos;re not a robot.
                </p>
              </div>
            </div>

            <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <div style={{ flex: 1.2, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#f8fafc', borderRadius: 12, minHeight: 48, padding: '4px 8px', userSelect: 'none' }}>
                {robotMathChallenge?.image ? (
                  <img
                    src={robotMathChallenge.image}
                    alt="Math captcha image: single-digit addition or subtraction"
                    draggable={false}
                    style={{ height: 40, width: 'auto', maxWidth: '100%', pointerEvents: 'none' }}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: '#64748b' }}>
                    {robotMathLoading ? 'Loading image…' : 'Press New to load the image.'}
                  </span>
                )}
              </div>
              <input
                type="number"
                value={robotMathInput}
                onChange={(e) => { setRobotMathInput(e.target.value); if (robotCheckError) setRobotCheckError(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void verifyRobotMath(); } }}
                placeholder="Answer"
                disabled={robotMathVerifying}
                aria-label="Math captcha answer"
                style={{ flex: 1, minWidth: 0, height: 48, borderRadius: 12, border: robotCheckError ? '1px solid rgba(239,68,68,0.7)' : '1px solid rgba(35, 102, 162, 0.25)', background: '#f8fafe', color: '#000', padding: '0 12px', outline: 'none', fontSize: 14, boxSizing: 'border-box' }}
              />
            </div>
            <div style={{ marginTop: 8, display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => void fetchRobotMathChallenge()}
                disabled={robotMathVerifying || robotMathLoading}
                title="New math image"
                aria-label="New math image"
                style={{ flex: 1, borderRadius: 12, border: '1px solid rgba(148, 163, 184, 0.30)', background: 'rgba(148, 163, 184, 0.14)', color: '#cbd5e1', fontWeight: 700, fontSize: 12, padding: '10px 0', cursor: robotMathVerifying || robotMathLoading ? 'not-allowed' : 'pointer' }}
              >
                ↻ New
              </button>
              <button
                type="button"
                onClick={() => void verifyRobotMath()}
                disabled={robotMathVerifying || !robotMathInput.trim()}
                title={!robotMathInput.trim() ? 'Enter the answer, then verify' : 'Verify security answer'}
                style={{ flex: 2, minWidth: 0, borderRadius: 12, border: (robotMathVerifying || !robotMathInput.trim()) ? '1.5px solid rgba(147, 197, 253, 0.95)' : '1.5px solid #f0a03a', background: (robotMathVerifying || !robotMathInput.trim()) ? 'rgba(15, 23, 42, 0.72)' : '#2563eb', color: (robotMathVerifying || !robotMathInput.trim()) ? '#e2e8f0' : '#ffffff', fontWeight: 800, fontSize: 13, padding: '10px 0', cursor: robotMathVerifying || !robotMathInput.trim() ? 'not-allowed' : 'pointer' }}
              >
                {robotMathVerifying ? 'Verifying…' : 'Verify & continue'}
              </button>
            </div>

            {robotCheckError && (
              <p style={{ margin: '10px 0 0', color: '#fca5a5', fontSize: 12, lineHeight: 1.35 }}>
                {robotCheckError}
              </p>
            )}

            {!robotCheckError && captchaStatusMessage && (
              <p style={{ margin: '10px 0 0', color: '#f0a03a', fontSize: 11, lineHeight: 1.35 }}>
                {captchaStatusMessage}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── "Unauthorized Access Detected" floating toast (shown just before blocking) ── */}
      {showUnauthorizedOverlay && (
        <div
          role="alert"
          aria-live="assertive"
          style={{
            position: 'fixed',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            zIndex: 200,
            width: 'min(92vw, 380px)',
            animation: unauthorizedOverlayExiting
              ? 'unauthorizedSlideOut 0.6s cubic-bezier(0.4,0,0.2,1) both'
              : 'unauthorizedSlideIn 0.35s cubic-bezier(0.2,0.85,0.25,1.08) both',
          }}
        >
          <div
            style={{
              background: 'linear-gradient(145deg, rgba(90,10,10,0.97), rgba(60,5,5,0.98))',
              border: '1.5px solid rgba(239,68,68,0.7)',
              borderRadius: 20,
              boxShadow: '0 32px 80px rgba(0,0,0,0.55), 0 0 0 4px rgba(239,68,68,0.18)',
              padding: '28px 28px 24px',
              textAlign: 'center',
              color: '#fff',
              animation: 'warningPulse 1.4s ease-in-out infinite',
            }}
          >
            {/* Red warning icon */}
            <div style={{
              width: 60, height: 60, borderRadius: '50%',
              background: 'rgba(239,68,68,0.20)',
              border: '2px solid rgba(239,68,68,0.60)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              margin: '0 auto 16px',
            }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>
            <div style={{ fontSize: 19, fontWeight: 800, letterSpacing: 0.5, color: '#fca5a5', marginBottom: 8 }}>
              Unauthorized Access Detected
            </div>
            <div style={{ fontSize: 13, color: '#fecaca', lineHeight: 1.55, marginBottom: 6 }}>
              Your browser has been flagged for repeated unauthorized login attempts.
            </div>
            <div style={{ fontSize: 12, color: '#f87171', fontWeight: 600, marginTop: 8 }}>
              This browser is being blocked from accessing the system.
            </div>
          </div>
        </div>
      )}

      {/* Browser lockout remains server-enforced after account identification. */}
      {browserBlocked && !showUnauthorizedOverlay && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 120,
            width: 'min(90vw, 360px)',
            padding: '12px 14px',
            borderRadius: 12,
            background: 'rgba(80,8,8,0.96)',
            border: '1px solid rgba(239,68,68,0.45)',
            boxShadow: '0 14px 36px rgba(0,0,0,0.38)',
            color: '#fecaca',
            fontSize: 12.5,
            lineHeight: 1.5,
            pointerEvents: 'none',
          }}
        >
          <strong style={{ color: '#fca5a5' }}>Browser security lock active.</strong>{' '}
          Administrators may still sign in. Other accounts must be unblocked by an administrator.
        </div>
      )}
    </div>
  );
}
