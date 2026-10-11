import { CSSProperties, FocusEvent, InputHTMLAttributes, useId, useState } from 'react';
import { generatePasswordSuggestions } from '@/utils/password';

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    containerClassName?: string;
    containerStyle?: CSSProperties;
    toggleButtonClassName?: string;
    toggleButtonStyle?: CSSProperties;
    /** Hide the visibility toggle for generated or otherwise non-revealable fields. */
    showVisibilityToggle?: boolean;
    /** Floating glass strength indicator shown below the input while typing */
    showStrength?: boolean;
    /** Show a Google-style "Suggest a strong password" picker below the input */
    showSuggest?: boolean;
    /** Called with the picked suggestion so the parent can fill new + confirm fields */
    onSuggestPick?: (password: string) => void;
    /** Show the "a copy will be emailed to the account Gmail" notice in the picker */
    suggestEmailNotice?: boolean;
};

type Strength = 'weak' | 'fair' | 'strong';

function getStrength(value: string): { score: number; label: Strength; criteria: { minLen: boolean; hasNumber: boolean; hasSymbol: boolean; hasUpper: boolean } } {
    const criteria = {
        minLen: value.length >= 8,
        hasNumber: /[0-9]/.test(value),
        hasSymbol: /[^A-Za-z0-9]/.test(value),
        hasUpper: /[A-Z]/.test(value),
    };
    const score = Object.values(criteria).filter(Boolean).length;
    let label: Strength = 'weak';
    if (score >= 4) label = 'strong';
    else if (score >= 2) label = 'fair';
    return { score, label, criteria };
}

const BAR_COLORS: Record<Strength, string> = {
    weak: '#ef4444',
    fair: '#f59e0b',
    strong: '#22c55e',
};

const LABEL_COLORS: Record<Strength, string> = {
    weak: '#dc2626',
    fair: '#d97706',
    strong: '#16a34a',
};

const LABELS: Record<Strength, string> = {
    weak: 'Weak',
    fair: 'Fair',
    strong: 'Strong',
};

