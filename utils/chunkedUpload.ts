/**
 * Resumable chunked upload client (progress %, speed, ETA, resume-on-retry).
 *
 * Protocol (implemented by api/chunked_upload_utils.php consumers):
 *   POST {baseUrl}?action={initAction}    file_name, file_size, ...meta fields
 *     -> { upload_id, received }
 *   POST {baseUrl}?action={chunkAction}   upload_id, offset, chunk(blob)
 *     -> { received }  (409 + { received } when offset is stale -> resync)
 *   POST {baseUrl}?action={completeAction} upload_id
 *     -> endpoint-specific success payload
 *   POST {baseUrl}?action={abortAction}   upload_id  (best-effort cleanup)
 *
 * Resume: the caller keeps an UploadSession ({ uploadId, received }) across
 * retries. A retry re-sends only unconfirmed bytes — it CONTINUES the upload
 * instead of restarting it. If the server lost the temp data (404/410), the
 * client re-inits once and restarts that file only.
 */

export const DEFAULT_UPLOAD_CHUNK_SIZE = 1024 * 1024; // 1 MB

export type UploadSession = {
    uploadId: string | null;
    received: number;
};

export type UploadProgress = {
    loadedBytes: number;
    totalBytes: number;
    percent: number;
    speedBps: number;
    etaSeconds: number | null;
};

export function formatBytes(bytes: number): string {
    const n = Number(bytes || 0);
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(bps: number): string {
    if (!bps || bps <= 0) return '';
    return `${formatBytes(bps)}/s`;
}

export function formatEta(totalSeconds: number | null): string {
    if (totalSeconds === null || !Number.isFinite(totalSeconds)) return '';
    const s = Math.max(0, Math.ceil(totalSeconds));
    if (s < 1) return 'a moment';
    if (s < 60) return `${s}s left`;
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? `${m}m left` : `${m}m ${rest}s left`;
}

/** Smooth speed/ETA tracker fed with cumulative loaded bytes. */
export function createProgressTracker(totalBytes: number, onProgress: (p: UploadProgress) => void) {
    const total = Math.max(1, Math.floor(totalBytes || 0));
    let lastLoaded = 0;
    let lastAt = Date.now();
    let speedBps = 0;
    const report = (loadedBytes: number) => {
        const now = Date.now();
        const clamped = Math.min(total, Math.max(0, Math.floor(loadedBytes)));
        const dt = (now - lastAt) / 1000;
        if (dt >= 0.25) {
            const instant = (clamped - lastLoaded) / dt;
            if (instant >= 0) {
                speedBps = speedBps <= 0 ? instant : speedBps * 0.7 + instant * 0.3;
            }
            lastLoaded = clamped;
            lastAt = now;
        }
        onProgress({
            loadedBytes: clamped,
            totalBytes: total,
            percent: Math.min(100, Math.round((clamped / total) * 100)),
            speedBps: Math.round(speedBps),
            etaSeconds: speedBps > 0 && clamped < total ? (total - clamped) / speedBps : null,
        });
    };
    // Seed the first sample so ETA appears quickly.
    report(0);
    return { report };
}

async function readJsonSafe(res: Response): Promise<any> {
    const text = await res.text();
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        return { __rawResponseText: text };
    }
}

function uploadResponseError(data: any, status: number, stage: string): string {
    if (data?.message) return String(data.message);
    if (String(data?.__rawResponseText || '').trim()) {
        return `${stage} failed (status ${status}); the server returned a non-JSON error response. Check the backend logs for details.`;
    }
    return `${stage} failed (status ${status})`;
}

export class ChunkedUploadError extends Error {
    status: number;
    serverReceived: number | null;
    sessionGone: boolean;
    constructor(message: string, status = 0, serverReceived: number | null = null, sessionGone = false) {
        super(message);
        this.name = 'ChunkedUploadError';
        this.status = status;
        this.serverReceived = serverReceived;
        this.sessionGone = sessionGone;
    }
}

async function initSession(
    baseUrl: string,
    initAction: string,
    file: File,
    fields: Record<string, string>,
    resumeId?: string | null
): Promise<{ uploadId: string; received: number }> {
    const body = new FormData();
    body.append('file_name', file.name);
    body.append('file_size', String(file.size));
    if (resumeId) body.append('resume_id', resumeId);
    Object.entries(fields).forEach(([key, value]) => body.append(key, value));
    const res = await fetch(`${baseUrl}?action=${encodeURIComponent(initAction)}`, {
        method: 'POST',
        credentials: 'include',
        body,
    });
    const data = await readJsonSafe(res);
    if (!res.ok || !data?.success || !data?.data?.upload_id) {
        throw new ChunkedUploadError(uploadResponseError(data, res.status, 'Upload initialization'), res.status);
    }
    return { uploadId: String(data.data.upload_id), received: Number(data.data.received || 0) };
}

