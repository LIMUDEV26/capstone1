import { useState, useEffect, useRef, useMemo } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import Pagination from '../components/Pagination';
import CrudActionIcon from '../components/CrudActionIcon';
import FileIcon, { fileKindLabel } from '../components/FileIcon';
import UploadProgressBar from '../components/UploadProgressBar';
import {
    abortSession as abortChunkedSession,
    runResumableUpload,
    type UploadProgress,
    type UploadSession,
} from '@/utils/chunkedUpload';
import { confirmAction, promptAction, showLoadingModal, closeLoadingModal, notifyError, showCenteredCardNotification } from '@/utils/notify';
import { getApiBaseUrl, getAuthenticatedFileUrl } from '@/utils/network';
import SearchBar from '../components/SearchBar';
import ZeroResults from '../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import { Archive, Download, Share2, Upload, X } from 'lucide-react';
import styles from '../styles/Documents.module.css';

const API_BASE = getApiBaseUrl();

type FileCategory = 'pdf' | 'document' | 'spreadsheet' | 'presentation' | 'image' | 'video' | 'audio' | 'archive' | 'text' | 'code' | 'other';

const getFileExtension = (name: unknown) => String(name || '').split('.').pop()?.toLowerCase() || '';
const getFileCategory = (name: unknown, mime: unknown): FileCategory => {
    const ext = getFileExtension(name);
    const type = String(mime || '').toLowerCase();
    if (ext === 'pdf' || type.includes('pdf')) return 'pdf';
    if (['doc', 'docx', 'odt', 'rtf'].includes(ext) || type.includes('word')) return 'document';
    if (['xls', 'xlsx', 'csv', 'ods'].includes(ext) || type.includes('spreadsheet') || type.includes('excel')) return 'spreadsheet';
    if (['ppt', 'pptx', 'odp'].includes(ext) || type.includes('presentation') || type.includes('powerpoint')) return 'presentation';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(ext) || type.startsWith('image/')) return 'image';
    if (['mp4', 'mov', 'webm', 'avi'].includes(ext) || type.startsWith('video/')) return 'video';
    if (['mp3', 'wav', 'ogg', 'm4a'].includes(ext) || type.startsWith('audio/')) return 'audio';
    if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
    if (['txt', 'md'].includes(ext) || type.startsWith('text/plain')) return 'text';
    if (['js', 'ts', 'tsx', 'jsx', 'php', 'py', 'java', 'html', 'css', 'json', 'xml', 'sql'].includes(ext)) return 'code';
    return 'other';
};

const FILE_CATEGORY_LABELS: Record<FileCategory, string> = {
    pdf: 'PDF', document: 'Documents', spreadsheet: 'Spreadsheets', presentation: 'Presentations',
    image: 'Images', video: 'Video', audio: 'Audio', archive: 'Archives', text: 'Text', code: 'Code', other: 'Other',
};

const FILE_CATEGORY_COLORS: Record<FileCategory, string> = {
    pdf: '#dc2626', document: '#2563eb', spreadsheet: '#16803c', presentation: '#ea580c',
    image: '#7c3aed', video: '#db2777', audio: '#4f46e5', archive: '#ca8a04', text: '#64748b', code: '#0f766e', other: '#64748b',
};

const getDocumentIdentity = (doc: any): string => {
    const name = String(doc?.file_name || '').trim().toLowerCase();
    const size = Number(doc?.file_size || 0);
    return name && size > 0 ? `${name}::${size}` : `id::${Number(doc?.id || 0)}`;
};

