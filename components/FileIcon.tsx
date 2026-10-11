import type { CSSProperties } from 'react';

/** File extension (lowercase, no dot) from a file name. */
export function fileExtension(fileName: unknown): string {
    const name = String(fileName ?? '').trim();
    const dot = name.lastIndexOf('.');
    if (dot < 0 || dot === name.length - 1) return '';
    return name.slice(dot + 1).toLowerCase();
}

/** Short human type label, e.g. "PDF", "JPG", "PNG", "DOCX". Falls back to mime subtype. */
export function fileKindLabel(fileName: unknown, mimeType?: unknown): string {
    const ext = fileExtension(fileName);
    if (ext) return ext.toUpperCase();
    const mime = String(mimeType ?? '').trim().toLowerCase();
    if (mime.includes('/')) {
        const sub = mime.split('/')[1] || '';
        if (sub) return sub.toUpperCase();
    }
    return 'FILE';
}

type FileKind = 'pdf' | 'image' | 'word' | 'excel' | 'archive' | 'text' | 'other';

function classifyFile(fileName: unknown, mimeType?: unknown): FileKind {
    const ext = fileExtension(fileName);
    const mime = String(mimeType ?? '').toLowerCase();
    if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'].includes(ext) || mime.startsWith('image/')) return 'image';
    if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || mime.includes('word') || mime.includes('opendocument.text')) return 'word';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || mime.includes('spreadsheet') || mime === 'text/csv') return 'excel';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    if (['txt', 'md', 'log', 'json', 'xml', 'html', 'css', 'js', 'ts'].includes(ext) || mime.startsWith('text/')) return 'text';
    return 'other';
}

const KIND_STYLES: Record<FileKind, { bg: string; fg: string; border: string }> = {
    pdf: { bg: '#fee2e2', fg: '#b91c1c', border: '#fecaca' },
    image: { bg: '#d1fae5', fg: '#047857', border: '#a7f3d0' },
    word: { bg: '#dbeafe', fg: '#1d4ed8', border: '#bfdbfe' },
    excel: { bg: '#dcfce7', fg: '#15803d', border: '#bbf7d0' },
    archive: { bg: '#fef3c7', fg: '#b45309', border: '#fde68a' },
    text: { bg: '#f1f5f9', fg: '#475569', border: '#e2e8f0' },
    other: { bg: '#f1f5f9', fg: '#64748b', border: '#e2e8f0' },
};

type FileIconProps = {
    fileName?: unknown;
    mimeType?: unknown;
    size?: number;
    style?: CSSProperties;
    title?: string;
};

/**
 * Small file-type badge: colored tile with the extension label
 * (PDF / JPG / PNG / DOCX / …) based on file name or mime type.
 */
export default function FileIcon({ fileName, mimeType, size = 36, style, title }: FileIconProps) {
    const kind = classifyFile(fileName, mimeType);
    const colors = KIND_STYLES[kind];
    const label = fileKindLabel(fileName, mimeType).slice(0, 4);
    const px = Math.max(28, size);
    return (
        <span
            title={title ?? String(fileName ?? label)}
            aria-hidden="true"
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexDirection: 'column',
                width: px,
                height: px,
                borderRadius: 8,
                background: colors.bg,
                border: `1px solid ${colors.border}`,
                color: colors.fg,
                flexShrink: 0,
                lineHeight: 1,
                ...style,
            }}
        >
            <svg
                width={Math.round(px * 0.42)}
                height={Math.round(px * 0.42)}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
            >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
            </svg>
            <span style={{ fontSize: Math.max(7, Math.round(px * 0.2)), fontWeight: 800, letterSpacing: '0.02em', marginTop: 1 }}>
                {label}
            </span>
        </span>
    );
}