function postChunkXhr(
    baseUrl: string,
    chunkAction: string,
    uploadId: string,
    offset: number,
    blob: Blob,
    fileName: string,
    onChunkProgress: (chunkLoaded: number) => void
): Promise<number> {
    return new Promise((resolve, reject) => {
        const body = new FormData();
        body.append('upload_id', uploadId);
        body.append('offset', String(offset));
        body.append('chunk', blob, fileName);
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}?action=${encodeURIComponent(chunkAction)}`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onChunkProgress(e.loaded);
            else onChunkProgress(0);
        };
        xhr.onload = () => {
            let data: any = {};
            try {
                data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
            } catch {
                data = {};
            }
            if (xhr.status === 200) {
                const received = Number(data?.data?.received);
                if (Number.isFinite(received)) {
                    resolve(received);
                    return;
                }
                reject(new ChunkedUploadError('Invalid chunk response from server.', xhr.status));
                return;
            }
            const serverReceivedRaw = Number(data?.data?.received);
            const serverReceived = Number.isFinite(serverReceivedRaw) ? serverReceivedRaw : null;
            const gone = xhr.status === 404 || xhr.status === 410;
            reject(
                new ChunkedUploadError(
                    String(data?.message || `Chunk upload failed (status ${xhr.status})`),
                    xhr.status,
                    serverReceived,
                    gone
                )
            );
        };
        xhr.onerror = () => reject(new ChunkedUploadError('Network error while uploading.', 0));
        xhr.ontimeout = () => reject(new ChunkedUploadError('Upload timed out. Retry to continue.', 0));
        xhr.send(body);
    });
}

async function completeSession(baseUrl: string, completeAction: string, uploadId: string): Promise<any> {
    const body = new FormData();
    body.append('upload_id', uploadId);
    const res = await fetch(`${baseUrl}?action=${encodeURIComponent(completeAction)}`, {
        method: 'POST',
        credentials: 'include',
        body,
    });
    const data = await readJsonSafe(res);
    if (!res.ok || !data?.success) {
        throw new ChunkedUploadError(uploadResponseError(data, res.status, 'Finalizing upload'), res.status);
    }
    return data;
}

export async function abortSession(baseUrl: string, abortAction: string, uploadId: string | null): Promise<void> {
    if (!uploadId) return;
    try {
        const body = new FormData();
        body.append('upload_id', uploadId);
        await fetch(`${baseUrl}?action=${encodeURIComponent(abortAction)}`, {
            method: 'POST',
            credentials: 'include',
            body,
        });
    } catch {
        /* best-effort cleanup */
    }
}

export type ResumableUploadOptions = {
    baseUrl: string;
    initAction: string;
    chunkAction: string;
    completeAction: string;
    file: File;
    /** Endpoint-specific metadata fields sent at init (title, client_id, ...). */
    fields?: Record<string, string>;
    /** Mutable resume state kept by the caller across retries. */
    session: UploadSession;
    chunkSize?: number;
    onProgress?: (p: UploadProgress) => void;
};

/**
 * Upload a file in chunks, resuming from session.received. On failure the
 * session keeps the last server-confirmed offset, so the next call CONTINUES
 * instead of re-uploading. Resolves with the complete-action payload.
 */
export async function runResumableUpload(options: ResumableUploadOptions): Promise<any> {
    const {
        baseUrl,
        initAction,
        chunkAction,
        completeAction,
        file,
        fields = {},
        session,
        chunkSize = DEFAULT_UPLOAD_CHUNK_SIZE,
        onProgress,
    } = options;
    const total = file.size;
    if (total <= 0) throw new ChunkedUploadError('File is empty.', 400);

    const tracker = createProgressTracker(total, onProgress ?? (() => undefined));

    if (!session.uploadId) {
        const init = await initSession(baseUrl, initAction, file, fields);
        session.uploadId = init.uploadId;
        session.received = init.received;
    }
    tracker.report(session.received);

    let reinitAttempted = false;
    for (;;) {
        if (session.received >= total) break;
        const end = Math.min(total, session.received + Math.max(64 * 1024, chunkSize));
        const blob = file.slice(session.received, end);
        const base = session.received;
        try {
            const received = await postChunkXhr(baseUrl, chunkAction, session.uploadId as string, base, blob, file.name, (chunkLoaded) =>
                tracker.report(base + chunkLoaded)
            );
            session.received = Math.max(session.received, received);
            tracker.report(session.received);
        } catch (err) {
            if (err instanceof ChunkedUploadError) {
                if (err.sessionGone && !reinitAttempted) {
                    // Server lost the temp data (e.g. pruned): re-init once and
                    // continue from whatever the fresh session confirms.
                    reinitAttempted = true;
                    const init = await initSession(baseUrl, initAction, file, fields);
                    session.uploadId = init.uploadId;
                    session.received = init.received;
                    tracker.report(session.received);
                    continue;
                }
                if (err.serverReceived !== null && err.serverReceived >= 0) {
                    // Stale offset: resync to the server truth and continue.
                    session.received = Math.min(total, err.serverReceived);
                    tracker.report(session.received);
                    continue;
                }
            }
            throw err;
        }
    }

    let result: any;
    try {
        result = await completeSession(baseUrl, completeAction, session.uploadId as string);
    } catch (err) {
        if (err instanceof ChunkedUploadError) {
            // The endpoint answered, so it has already consumed the assembled
            // file — and this API deletes the temp session before running its
            // pipeline. A rejection (missing columns, failed validation) thus
            // leaves nothing to resume: keeping the dead id would make the
            // caller offer a "continue" retry that only 404s. Force a clean
            // restart of this file instead.
            session.uploadId = null;
            session.received = 0;
        }
        throw err;
    }
    session.uploadId = null;
    session.received = total;
    tracker.report(total);
    return result;
}
