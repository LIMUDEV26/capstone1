import React from 'react';

type TinyReloadButtonProps = {
    onClick: () => void | Promise<void>;
    loading?: boolean;
    title?: string;
    size?: number;
    disabled?: boolean;
    style?: React.CSSProperties;
};

export default function TinyReloadButton({
    onClick,
    loading = false,
    title = 'Reload list',
    size = 28,
    disabled,
    style,
}: TinyReloadButtonProps) {
    const isDisabled = Boolean(disabled || loading);
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={isDisabled}
            title={title}
            aria-label={title}
            style={{
                width: size,
                height: size,
                minWidth: size,
                minHeight: size,
                padding: 0,
                borderRadius: 7,
                border: '1px solid #e2e8f0',
                background: '#ffffff',
                color: '#475569',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                lineHeight: 1,
                opacity: isDisabled ? 0.6 : 1,
                transition: 'background 0.15s, border-color 0.15s, opacity 0.15s',
                flexShrink: 0,
                ...style,
            }}
            onMouseEnter={(e) => {
                if (!isDisabled) (e.currentTarget.style.background = '#f8fafc');
            }}
            onMouseLeave={(e) => {
                (e.currentTarget.style.background = '#ffffff');
            }}
        >
            <svg
                width={14}
                height={14}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.1}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{
                    display: 'block',
                    animation: loading ? 'tiny-reload-spin 0.7s linear infinite' : undefined,
                }}
            >
                <path d="M21 12a9 9 0 1 1 -2.64 -6.36" />
                <polyline points="21 3 21 9 15 9" />
            </svg>
            <style>{`@keyframes tiny-reload-spin { to { transform: rotate(360deg); } }`}</style>
        </button>
    );
}
