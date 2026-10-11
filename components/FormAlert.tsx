import type { CSSProperties, ReactNode } from 'react';

type AlertTone = 'error' | 'success' | 'info';

const TONE_STYLE: Record<AlertTone, { color: string; background: string; border: string }> = {
    error: { color: '#b91c1c', background: '#fef2f2', border: '#fecaca' },
    success: { color: '#15803d', background: '#f0fdf4', border: '#bbf7d0' },
    info: { color: '#1d4ed8', background: '#eff6ff', border: '#bfdbfe' },
};

/**
 * Small inline message rendered directly under a textfield/select/textarea.
 * Renders nothing when `message` is empty, so it never reserves space.
 */
export function FieldMessage({ message, tone = 'error' }: { message?: string | null; tone?: AlertTone }) {
    if (!message) return null;
    const style = TONE_STYLE[tone];
    return (
        <div
            role={tone === 'error' ? 'alert' : 'status'}
            style={{ marginTop: 5, fontSize: 12, lineHeight: 1.45, color: style.color, fontWeight: 600 }}
        >
            {message}
        </div>
    );
}

/**
 * Form/page-level inline banner (replaces popup toasts for form results).
 * Place at the top of the form or page section it describes.
 */
export function FormAlert({
    tone,
    message,
    onDismiss,
    style,
}: {
    tone: AlertTone;
    message?: string | null;
    onDismiss?: () => void;
    style?: CSSProperties;
}) {
    if (!message) return null;
    const colors = TONE_STYLE[tone];
    return (
        <div
            role={tone === 'error' ? 'alert' : 'status'}
            style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                background: colors.background,
                border: `1px solid ${colors.border}`,
                color: colors.color,
                borderRadius: 8,
                padding: '9px 12px',
                fontSize: 13,
                fontWeight: 600,
                lineHeight: 1.5,
                ...style,
            }}
        >
            <span style={{ flex: 1, minWidth: 0 }}>{message}</span>
            {onDismiss && (
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss message"
                    style={{
                        background: 'none',
                        border: 'none',
                        color: colors.color,
                        cursor: 'pointer',
                        fontSize: 15,
                        lineHeight: 1,
                        padding: '0 0 0 4px',
                        flexShrink: 0,
                    }}
                >
                    ×
                </button>
            )}
        </div>
    );
}

/**
 * Inline two-button confirmation strip (replaces popup confirm dialogs).
 * Render it in place — e.g. inside a table row or card — where the action lives.
 */
export function InlineConfirmBar({
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    onConfirm,
    onCancel,
    busy = false,
    danger = true,
}: {
    message: ReactNode;
    confirmLabel?: string;
    cancelLabel?: string;
    onConfirm: () => void;
    onCancel: () => void;
    busy?: boolean;
    danger?: boolean;
}) {
    return (
        <div
            role="alertdialog"
            aria-live="assertive"
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                background: danger ? '#fef2f2' : '#eff6ff',
                border: `1px solid ${danger ? '#fecaca' : '#bfdbfe'}`,
                color: danger ? '#991b1b' : '#1e40af',
                borderRadius: 8,
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 600,
            }}
        >
            <span style={{ flex: '1 1 200px', minWidth: 0 }}>{message}</span>
            <span style={{ display: 'inline-flex', gap: 8, flexShrink: 0 }}>
                <button
                    type="button"
                    onClick={onConfirm}
                    disabled={busy}
                    style={{
                        padding: '6px 14px',
                        border: 'none',
                        borderRadius: 7,
                        background: danger ? '#dc2626' : '#1d4ed8',
                        color: '#fff',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: busy ? 'not-allowed' : 'pointer',
                        opacity: busy ? 0.7 : 1,
                    }}
                >
                    {busy ? 'Working…' : confirmLabel}
                </button>
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                    style={{
                        padding: '6px 14px',
                        border: '1px solid #d1d5db',
                        borderRadius: 7,
                        background: '#fff',
                        color: '#374151',
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: busy ? 'not-allowed' : 'pointer',
                    }}
                >
                    {cancelLabel}
                </button>
            </span>
        </div>
    );
}
