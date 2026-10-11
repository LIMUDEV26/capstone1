import { formatBytes, formatEta, formatSpeed, type UploadProgress } from '@/utils/chunkedUpload';

type UploadProgressBarProps = {
    progress: UploadProgress | null;
    /** Fallback percent (0-100) when no live progress object exists yet. */
    percent?: number;
    /** Small caption under the bar, e.g. status or error text. */
    caption?: string;
    tone?: 'uploading' | 'done' | 'error' | 'idle';
};

const TONE_COLORS: Record<NonNullable<UploadProgressBarProps['tone']>, string> = {
    uploading: '#2563eb',
    done: '#16a34a',
    error: '#dc2626',
    idle: '#94a3b8',
};

/**
 * Upload loader: progress bar with % plus transferred size, speed and ETA.
 */
export default function UploadProgressBar({ progress, percent, caption, tone = 'uploading' }: UploadProgressBarProps) {
    const pct = progress ? progress.percent : Math.min(100, Math.max(0, Math.round(percent ?? 0)));
    const color = TONE_COLORS[tone];
    const sizeLine = progress
        ? `${formatBytes(progress.loadedBytes)} of ${formatBytes(progress.totalBytes)}`
        : '';
    const speedLine = progress && progress.speedBps > 0 ? formatSpeed(progress.speedBps) : '';
    const etaLine = progress ? formatEta(progress.etaSeconds) : '';
    const meta = [sizeLine, speedLine, etaLine].filter(Boolean).join('  •  ');
    return (
        <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={pct}
                    aria-label="Upload progress"
                    style={{ flex: 1, height: 8, borderRadius: 99, background: '#e2e8f0', overflow: 'hidden' }}
                >
                    <div
                        style={{
                            width: `${pct}%`,
                            height: '100%',
                            borderRadius: 99,
                            background: tone === 'idle' ? '#cbd5e1' : color,
                            transition: 'width 0.2s ease',
                        }}
                    />
                </div>
                <span style={{ fontSize: 12, fontWeight: 800, color, minWidth: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {pct}%
                </span>
            </div>
            {(meta || caption) && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 3, flexWrap: 'wrap' }}>
                    {meta && <span style={{ fontSize: 11, color: '#64748b' }}>{meta}</span>}
                    {caption && <span style={{ fontSize: 11, color: tone === 'error' ? '#b91c1c' : '#64748b' }}>{caption}</span>}
                </div>
            )}
        </div>
    );
}