export default function PasswordInput({
    id,
    className,
    style,
    disabled,
    containerClassName,
    containerStyle,
    toggleButtonClassName,
    toggleButtonStyle,
    showVisibilityToggle = true,
    showStrength = false,
    showSuggest = false,
    onSuggestPick,
    suggestEmailNotice = false,
    onFocus,
    onBlur,
    ...inputProps
}: PasswordInputProps) {
    const [visible, setVisible] = useState(false);
    const [focused, setFocused] = useState(false);
    const [suggestOpen, setSuggestOpen] = useState(false);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const generatedId = useId();
    const inputId = id ?? `pwd-${generatedId}`;

    const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
        setFocused(true);
        onFocus?.(event);
    };

    const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
        setFocused(false);
        onBlur?.(event);
    };

    const mergedInputStyle: CSSProperties = { ...(style || {}) };
    if (showVisibilityToggle && mergedInputStyle.paddingRight === undefined) {
        mergedInputStyle.paddingRight = 44;
    }

    const rawValue = typeof inputProps.value === 'string' ? inputProps.value : '';
    const hasValue = rawValue.length > 0;
    const { score, label, criteria } = getStrength(rawValue);
    const showFloat = showStrength && hasValue && focused && !suggestOpen;

    const openSuggestions = () => {
        setSuggestions(generatePasswordSuggestions());
        setSuggestOpen(true);
    };

    return (
        <div
            className={containerClassName}
            style={{ position: 'relative', width: '100%', display: 'block', ...(containerStyle || {}) }}
        >
            <input
                {...inputProps}
                id={inputId}
                type={showVisibilityToggle && visible ? 'text' : 'password'}
                className={className}
                style={mergedInputStyle}
                disabled={disabled}
                onFocus={handleFocus}
                onBlur={handleBlur}
            />
            {showVisibilityToggle && (
                <button
                    type="button"
                    className={toggleButtonClassName}
                    onClick={() => setVisible((prev) => !prev)}
                    aria-label={visible ? 'Hide password' : 'Show password'}
                    title={visible ? 'Hide password' : 'Show password'}
                    disabled={disabled}
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
                        cursor: disabled ? 'default' : 'pointer',
                        color: '#64748b',
                        opacity: disabled ? 0.6 : 1,
                        lineHeight: 0,
                        zIndex: 2,
                        ...(toggleButtonStyle || {}),
                    }}
                >
                    {visible ? (
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{ display: 'block' }}
                    >
                        <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.11 1 12c.74-1.64 1.82-3.1 3.17-4.28" />
                        <path d="M10.58 10.58A2 2 0 0 0 12 14a2 2 0 0 0 1.42-.58" />
                        <path d="M9.88 5.09A10.94 10.94 0 0 1 12 4c5 0 9.27 3.89 11 8a10.94 10.94 0 0 1-1.69 2.86" />
                        <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                    ) : (
                    <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        style={{ display: 'block' }}
                    >
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                        <circle cx="12" cy="12" r="3" />
                    </svg>
                    )}
                </button>
            )}

            {showFloat && (
                <>
                    <style>{'@keyframes pwdFloatIn{from{opacity:0;transform:translateY(-4px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}'}</style>
                    <div
                        role="status"
                        style={{
                            position: 'absolute',
                            top: 'calc(100% + 6px)',
                            left: 0,
                            right: 0,
                            zIndex: 30,
                            padding: '8px 10px',
                            borderRadius: 12,
                            background: 'rgba(15, 23, 42, 0.55)',
                            backdropFilter: 'blur(14px) saturate(160%)',
                            WebkitBackdropFilter: 'blur(14px) saturate(160%)',
                            border: '1px solid rgba(148, 163, 184, 0.22)',
                            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.08)',
                            animation: 'pwdFloatIn 0.18s ease-out',
                            textAlign: 'left',
                            pointerEvents: 'none',
                        }}
                    >
                        <div style={{ display: 'flex', gap: 3, marginBottom: 5 }}>
                            {[1, 2, 3, 4].map((n) => (
                                <div key={n} style={{ flex: 1, height: 3, borderRadius: 99, background: n <= score ? BAR_COLORS[label] : 'rgba(148,163,184,0.2)', transition: 'background 0.25s ease' }} />
                            ))}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                            <span style={{ fontSize: 10, fontWeight: 700, color: LABEL_COLORS[label] }}>{LABELS[label]}</span>
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                {([{ met: criteria.minLen, text: '8+ chars' }, { met: criteria.hasNumber, text: '1 number' }, { met: criteria.hasSymbol, text: '1 symbol' }, { met: criteria.hasUpper, text: '1 capital' }] as const).map(({ met, text }) => (
                                    <span key={text} style={{ fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 99, border: `1px solid ${met ? 'rgba(74,222,128,0.4)' : 'rgba(148,163,184,0.2)'}`, background: met ? 'rgba(74,222,128,0.12)' : 'rgba(148,163,184,0.06)', color: met ? '#4ade80' : '#94a3b8', transition: 'all 0.2s ease' }}>
                                        {met ? '✓ ' : ''}{text}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </>
            )}
            {showSuggest && !disabled && (
                <div style={{ marginTop: 6 }}>
                    {!suggestOpen ? (
                        <button
                            type="button"
                            onClick={openSuggestions}
                            style={{
                                background: 'transparent',
                                border: 'none',
                                padding: 0,
                                color: '#1d4ed8',
                                fontSize: 12,
                                fontWeight: 600,
                                cursor: 'pointer',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 4,
                            }}
                        >
                            <span aria-hidden="true">✨</span> Suggest a strong password
                        </button>
                    ) : (
                        <div
                            role="dialog"
                            aria-label="Suggested passwords"
                            style={{
                                border: '1px solid #e2e8f0',
                                borderRadius: 10,
                                background: '#f8fafc',
                                padding: '8px 10px',
                                display: 'grid',
                                gap: 6,
                            }}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                <span style={{ fontSize: 12, fontWeight: 700, color: '#334155' }}>Suggested passwords</span>
                                <div style={{ display: 'flex', gap: 8 }}>
                                    <button
                                        type="button"
                                        onClick={() => setSuggestions(generatePasswordSuggestions())}
                                        title="Generate new suggestions"
                                        aria-label="Generate new suggestions"
                                        style={{ background: 'transparent', border: 'none', padding: 0, color: '#1d4ed8', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                                    >
                                        ↻ New
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setSuggestOpen(false)}
                                        aria-label="Close suggestions"
                                        style={{ background: 'transparent', border: 'none', padding: 0, color: '#64748b', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                            {suggestions.map((pwd) => (
                                <button
                                    key={pwd}
                                    type="button"
                                    onClick={() => {
                                        onSuggestPick?.(pwd);
                                        setSuggestOpen(false);
                                    }}
                                    title="Use this password"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: 8,
                                        width: '100%',
                                        padding: '7px 10px',
                                        borderRadius: 8,
                                        border: '1px solid #e2e8f0',
                                        background: '#ffffff',
                                        cursor: 'pointer',
                                        textAlign: 'left',
                                    }}
                                >
                                    <span style={{ fontFamily: 'Consolas,Monaco,monospace', fontSize: 13, fontWeight: 700, color: '#0f172a', wordBreak: 'break-all' }}>
                                        {pwd}
                                    </span>
                                    <span style={{ fontSize: 11, fontWeight: 700, color: '#1d4ed8', flexShrink: 0 }}>Use</span>
                                </button>
                            ))}
                            {suggestEmailNotice && (
                                <span style={{ fontSize: 11, color: '#64748b', lineHeight: 1.5 }}>
                                    Hard to remember? A copy of the password you choose will be emailed to the account&apos;s Gmail after a successful change.
                                </span>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
