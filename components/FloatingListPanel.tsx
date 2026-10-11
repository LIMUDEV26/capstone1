import {
  useEffect,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';

function stopClose(event: ReactMouseEvent<HTMLDivElement>) {
  event.stopPropagation();
}

type FloatingListPanelProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  tone?: 'light' | 'dark';
  width?: CSSProperties['width'];
  maxWidth?: CSSProperties['maxWidth'];
  maxHeight?: CSSProperties['maxHeight'];
  zIndex?: number;
  panelStyle?: CSSProperties;
  contentStyle?: CSSProperties;
  headerAction?: ReactNode;
};

const panelTones: Record<NonNullable<FloatingListPanelProps['tone']>, {
  overlay: string;
  background: string;
  border: string;
  heading: string;
  body: string;
  closeBackground: string;
  closeBorder: string;
  closeColor: string;
  shadow: string;
}> = {
  light: {
    overlay: 'rgba(15, 23, 42, 0.58)',
    background: '#ffffff',
    border: '1px solid rgba(226, 232, 240, 0.95)',
    heading: '#0f172a',
    body: '#475569',
    closeBackground: '#f8fafc',
    closeBorder: '#dbe4f0',
    closeColor: '#475569',
    shadow: '0 28px 80px rgba(15, 23, 42, 0.24)',
  },
  dark: {
    overlay: 'rgba(2, 6, 23, 0.78)',
    background: '#0d1d3d',
    border: '1px solid rgba(99, 132, 205, 0.28)',
    heading: '#dbe7ff',
    body: '#9fb3de',
    closeBackground: 'rgba(19, 41, 84, 0.96)',
    closeBorder: 'rgba(99, 132, 205, 0.28)',
    closeColor: '#dbe7ff',
    shadow: '0 32px 92px rgba(2, 6, 23, 0.46)',
  },
};

export default function FloatingListPanel({
  open,
  onClose,
  title,
  description,
  children,
  tone = 'light',
  width = 'min(1040px, 96vw)',
  maxWidth,
  maxHeight = '88vh',
  zIndex = 24000,
  panelStyle,
  contentStyle,
  headerAction,
}: FloatingListPanelProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open) {
      if (!dialog.open) dialog.showModal();
      document.body.style.overflow = 'hidden';
    } else {
      if (dialog.open) dialog.close();
      document.body.style.overflow = '';
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleCancel = (e: Event) => { e.preventDefault(); onClose(); };
    dialog.addEventListener('cancel', handleCancel);
    return () => dialog.removeEventListener('cancel', handleCancel);
  }, [onClose]);

  if (!open) {
    return null;
  }

  const palette = panelTones[tone];

  return (
    <dialog
      ref={dialogRef}
      aria-label={title}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        width: '100%',
        height: '100%',
        maxWidth: '100%',
        maxHeight: '100%',
        margin: 0,
        padding: 18,
        border: 'none',
        background: palette.overlay,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        onClick={stopClose}
        style={{
          width,
          maxWidth,
          maxHeight,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          borderRadius: 24,
          background: palette.background,
          border: palette.border,
          boxShadow: palette.shadow,
          ...panelStyle,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 12,
            padding: '20px 22px 16px',
            borderBottom: tone === 'dark' ? '1px solid rgba(99, 132, 205, 0.18)' : '1px solid #e2e8f0',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, color: palette.heading, fontSize: 18, lineHeight: 1.2 }}>{title}</h2>
            {description ? (
              <p style={{ margin: '6px 0 0', color: palette.body, fontSize: 13, lineHeight: 1.55 }}>{description}</p>
            ) : null}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {headerAction}
            <button
              type="button"
              onClick={onClose}
              aria-label={`Close ${title}`}
              title="Close"
              style={{
                width: 38,
                height: 38,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 999,
                border: palette.closeBorder,
                background: palette.closeBackground,
                color: palette.closeColor,
                cursor: 'pointer',
                padding: 0,
                flexShrink: 0,
                transition: 'transform 160ms cubic-bezier(0.23, 1, 0.32, 1)',
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        <div
          style={{
            minHeight: 0,
            overflow: 'auto',
            padding: '0 22px 22px',
            ...contentStyle,
          }}
        >
          {children}
        </div>
      </div>
    </dialog>
  );
}
