import type { ButtonHTMLAttributes, CSSProperties } from 'react';

type ExpandIconButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  label: string;
  tone?: 'light' | 'dark';
  size?: number;
  style?: CSSProperties;
};

const toneStyles: Record<NonNullable<ExpandIconButtonProps['tone']>, CSSProperties> = {
  light: {
    background: 'rgba(248, 250, 252, 0.96)',
    border: '1px solid #dbe4f0',
    color: '#334155',
    boxShadow: '0 14px 32px rgba(15, 23, 42, 0.08)',
  },
  dark: {
    background: 'rgba(13, 29, 61, 0.92)',
    border: '1px solid rgba(99, 132, 205, 0.28)',
    color: '#dbe7ff',
    boxShadow: '0 16px 36px rgba(2, 6, 23, 0.32)',
  },
};

export default function ExpandIconButton({
  label,
  tone = 'light',
  size = 34,
  style,
  type = 'button',
  ...buttonProps
}: ExpandIconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      {...buttonProps}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
        cursor: 'pointer',
        padding: 0,
        flexShrink: 0,
        transition: 'transform 160ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 180ms cubic-bezier(0.23, 1, 0.32, 1)',
        ...toneStyles[tone],
        ...style,
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 3 21 3 21 9" />
        <polyline points="9 21 3 21 3 15" />
        <line x1="21" y1="3" x2="14" y2="10" />
        <line x1="3" y1="21" x2="10" y2="14" />
      </svg>
    </button>
  );
}
