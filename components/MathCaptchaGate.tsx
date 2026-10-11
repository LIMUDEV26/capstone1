import { useCallback, useEffect, useRef, useState } from 'react';
import { getApiBaseUrl } from '@/utils/network';
import styles from '@/styles/MathCaptchaGate.module.css';

const DEFAULT_TIMER_SECONDS = 120;

type ServerMathChallenge = {
    id: string;
    image: string;
    expiresIn: number;
};

type MathCaptchaGateProps = {
    /** Called whenever the verified state changes. Gate the rest of the form on it. */
    onVerifiedChange: (verified: boolean) => void;
    /** Disables the inputs (e.g. while a request is in flight). */
    disabled?: boolean;
    /** Bump to force a fresh challenge (e.g. after a successful submit). */
    resetSignal?: number;
    /** Optional label shown above the challenge. Defaults to "Security check". */
    title?: string;
};

/**
 * Self-contained math-captcha gate backed by the server: the challenge is a
 * single-digit math IMAGE issued by the API and the answer is verified
 * server-side, so it cannot be bypassed from outside the frontend.
 */
export default function MathCaptchaGate({ onVerifiedChange, disabled = false, resetSignal = 0, title = 'Security check' }: MathCaptchaGateProps) {
    const [challenge, setChallenge] = useState<ServerMathChallenge | null>(null);
    const [loadingChallenge, setLoadingChallenge] = useState(false);
    const [answer, setAnswer] = useState('');
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [verified, setVerified] = useState(false);
    // Countdown per question, driven by Settings → Captcha Management →
    // Math Captcha Timer (seconds/minutes + on/off). Null = timer off.
    const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
    const timeoutRef = useRef(DEFAULT_TIMER_SECONDS);
    const timerOnRef = useRef(true);
    const answerInputRef = useRef<HTMLInputElement>(null);
    const onVerifiedChangeRef = useRef(onVerifiedChange);
    onVerifiedChangeRef.current = onVerifiedChange;

    const resetCountdown = useCallback(() => {
        setSecondsLeft(timerOnRef.current ? timeoutRef.current : null);
    }, []);

    const fetchChallenge = useCallback(async () => {
        setLoadingChallenge(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/auth.php?action=math_challenge`, {
                method: 'GET',
                credentials: 'include',
            });
            const data = await res.json() as {
                success?: boolean;
                data?: { challenge_id?: string; image?: string; expires_in?: number };
            };
            if (res.ok && data.success && data.data?.challenge_id && data.data?.image) {
                setChallenge({
                    id: String(data.data.challenge_id),
                    image: String(data.data.image),
                    expiresIn: Number(data.data.expires_in) || DEFAULT_TIMER_SECONDS,
                });
                setAnswer('');
                setError(null);
                setVerified(false);
                onVerifiedChangeRef.current(false);
                resetCountdown();
            } else {
                setError('Could not load the verification image. Press New to retry.');
            }
        } catch {
            setError('Could not load the verification image. Press New to retry.');
        } finally {
            setLoadingChallenge(false);
        }
    }, [resetCountdown]);

    const regenerate = useCallback(() => {
        void fetchChallenge();
    }, [fetchChallenge]);

    // Load the admin-configured timer once.
    useEffect(() => {
        let active = true;
        fetch(`${getApiBaseUrl()}/settings_api.php?action=public_login_captcha_settings`, { method: 'GET' })
            .then((res) => res.json())
            .then((data: { success?: boolean; data?: { math_captcha_timer_enabled?: boolean | number | string; math_captcha_timeout_seconds?: number } }) => {
                if (!active) return;
                const enabled = data?.data?.math_captcha_timer_enabled;
                const on = !(enabled === false || enabled === 0 || enabled === '0');
                const secs = Math.max(10, Math.min(3600, Math.trunc(Number(data?.data?.math_captcha_timeout_seconds ?? DEFAULT_TIMER_SECONDS)) || DEFAULT_TIMER_SECONDS));
                timerOnRef.current = on;
                timeoutRef.current = secs;
                setSecondsLeft(on ? secs : null);
            })
            .catch(() => {
                if (!active) return;
                setSecondsLeft(DEFAULT_TIMER_SECONDS);
            });
        return () => {
            active = false;
        };
    }, []);

    // Fresh server challenge on mount and whenever the parent bumps resetSignal.
    useEffect(() => {
        void fetchChallenge();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetSignal]);

    // Tick the countdown; expiry silently burns the image and fetches a
    // new one (no warning shown).
    useEffect(() => {
        if (secondsLeft === null || verified || disabled) return;
        if (secondsLeft <= 0) {
            void fetchChallenge();
            return;
        }
        const t = window.setTimeout(() => {
            setSecondsLeft((s) => (typeof s === 'number' ? s - 1 : s));
        }, 1000);
        return () => window.clearTimeout(t);
    }, [secondsLeft, verified, disabled, fetchChallenge]);

    const verify = async () => {
        if (disabled || verified || verifying) return;
        const given = answer.trim();
        if (!given) {
            setError('Please answer the math image to continue.');
            answerInputRef.current?.focus();
            return;
        }
        if (!challenge) {
            setError('Verification image is still loading. Press New to retry.');
            return;
        }
        setVerifying(true);
        try {
            const res = await fetch(`${getApiBaseUrl()}/auth.php?action=math_verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ challenge_id: challenge.id, answer: given }),
            });
            const data = await res.json() as { success?: boolean; message?: string; errors?: { code?: string } };
            if (res.ok && data.success) {
                setError(null);
                setVerified(true);
                onVerifiedChange(true);
                return;
            }
            // Expired images refresh silently with no warning.
            if (data.errors?.code === 'captcha_expired') {
                setError(null);
                void fetchChallenge();
                return;
            }
            setError(String(data.message || 'Incorrect answer. A new image was generated — try again.'));
            void fetchChallenge();
        } catch {
            setError('Could not verify the answer. A new image was generated — try again.');
            void fetchChallenge();
        } finally {
            setVerifying(false);
        }
    };

    const formatCountdown = (totalSeconds: number) => {
        const safe = Math.max(0, totalSeconds);
        const mins = Math.floor(safe / 60);
        const secs = safe % 60;
        return `${mins}:${String(secs).padStart(2, '0')}`;
    };

    return (
        <div className={styles.gate} style={{ padding: 12, borderRadius: 12, border: verified ? '1px solid rgba(22, 163, 74, 0.45)' : '1px solid #e2e8f0', background: verified ? '#f0fdf4' : '#f8fafc' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, color: '#334155', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    {title} — answer first to continue
                    {secondsLeft !== null && !verified && (
                        <span
                            role="timer"
                            aria-label={`Time left: ${formatCountdown(secondsLeft)}`}
                            style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                                fontSize: 11,
                                fontWeight: 800,
                                padding: '2px 8px',
                                borderRadius: 999,
                                color: secondsLeft <= 10 ? '#b91c1c' : '#1d4ed8',
                                background: secondsLeft <= 10 ? 'rgba(239, 68, 68, 0.12)' : 'rgba(59, 130, 246, 0.12)',
                                border: `1px solid ${secondsLeft <= 10 ? 'rgba(239, 68, 68, 0.35)' : 'rgba(59, 130, 246, 0.30)'}`,
                                fontVariantNumeric: 'tabular-nums',
                            }}
                        >
                            ⏱ {formatCountdown(secondsLeft)}
                        </span>
                    )}
                </span>
                <button
                    type="button"
                    onClick={() => regenerate()}
                    disabled={disabled || loadingChallenge}
                    title="New math image"
                    aria-label="New math image"
                    style={{ background: 'rgba(148, 163, 184, 0.14)', border: '1px solid rgba(148, 163, 184, 0.30)', color: '#475569', borderRadius: 8, padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: disabled || loadingChallenge ? 'not-allowed' : 'pointer' }}
                >
                    ↻ New
                </button>
            </div>
            {verified ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 700, color: '#15803d' }}>
                    <span aria-hidden="true">✓</span> Verified — you may continue.
                </div>
            ) : (
                <div className={styles.challengeRow}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#ffffff', borderRadius: 10, minHeight: 44, padding: '4px 10px', userSelect: 'none', border: '1px solid #e2e8f0', minWidth: 0 }}>
                        {challenge?.image ? (
                            <img
                                src={challenge.image}
                                alt="Math captcha image: single-digit addition or subtraction"
                                draggable={false}
                                style={{ height: 40, width: 'auto', maxWidth: '100%', pointerEvents: 'none' }}
                            />
                        ) : (
                            <span style={{ fontSize: 12, color: '#64748b' }}>
                                {loadingChallenge ? 'Loading image…' : 'Press New to load the image.'}
                            </span>
                        )}
                    </div>
                    <input
                        ref={answerInputRef}
                        type="number"
                        value={answer}
                        onChange={(e) => { setAnswer(e.target.value); if (error) setError(null); }}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void verify(); } }}
                        placeholder="Answer"
                        disabled={disabled || verifying}
                        aria-label="Math captcha answer"
                        style={{ width: '100%', minWidth: 0, height: 44, borderRadius: 10, border: error ? '1px solid rgba(239,68,68,0.7)' : '1px solid #cbd5e1', background: '#ffffff', color: '#0f172a', padding: '0 12px', outline: 'none', fontSize: 13.5, boxSizing: 'border-box' }}
                    />
                    <button
                        className={styles.verifyButton}
                        type="button"
                        onClick={() => void verify()}
                        disabled={disabled || verifying}
                        aria-busy={verifying}
                        title={!answer.trim() ? 'Enter the answer, then verify' : 'Verify security answer'}
                        style={{ background: disabled || verifying ? '#93c5fd' : '#1e3a8a', cursor: disabled || verifying ? 'not-allowed' : 'pointer', boxShadow: disabled || verifying ? 'none' : '0 2px 5px rgba(30, 58, 138, 0.18)' }}
                    >
                        {verifying ? '…' : 'Verify'}
                    </button>
                </div>
            )}
            {error && (
                <p style={{ margin: '6px 0 0', fontSize: 11.5, color: '#b91c1c', lineHeight: 1.4 }}>{error}</p>
            )}
        </div>
    );
}
