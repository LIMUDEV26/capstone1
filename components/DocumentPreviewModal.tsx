import type { CSSProperties } from 'react';

export type PreviewDocument = {
  name: string;
  url: string;
  mime?: string | null;
};

function getFileExtension(name: string) {
  const value = String(name || '').trim().toLowerCase();
  const lastDot = value.lastIndexOf('.');
  return lastDot >= 0 ? value.slice(lastDot + 1) : '';
}

export function isInlineDocumentPreviewable(document: PreviewDocument | null | undefined) {
  if (!document?.url) return false;

  const mime = String(document.mime || '').toLowerCase().split(';', 1)[0].trim();
  if (mime === 'application/pdf' || mime.startsWith('image/')) return true;
  if (mime.startsWith('text/')) return true;
  if (mime === 'application/json' || mime === 'application/xml') return true;

  return ['csv', 'html', 'htm', 'json', 'md', 'pdf', 'txt', 'xml', 'gif', 'jpeg', 'jpg', 'png', 'webp'].includes(
    getFileExtension(document.name)
  );
}

const buttonStyle: CSSProperties = {
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  textDecoration: 'none',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

type DocumentPreviewModalProps = {
  document: PreviewDocument | null;
  onClose: () => void;
  zIndex?: number;
};

export default function DocumentPreviewModal({ document, onClose, zIndex = 45000 }: DocumentPreviewModalProps) {
  if (!document) return null;

  const canPreview = isInlineDocumentPreviewable(document);

  return (
    <div
      role="presentation"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex,
        background: 'rgba(15,23,42,0.62)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${document.name}`}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(1080px, 96vw)',
          height: 'min(86vh, 820px)',
          background: '#fff',
          border: '1px solid #dbe4f0',
          borderRadius: 14,
          boxShadow: '0 24px 80px rgba(15,23,42,0.32)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: '12px 14px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {document.name}
            </div>
            <div style={{ fontSize: 11, color: '#64748b' }}>In-system document viewer</div>
          </div>
          <button type="button" onClick={onClose} style={{ ...buttonStyle, border: '1px solid #cbd5e1', background: '#fff', color: '#334155' }}>
            Close Viewer
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, background: '#f8fafc', padding: 10, overflow: 'auto' }}>
          {canPreview ? (
            <iframe
              src={document.url}
              title={`Preview ${document.name}`}
              style={{ width: '100%', height: '100%', minHeight: 420, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff' }}
            />
          ) : (
            <div style={{ height: '100%', minHeight: 420, border: '1px solid #e2e8f0', borderRadius: 8, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center' }}>
              <div>
                <div style={{ color: '#334155', fontSize: 14, fontWeight: 700 }}>Preview is not available for this file type.</div>
                <div style={{ marginTop: 6, color: '#64748b', fontSize: 12 }}>Use Download File if you need to open it in its desktop application.</div>
                <a href={document.url} download={document.name} style={{ ...buttonStyle, marginTop: 14, border: '1px solid #cbd5e1', background: '#fff', color: '#1d4ed8' }}>
                  Download File
                </a>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}