import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import CrudActionIcon from '../../components/CrudActionIcon';
import SettingsLayout from '../../components/SettingsLayout';
import TinyReloadButton from '../../components/TinyReloadButton';
import { SettingsPageHeader } from '../../components/SettingsPageShell';
import { useAdminSettingsPage } from '../../components/useAdminSettingsPage';
import { notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';

const API_BASE = getApiBaseUrl();

type CaptchaTimeoutUnit = 'seconds' | 'minutes' | 'hours';

const clampCaptchaTimeoutSeconds = (value: number) => {
    if (Number.isNaN(value)) return 300;
    return Math.max(30, Math.min(86400, Math.trunc(value)));
};

const captchaTimeoutValueToSeconds = (value: number, unit: CaptchaTimeoutUnit, fallbackSeconds = 300) => {
    const raw = Number.isFinite(value) ? value : fallbackSeconds;
    const seconds = unit === 'hours'
        ? Math.round(raw * 3600)
        : unit === 'minutes'
            ? Math.round(raw * 60)
            : Math.round(raw);
    return clampCaptchaTimeoutSeconds(seconds);
};

const secondsToCaptchaTimeoutValue = (seconds: number, unit: CaptchaTimeoutUnit) => {
    const safeSeconds = clampCaptchaTimeoutSeconds(seconds);
    if (unit === 'hours') {
        return Number((safeSeconds / 3600).toFixed(2));
    }
    if (unit === 'minutes') {
        return Number((safeSeconds / 60).toFixed(2));
    }
    return safeSeconds;
};

// ─── shared input / label styles ─────────────────────────────────────────────

const inputStyle: React.CSSProperties = { padding: '7px 10px', borderRadius: 8, border: '1px solid #d1d5db', fontSize: 13, color: '#111', width: '100%', boxSizing: 'border-box' };
const hintStyle: React.CSSProperties  = { fontSize: 10, color: '#9ca3af' };

export default function MathCaptchaSettings() {
    const router = useRouter();
    const embedded = true;
    const { user, loading: authLoading, logout } = useAdminSettingsPage();
    const [pageLoading, setPageLoading] = useState(true);

    // ── Basic captcha settings ────────────────────────────────────────────────
    const [captchaUnit,        setCaptchaUnit]        = useState<CaptchaTimeoutUnit>('minutes');
    const [captchaTimeoutValue,setCaptchaTimeoutValue]= useState(5);
    const [failedAttemptLimit, setFailedAttemptLimit] = useState(5);

    // ── Math captcha answer timer ─────────────────────────────────────────────

    // ── Bot-resistance settings ───────────────────────────────────────────────
    const [minDragMs,      setMinDragMs]      = useState(400);
    const [maxAttempts,    setMaxAttempts]    = useState(3);
    const [suspiciousRiskThreshold, setSuspiciousRiskThreshold] = useState(3);
    const [tolerancePx,    setTolerancePx]    = useState(15);
    const [minPathPoints,  setMinPathPoints]  = useState(3);

    // ── hCaptcha settings ──────────────────────────────────────────────────
    const [hcaptchaSiteKey, setHcaptchaSiteKey] = useState('');
    const [hcaptchaSecret, setHcaptchaSecret] = useState('');

    const [saving, setSaving] = useState(false);
    const [msg, setMsg] = useState<string | null>(null);
    const [err, setErr] = useState<string | null>(null);
    const [reloading, setReloading] = useState(false);

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
                await fetchSettings();
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
        if (!msg) return;
        void notifySuccess(msg);
        setMsg(null);
    }, [msg]);

    useEffect(() => {
        if (!err) return;
        void notifyError(err);
        setErr(null);
    }, [err]);

    const fetchSettings = async () => {
        try {
            const keys = [
                'captcha_timeout_seconds',
                'login_failed_attempt_limit',
                'slider_min_drag_ms',
                'slider_max_attempts',
                'login_suspicious_risk_threshold',
                'slider_tolerance_px',
                'slider_min_path_points',
                'hcaptcha_site_key',
                'hcaptcha_secret',
            ].join(',');
            const res  = await fetch(`${API_BASE}/settings_api.php?keys=${keys}`, { credentials: 'include', cache: 'no-store' });
            const data = await res.json();
            if (data.success && data.data) {
                const d = data.data;
                const captchaSeconds = clampCaptchaTimeoutSeconds(Number(d.captcha_timeout_seconds ?? 300));
                const nextCaptchaUnit: CaptchaTimeoutUnit = captchaSeconds % 3600 === 0
                    ? 'hours'
                    : captchaSeconds % 60 === 0
                        ? 'minutes'
                        : 'seconds';
                setCaptchaUnit(nextCaptchaUnit);
                setCaptchaTimeoutValue(secondsToCaptchaTimeoutValue(captchaSeconds, nextCaptchaUnit));
                setFailedAttemptLimit(Math.max(1, Math.min(20,  Number(d.login_failed_attempt_limit ?? 5))));
                setMinDragMs(     Math.max(200, Math.min(5000, Number(d.slider_min_drag_ms      ?? 400))));
                setMaxAttempts(   Math.max(1,   Math.min(10,   Number(d.slider_max_attempts     ?? 3))));
                setSuspiciousRiskThreshold(Math.max(1, Math.min(10, Number(d.login_suspicious_risk_threshold ?? 3))));
                setTolerancePx(   Math.max(8,   Math.min(40,   Number(d.slider_tolerance_px     ?? 15))));
                setMinPathPoints( Math.max(1,   Math.min(20,   Number(d.slider_min_path_points  ?? 3))));
                setHcaptchaSiteKey(d.hcaptcha_site_key ?? '');
                setHcaptchaSecret(d.hcaptcha_secret ?? '');
            }
        } catch {
            // Keep defaults when settings are unavailable.
        }
    };

    const handleReload = async () => {
        setReloading(true);
        try {
            await fetchSettings();
        } finally {
            setReloading(false);
        }
    };

    const handleSave = async () => {
        setSaving(true);
        setMsg(null);
        setErr(null);

        const captchaValue     = captchaTimeoutValueToSeconds(captchaTimeoutValue, captchaUnit, 300);
        setCaptchaTimeoutValue(secondsToCaptchaTimeoutValue(captchaValue, captchaUnit));
        const nextAttemptLimit = Math.max(1, Math.min(20,   Math.trunc(Number(failedAttemptLimit) || 5)));
        const nextMinDragMs    = Math.max(200, Math.min(5000, Math.trunc(Number(minDragMs)    || 400)));
        const nextMaxAttempts  = Math.max(1,   Math.min(10,   Math.trunc(Number(maxAttempts)  || 3)));
        const nextRiskThreshold = Math.max(1,  Math.min(10,   Math.trunc(Number(suspiciousRiskThreshold) || 3)));
        const nextTolerancePx  = Math.max(8,   Math.min(40,   Math.trunc(Number(tolerancePx)  || 15)));
        const nextMinPathPts   = Math.max(1,   Math.min(20,   Math.trunc(Number(minPathPoints) || 3)));
        setFailedAttemptLimit(nextAttemptLimit);
        setMinDragMs(nextMinDragMs);
        setMaxAttempts(nextMaxAttempts);
        setSuspiciousRiskThreshold(nextRiskThreshold);
        setTolerancePx(nextTolerancePx);
        setMinPathPoints(nextMinPathPts);

        try {
            const res = await fetch(`${API_BASE}/settings_api.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    settings: {
                        captcha_timeout_seconds:    captchaValue,
                        login_failed_attempt_limit: nextAttemptLimit,
                        slider_min_drag_ms:         nextMinDragMs,
                        slider_max_attempts:        nextMaxAttempts,
                        login_suspicious_risk_threshold: nextRiskThreshold,
                        slider_tolerance_px:        nextTolerancePx,
                        slider_min_path_points:     nextMinPathPts,
                        hcaptcha_site_key:          hcaptchaSiteKey,
                        hcaptcha_secret:            hcaptchaSecret,
                    },
                }),
            });
            const data = await res.json();
            if (data.success) {
                await fetchSettings();
                setMsg('Captcha management settings saved.');
            } else {
                setErr(data.message || 'Failed to save captcha management settings.');
            }
        } catch {
            setErr('Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleCaptchaUnitChange = (nextUnit: CaptchaTimeoutUnit) => {
        if (nextUnit === captchaUnit) return;
        const seconds = captchaTimeoutValueToSeconds(captchaTimeoutValue, captchaUnit, 300);
        setCaptchaUnit(nextUnit);
        setCaptchaTimeoutValue(secondsToCaptchaTimeoutValue(seconds, nextUnit));
    };

    if (authLoading) {
        return (
            <SettingsLayout activeSection="math-captcha" user={user} onLogout={logout}>
                <div style={{ padding: 20 }}>Loading...</div>
            </SettingsLayout>
        );
    }

    // ─── compact square tiles, laid left-to-right (wraps, minimal scrolling) ──
    const tileGrid: React.CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 10, alignItems: 'stretch' };
    const groupLabel: React.CSSProperties = { margin: '14px 0 6px 0', fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: 0.5 };
    const tileLabel: React.CSSProperties = { fontSize: 11, color: '#111827', fontWeight: 700 };
    const tileInput: React.CSSProperties = { ...inputStyle, padding: '6px 8px', fontSize: 12 };
    const tile = (children: React.ReactNode, wide = false) => (
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 10, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 128, ...(wide ? { gridColumn: 'span 2' } : {}) }}>
            {children}
        </div>
    );

    return (
        <SettingsLayout activeSection="math-captcha" user={user} onLogout={logout}>
            {pageLoading && <div style={{ padding: '8px 0', fontSize: 12, color: '#6b7280' }}>Loading settings...</div>}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <SettingsPageHeader embedded={embedded} title="Captcha Management" onBack={() => router.push('/settings')} />
                <TinyReloadButton onClick={handleReload} loading={reloading} title="Reload settings" />
            </div>

            {/* ── Login Captcha tiles ─────────────────────────────────── */}
            <div style={groupLabel}>Floating Captcha · Login challenge settings</div>
            <div style={tileGrid}>
                {tile(
                    <>
                        <label style={tileLabel}>Failed Attempt Limit</label>
                        <span style={hintStyle}>Attempts before lockout.</span>
                        <input
                            type="number" min={1} max={20} step={1}
                            value={failedAttemptLimit}
                            onChange={(e) => setFailedAttemptLimit(Math.max(1, Math.min(20, Math.trunc(Number(e.target.value) || 1))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 5 · 1–20</span>
                    </>
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Expiry Time</label>
                        <span style={hintStyle}>Captcha validity period.</span>
                        <select
                            value={captchaUnit}
                            onChange={(e) => handleCaptchaUnitChange(e.target.value as CaptchaTimeoutUnit)}
                            style={{ ...tileInput, background: '#f8fafc' }}
                        >
                            <option value="seconds">Second/s</option>
                            <option value="minutes">Minute/s</option>
                            <option value="hours">Hour/s</option>
                        </select>
                        <input
                            type="number"
                            min={captchaUnit === 'hours' ? 0.01 : captchaUnit === 'minutes' ? 0.5  : 30}
                            max={captchaUnit === 'hours' ? 24   : captchaUnit === 'minutes' ? 1440 : 86400}
                            step={captchaUnit === 'hours' ? 0.25 : captchaUnit === 'minutes' ? 0.5  : 30}
                            value={captchaTimeoutValue}
                            onChange={(e) => setCaptchaTimeoutValue(secondsToCaptchaTimeoutValue(
                                captchaTimeoutValueToSeconds(Number(e.target.value), captchaUnit, 300),
                                captchaUnit
                            ))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>
                            {captchaUnit === 'hours'
                                ? '0.01–24 hours'
                                : captchaUnit === 'minutes'
                                    ? '0.5–1440 minutes'
                                    : '30–86400 seconds'}
                        </span>
                    </>
                )}
            </div>

            {/* ── Math captcha answer timer ─────────────────────────────── */}
            {/* ── Bot-resistance tiles ────────────────────────────────── */}
            <div style={groupLabel}>Bot-Resistance · Bot checks and challenge threshold</div>
            <div style={tileGrid}>
                {tile(
                    <>
                        <label style={tileLabel}>Min Drag (ms)</label>
                        <span style={hintStyle}>Rejects instant submits.</span>
                        <input
                            type="number" min={200} max={5000} step={50}
                            value={minDragMs}
                            onChange={(e) => setMinDragMs(Math.max(200, Math.min(5000, Math.trunc(Number(e.target.value) || 400))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 400</span>
                    </>
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Max Attempts</label>
                        <span style={hintStyle}>Failures per session.</span>
                        <input
                            type="number" min={1} max={10} step={1}
                            value={maxAttempts}
                            onChange={(e) => setMaxAttempts(Math.max(1, Math.min(10, Math.trunc(Number(e.target.value) || 3))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 3 · 1–10</span>
                    </>
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Suspicious Threshold</label>
                        <span style={hintStyle}>Score for challenge.</span>
                        <input
                            type="number" min={1} max={10} step={1}
                            value={suspiciousRiskThreshold}
                            onChange={(e) => setSuspiciousRiskThreshold(Math.max(1, Math.min(10, Math.trunc(Number(e.target.value) || 3))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 3 · 1–10</span>
                    </>
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Tolerance (px)</label>
                        <span style={hintStyle}>Placement error.</span>
                        <input
                            type="number" min={8} max={40} step={1}
                            value={tolerancePx}
                            onChange={(e) => setTolerancePx(Math.max(8, Math.min(40, Math.trunc(Number(e.target.value) || 15))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 15 · 8–40</span>
                    </>
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Min Path Samples</label>
                        <span style={hintStyle}>Movement samples.</span>
                        <input
                            type="number" min={1} max={20} step={1}
                            value={minPathPoints}
                            onChange={(e) => setMinPathPoints(Math.max(1, Math.min(20, Math.trunc(Number(e.target.value) || 3))))}
                            style={tileInput}
                        />
                        <span style={hintStyle}>Default 3 · 1–20</span>
                    </>
                )}
            </div>

            {/* ── hCaptcha tiles ──────────────────────────────────────── */}
            <div style={groupLabel}>hCaptcha · Keys for login verification</div>
            <div style={tileGrid}>
                {tile(
                    <>
                        <label style={tileLabel}>Site Key</label>
                        <span style={hintStyle}>Public key from <a href="https://dashboard.hcaptcha.com" target="_blank" rel="noopener noreferrer" style={{ color: '#2563eb' }}>hCaptcha Dashboard</a>.</span>
                        <input
                            type="text"
                            value={hcaptchaSiteKey}
                            onChange={(e) => setHcaptchaSiteKey(e.target.value)}
                            style={tileInput}
                            placeholder="e.g. 0e6421f6-…"
                        />
                    </>,
                    true
                )}
                {tile(
                    <>
                        <label style={tileLabel}>Secret</label>
                        <span style={hintStyle}>Server-side secret. Keep confidential.</span>
                        <input
                            type="password"
                            value={hcaptchaSecret}
                            onChange={(e) => setHcaptchaSecret(e.target.value)}
                            style={tileInput}
                            placeholder="e.g. ES_..."
                        />
                    </>,
                    true
                )}
            </div>

            {/* ── Save button ─────────────────────────────────────────────── */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
                <button
                    onClick={handleSave}
                    disabled={saving}
                    title="Save Settings"
                    aria-label="Save captcha management settings"
                    style={{
                        background: 'transparent', color: '#1e3a8a', border: 'none',
                        padding: '4px 0', textDecoration: 'underline',
                        cursor: 'pointer', fontWeight: 600, fontSize: 14,
                        opacity: saving ? 0.7 : 1,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}
                >
                    {saving ? 'Saving...' : 'Submit'}
                </button>
            </div>
        </SettingsLayout>
    );
}