export default function DocumentsPage() {
    const router = useRouter();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [user, setUser] = useState<any>(null);
    const [activeTab, setActiveTab] = useState<'library' | 'contracts' | 'received'>('library');
    const [loading, setLoading] = useState(true);

    // Data
    const [receivedDocs, setReceivedDocs] = useState<any[]>([]);
    const [clients, setClients] = useState<any[]>([]);
    const [employees, setEmployees] = useState<any[]>([]);
    const [projects, setProjects] = useState<any[]>([]);

    // Central library (all uploads across the system)
    const [libraryDocs, setLibraryDocs] = useState<any[]>([]);
    const [libLoading, setLibLoading] = useState(false);
    const [libFilters, setLibFilters] = useState({ search: '', client_id: '', document_type: '', source: '', status: 'active' });
    const [libPage, setLibPage] = useState(1);
    const [libDropdown, setLibDropdown] = useState<number | null>(null);
    const [libView, setLibView] = useState<'table' | 'cards'>('table');
    const [libFileCategory, setLibFileCategory] = useState<'all' | FileCategory>('all');
    const [libSort, setLibSort] = useState<'modified' | 'uploaded' | 'name' | 'size' | 'type' | 'owner'>('modified');
    const [selectedLibraryIds, setSelectedLibraryIds] = useState<number[]>([]);
    const [showUploadModal, setShowUploadModal] = useState(false);
    const [uploadForm, setUploadForm] = useState({ document_type: 'Other', client_id: '', task_id: '', project_id: '', notes: '' });
    type UploadLaneStatus = 'queued' | 'uploading' | 'done' | 'error';
    type UploadLane = { key: string; file: File; title: string; status: UploadLaneStatus; error: string | null; retryable: boolean; progress: UploadProgress | null };
    const [uploadFiles, setUploadFiles] = useState<UploadLane[]>([]);
    const [uploading, setUploading] = useState(false);
    const [uploadTasks, setUploadTasks] = useState<any[]>([]);
    // Synchronous mirror of the lanes so batch completion can be decided
    // after async uploads without waiting for React state to flush.
    // IMPORTANT: update the ref synchronously (not inside the setState
    // updater) so reads right after uploadSingleLane see the latest status.
    const uploadFilesRef = useRef<UploadLane[]>([]);
    const setLanes = (next: UploadLane[] | ((prev: UploadLane[]) => UploadLane[])) => {
        const prev = uploadFilesRef.current;
        const resolved = typeof next === 'function' ? (next as (p: UploadLane[]) => UploadLane[])(prev) : next;
        uploadFilesRef.current = resolved;
        setUploadFiles(resolved);
    };
    const [editingDoc, setEditingDoc] = useState<any>(null);
    const [editForm, setEditForm] = useState({ title: '', document_type: 'Other', client_id: '', task_id: '', project_id: '', notes: '', status: 'active' });
    const [viewDoc, setViewDoc] = useState<any>(null);

    // Contracts in the library
    const [contracts, setContracts] = useState<any[]>([]);
    const [contractsLoading, setContractsLoading] = useState(false);
    const [contractsPage, setContractsPage] = useState(1);
    const [contractDropdown, setContractDropdown] = useState<number | null>(null);
    const [contractView, setContractView] = useState<'table' | 'cards'>('cards');
    const [showArchivedContracts, setShowArchivedContracts] = useState(false);
    // Contracts-tab filters (client-side, based on contract details).
    const [contractFilters, setContractFilters] = useState({ search: '', client_id: '', status: 'all' });
    const contractStatusKey = (c: any): string => {
        if (Number(c?.is_signed) === 1 || (c as any)?.signed_contract_file) return 'signed';
        const status = String(c?.status || '').toLowerCase();
        if (status === 'accepted') return 'accepted';
        if (status === 'rejected') return 'rejected';
        if (status === 'expired') return 'expired';
        const deadline = (c as any)?.project_deadline as string | null | undefined;
        if (deadline && !Number.isNaN(new Date(deadline).getTime()) && new Date(deadline) < new Date()) return 'expired';
        return 'pending';
    };
    const filteredContracts = useMemo(() => {
        const term = contractFilters.search.trim().toLowerCase();
        return contracts.filter((c: any) => {
            if (contractFilters.client_id && String(c?.client_id ?? '') !== String(contractFilters.client_id)) return false;
            if (contractFilters.status !== 'all' && contractStatusKey(c) !== contractFilters.status) return false;
            if (!term) return true;
            return [c?.title, c?.client_name].join(' ').toLowerCase().includes(term);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contracts, contractFilters]);

    const DOC_TYPES = ['Contract', 'Report', 'Receipt', 'ID', 'Certificate', 'Letter', 'Form', 'Other'];
    const DOC_SOURCES: Array<{ value: string; label: string }> = [
        { value: 'upload', label: 'Direct Upload' },
        { value: 'task_submission', label: 'Task Submission' },
        { value: 'task_attachment', label: 'Task Attachment' },
        { value: 'contract_file', label: 'Signed Contract' },
        { value: 'received', label: 'Received Document' },
    ];
    const docSourceLabel = (value: string) => DOC_SOURCES.find(s => s.value === value)?.label || value || '-';
    const isAdminUser = String(user?.role || '').toLowerCase() === 'admin';
    const docDownloadUrl = (filePath: string) => getAuthenticatedFileUrl(filePath);
    const formatFileSize = (bytes: unknown) => {
        const n = Number(bytes || 0);
        if (!n) return '-';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
        return `${(n / (1024 * 1024)).toFixed(2)} MB`;
    };

    // Task Integration Data
    const [tasks, setTasks] = useState<any[]>([]);

    // UI
    const [search, setSearch] = useState('');
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [modalData, setModalData] = useState<any>({});
    const [modalMode, setModalMode] = useState<'create' | 'edit'>('create');
    const [submitting, setSubmitting] = useState(false);
    const [updatingStatusId, setUpdatingStatusId] = useState<number | null>(null);
    const [msg, setMsg] = useState<string | null>(null);
    const [receivedPage, setReceivedPage] = useState(1);
    // Received-tab filters (client-side; search stays server-side).
    const [receivedFilters, setReceivedFilters] = useState({ client_id: '', status: 'all' });

    type ClientService = {
        service_id: number;
        service_name: string;
    };

    useEffect(() => { checkSession(); }, []);

    const checkSession = async () => {
        try {
            const [authRes] = await Promise.all([
                fetch(`${API_BASE}/auth.php`, { credentials: 'include' }),
                fetchInitialData(),
            ]);
            const data = await authRes.json();
            if (data.success) {
                setUser(data.data);
            } else {
                router.push('/');
            }
        } catch { router.push('/'); } finally { setLoading(false); }
    };

    const fetchInitialData = async () => {
        fetchReceived();
        fetchClients();
        fetchEmployees();
        fetchLibrary();
        fetchContracts();
    };

    const fetchReceived = async () => {
        try {
            const res = await fetch(`${API_BASE}/documents.php?action=list_received&search=${encodeURIComponent(search)}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setReceivedDocs(data.data || []);
        } catch { }
    };

    const fetchClients = async () => {
        try {
            const res = await fetch(`${API_BASE}/clients.php`, { credentials: 'include' });
            const data = await res.json();
            setClients(data.data || []);
        } catch { }
    };

    const fetchEmployees = async () => {
        try {
            const res = await fetch(`${API_BASE}/employees.php`, { credentials: 'include' });
            const data = await res.json();
            setEmployees(data.data || []);
        } catch { }
    };

    // Task Integration Fetches
    const fetchTasksByClient = async (client_id: number) => {
        try {
            // Fetch tasks for client (spanning all projects)
            const res = await fetch(`${API_BASE}/tasks.php?client_id=${client_id}`, { credentials: 'include' });
            const data = await res.json();
            setTasks(data.data || []);
        } catch { setTasks([]); }
    };

    const fetchProjectsByClient = async (client_id: number) => {
        try {
            const res = await fetch(`${API_BASE}/projects.php?client_id=${client_id}`, { credentials: 'include' });
            const data = await res.json();
            setProjects(Array.isArray(data.data) ? data.data : []);
        } catch { setProjects([]); }
    };

    // ── Central library ──────────────────────────────────────────────
    const fetchLibrary = async (filters = libFilters) => {
        setLibLoading(true);
        try {
            const params = new URLSearchParams();
            if (filters.search.trim()) params.set('search', filters.search.trim());
            if (filters.client_id) params.set('client_id', filters.client_id);
            if (filters.document_type) params.set('document_type', filters.document_type);
            if (filters.source) params.set('source', filters.source);
            params.set('status', filters.status || 'all');
            const res = await fetch(`${API_BASE}/document-management.php?${params.toString()}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setLibraryDocs(Array.isArray(data.data) ? data.data : []);
        } catch { /* keep previous list */ } finally {
            setLibLoading(false);
        }
    };

    const fetchContracts = async (archived = showArchivedContracts) => {
        setContractsLoading(true);
        try {
            const res = await fetch(`${API_BASE}/contracts.php${archived ? '?archived=1' : ''}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setContracts(Array.isArray(data.data) ? data.data : []);
        } catch { /* keep previous list */ } finally {
            setContractsLoading(false);
        }
    };

    const ALLOWED_UPLOAD_EXTS = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

    const laneTitleFromFile = (file: File) => {
        const name = String(file?.name || '').trim() || 'Document';
        return name.replace(/\.[^.]+$/, '') || name;
    };

    const resetUploadModal = () => {
        laneSessions.current.forEach((session, key) => dropLaneSession(key, true));
        setShowUploadModal(false);
        setUploadForm({ document_type: 'Other', client_id: '', task_id: '', project_id: '', notes: '' });
        setLanes([]);
        setUploadTasks([]);
        setProjects([]);
    };

    const addUploadFiles = (list: FileList | File[] | null) => {
        if (!list) return;
        const incoming: UploadLane[] = [];
        Array.from(list).forEach((file) => {
            const ext = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
            const key = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
            if (!ALLOWED_UPLOAD_EXTS.includes(ext)) {
                incoming.push({ key, file, title: laneTitleFromFile(file), status: 'error', error: 'Only PDF, JPG, PNG, or WEBP files are allowed.', retryable: false, progress: null });
            } else if (file.size > MAX_UPLOAD_BYTES) {
                incoming.push({ key, file, title: laneTitleFromFile(file), status: 'error', error: 'File must be 10MB or less.', retryable: false, progress: null });
            } else if (file.size <= 0) {
                incoming.push({ key, file, title: laneTitleFromFile(file), status: 'error', error: 'File is empty.', retryable: false, progress: null });
            } else {
                incoming.push({ key, file, title: laneTitleFromFile(file), status: 'queued', error: null, retryable: false, progress: null });
            }
        });
        if (incoming.length > 0) setLanes((prev) => [...prev, ...incoming]);
    };

    // Resume sessions per lane: kept across retries so a retry CONTINUES
    // from the last server-confirmed byte instead of re-uploading.
    const laneSessions = useRef<Map<string, UploadSession>>(new Map());
    const getLaneSession = (key: string): UploadSession => {
        let session = laneSessions.current.get(key);
        if (!session) {
            session = { uploadId: null, received: 0 };
            laneSessions.current.set(key, session);
        }
        return session;
    };
    const dropLaneSession = (key: string, abort = false) => {
        const session = laneSessions.current.get(key);
        laneSessions.current.delete(key);
        if (abort && session?.uploadId) {
            void abortChunkedSession(`${API_BASE}/document-management.php`, 'upload_abort', session.uploadId);
        }
    };

    const updateUploadLane = (key: string, patch: Partial<UploadLane>) => {
        setLanes((prev) => prev.map((lane) => (lane.key === key ? { ...lane, ...patch } : lane)));
    };

    const removeUploadLane = (key: string) => {
        const lane = uploadFilesRef.current.find((l) => l.key === key);
        if (lane && lane.status !== 'uploading') dropLaneSession(key, true);
        setLanes((prev) => prev.filter((l) => l.key !== key || l.status === 'uploading'));
    };

    const uploadSingleLane = async (lane: UploadLane): Promise<boolean> => {
        updateUploadLane(lane.key, { status: 'uploading', error: null, retryable: false, progress: null });
        try {
            // Re-read the title from the ref at send time in case it was edited mid-batch.
            const freshTitle = (uploadFilesRef.current.find((l) => l.key === lane.key)?.title ?? lane.title).trim();
            await runResumableUpload({
                baseUrl: `${API_BASE}/document-management.php`,
                initAction: 'upload_init',
                chunkAction: 'upload_chunk',
                completeAction: 'upload_complete',
                file: lane.file,
                fields: {
                    title: freshTitle,
                    document_type: uploadForm.document_type,
                    client_id: uploadForm.client_id,
                    ...(uploadForm.task_id ? { task_id: uploadForm.task_id } : {}),
                    ...(uploadForm.project_id ? { project_id: uploadForm.project_id } : {}),
                    ...(uploadForm.notes.trim() ? { notes: uploadForm.notes.trim() } : {}),
                },
                session: getLaneSession(lane.key),
                onProgress: (progress) => updateUploadLane(lane.key, { progress }),
            });
            dropLaneSession(lane.key);
            updateUploadLane(lane.key, {
                status: 'done',
                error: null,
                retryable: false,
                progress: { loadedBytes: lane.file.size, totalBytes: lane.file.size, percent: 100, speedBps: 0, etaSeconds: null },
            });
            return true;
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Upload failed.';
            const continuing = getLaneSession(lane.key).received > 0;
            updateUploadLane(lane.key, {
                status: 'error',
                // Retry resumes from the confirmed offset — it continues.
                error: continuing ? `${message} — retry continues from ${Math.round((getLaneSession(lane.key).received / Math.max(1, lane.file.size)) * 100)}%.` : message,
                retryable: true,
            });
            return false;
        }
    };

    const finishUploadBatchIfComplete = async () => {
        const lanes = uploadFilesRef.current;
        if (lanes.length === 0) return;
        const pending = lanes.filter((lane) => lane.status === 'queued' || lane.status === 'uploading' || (lane.status === 'error' && lane.retryable));
        if (pending.length > 0) {
            if (lanes.some((lane) => lane.status === 'error')) {
                void notifyError('Some files failed to upload. Retry each failed file below.');
            }
            return;
        }
        const blocked = lanes.filter((lane) => lane.status === 'error' && !lane.retryable);
        const done = lanes.filter((lane) => lane.status === 'done').length;
        if (blocked.length > 0) {
            void notifyError('Some files cannot be uploaded (invalid type or size). Remove them to continue.');
            return;
        }
        if (done > 0) {
            // Close the floating upload form immediately so it never sticks
            // around after success, then refresh the list lively.
            const doneCount = done;
            resetUploadModal();
            setLibPage(1);
            // Fetch with explicit active-first filters so the new uploads are
            // visible even if the user had paged or filtered before.
            await fetchLibrary({ ...libFilters, status: libFilters.status || 'active' });
            void showCenteredCardNotification(
                doneCount === 1 ? 'Document uploaded successfully.' : `${doneCount} documents uploaded successfully.`,
                { title: 'Uploaded' }
            );
        }
    };

    const runPendingUploadLanes = async (lanes: UploadLane[]) => {
        setUploading(true);
        try {
            for (const lane of lanes) {
                const latest = uploadFilesRef.current.find((l) => l.key === lane.key) || lane;
                if (latest.status !== 'queued' && !(latest.status === 'error' && latest.retryable)) continue;
                // Title is re-read from the ref at send time in case it was edited mid-batch.
                await uploadSingleLane(latest);
            }
        } finally {
            setUploading(false);
            await finishUploadBatchIfComplete();
        }
    };

    const handleUploadSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!uploadForm.client_id) {
            void notifyError('Please choose whose client this document belongs to.');
            return;
        }
        const actionable = uploadFiles.filter((lane) => lane.status === 'queued' || (lane.status === 'error' && lane.retryable));
        if (uploadFiles.length === 0) {
            void notifyError('Please choose at least one file to upload (PDF, JPG, PNG, or WEBP, max 10MB each).');
            return;
        }
        if (actionable.length === 0) {
            void notifyError('No pending files to upload. Remove finished files or retry failed ones.');
            return;
        }
        const missingTitle = actionable.find((lane) => !lane.title.trim());
        if (missingTitle) {
            void notifyError('Each file needs a title.');
            return;
        }
        await runPendingUploadLanes(actionable);
    };

    const retryUploadLane = async (key: string) => {
        if (!uploadForm.client_id) {
            void notifyError('Please choose whose client this document belongs to.');
            return;
        }
        const lane = uploadFiles.find((l) => l.key === key);
        if (!lane || lane.status === 'uploading' || lane.status === 'done') return;
        if (!lane.title.trim()) {
            void notifyError('Each file needs a title.');
            return;
        }
        await runPendingUploadLanes([lane]);
    };

    const openEditDoc = (doc: any) => {
        setEditingDoc(doc);
        const docClientId = doc.client_id ? String(doc.client_id) : '';
        setEditForm({
            title: doc.title || '',
            document_type: doc.document_type || 'Other',
            client_id: docClientId,
            task_id: doc.task_id ? String(doc.task_id) : '',
            project_id: doc.project_id ? String(doc.project_id) : '',
            notes: doc.notes || '',
            status: doc.status || 'active',
        });
        setUploadTasks([]);
        setProjects([]);
        if (docClientId) {
            void fetchTasksByClient(Number(docClientId));
            void fetchProjectsByClient(Number(docClientId));
        }
        setLibDropdown(null);
    };

    const handleEditDocSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!editingDoc) return;
        setUploading(true);
        try {
            const res = await fetch(`${API_BASE}/document-management.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    id: editingDoc.id,
                    title: editForm.title.trim(),
                    document_type: editForm.document_type,
                    client_id: editForm.client_id ? Number(editForm.client_id) : undefined,
                    task_id: editForm.task_id ? Number(editForm.task_id) : null,
                    project_id: editForm.project_id ? Number(editForm.project_id) : null,
                    notes: editForm.notes,
                    status: editForm.status,
                }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setEditingDoc(null);
                await fetchLibrary();
                void showCenteredCardNotification('Document updated successfully.', { title: 'Saved' });
            } else {
                void notifyError(data.message || 'Update failed.');
            }
        } catch {
            void notifyError('Network error while updating.');
        } finally {
            setUploading(false);
        }
    };

    const handleArchiveDoc = async (doc: any, archive: boolean) => {
        setLibDropdown(null);
        try {
            const res = await fetch(`${API_BASE}/document-management.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: doc.id, status: archive ? 'archived' : 'active' }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                const nextStatus = archive ? 'archived' : 'active';
                const identity = getDocumentIdentity(doc);
                setLibraryDocs((current) => {
                    if (libFilters.status && libFilters.status !== nextStatus) {
                        return current.filter((item) => getDocumentIdentity(item) !== identity);
                    }
                    return current.map((item) => getDocumentIdentity(item) === identity ? { ...item, status: nextStatus } : item);
                });
                await fetchLibrary({ ...libFilters });
            } else {
                void notifyError(data.message || 'Failed to update status.');
            }
        } catch {
            void notifyError('Network error.');
        }
    };

    const handleDeleteDoc = async (doc: any) => {
        setLibDropdown(null);
        const confirmed = await confirmAction({
            title: 'Delete document?',
            text: `"${doc.title}" will be permanently removed from the library.${doc.source === 'upload' ? ' Its file will also be deleted.' : ' The original file stays intact.'}`,
            confirmButtonText: 'Delete',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;
        try {
            const res = await fetch(`${API_BASE}/document-management.php?action=delete&id=${doc.id}`, {
                method: 'POST',
                credentials: 'include',
            });
            const data = await res.json();
            if (res.ok && data.success) {
                await fetchLibrary();
            } else {
                void notifyError(data.message || 'Delete failed.');
            }
        } catch {
            void notifyError('Network error.');
        }
    };

    const handleToggleContractArchive = async (contract: any) => {
        setContractDropdown(null);
        try {
            const res = await fetch(`${API_BASE}/contracts.php?action=toggle_archive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: contract.id }),
            });
            const data = await res.json();
            if (res.ok && data.success) {
                await fetchContracts();
            } else {
                void notifyError(data.message || 'Failed to update contract.');
            }
        } catch {
            void notifyError('Network error.');
        }
    };

    // Debounce search
    useEffect(() => {
        const timer = setTimeout(() => {
            if (activeTab === 'received') fetchReceived();
        }, 500);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [search]);

    // Debounced library search (filter changes refetch immediately below).
    useEffect(() => {
        const timer = setTimeout(() => {
            if (activeTab === 'library') {
                setLibPage(1);
                void fetchLibrary({ ...libFilters });
            }
        }, 500);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [libFilters.search]);

    // Close row dropdowns on outside click.
    useEffect(() => {
        const close = () => { setLibDropdown(null); setContractDropdown(null); };
        document.addEventListener('click', close);
        return () => document.removeEventListener('click', close);
    }, []);

    useEffect(() => {
        try {
            const saved = localStorage.getItem('documents:library-view');
            if (saved === 'table' || saved === 'cards') setLibView(saved);
            else if (window.innerWidth < 700) setLibView('cards');
        } catch { /* browser storage may be unavailable */ }
    }, []);

    useEffect(() => {
        try { localStorage.setItem('documents:library-view', libView); } catch { /* browser storage may be unavailable */ }
    }, [libView]);

    useEffect(() => {
        try {
            const saved = localStorage.getItem('documents:contracts-view');
            if (saved === 'table' || saved === 'cards') setContractView(saved);
        } catch { /* browser storage may be unavailable */ }
    }, []);

    useEffect(() => {
        try { localStorage.setItem('documents:contracts-view', contractView); } catch { /* browser storage may be unavailable */ }
    }, [contractView]);

    const handleUploadClientChange = (clientId: string) => {
        setUploadForm(prev => ({ ...prev, client_id: clientId, task_id: '', project_id: '' }));
        setUploadTasks([]);
        setProjects([]);
        if (clientId) {
            void fetchTasksByClient(Number(clientId));
            void fetchProjectsByClient(Number(clientId));
        }
    };

    const handleEditDocClientChange = (clientId: string) => {
        setEditForm(prev => ({ ...prev, client_id: clientId, task_id: '', project_id: '' }));
        setUploadTasks([]);
        setProjects([]);
        if (clientId) {
            void fetchTasksByClient(Number(clientId));
            void fetchProjectsByClient(Number(clientId));
        }
    };

    const getClientServices = (clientId: string | number | undefined | null): ClientService[] => {
        const cid = Number(clientId);
        if (!cid) return [];
        const client = clients.find(c => Number(c.client_id) === cid);
        return Array.isArray(client?.services) ? (client.services as ClientService[]) : [];
    };

    const handleOpenModal = (mode: 'create' | 'edit', item: any = {}) => {
        setModalMode(mode);
        const initialData = item.document_id
            ? item
            : { received_date: new Date().toISOString().split('T')[0], status: 'received' };

        setModalData(initialData);

        if (item.client_id) {
            fetchTasksByClient(item.client_id);
        } else {
            setTasks([]);
        }

        setIsModalOpen(true);
        setMsg(null);
    };

    const handleClientChange = (clientId: string) => {
        const cid = parseInt(clientId);
        const services = getClientServices(clientId);
        const defaultType = services.length > 0 ? services[0].service_name : '';
        setModalData((prev: Record<string, unknown>) => ({
            ...prev,
            client_id: clientId,
            task_id: null,
            document_type: defaultType
        }));
        if (cid) fetchTasksByClient(cid);
        else setTasks([]);
    };

    const handleTaskChange = (taskId: string) => {
        const tId = parseInt(taskId);
        const task = tasks.find(t => t.id === tId);
        setModalData((prev: Record<string, unknown>) => {
            const services = getClientServices(prev.client_id as string | number | undefined | null);
            const defaultType = services.length > 0 ? services[0].service_name : '';

            return {
                ...prev,
                task_id: taskId,
                document_name: task ? task.title : (prev.document_name as string | undefined),
                document_type: task && task.service_name ? task.service_name : ((prev.document_type as string | undefined) || defaultType)
            };
        });
    };

    const notifyTaskCalendarSync = () => {
        if (typeof window === 'undefined') return;
        const stamp = String(Date.now());
        try {
            localStorage.setItem('capstone_tasks_sync', stamp);
        } catch {
            // Ignore storage errors (private mode, quota, etc.)
        }
        window.dispatchEvent(new CustomEvent('capstone:tasks-sync', { detail: { source: 'documents', stamp } }));
    };

    const promptToSendLinkedTaskReport = async (taskId: number, clientId?: number | string | null, taskTitle?: string) => {
        if (!taskId) return;

        const linkedTask = tasks.find((entry) => Number(entry?.id) === Number(taskId));
        const linkedClient = clients.find((entry) => Number(entry?.client_id) === Number(clientId));
        const clientLabel = linkedClient?.client_name || 'this client';
        const isResend = Number(linkedTask?.has_completion_report ?? 0) === 1;

        const shouldSend = await confirmAction({
            title: isResend ? 'Resend completion report?' : 'Send completion report?',
            text: `Document saved successfully. Do you want to ${isResend ? 'resend' : 'send'} the completion report to ${clientLabel} now?`,
            confirmButtonText: isResend ? 'Resend report' : 'Send report',
            cancelButtonText: 'Later',
            icon: 'question',
        });
        if (!shouldSend) return;

        const reportDefault = `Task "${linkedTask?.title || taskTitle || 'Task'}" for client "${clientLabel}" has been completed successfully.`;
        const promptLabel = isResend
            ? 'Update and resend completion report for the client (optional):'
            : 'Enter completion report for the client (optional):';
        const reportBody = await promptAction({
            title: isResend ? 'Resend completion report' : 'Send completion report',
            text: `Review the message before sending it to ${clientLabel}.`,
            inputLabel: promptLabel,
            inputValue: reportDefault,
            confirmButtonText: isResend ? 'Resend report' : 'Send report',
            cancelButtonText: 'Cancel',
            icon: 'question',
            large: true, // Use large textarea for better editing
        });
        if (reportBody === null) return;

        // Show loading modal with clock loader
        showLoadingModal(
            'Sending Completion Report...',
            'Preparing and sending report to client. This may take a moment...'
        );

        try {
            const res = await fetch(`${API_BASE}/task-reports.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    task_id: taskId,
                    report_body: reportBody.trim(),
                }),
            });
            const data = await res.json();
            if (!data.success) {
                closeLoadingModal();
                const errorMessage = data.message || 'Failed to send completion report.';
                // Check if it's the client email validation error
                if (errorMessage.includes('client email must be a valid')) {
                    showCenteredCardNotification(errorMessage, {
                        title: 'Cannot Send Report',
                        icon: 'warning',
                        duration: 5000,
                        showActionButton: true,
                        actionButtonText: 'Edit client data',
                        onActionClick: () => {
                            if (clientId) {
                                router.push(`/clients?edit=${clientId}`);
                            } else {
                                router.push('/clients');
                            }
                        },
                    });
                } else {
                    notifyError(errorMessage);
                }
                return;
            }
            closeLoadingModal();
            // Success notification auto-shown via global fetch wrapper
            if (clientId) {
                await fetchTasksByClient(Number(clientId));
            }
        } catch {
            closeLoadingModal();
            notifyError('Failed to send completion report.');
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSubmitting(true);
        try {
            const action = modalMode === 'create' ? 'create_received' : 'update_received';

            const payload = modalMode === 'create'
                ? { ...modalData, status: 'received' }
                : modalData;

            const res = await fetch(`${API_BASE}/documents.php?action=${action}`, {
                method: modalMode === 'create' ? 'POST' : 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                setMsg('Saved successfully!');
                setIsModalOpen(false);
                setReceivedDocs(prev => {
                    if (modalMode === 'edit') {
                        return prev.map(doc => doc.document_id === modalData.document_id ? { ...doc, ...modalData } : doc);
                    }
                    return [{ ...modalData, status: 'received', document_id: Date.now() }, ...prev];
                });
                notifyTaskCalendarSync();

                const linkedTaskId = Number(payload.task_id || 0);
                if (modalMode === 'create' && linkedTaskId > 0) {
                    await promptToSendLinkedTaskReport(
                        linkedTaskId,
                        payload.client_id as number | string | null | undefined,
                        String(payload.document_name || '')
                    );
                }
            } else {
                alert(data.message || 'Error saving');
            }
        } catch { alert('Network error'); }
        setSubmitting(false);
    };

    const handleArchive = async (id: number) => {
        if (!(await confirmAction({
            title: 'Archive this document record?',
            text: 'This will hide it from active document lists.',
            confirmButtonText: 'Archive',
            icon: 'warning',
            danger: true
        }))) return;

        try {
            const res = await fetch(`${API_BASE}/documents.php?action=update_received`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ document_id: id, status: 'archived' })
            });
            const data = await res.json();
            if (data.success) {
                setReceivedDocs(prev => prev.filter(doc => doc.document_id !== id));
                notifyTaskCalendarSync();
            } else {
                alert(data.message || 'Failed to archive document');
            }
        } catch { }
    };

    const handleChangeReceivedStatus = async (documentId: number, status: string) => {
        setUpdatingStatusId(documentId);
        try {
            const res = await fetch(`${API_BASE}/documents.php?action=update_received`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ document_id: documentId, status })
            });
            const data = await res.json();
            if (data.success) {
                setReceivedDocs(prev =>
                    prev.map(doc => doc.document_id === documentId ? { ...doc, status } : doc)
                );
                notifyTaskCalendarSync();
            } else {
                alert(data.message || 'Failed to update status');
            }
        } catch {
            alert('Network error while updating status');
        } finally {
            setUpdatingStatusId(null);
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'received': return '#3b82f6';
            case 'processing': return '#eab308';
            case 'completed': return '#22c55e';
            case 'archived': return '#64748b';
            case 'pending': return '#f97316';
            case 'submitted': return '#3b82f6';
            case 'accepted': return '#22c55e';
            case 'rejected': return '#ef4444';
            default: return '#64748b';
        }
    };

    const uniqueLibraryDocs = useMemo(() => {
        const unique = new Map<string, any>();
        libraryDocs.forEach((doc) => {
            const identity = getDocumentIdentity(doc);
            if (!unique.has(identity)) unique.set(identity, doc);
        });
        return Array.from(unique.values());
    }, [libraryDocs]);

    const libraryCategoryCounts = useMemo(() => {
        const counts = new Map<FileCategory, number>();
        uniqueLibraryDocs.forEach((doc) => {
            const category = getFileCategory(doc.file_name, doc.mime_type);
            counts.set(category, (counts.get(category) || 0) + 1);
        });
        return counts;
    }, [uniqueLibraryDocs]);

    const visibleLibraryDocs = useMemo(() => {
        const rows = libFileCategory === 'all'
            ? [...uniqueLibraryDocs]
            : uniqueLibraryDocs.filter((doc) => getFileCategory(doc.file_name, doc.mime_type) === libFileCategory);
        const time = (value: unknown) => {
            const parsed = new Date(String(value || '')).getTime();
            return Number.isFinite(parsed) ? parsed : 0;
        };
        rows.sort((a, b) => {
            if (libSort === 'name') return String(a.title || a.file_name || '').localeCompare(String(b.title || b.file_name || ''));
            if (libSort === 'size') return Number(b.file_size || 0) - Number(a.file_size || 0);
            if (libSort === 'type') return FILE_CATEGORY_LABELS[getFileCategory(a.file_name, a.mime_type)].localeCompare(FILE_CATEGORY_LABELS[getFileCategory(b.file_name, b.mime_type)]);
            if (libSort === 'owner') return String(a.uploaded_by_name || '').localeCompare(String(b.uploaded_by_name || ''));
            if (libSort === 'uploaded') return time(b.created_at) - time(a.created_at);
            return time(b.updated_at || b.created_at) - time(a.updated_at || a.created_at);
        });
        return rows;
    }, [uniqueLibraryDocs, libFileCategory, libSort]);

    const libraryStats = useMemo(() => {
        const recentThreshold = Date.now() - (7 * 24 * 60 * 60 * 1000);
        return {
            total: uniqueLibraryDocs.length,
            recent: uniqueLibraryDocs.filter((doc) => new Date(doc.created_at || 0).getTime() >= recentThreshold).length,
            linked: uniqueLibraryDocs.filter((doc) => doc.project_id || doc.task_id).length,
            archived: uniqueLibraryDocs.filter((doc) => String(doc.status).toLowerCase() === 'archived').length,
            bytes: uniqueLibraryDocs.reduce((sum, doc) => sum + Number(doc.file_size || 0), 0),
        };
    }, [uniqueLibraryDocs]);

    useEffect(() => {
        setSelectedLibraryIds((current) => current.filter((id) => visibleLibraryDocs.some((doc) => Number(doc.id) === id)));
        const pages = Math.max(1, Math.ceil(visibleLibraryDocs.length / ITEMS_PER_PAGE));
        if (libPage > pages) setLibPage(pages);
    }, [visibleLibraryDocs, ITEMS_PER_PAGE, libPage]);

    const toggleLibrarySelection = (id: number) => {
        setSelectedLibraryIds((current) => current.includes(id) ? current.filter((value) => value !== id) : [...current, id]);
    };

    const selectedLibraryDocs = visibleLibraryDocs.filter((doc) => selectedLibraryIds.includes(Number(doc.id)));
    const currentLibraryPage = visibleLibraryDocs.slice((libPage - 1) * ITEMS_PER_PAGE, libPage * ITEMS_PER_PAGE);
    const allCurrentPageSelected = currentLibraryPage.length > 0 && currentLibraryPage.every((doc) => selectedLibraryIds.includes(Number(doc.id)));

    const downloadSelectedDocuments = () => {
        selectedLibraryDocs.filter((doc) => doc.file_path).forEach((doc, index) => {
            window.setTimeout(() => {
                const link = document.createElement('a');
                link.href = docDownloadUrl(doc.file_path);
                link.target = '_blank';
                link.rel = 'noopener noreferrer';
                document.body.appendChild(link);
                link.click();
                link.remove();
            }, index * 150);
        });
    };

    const shareSelectedDocuments = async () => {
        const links = selectedLibraryDocs.filter((doc) => doc.file_path).map((doc) => `${doc.title}: ${docDownloadUrl(doc.file_path)}`);
        if (links.length === 0) return;
        try {
            await navigator.clipboard.writeText(links.join('\n'));
            void showCenteredCardNotification(`${links.length} document link${links.length === 1 ? '' : 's'} copied.`, { title: 'Ready to share' });
        } catch {
            void notifyError('Your browser blocked clipboard access. Open each document and use Download instead.');
        }
    };

    const archiveSelectedDocuments = async () => {
        const restoring = libFilters.status === 'archived';
        const nextStatus = restoring ? 'active' : 'archived';
        if (!(await confirmAction({ title: `${restoring ? 'Restore' : 'Archive'} selected documents?`, text: `${selectedLibraryDocs.length} document${selectedLibraryDocs.length === 1 ? '' : 's'} will ${restoring ? 'return to Active Documents' : 'move to Archive Storage'}.`, confirmButtonText: restoring ? 'Restore' : 'Archive', icon: 'warning' }))) return;
        const selectedIdentities = new Set(selectedLibraryDocs.map((doc) => getDocumentIdentity(doc)));
        await Promise.all(selectedLibraryDocs.map((doc) => fetch(`${API_BASE}/document-management.php`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
            body: JSON.stringify({ id: doc.id, status: nextStatus }),
        })));
        setLibraryDocs((current) => current.filter((doc) => !selectedIdentities.has(getDocumentIdentity(doc))));
        setSelectedLibraryIds([]);
        await fetchLibrary({ ...libFilters });
    };

    const renderDocumentPreview = (doc: any) => {
        if (!doc?.file_path) return <div className={styles.previewUnavailable}><FileIcon fileName={doc?.file_name} mimeType={doc?.mime_type} size={72} /><strong>Preview is not available</strong><span>This record does not have a linked file.</span></div>;
        const category = getFileCategory(doc.file_name, doc.mime_type);
        const url = docDownloadUrl(doc.file_path);
        if (category === 'image') return <img className={styles.previewImage} src={url} alt={doc.title || doc.file_name || 'Document preview'} />;
        if (category === 'pdf' || category === 'text' || category === 'code') return <iframe className={styles.previewFrame} src={url} title={`Preview of ${doc.title}`} />;
        if (category === 'video') return <video className={styles.previewMedia} src={url} controls preload="metadata" />;
        if (category === 'audio') return <div className={styles.previewUnavailable}><FileIcon fileName={doc.file_name} mimeType={doc.mime_type} size={72} /><strong>{doc.file_name}</strong><audio src={url} controls preload="metadata" /></div>;
        return <div className={styles.previewUnavailable}><FileIcon fileName={doc.file_name} mimeType={doc.mime_type} size={72} /><strong>Preview is not available for this file type.</strong><span>Download the file to open it with a compatible application.</span><a href={url} target="_blank" rel="noopener noreferrer">Download file</a></div>;
    };

    const selectedClientServices = getClientServices(modalData.client_id);
    const filteredReceivedDocs = useMemo(() => {
        return receivedDocs.filter((d: any) => {
            if (receivedFilters.client_id && String(d?.client_name ?? '') !== String(receivedFilters.client_id)) return false;
            if (receivedFilters.status !== 'all' && String(d?.status || 'received').toLowerCase() !== receivedFilters.status) return false;
            return true;
        });
    }, [receivedDocs, receivedFilters]);
    const paginatedReceivedDocs = filteredReceivedDocs.slice((receivedPage - 1) * ITEMS_PER_PAGE, receivedPage * ITEMS_PER_PAGE);

    useEffect(() => {
        if (activeTab === 'received') setReceivedPage(1);
    }, [activeTab, search, receivedFilters]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filteredReceivedDocs.length / ITEMS_PER_PAGE));
        if (receivedPage > totalPages) setReceivedPage(totalPages);
    }, [filteredReceivedDocs.length, receivedPage]);

    const handleLogout = async () => {
        await fetch(`${API_BASE}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    if (loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={user?.role} user={user} onLogout={handleLogout}>
            <Head><title>Document Management</title></Head>
            <div className={styles.page}>
                <section className={styles.hero} aria-labelledby="documents-title">
                    <div className={styles.heroPattern} aria-hidden="true" />
                    <div className={styles.heroContent}>
                        <div>
                            <div className={styles.eyebrow}>Central document workspace</div>
                            <h1 id="documents-title" className={styles.heroTitle}>Document Management</h1>
                            <p className={styles.heroTagline}>Organize, review, and manage all your documents in one place.</p>
                            <div className={styles.heroMeta}>
                                <span><strong>{libraryStats.total.toLocaleString()}</strong> files in the current workspace</span>
                                <span><strong>{libraryStats.recent}</strong> added in the last 7 days</span>
                            </div>
                        </div>
                        <div className={styles.heroActions}>
                    {activeTab === 'library' && (
                        <button
                            onClick={() => setShowUploadModal(true)}
                            title="Upload Document"
                            aria-label="Upload Document"
                            className={styles.heroButton}
                        >
                            <Upload size={17} /> Upload Document
                        </button>
                    )}
                    {activeTab === 'received' && (
                        <button
                            onClick={() => handleOpenModal('create')}
                            title="Add Document"
                            aria-label="Add Document"
                            className={styles.heroButton}
                        >
                            Add Document
                        </button>
                    )}
                    {activeTab === 'contracts' && (
                        <button
                            onClick={() => router.push('/contracts')}
                            title="Manage Contracts"
                            aria-label="Manage Contracts"
                            className={styles.heroButton}
                        >
                            Manage Contracts
                        </button>
                    )}
                        </div>
                    </div>
                </section>

                <section className={styles.summaryGrid} aria-label="Document overview">
                    <article className={styles.summaryPrimary}><span>Total files</span><strong>{libraryStats.total.toLocaleString()}</strong><small>Available under the current filters</small></article>
                    <article className={styles.summaryCard}><span>Recently added</span><strong>{libraryStats.recent}</strong><small>Past 7 days</small></article>
                    <article className={styles.summaryCard}><span>Linked records</span><strong>{libraryStats.linked}</strong><small>Connected to tasks or projects</small></article>
                    <article className={styles.summaryCard}><span>Storage used</span><strong>{formatFileSize(libraryStats.bytes)}</strong><small>Across visible library files</small></article>
                </section>

                {/* Tabs */}
                <div className={styles.tabs}>
                    <div
                        onClick={() => setActiveTab('library')}
                        style={{ padding: '10px 20px', cursor: 'pointer', borderBottom: activeTab === 'library' ? '2px solid #1e3a8a' : 'none', fontWeight: activeTab === 'library' ? 600 : 400, color: activeTab === 'library' ? '#1e3a8a' : '#64748b' }}
                    >
                        All Documents
                    </div>
                    <div
                        onClick={() => setActiveTab('contracts')}
                        style={{ padding: '10px 20px', cursor: 'pointer', borderBottom: activeTab === 'contracts' ? '2px solid #1e3a8a' : 'none', fontWeight: activeTab === 'contracts' ? 600 : 400, color: activeTab === 'contracts' ? '#1e3a8a' : '#64748b' }}
                    >
                        Contracts
                    </div>
                </div>

                {/* Content */}
                {activeTab === 'library' && (
                    <>
                        <div className={styles.libraryToolbar}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <label style={{ flex: '2 1 220px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Search</span>
                                    <SearchBar
                                        storageKey="documents:library"
                                        placeholder="Search files, owners, clients, types, or notes..."
                                        ariaLabel="Search document library"
                                        value={libFilters.search}
                                        onChange={(v) => setLibFilters(prev => ({ ...prev, search: v }))}
                                        suggestions={collectSearchTerms(libraryDocs, [
                                            (d: any) => d.title,
                                            (d: any) => d.file_name,
                                            (d: any) => d.notes,
                                            (d: any) => d.client_name,
                                            (d: any) => d.uploaded_by_name,
                                            (d: any) => d.document_type,
                                            (d: any) => d.mime_type,
                                        ])}
                                        inputStyle={{ padding: 10 }}
                                    />
                                </label>
                                <label style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Client</span>
                                    <select
                                        value={libFilters.client_id}
                                        onChange={e => { setLibFilters(prev => ({ ...prev, client_id: e.target.value })); setLibPage(1); void fetchLibrary({ ...libFilters, client_id: e.target.value }); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="">All Clients</option>
                                        {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: '1 1 140px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Type</span>
                                    <select
                                        value={libFilters.document_type}
                                        onChange={e => { setLibFilters(prev => ({ ...prev, document_type: e.target.value })); setLibPage(1); void fetchLibrary({ ...libFilters, document_type: e.target.value }); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="">All Types</option>
                                        {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Source</span>
                                    <select
                                        value={libFilters.source}
                                        onChange={e => { setLibFilters(prev => ({ ...prev, source: e.target.value })); setLibPage(1); void fetchLibrary({ ...libFilters, source: e.target.value }); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="">All Sources</option>
                                        {DOC_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                                    </select>
                                </label>
                            </div>
                        </div>
                        <div className={styles.toolbarFooter}>
                            <div className={styles.formatFilters} aria-label="Filter by file format">
                                <button type="button" className={libFileCategory === 'all' ? styles.formatFilterActive : styles.formatFilter} onClick={() => { setLibFileCategory('all'); setLibPage(1); }}>All files <span>{uniqueLibraryDocs.length}</span></button>
                                {Array.from(libraryCategoryCounts.entries()).sort((a, b) => FILE_CATEGORY_LABELS[a[0]].localeCompare(FILE_CATEGORY_LABELS[b[0]])).map(([category, count]) => (
                                    <button key={category} type="button" className={libFileCategory === category ? styles.formatFilterActive : styles.formatFilter} onClick={() => { setLibFileCategory(category); setLibPage(1); }}>
                                        <i style={{ background: FILE_CATEGORY_COLORS[category] }} />{FILE_CATEGORY_LABELS[category]} <span>{count}</span>
                                    </button>
                                ))}
                            </div>
                            <div className={styles.toolbarControls}>
                                <button
                                    type="button"
                                    className={libFilters.status === 'archived' ? styles.archiveStorageActive : styles.archiveStorageButton}
                                    onClick={() => {
                                        const status = libFilters.status === 'archived' ? 'active' : 'archived';
                                        const nextFilters = { ...libFilters, status };
                                        setLibFilters(nextFilters);
                                        setLibPage(1);
                                        setSelectedLibraryIds([]);
                                        void fetchLibrary(nextFilters);
                                    }}
                                >
                                    <Archive size={14} /> {libFilters.status === 'archived' ? 'Back to Active' : 'Archive Storage'}
                                </button>
                                <label className={styles.sortControl}>
                                    <span>Sort</span>
                                    <select value={libSort} onChange={(event) => { setLibSort(event.target.value as typeof libSort); setLibPage(1); }}>
                                        <option value="modified">Recently modified</option>
                                        <option value="uploaded">Recently uploaded</option>
                                        <option value="name">Name</option>
                                        <option value="size">File size</option>
                                        <option value="type">File type</option>
                                        <option value="owner">Owner</option>
                                    </select>
                                </label>
                            <div style={{ display: 'inline-flex', background: '#f1f5f9', borderRadius: 8, padding: 3, gap: 2 }} role="tablist" aria-label="Library view">
                                <button
                                    type="button"
                                    onClick={() => setLibView('table')}
                                    title="List view"
                                    aria-label="List view"
                                    style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: libView === 'table' ? '#fff' : 'transparent', color: libView === 'table' ? '#1e3a8a' : '#64748b', boxShadow: libView === 'table' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none' }}
                                >
                                    ☰ List
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setLibView('cards')}
                                    title="Card view"
                                    aria-label="Card view"
                                    style={{ padding: '6px 14px', borderRadius: 6, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 700, background: libView === 'cards' ? '#fff' : 'transparent', color: libView === 'cards' ? '#1e3a8a' : '#64748b', boxShadow: libView === 'cards' ? '0 1px 2px rgba(0,0,0,0.1)' : 'none' }}
                                >
                                    ▦ Cards
                                </button>
                            </div>
                            </div>
                        </div>
                        {selectedLibraryIds.length > 0 && (
                            <div className={styles.bulkBar} role="toolbar" aria-label="Selected document actions">
                                <strong>{selectedLibraryIds.length} file{selectedLibraryIds.length === 1 ? '' : 's'} selected</strong>
                                <button type="button" onClick={downloadSelectedDocuments}><Download size={15} /> Download</button>
                                <button type="button" onClick={() => void shareSelectedDocuments()}><Share2 size={15} /> Share</button>
                                <button type="button" onClick={() => void archiveSelectedDocuments()}><Archive size={15} /> {libFilters.status === 'archived' ? 'Restore' : 'Archive'}</button>
                                <button type="button" onClick={() => setSelectedLibraryIds([])} className={styles.bulkClear}><X size={15} /> Clear</button>
                            </div>
                        )}
                        {libView === 'table' ? (
                        <div className={styles.listPanel}>
                            <table className="llb-table llb-pin-first" data-density="compact" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 8px', tableLayout: 'fixed' }}>
                                <colgroup>
                                    <col style={{ width: '27%' }} />
                                    <col style={{ width: '13%' }} />
                                    <col style={{ width: '20%' }} />
                                    <col style={{ width: '20%' }} />
                                    <col style={{ width: '9%' }} />
                                    <col style={{ width: 96 }} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>DOCUMENT NAME</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>CLIENT</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>LINKED TO</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>FILE</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>STATUS</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'center', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>ACTIONS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {libLoading && visibleLibraryDocs.length === 0 ? (
                                        <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading documents...</td></tr>
                                    ) : visibleLibraryDocs.length === 0 ? (
                                        <tr><td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#94a3b8' }}>
                                            {libFilters.search.trim() || libFilters.client_id || libFilters.document_type || libFilters.source ? (
                                                <ZeroResults
                                                    query={libFilters.search}
                                                    itemLabel="documents"
                                                    alternatives={getAlternativeSuggestions(libFilters.search, collectSearchTerms(clients, [(c: any) => c.client_name]))}
                                                    onPickAlternative={(term) => setLibFilters(prev => ({ ...prev, search: term }))}
                                                    onClear={() => setLibFilters(prev => ({ ...prev, search: '' }))}
                                                />
                                            ) : 'No documents found. Upload the first one to start the library.'}
                                        </td></tr>
                                    ) : currentLibraryPage.map(doc => (
                                        <tr key={doc.id} onClick={() => setViewDoc(doc)} title={`Preview ${doc.title}`} style={{ background: '#fff', cursor: 'pointer', borderLeft: `3px solid ${FILE_CATEGORY_COLORS[getFileCategory(doc.file_name, doc.mime_type)]}` }}>
                                            <td style={{ padding: '10px 14px', borderBottom: 'none', borderRadius: '10px 0 0 10px' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
                                                    <input type="checkbox" aria-label={`Select ${doc.title}`} checked={selectedLibraryIds.includes(Number(doc.id))} onClick={(event) => event.stopPropagation()} onChange={() => toggleLibrarySelection(Number(doc.id))} />
                                                    <div style={{ minWidth: 0 }}><div className="llb-ellipsis" style={{ fontWeight: 700 }} title={doc.title}>{doc.title}</div><div className="llb-ellipsis" style={{ fontSize: 11, color: '#64748b' }}>{doc.uploaded_by_name || 'Unknown owner'}</div></div>
                                                </div>
                                            </td>
                                            <td style={{ padding: '10px 14px', borderBottom: 'none' }}>
                                                <div className="llb-ellipsis" title={doc.client_name || ''}>{doc.client_name || '-'}</div>
                                            </td>
                                            <td style={{ padding: '10px 14px', fontSize: 12, color: '#475569', borderBottom: 'none' }}>
                                                {doc.project_name ? <div className="llb-ellipsis" title={doc.project_name}>Project: <strong>{doc.project_name}</strong></div> : null}
                                                {doc.task_title ? <div className="llb-ellipsis" style={{ color: '#64748b' }} title={doc.task_title}>Task: <strong>{doc.task_title}</strong></div> : null}
                                                {!doc.task_title && !doc.project_name ? <span style={{ color: '#94a3b8' }}>-</span> : null}
                                            </td>
                                            <td style={{ padding: '10px 14px', fontSize: 12, color: '#475569', borderBottom: 'none' }}>
                                                <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
                                                    <FileIcon fileName={doc.file_name} mimeType={doc.mime_type} size={34} />
                                                    <div style={{ minWidth: 0, flex: 1 }}>
                                                        <div
                                                            className="llb-ellipsis"
                                                            style={{ fontWeight: 600, color: '#0f172a' }}
                                                            title={`${doc.file_name || ''}${doc.created_at ? `\nUploaded ${new Date(doc.created_at).toLocaleString()}${doc.uploaded_by_name && String(doc.uploaded_by_name).trim() ? ` by ${doc.uploaded_by_name}` : ''}` : ''}`}
                                                        >
                                                            {doc.file_name || '-'}
                                                        </div>
                                                        <div className="llb-ellipsis" style={{ color: '#64748b', marginTop: 2 }}>
                                                            <span style={{ fontWeight: 700 }}>{fileKindLabel(doc.file_name, doc.mime_type)}</span>
                                                            <span style={{ margin: '0 5px', color: '#cbd5e1' }}>•</span>
                                                            {formatFileSize(doc.file_size)}
                                                        </div>
                                                        <div style={{ color: '#94a3b8', marginTop: 2 }}>Modified {new Date(doc.updated_at || doc.created_at).toLocaleDateString()}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td style={{ padding: '10px 14px', borderBottom: 'none' }}>
                                                <span style={{
                                                    display: 'inline-block', whiteSpace: 'nowrap',
                                                    padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
                                                    background: doc.status === 'active' ? '#dcfce7' : '#f1f5f9',
                                                    color: doc.status === 'active' ? '#166534' : '#64748b',
                                                }}>
                                                    {doc.status}
                                                </span>
                                            </td>
                                            <td onClick={(e) => e.stopPropagation()} style={{ padding: '10px 14px', textAlign: 'center', position: 'relative', borderBottom: 'none', borderRadius: '0 10px 10px 0' }} className="llb-actions">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setLibDropdown(libDropdown === doc.id ? null : doc.id); }}
                                                    title="Actions"
                                                    aria-label={`Actions for ${doc.title}`}
                                                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 5 }}
                                                >
                                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#666"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                                                </button>
                                                {libDropdown === doc.id && (
                                                    <div style={{
                                                        position: 'absolute', right: 10, top: '100%', background: '#fff',
                                                        border: '1px solid #e2e8f0', borderRadius: 8,
                                                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100, minWidth: 150,
                                                    }}>
                                                        <button onClick={() => { setViewDoc(doc); setLibDropdown(null); }} title="View" aria-label={`View ${doc.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                                                            <CrudActionIcon action="view" /> View
                                                        </button>
                                                        {doc.file_path && (
                                                            <a href={docDownloadUrl(doc.file_path)} target="_blank" rel="noopener noreferrer" onClick={() => setLibDropdown(null)} title="Download" aria-label={`Download ${doc.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#1e3a8a', textDecoration: 'none' }}>
                                                                <CrudActionIcon action="approve" /> Download
                                                            </a>
                                                        )}
                                                        <button onClick={() => openEditDoc(doc)} title="Edit" aria-label={`Edit ${doc.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                                                            <CrudActionIcon action="edit" /> Edit
                                                        </button>
                                                        <button onClick={() => void handleArchiveDoc(doc, doc.status !== 'archived')} title={doc.status === 'archived' ? 'Restore' : 'Archive'} aria-label={`${doc.status === 'archived' ? 'Restore' : 'Archive'} ${doc.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: doc.status === 'archived' ? '#166534' : '#dc2626' }}>
                                                            <CrudActionIcon action={doc.status === 'archived' ? 'restore' : 'archive'} /> {doc.status === 'archived' ? 'Restore' : 'Archive'}
                                                        </button>
                                                        {isAdminUser && (
                                                            <button onClick={() => void handleDeleteDoc(doc)} title="Delete" aria-label={`Delete ${doc.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#991b1b', fontWeight: 700 }}>
                                                                <CrudActionIcon action="delete" /> Delete
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        ) : (
                        <div>
                            {libLoading && visibleLibraryDocs.length === 0 ? (
                                <div style={{ background: '#fff', borderRadius: 12, padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading documents...</div>
                            ) : visibleLibraryDocs.length === 0 ? (
                                <div style={{ background: '#fff', borderRadius: 12, padding: 12, textAlign: 'center', color: '#94a3b8' }}>
                                    {libFilters.search.trim() || libFilters.client_id || libFilters.document_type || libFilters.source ? (
                                        <ZeroResults
                                            query={libFilters.search}
                                            itemLabel="documents"
                                            alternatives={getAlternativeSuggestions(libFilters.search, collectSearchTerms(clients, [(c: any) => c.client_name]))}
                                            onPickAlternative={(term) => setLibFilters(prev => ({ ...prev, search: term }))}
                                            onClear={() => setLibFilters(prev => ({ ...prev, search: '' }))}
                                        />
                                    ) : 'No documents found. Upload the first one to start the library.'}
                                </div>
                            ) : (
                                <div className={styles.documentGrid}>
                                    {currentLibraryPage.map(doc => (
                                        <div
                                            key={doc.id}
                                            onClick={() => setViewDoc(doc)}
                                            title={`View ${doc.title}`}
                                            role="button"
                                            tabIndex={0}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setViewDoc(doc); } }}
                                            className={styles.documentCard}
                                            style={{ borderTopColor: FILE_CATEGORY_COLORS[getFileCategory(doc.file_name, doc.mime_type)] }}
                                        >
                                            <div className={styles.cardHeader}>
                                                {getFileCategory(doc.file_name, doc.mime_type) === 'image' && doc.file_path
                                                    ? <img src={docDownloadUrl(doc.file_path)} alt="" style={{ width: 58, height: 52, borderRadius: 6, objectFit: 'cover', border: '1px solid #e2e8f0' }} />
                                                    : <FileIcon fileName={doc.file_name} mimeType={doc.mime_type} size={52} />}
                                                <div className={styles.cardQuickActions} onClick={(event) => event.stopPropagation()}>
                                                    <button onClick={() => setViewDoc(doc)} title={`View ${doc.title}`}>View</button>
                                                    {doc.file_path && <a href={docDownloadUrl(doc.file_path)} target="_blank" rel="noopener noreferrer" title={`Download ${doc.title}`}>Download</a>}
                                                </div>
                                                <input type="checkbox" aria-label={`Select ${doc.title}`} checked={selectedLibraryIds.includes(Number(doc.id))} onClick={(event) => event.stopPropagation()} onChange={() => toggleLibrarySelection(Number(doc.id))} />
                                            </div>
                                            <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.title}>{doc.title}</div>
                                            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.client_name || ''}>{doc.client_name || '-'} • {doc.document_type}</div>
                                            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={doc.file_name || ''}>{doc.file_name || '-'}</div>
                                            <div style={{ fontSize: 11, color: '#475569', fontWeight: 700, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`File size: ${formatFileSize(doc.file_size)}`}>Size: {formatFileSize(doc.file_size)}</div>
                                            <div style={{ fontSize: 11, color: '#64748b', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{doc.uploaded_by_name || 'Unknown owner'} · {new Date(doc.updated_at || doc.created_at).toLocaleDateString()}</div>
                                            <span style={{ alignSelf: 'flex-start', marginTop: 6, padding: '2px 7px', borderRadius: 99, fontSize: 10, fontWeight: 700, textTransform: 'capitalize', background: doc.status === 'active' ? '#dcfce7' : '#f1f5f9', color: doc.status === 'active' ? '#166534' : '#64748b' }}>{doc.status}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                        )}
                        <Pagination
                            currentPage={libPage}
                            totalItems={visibleLibraryDocs.length}
                            itemsPerPage={ITEMS_PER_PAGE}
                            onPageChange={setLibPage}
                            label="documents"
                        />
                    </>
                )}

                {activeTab === 'contracts' && (
                    <>
                        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: 10, marginBottom: 12 }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <label style={{ flex: '2 1 220px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Search</span>
                                    <SearchBar
                                        storageKey="documents:contracts"
                                        placeholder="Search title or client..."
                                        ariaLabel="Search contracts"
                                        value={contractFilters.search}
                                        onChange={(v) => { setContractFilters(prev => ({ ...prev, search: v })); setContractsPage(1); }}
                                        suggestions={collectSearchTerms(contracts, [
                                            (c: any) => c.title,
                                            (c: any) => c.client_name,
                                        ])}
                                        inputStyle={{ padding: 10 }}
                                    />
                                </label>
                                <label style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Client</span>
                                    <select
                                        value={contractFilters.client_id}
                                        onChange={e => { setContractFilters(prev => ({ ...prev, client_id: e.target.value })); setContractsPage(1); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="">All Clients</option>
                                        {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Status</span>
                                    <select
                                        value={contractFilters.status}
                                        onChange={e => { setContractFilters(prev => ({ ...prev, status: e.target.value })); setContractsPage(1); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="all">All Statuses</option>
                                        <option value="signed">Signed</option>
                                        <option value="accepted">Valid</option>
                                        <option value="rejected">Rejected</option>
                                        <option value="expired">Expired</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        <div className={styles.contractArchiveBar}>
                            <div className={styles.contractViewToggle} role="tablist" aria-label="Contracts view">
                                <button type="button" onClick={() => setContractView('table')} className={contractView === 'table' ? styles.viewButtonActive : styles.viewButton}>List</button>
                                <button type="button" onClick={() => setContractView('cards')} className={contractView === 'cards' ? styles.viewButtonActive : styles.viewButton}>Cards</button>
                            </div>
                            <button
                                onClick={() => { const next = !showArchivedContracts; setShowArchivedContracts(next); setContractsPage(1); void fetchContracts(next); }}
                                title={showArchivedContracts ? 'Back to Active Contracts' : 'View Archived Contracts'}
                                style={{
                                    background: showArchivedContracts ? '#1e3a8a' : '#f1f5f9',
                                    color: showArchivedContracts ? '#fff' : '#64748b',
                                    border: 'none', borderRadius: 6, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600,
                                    flex: '0 0 auto',
                                }}
                            >
                                {showArchivedContracts ? 'Back to Active' : `Archive (${contracts.filter(c => Number(c.is_archived) === 1).length})`}
                            </button>
                        </div>
                        {contractView === 'table' ? (
                        <div className={styles.contractTablePanel}>
                            <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'separate', borderSpacing: '0 8px', tableLayout: 'fixed' }}>
                                <colgroup>
                                    <col style={{ width: '40%' }} />
                                    <col style={{ width: '16%' }} />
                                    <col style={{ width: '10%' }} />
                                    <col style={{ width: '14%' }} />
                                    <col style={{ width: '12%' }} />
                                    <col style={{ width: '8%' }} />
                                </colgroup>
                                <thead>
                                    <tr>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>CONTRACT</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>CLIENT</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>STATUS</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>SIGNED FILE</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em' }}>UPDATED</th>
                                        <th style={{ padding: '2px 14px 6px', textAlign: 'center', fontSize: 11, fontWeight: 800, color: '#64748b', letterSpacing: '0.04em', width: 60 }}>ACTIONS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {contractsLoading ? (
                                        <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>Loading contracts...</td></tr>
                                    ) : contracts.length === 0 ? (
                                        <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>{showArchivedContracts ? 'No archived contracts.' : 'No contracts yet. Create one from the Contracts page.'}</td></tr>
                                    ) : filteredContracts.length === 0 ? (
                                        <tr><td colSpan={6} style={{ padding: 30, textAlign: 'center', color: '#94a3b8' }}>No contracts match these filters.</td></tr>
                                    ) : filteredContracts.slice((contractsPage - 1) * ITEMS_PER_PAGE, contractsPage * ITEMS_PER_PAGE).map(contract => (
                                        <tr key={contract.id} style={{ background: '#fff', boxShadow: '0 1px 3px rgba(15,23,42,0.08)' }}>
                                            <td style={{ padding: 14, borderBottom: 'none', borderRadius: '10px 0 0 10px' }}>
                                                <div style={{ fontWeight: 600 }}>{contract.title}</div>
                                            </td>
                                            <td style={{ padding: 14, borderBottom: 'none' }} className="llb-trunc" title={contract.client_name || ''}>{contract.client_name || '-'}</td>
                                            <td style={{ padding: 14, borderBottom: 'none' }}>
                                                {Number((contract as any).is_signed) === 1 || (contract as any).signed_contract_file ? (
                                                    <span style={{ padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700, background: '#f0fdf4', color: '#15803d', border: '1px solid #bbf7d0' }}>
                                                        Signed
                                                    </span>
                                                ) : (
                                                    (() => {
                                                        const deadline = (contract as any).project_deadline as string | null | undefined;
                                                        const isExpired = deadline ? new Date(deadline) < new Date() : false;
                                                        const status = String(contract.status || 'pending').toLowerCase();
                                                        const st = status === 'accepted'
                                                            ? { bg: '#dcfce7', color: '#166534', label: 'Valid' }
                                                            : status === 'rejected'
                                                                ? { bg: '#fee2e2', color: '#991b1b', label: 'Rejected' }
                                                                : status === 'expired' || isExpired
                                                                    ? { bg: '#fef3c7', color: '#92400e', label: 'Expired' }
                                                                    : { bg: '#eff6ff', color: '#1d4ed8', label: 'Pending' };
                                                        return (
                                                            <span style={{
                                                                padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
                                                                background: st.bg, color: st.color,
                                                            }}>
                                                                {st.label}
                                                            </span>
                                                        );
                                                    })()
                                                )}
                                            </td>
                                            <td style={{ padding: 14, fontSize: 12, borderBottom: 'none' }}>
                                                {contract.signed_contract_file ? (
                                                    <a href={docDownloadUrl(contract.signed_contract_file)} target="_blank" rel="noopener noreferrer" style={{ color: '#1d4ed8', fontWeight: 600 }}>
                                                        Download PDF
                                                    </a>
                                                ) : (
                                                    <span style={{ color: '#94a3b8' }}>-</span>
                                                )}
                                            </td>
                                            <td style={{ padding: 14, fontSize: 12, color: '#64748b', borderBottom: 'none' }}>
                                                {contract.updated_at ? new Date(contract.updated_at).toLocaleDateString() : '-'}
                                            </td>
                                            <td style={{ padding: 14, textAlign: 'center', position: 'relative', borderBottom: 'none', borderRadius: '0 10px 10px 0' }} className="llb-actions">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setContractDropdown(contractDropdown === contract.id ? null : contract.id); }}
                                                    title="Actions"
                                                    aria-label={`Actions for ${contract.title}`}
                                                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 5 }}
                                                >
                                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="#666"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>
                                                </button>
                                                {contractDropdown === contract.id && (
                                                    <div style={{
                                                        position: 'absolute', right: 10, top: '100%', background: '#fff',
                                                        border: '1px solid #e2e8f0', borderRadius: 8,
                                                        boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100, minWidth: 170,
                                                    }}>
                                                        <button onClick={() => { setContractDropdown(null); router.push('/contracts'); }} title="Open in Contracts" aria-label={`Open ${contract.title} in Contracts`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                                                            <CrudActionIcon action="view" /> Open in Contracts
                                                        </button>
                                                        {contract.signed_contract_file && (
                                                            <a href={docDownloadUrl(contract.signed_contract_file)} target="_blank" rel="noopener noreferrer" onClick={() => setContractDropdown(null)} title="Download" aria-label={`Download ${contract.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#1e3a8a', textDecoration: 'none' }}>
                                                                <CrudActionIcon action="approve" /> Download
                                                            </a>
                                                        )}
                                                        {isAdminUser && (
                                                            <button onClick={() => void handleToggleContractArchive(contract)} title={showArchivedContracts ? 'Restore' : 'Archive'} aria-label={`${showArchivedContracts ? 'Restore' : 'Archive'} ${contract.title}`} style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: 10, textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: showArchivedContracts ? '#166534' : '#dc2626' }}>
                                                                <CrudActionIcon action={showArchivedContracts ? 'restore' : 'archive'} /> {showArchivedContracts ? 'Restore' : 'Archive'}
                                                            </button>
                                                        )}
                                                    </div>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                        ) : (
                            <div className={styles.contractGrid}>
                                {contractsLoading && filteredContracts.length === 0 ? (
                                    <div className={styles.contractEmpty}>Loading contracts...</div>
                                ) : filteredContracts.length === 0 ? (
                                    <div className={styles.contractEmpty}>{showArchivedContracts ? 'No archived contracts.' : 'No contracts match these filters.'}</div>
                                ) : filteredContracts.slice((contractsPage - 1) * ITEMS_PER_PAGE, contractsPage * ITEMS_PER_PAGE).map((contract) => {
                                    const state = contractStatusKey(contract);
                                    const statusLabel = state === 'accepted' ? 'Valid' : state.charAt(0).toUpperCase() + state.slice(1);
                                    return (
                                        <article key={contract.id} className={styles.contractCard}>
                                            <div className={styles.contractCardTop}>
                                                <FileIcon fileName={contract.signed_contract_file || `${contract.title}.pdf`} mimeType="application/pdf" size={44} />
                                                <span className={`${styles.contractStatus} ${styles[`contractStatus_${state}`] || ''}`}>{statusLabel}</span>
                                            </div>
                                            <h3 title={contract.title}>{contract.title}</h3>
                                            <p title={contract.client_name || ''}>{contract.client_name || 'No client'}</p>
                                            <dl>
                                                <div><dt>Updated</dt><dd>{contract.updated_at ? new Date(contract.updated_at).toLocaleDateString() : '-'}</dd></div>
                                                <div><dt>File</dt><dd>{contract.signed_contract_file ? 'Signed PDF' : 'Not uploaded'}</dd></div>
                                            </dl>
                                            <div className={styles.contractCardActions}>
                                                <button type="button" onClick={() => router.push('/contracts')}>Open</button>
                                                {contract.signed_contract_file && <a href={docDownloadUrl(contract.signed_contract_file)} target="_blank" rel="noopener noreferrer">Download</a>}
                                                {isAdminUser && <button type="button" onClick={() => void handleToggleContractArchive(contract)}>{showArchivedContracts ? 'Restore' : 'Archive'}</button>}
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>
                        )}
                        <Pagination
                            currentPage={contractsPage}
                            totalItems={filteredContracts.length}
                            itemsPerPage={ITEMS_PER_PAGE}
                            onPageChange={setContractsPage}
                            label="contracts"
                        />
                    </>
                )}

                {activeTab === 'received' && (
                    <>
                        <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', padding: 10, marginBottom: 12 }}>
                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                <label style={{ flex: '2 1 220px', display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Search</span>
                                    <SearchBar
                                        storageKey="documents:received"
                                        placeholder="Search documents or clients..."
                                        ariaLabel="Search received documents"
                                        value={search}
                                        onChange={setSearch}
                                        suggestions={collectSearchTerms(receivedDocs, [
                                            (d: any) => d.title,
                                            (d: any) => d.file_name,
                                            (d: any) => d.client_name,
                                        ])}
                                        inputStyle={{ padding: 10 }}
                                    />
                                </label>
                                <label style={{ flex: '1 1 160px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Client</span>
                                    <select
                                        value={receivedFilters.client_id}
                                        onChange={e => { setReceivedFilters(prev => ({ ...prev, client_id: e.target.value })); setReceivedPage(1); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="">All Clients</option>
                                        {clients.map(c => <option key={c.client_id} value={c.client_name}>{c.client_name}</option>)}
                                    </select>
                                </label>
                                <label style={{ flex: '1 1 130px', display: 'flex', flexDirection: 'column', gap: 3 }}>
                                    <span style={{ fontSize: 11, fontWeight: 800, color: '#374151' }}>Status</span>
                                    <select
                                        value={receivedFilters.status}
                                        onChange={e => { setReceivedFilters(prev => ({ ...prev, status: e.target.value })); setReceivedPage(1); }}
                                        style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}
                                    >
                                        <option value="all">All Statuses</option>
                                        <option value="received">Received</option>
                                        <option value="processing">Processing</option>
                                        <option value="completed">Completed</option>
                                        <option value="archived">Archived</option>
                                    </select>
                                </label>
                            </div>
                        </div>
                        <div style={{ background: '#fff', borderRadius: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'hidden' }}>
                            <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                <thead style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
                                    <tr>
                                        <th style={{ padding: 14, textAlign: 'left', fontSize: 13, color: '#64748b' }}>DOCUMENT NAME</th>
                                        <th style={{ padding: 14, textAlign: 'left', fontSize: 13, color: '#64748b' }}>CLIENT</th>
                                        <th style={{ padding: 14, textAlign: 'left', fontSize: 13, color: '#64748b' }}>RECEIVED DATE</th>
                                        <th style={{ padding: 14, textAlign: 'left', fontSize: 13, color: '#64748b' }}>STATUS</th>
                                        <th style={{ padding: 14, textAlign: 'left', fontSize: 13, color: '#64748b' }}>LINKED TASK</th>
                                        <th style={{ padding: 14, textAlign: 'right', fontSize: 13, color: '#64748b' }}>ACTIONS</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filteredReceivedDocs.length === 0 ? <tr><td colSpan={6} style={{ padding: 12, textAlign: 'center', color: '#94a3b8' }}>
                                        {search.trim() ? (
                                            <ZeroResults
                                                query={search}
                                                itemLabel="documents"
                                                alternatives={getAlternativeSuggestions(search, collectSearchTerms(clients, [(c: any) => c.client_name]))}
                                                onPickAlternative={(term) => setSearch(term)}
                                                onClear={() => { setSearch(''); setReceivedFilters({ client_id: '', status: 'all' }); setReceivedPage(1); }}
                                            />
                                        ) : 'No documents found.'}
                                    </td></tr> :
                                        paginatedReceivedDocs.map(doc => (
                                            <tr key={doc.document_id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                                                <td style={{ padding: 14 }}>
                                                    <div style={{ fontWeight: 600 }}>{doc.document_name}</div>
                                                    <div style={{ fontSize: 12, color: '#64748b' }}>{doc.document_type}</div>
                                                </td>
                                                <td style={{ padding: 14 }} className="llb-trunc" title={doc.client_name || ''}>{doc.client_name || '-'}</td>
                                                <td style={{ padding: 14 }}>{doc.received_date}</td>
                                                <td style={{ padding: 14 }}>
                                                    <select
                                                        value={doc.status || 'received'}
                                                        disabled={updatingStatusId === doc.document_id}
                                                        onChange={e => handleChangeReceivedStatus(doc.document_id, e.target.value)}
                                                        style={{
                                                            width: '100%',
                                                            maxWidth: 150,
                                                            padding: '6px 8px',
                                                            borderRadius: 8,
                                                            border: '1px solid #e2e8f0',
                                                            background: '#fff',
                                                            color: getStatusColor(doc.status),
                                                            fontSize: 12,
                                                            fontWeight: 600,
                                                            textTransform: 'capitalize'
                                                        }}
                                                    >
                                                        <option value="received">Received</option>
                                                        <option value="processing">Processing</option>
                                                        <option value="completed">Completed</option>
                                                        <option value="archived">Archived</option>
                                                    </select>
                                                </td>
                                                <td style={{ padding: 14, fontSize: 13 }} title={doc.task_title} className="llb-trunc">
                                                    {doc.task_title ? (
                                                        <span style={{ color: '#059669', background: '#d1fae5', padding: '2px 6px', borderRadius: 4, fontSize: 11 }}>
                                                            ✓ {doc.task_title.length > 20 ? doc.task_title.substring(0, 20) + '...' : doc.task_title}
                                                        </span>
                                                    ) : <span style={{ color: '#94a3b8' }}>-</span>}
                                                </td>
                                                <td style={{ padding: 14, textAlign: 'right' }} className="llb-actions">
                                                    <button onClick={() => handleOpenModal('edit', doc)} title="Edit" aria-label={`Edit ${doc.document_name}`} style={{ marginRight: 8, background: 'none', border: 'none', color: '#2563eb', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                                        <CrudActionIcon action="edit" />
                                                    </button>
                                                    {doc.status !== 'archived' && (
                                                        <button onClick={() => handleArchive(doc.document_id)} title="Archive" aria-label={`Archive ${doc.document_name}`} style={{ background: 'none', border: 'none', color: '#dc2626', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                                            <CrudActionIcon action="archive" />
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))
                                    }
                                </tbody>
                            </table>
                        </div>
                        <Pagination
                            currentPage={receivedPage}
                            totalItems={filteredReceivedDocs.length}
                            itemsPerPage={ITEMS_PER_PAGE}
                            onPageChange={setReceivedPage}
                            label="documents"
                        />
                    </>
                )}
            </div>

            {/* Upload Modal */}
            {showUploadModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
                    <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 4 }}>Upload Documents</h2>
                        <p style={{ fontSize: 12, color: '#64748b', margin: '0 0 16px 0' }}>Choose whose client these belong to, then add one or more files. Each file uploads on its own lane with its own retry.</p>
                        <form onSubmit={handleUploadSubmit} style={{ display: 'grid', gap: 14 }}>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Document Type *</label>
                                    <select required value={uploadForm.document_type} onChange={e => setUploadForm({ ...uploadForm, document_type: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Whose Client? *</label>
                                    <select required value={uploadForm.client_id} onChange={e => handleUploadClientChange(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        <option value="">-- Select Client --</option>
                                        {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Link Task (optional)</label>
                                    <select disabled={!uploadForm.client_id} value={uploadForm.task_id} onChange={e => setUploadForm({ ...uploadForm, task_id: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: !uploadForm.client_id ? '#f1f5f9' : '#fff' }}>
                                        <option value="">-- No Task --</option>
                                        {uploadTasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Link Project (optional)</label>
                                    <select disabled={!uploadForm.client_id} value={uploadForm.project_id} onChange={e => setUploadForm({ ...uploadForm, project_id: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: !uploadForm.client_id ? '#f1f5f9' : '#fff' }}>
                                        <option value="">-- No Project --</option>
                                        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Files * (PDF, JPG, PNG, WEBP — max 10MB each, multiple allowed)</label>
                                <input
                                    type="file"
                                    multiple
                                    accept=".pdf,.jpg,.jpeg,.png,.webp"
                                    onChange={e => { addUploadFiles(e.target.files); e.target.value = ''; }}
                                    className="upload-hover-glow"
                                    style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', color: '#334155', background: '#fff' }}
                                />
                            </div>
                            {uploadFiles.length > 0 && (
                                <div style={{ display: 'grid', gap: 8 }}>
                                    {uploadFiles.map((lane) => {
                                        const laneLocked = lane.status === 'uploading' || lane.status === 'done';
                                        const statusStyle: Record<string, { bg: string; fg: string; label: string }> = {
                                            queued: { bg: '#f1f5f9', fg: '#475569', label: 'Queued' },
                                            uploading: { bg: '#dbeafe', fg: '#1d4ed8', label: 'Uploading…' },
                                            done: { bg: '#dcfce7', fg: '#166534', label: 'Uploaded' },
                                            error: { bg: '#fee2e2', fg: '#b91c1c', label: lane.retryable ? 'Failed' : 'Invalid' },
                                        };
                                        const chip = statusStyle[lane.status];
                                        return (
                                            <div key={lane.key} className="upload-hover-glow" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', border: '1px solid #e2e8f0', borderRadius: 10, padding: 10, background: lane.status === 'done' ? '#f0fdf4' : '#fff' }}>
                                                <FileIcon fileName={lane.file.name} size={36} />
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <input
                                                        type="text"
                                                        value={lane.title}
                                                        onChange={(e) => updateUploadLane(lane.key, { title: e.target.value })}
                                                        disabled={laneLocked}
                                                        placeholder="Document title *"
                                                        aria-label={`Title for ${lane.file.name}`}
                                                        style={{ width: '100%', padding: '6px 8px', borderRadius: 6, border: '1px solid #e2e8f0', fontSize: 13, fontWeight: 600, color: '#0f172a', marginBottom: 4 }}
                                                    />
                                                    <div style={{ maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, color: '#64748b' }} title={lane.file.name}>
                                                        {lane.file.name} • {formatFileSize(lane.file.size)}
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                                                        <span style={{ padding: '2px 8px', borderRadius: 99, fontSize: 11, fontWeight: 700, background: chip.bg, color: chip.fg }}>
                                                            {chip.label}
                                                        </span>
                                                        {lane.status === 'error' && lane.error && (
                                                            <span style={{ fontSize: 11, color: '#b91c1c' }}>{lane.error}</span>
                                                        )}
                                                    </div>
                                                    {(lane.status === 'uploading' || (lane.status === 'error' && lane.progress && lane.progress.percent > 0)) && (
                                                        <div style={{ marginTop: 6 }}>
                                                            <UploadProgressBar
                                                                progress={lane.progress}
                                                                tone={lane.status === 'error' ? 'error' : 'uploading'}
                                                                caption={lane.status === 'error' ? 'Paused — retry continues from here, no re-upload.' : undefined}
                                                            />
                                                        </div>
                                                    )}
                                                </div>
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
                                                    {lane.status === 'error' && lane.retryable && (
                                                        <button
                                                            type="button"
                                                            onClick={() => void retryUploadLane(lane.key)}
                                                            disabled={uploading}
                                                            title={`Retry uploading ${lane.file.name}`}
                                                            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: uploading ? 'not-allowed' : 'pointer', fontSize: 12, fontWeight: 700, opacity: uploading ? 0.5 : 1 }}
                                                        >
                                                            ↻ Retry
                                                        </button>
                                                    )}
                                                    {!laneLocked && (
                                                        <button
                                                            type="button"
                                                            onClick={() => removeUploadLane(lane.key)}
                                                            title={`Remove ${lane.file.name}`}
                                                            aria-label={`Remove ${lane.file.name}`}
                                                            style={{ padding: '6px 12px', borderRadius: 7, border: '1px solid #e2e8f0', background: '#fff', color: '#64748b', cursor: 'pointer', fontSize: 12, fontWeight: 700 }}
                                                        >
                                                            ✕
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                            <div>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Notes (Optional)</label>
                                <textarea value={uploadForm.notes} onChange={e => setUploadForm({ ...uploadForm, notes: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, alignItems: 'center' }}>
                                <button type="button" onClick={() => resetUploadModal()} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 600, color: '#64748b', fontSize: 14 }}>
                                    Cancel
                                </button>
                                <button type="submit" disabled={uploading} style={{ background: 'transparent', border: 'none', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, color: uploading ? '#94a3b8' : '#2563eb', fontSize: 14 }}>
                                    {uploading ? 'Uploading…' : `Upload${uploadFiles.length > 1 ? ` (${uploadFiles.length})` : ''}`}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Metadata Modal */}
            {editingDoc && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}>
                    <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: '100%', maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 16 }}>Edit Document</h2>
                        <form onSubmit={handleEditDocSubmit} style={{ display: 'grid', gap: 14 }}>
                            <div>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Title *</label>
                                <input required type="text" value={editForm.title} onChange={e => setEditForm({ ...editForm, title: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Type *</label>
                                    <select required value={editForm.document_type} onChange={e => setEditForm({ ...editForm, document_type: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        {DOC_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Client *</label>
                                    <select required value={editForm.client_id} onChange={e => handleEditDocClientChange(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        <option value="">-- Select Client --</option>
                                        {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Task</label>
                                    <select value={editForm.task_id} onChange={e => setEditForm({ ...editForm, task_id: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        <option value="">-- No Task --</option>
                                        {uploadTasks.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Project</label>
                                    <select value={editForm.project_id} onChange={e => setEditForm({ ...editForm, project_id: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                        <option value="">-- No Project --</option>
                                        {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                                    </select>
                                </div>
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Status</label>
                                <select value={editForm.status} onChange={e => setEditForm({ ...editForm, status: e.target.value })} required aria-required="true" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff' }}>
                                    <option value="active">Active</option>
                                    <option value="archived">Archived</option>
                                </select>
                            </div>
                            <div>
                                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Notes (Optional)</label>
                                <textarea value={editForm.notes} onChange={e => setEditForm({ ...editForm, notes: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, alignItems: 'center' }}>
                                <button type="button" onClick={() => setEditingDoc(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 600, color: '#64748b', fontSize: 14 }}>
                                    Cancel
                                </button>
                                <button type="submit" disabled={uploading} style={{ background: 'transparent', border: 'none', cursor: uploading ? 'not-allowed' : 'pointer', fontWeight: 600, color: uploading ? '#94a3b8' : '#2563eb', fontSize: 14 }}>
                                    {uploading ? 'Saving...' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* View Details Modal */}
            {viewDoc && (
                <div className={styles.reviewerBackdrop} onClick={() => setViewDoc(null)}>
                    <div className={styles.reviewer} onClick={e => e.stopPropagation()}>
                        <header className={styles.reviewerHeader}>
                            <div className={styles.reviewerIdentity}>
                                <FileIcon fileName={viewDoc.file_name} mimeType={viewDoc.mime_type} size={42} />
                                <div><h2>{viewDoc.title}</h2><p>{fileKindLabel(viewDoc.file_name, viewDoc.mime_type)} · {formatFileSize(viewDoc.file_size)} · {viewDoc.uploaded_by_name || 'Unknown owner'}</p></div>
                            </div>
                            <div className={styles.reviewerActions}>
                                {viewDoc.file_path && <a href={docDownloadUrl(viewDoc.file_path)} target="_blank" rel="noopener noreferrer"><Download size={16} /> Download</a>}
                                {viewDoc.file_path && <button type="button" onClick={() => void navigator.clipboard?.writeText(docDownloadUrl(viewDoc.file_path))}><Share2 size={16} /> Share</button>}
                                <button type="button" className={styles.closeReviewer} onClick={() => setViewDoc(null)} aria-label="Close preview"><X size={20} /></button>
                            </div>
                        </header>
                        <div className={styles.reviewerBody}>
                            <main className={styles.previewStage}>{renderDocumentPreview(viewDoc)}</main>
                            <aside className={styles.reviewerInfo}>
                                <div className={styles.infoHeading}><span>Document details</span><span className={styles.statusBadge}>{viewDoc.status}</span></div>
                                <dl>
                                    <div><dt>File name</dt><dd>{viewDoc.file_name || '-'}</dd></div>
                                    <div><dt>File type</dt><dd>{fileKindLabel(viewDoc.file_name, viewDoc.mime_type)}</dd></div>
                                    <div><dt>Size</dt><dd>{formatFileSize(viewDoc.file_size)}</dd></div>
                                    <div><dt>Owner</dt><dd>{viewDoc.uploaded_by_name || '-'}</dd></div>
                                    <div><dt>Client</dt><dd>{viewDoc.client_name || '-'}</dd></div>
                                    <div><dt>Location</dt><dd>{viewDoc.project_name || viewDoc.task_title || docSourceLabel(viewDoc.source)}</dd></div>
                                    <div><dt>Uploaded</dt><dd>{viewDoc.created_at ? new Date(viewDoc.created_at).toLocaleString() : '-'}</dd></div>
                                    <div><dt>Modified</dt><dd>{viewDoc.updated_at ? new Date(viewDoc.updated_at).toLocaleString() : (viewDoc.created_at ? new Date(viewDoc.created_at).toLocaleString() : '-')}</dd></div>
                                </dl>
                                {viewDoc.notes && <div className={styles.notesBlock}><strong>Notes</strong><p>{viewDoc.notes}</p></div>}
                                <div className={styles.activityBlock}><strong>Recent activity</strong><div><i />Uploaded {viewDoc.uploaded_by_name ? `by ${viewDoc.uploaded_by_name}` : ''}<span>{viewDoc.created_at ? new Date(viewDoc.created_at).toLocaleDateString() : ''}</span></div>{viewDoc.updated_at && viewDoc.updated_at !== viewDoc.created_at && <div><i />Metadata updated<span>{new Date(viewDoc.updated_at).toLocaleDateString()}</span></div>}</div>
                            </aside>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal */}
            {isModalOpen && activeTab === 'received' && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
                    <div style={{ background: '#fff', borderRadius: 'var(--modal-radius)', padding: 24, width: '100%', maxWidth: 500, maxHeight: '90vh', overflowY: 'auto' }}>
                        <h2 style={{ fontSize: 14, fontWeight: 'bold', marginBottom: 20 }}>
                            {modalMode === 'create' ? 'Add' : 'Edit'} Document
                        </h2>

                        <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 16 }}>
                            {activeTab === 'received' ? (
                                <>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Client *</label>
                                        <select required value={modalData.client_id || ''} onChange={e => handleClientChange(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }}>
                                            <option value="">-- Select Client --</option>
                                            {clients.map(c => <option key={c.client_id} value={c.client_id}>{c.client_name}</option>)}
                                        </select>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Select Task / Document Type</label>
                                        <select disabled={!modalData.client_id} value={modalData.task_id || ''} onChange={e => handleTaskChange(e.target.value)} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: !modalData.client_id ? '#f1f5f9' : '#fff' }}>
                                            <option value="">-- Select Pending Task (Optional) --</option>
                                            {tasks.filter(t => t.status !== 'completed').map(t => (
                                                <option key={t.id} value={t.id}>
                                                    {t.title} ({t.project_name})
                                                </option>
                                            ))}
                                            <option value="" disabled>--- Completed Tasks ---</option>
                                            {tasks.filter(t => t.status === 'completed').map(t => (
                                                <option key={t.id} value={t.id} disabled>
                                                    {t.title} (Completed)
                                                </option>
                                            ))}
                                        </select>
                                        <div style={{ fontSize: 11, color: '#64748b', marginTop: 4 }}>
                                            Selecting a task will auto-fill the document name and mark the task Completed.
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Document Name *</label>
                                        <input required type="text" value={modalData.document_name || ''} onChange={e => setModalData({ ...modalData, document_name: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                        <div>
                                            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Type *</label>
                                            <select
                                                required
                                                disabled={!modalData.client_id}
                                                value={modalData.document_type || ''}
                                                onChange={e => setModalData({ ...modalData, document_type: e.target.value })}
                                                style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: !modalData.client_id ? '#f1f5f9' : '#fff' }}
                                            >
                                                <option value="">-- Select Service Type --</option>
                                                {selectedClientServices.map((s: ClientService) => (
                                                    <option key={s.service_id} value={s.service_name}>
                                                        {s.service_name}
                                                    </option>
                                                ))}
                                                {modalData.document_type && !selectedClientServices.some((s: ClientService) => s.service_name === modalData.document_type) && (
                                                    <option value={modalData.document_type}>{modalData.document_type}</option>
                                                )}
                                            </select>
                                            {modalData.client_id && selectedClientServices.length === 0 && (
                                                <div style={{ fontSize: 11, color: '#b45309', marginTop: 4 }}>
                                                    This client has no active service assigned yet.
                                                </div>
                                            )}
                                        </div>
                                        <div>
                                            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Received Date *</label>
                                            <input required type="date" value={modalData.received_date || ''} onChange={e => setModalData({ ...modalData, received_date: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>File Location / Path</label>
                                        <input type="text" value={modalData.file_path || ''} onChange={e => setModalData({ ...modalData, file_path: e.target.value })} placeholder="e.g., Cabinet A, Drawer 2 or URL" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                                    </div>
                                </>
                            ) : (
                                <>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Document *</label>
                                        <select required disabled={modalMode === 'edit'} value={modalData.document_id || ''} onChange={e => setModalData({ ...modalData, document_id: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0', background: modalMode === 'edit' ? '#f1f5f9' : '#fff' }}>
                                            <option value="">-- Select Document --</option>
                                            {receivedDocs.map(d => <option key={d.document_id} value={d.document_id}>{d.document_name}</option>)}
                                        </select>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                                        <div>
                                            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Submission Date *</label>
                                            <input required type="date" value={modalData.submission_date || ''} onChange={e => setModalData({ ...modalData, submission_date: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                                        </div>
                                        <div>
                                            <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Submitted By *</label>
                                            <select required value={modalData.submitted_by || ''} onChange={e => setModalData({ ...modalData, submitted_by: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }}>
                                                <option value="">-- Employee --</option>
                                                {employees.map(emp => <option key={emp.employee_id} value={emp.employee_id}>{emp.first_name} {emp.last_name}</option>)}
                                            </select>
                                        </div>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Status</label>
                                        <select value={modalData.status || 'submitted'} onChange={e => setModalData({ ...modalData, status: e.target.value })} required aria-required="true" style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }}>
                                            <option value="submitted">Submitted</option>
                                            <option value="accepted">Accepted</option>
                                            <option value="rejected">Rejected</option>
                                        </select>
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>Notes (Optional)</label>
                                        <textarea value={modalData.notes || ''} onChange={e => setModalData({ ...modalData, notes: e.target.value })} style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #e2e8f0' }} />
                                    </div>
                                </>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 16, marginTop: 10, alignItems: 'center' }}>
                                <button 
                                    type="button" 
                                    onClick={() => setIsModalOpen(false)} 
                                    style={{ 
                                        background: 'transparent', 
                                        border: 'none', 
                                        padding: 0, 
                                        cursor: 'pointer', 
                                        fontWeight: 600,
                                        color: '#64748b',
                                        fontSize: 14
                                    }}
                                >
                                    Cancel
                                </button>
                                <button 
                                    type="submit" 
                                    disabled={submitting} 
                                    title="Save" 
                                    aria-label="Save document" 
                                    style={{ 
                                        background: 'transparent', 
                                        border: 'none', 
                                        padding: 0, 
                                        cursor: submitting ? 'not-allowed' : 'pointer', 
                                        fontWeight: 600,
                                        color: submitting ? '#94a3b8' : '#2563eb',
                                        fontSize: 14,
                                        opacity: submitting ? 0.6 : 1
                                    }}
                                >
                                    {submitting ? 'Saving...' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </Layout>
    );
}
