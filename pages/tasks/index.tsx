import {
    type CSSProperties,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import Head from 'next/head';
import axios from 'axios';
import Layout from '@/components/Layout';
import DocumentPreviewModal from '@/components/DocumentPreviewModal';
import { useProtectedPage } from '@/components/AuthProvider';
import { getApiBaseUrl } from '@/utils/network';
import { notifyError, notifySuccess, confirmAction } from '@/utils/notify';
import { useLiveSync } from '@/utils/liveSync';
import { hasRoleFeatureAccess } from '@/utils/roleFeatureAccess';
import styles from '@/styles/TasksBoard.module.css';

const API_BASE = getApiBaseUrl();

type TaskRow = {
    id: number;
    title: string;
    description?: string | null;
    status: string;
    workflow_status: string;
    priority?: 'low' | 'medium' | 'high' | 'urgent' | string;
    due_date?: string | null;
    project_id?: number | null;
    project_name?: string | null;
    client_name?: string | null;
    service_name?: string | null;
    assigned_to?: number | null;
    /** task-workflow.php returns this */
    assigned_to_name?: string | null;
    /** tasks.php returns this */
    assigned_name?: string | null;
    created_by?: number | null;
    created_by_name?: string | null;
    created_at?: string | null;
    rejection_reason?: string | null;
    submission_count?: number;
};

type TaskCommentRow = {
    comment_id: number;
    task_id: number;
    user_id: number;
    parent_comment_id?: number | null;
    comment_text?: string | null;
    attachment_path?: string | null;
    attachment_name?: string | null;
    attachment_mime?: string | null;
    attachment_size?: number | null;
    attachment_archived?: number | boolean;
    commenter_name?: string;
    commenter_role?: string;
    created_at?: string | null;
};

function getAssigneeName(task: TaskRow): string | null {
    return task.assigned_to_name || task.assigned_name || null;
}

type ProjectRow = { id: number; name: string };
type StaffRow = { id: number; full_name: string; first_name: string; last_name: string };

type ColumnKey = 'backlog' | 'in_progress' | 'review' | 'done';

interface ColumnDef {
    key: ColumnKey;
    label: string;
    dotColor: string;
    dot: string;
}

const COLUMNS: ColumnDef[] = [
    { key: 'backlog',      label: 'Backlog',      dotColor: '#9ca3af', dot: '○' },
    { key: 'in_progress',  label: 'In progress',  dotColor: '#f97316', dot: '●' },
    { key: 'review',       label: 'Review',       dotColor: '#3b82f6', dot: '●' },
    { key: 'done',         label: 'Done',         dotColor: '#10b981', dot: '●' },
];

function getColumnForTask(task: TaskRow): ColumnKey {
    const wf = String(task.workflow_status || '').toLowerCase();
    const st = String(task.status || '').toLowerCase();
    if (wf === 'completed' || st === 'completed') return 'done';
    if (wf === 'pending_manager' || wf === 'pending_admin') return 'review';
    if (wf === 'in_progress') return 'in_progress';
    return 'backlog';
}

function getStatusPayloadForColumn(col: ColumnKey): { workflow_status: string; status: string } {
    switch (col) {
        case 'backlog':     return { workflow_status: 'not_started', status: 'pending' };
        case 'in_progress': return { workflow_status: 'in_progress', status: 'in_progress' };
        case 'review':      return { workflow_status: 'pending_manager', status: 'in_progress' };
        case 'done':        return { workflow_status: 'completed', status: 'completed' };
    }
}

function canUserDragFrom(role: string, task: TaskRow, userId: number): boolean {
    if (role === 'admin' || role === 'manager') return true;
    // Staff: can only drag own tasks, not completed ones
    if (String(task.assigned_to) !== String(userId)) return false;
    const col = getColumnForTask(task);
    return col !== 'done';
}

function canUserDropToColumn(role: string, col: ColumnKey): boolean {
    if (role === 'admin' || role === 'manager') return true;
    // Staff cannot move to Done
    return col !== 'done';
}

function formatDueDate(value: unknown): string {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return raw;
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function isDueDateOverdue(value: unknown): boolean {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const d = new Date(raw);
    return !Number.isNaN(d.getTime()) && d < new Date();
}

function getInitials(name: unknown): string {
    const str = String(name || '').trim();
    if (!str) return '?';
    return str
        .split(' ')
        .slice(0, 2)
        .map((n) => n[0] || '')
        .join('')
        .toUpperCase() || str[0]?.toUpperCase() || '?';
}

function avatarBg(name: unknown): string {
    const str = String(name || '').trim();
    const colors = ['#6366f1','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#3b82f6','#10b981','#ef4444'];
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
    return colors[Math.abs(h) % colors.length];
}

function priorityColor(p: string): string {
    switch (p?.toLowerCase()) {
        case 'urgent': return '#ef4444';
        case 'high': return '#f97316';
        case 'medium': return '#eab308';
        case 'low': return '#22c55e';
        default: return '#94a3b8';
    }
}

// ── TaskCard ─────────────────────────────────────────────────────────────────

interface TaskCardProps {
    task: TaskRow;
    draggingId: number | null;
    canDrag: boolean;
    onClick: () => void;
    onDragStart: (id: number) => void;
    onDragEnd: () => void;
}

function TaskCard({ task, draggingId, canDrag, onClick, onDragStart, onDragEnd }: TaskCardProps) {
    const isDragging = draggingId === task.id;
    const overdue = isDueDateOverdue(task.due_date);

    const cardStyle: CSSProperties = {
        opacity: isDragging ? 0.45 : 1,
        cursor: canDrag ? 'grab' : 'pointer',
        userSelect: 'none',
    };

    return (
        <div
            className={styles.taskCard}
            style={cardStyle}
            draggable={canDrag}
            onDragStart={canDrag ? (e) => {
                e.dataTransfer.setData('taskId', String(task.id));
                e.dataTransfer.effectAllowed = 'move';
                onDragStart(task.id);
            } : undefined}
            onDragEnd={onDragEnd}
            onClick={onClick}
        >
            {task.priority && (
                <div className={styles.taskPriorityBar}
                    style={{ background: priorityColor(task.priority) }}
                    title={task.priority}
                />
            )}
            <p className={styles.taskTitle}>{task.title}</p>
            <div className={styles.taskMeta}>
                {task.project_name && (
                    <span className={styles.taskProject} title={task.client_name || task.project_name}>
                        {task.project_name}
                    </span>
                )}
                <div className={styles.taskMetaRight}>
                    {task.due_date && (
                        <span
                            className={styles.taskDueDate}
                            style={{ color: overdue ? '#ef4444' : '#64748b' }}
                        >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                            </svg>
                            {formatDueDate(task.due_date)}
                        </span>
                    )}
                    {getAssigneeName(task) && (
                        <div
                            className={styles.taskAvatar}
                            style={{ background: avatarBg(getAssigneeName(task)) }}
                            title={getAssigneeName(task) ?? undefined}
                        >
                            {getInitials(getAssigneeName(task))}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── TaskDetailModal ───────────────────────────────────────────────────────────

interface TaskDetailModalProps {
    task: TaskRow;
    onClose: () => void;
}

function TaskDetailModal({ task, onClose }: TaskDetailModalProps) {
    const overdue = isDueDateOverdue(task.due_date);
    const [comments, setComments] = useState<TaskCommentRow[]>([]);
    const [commentsLoading, setCommentsLoading] = useState(true);
    const [commentText, setCommentText] = useState('');
    const [commentFiles, setCommentFiles] = useState<File[]>([]);
    const [commentSaving, setCommentSaving] = useState(false);
    const [previewDocument, setPreviewDocument] = useState<{ name: string; url: string; mime?: string | null } | null>(null);

    const loadComments = useCallback(async () => {
        setCommentsLoading(true);
        try {
            const response = await fetch(`${API_BASE}/task-comments.php?task_id=${encodeURIComponent(String(task.id))}`, { credentials: 'include' });
            const payload = await response.json();
            if (!response.ok || !payload?.success) throw new Error(payload?.message || 'Unable to load task discussion.');
            setComments(Array.isArray(payload.data) ? payload.data : []);
        } catch (error) {
            setComments([]);
            notifyError(error instanceof Error ? error.message : 'Unable to load task discussion.');
        } finally {
            setCommentsLoading(false);
        }
    }, [task.id]);

    useEffect(() => {
        void loadComments();
    }, [loadComments]);

    const submitComment = async () => {
        if (!commentText.trim() && commentFiles.length === 0) return;
        setCommentSaving(true);
        try {
            const body = new FormData();
            body.append('task_id', String(task.id));
            if (commentText.trim()) body.append('comment_text', commentText.trim());
            commentFiles.forEach((file) => body.append('attachments[]', file));
            const response = await fetch(`${API_BASE}/task-comments.php`, { method: 'POST', credentials: 'include', body });
            const payload = await response.json();
            if (!response.ok || !payload?.success) throw new Error(payload?.message || 'Unable to post comment.');
            setCommentText('');
            setCommentFiles([]);
            await loadComments();
        } catch (error) {
            notifyError(error instanceof Error ? error.message : 'Unable to post comment.');
        } finally {
            setCommentSaving(false);
        }
    };

    const attachmentUrl = (comment: TaskCommentRow, download = false) =>
        `${API_BASE}/task-comments.php?action=view_attachment&comment_id=${encodeURIComponent(String(comment.comment_id))}${download ? '&download=1' : ''}`;

    const wfLabel: Record<string, string> = {
        not_started: 'Not Started',
        in_progress: 'In Progress',
        pending_manager: 'Pending Manager Review',
        pending_admin: 'Pending Admin Review',
        rejected_by_manager: 'Rejected by Manager',
        rejected_by_admin: 'Rejected by Admin',
        completed: 'Completed',
    };

    return (
        <>
        <div className={styles.modalBackdrop} onClick={onClose}>
            <div className={`${styles.modal} ${styles.taskDetailModal}`} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                    <h2 className={styles.modalTitle}>{task.title}</h2>
                    <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
                </div>
                <div className={styles.modalBody}>
                    <div className={styles.detailGrid}>
                        <div className={styles.detailItem}>
                            <span className={styles.detailLabel}>Status</span>
                            <span className={styles.detailValue}>{wfLabel[task.workflow_status] || task.workflow_status}</span>
                        </div>
                        {task.priority && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Priority</span>
                                <span className={styles.detailValue} style={{ color: priorityColor(task.priority), fontWeight: 700 }}>
                                    {task.priority.charAt(0).toUpperCase() + task.priority.slice(1)}
                                </span>
                            </div>
                        )}
                        {task.project_name && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Project</span>
                                <span className={styles.detailValue}>{task.project_name}</span>
                            </div>
                        )}
                        {task.client_name && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Client</span>
                                <span className={styles.detailValue}>{task.client_name}</span>
                            </div>
                        )}
                        {getAssigneeName(task) && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Assigned To</span>
                                <span className={styles.detailValue}>{getAssigneeName(task)}</span>
                            </div>
                        )}
                        {task.due_date && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Due Date</span>
                                <span className={styles.detailValue} style={{ color: overdue ? '#ef4444' : undefined }}>
                                    {formatDueDate(task.due_date)}{overdue ? ' (Overdue)' : ''}
                                </span>
                            </div>
                        )}
                        {task.service_name && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Service</span>
                                <span className={styles.detailValue}>{task.service_name}</span>
                            </div>
                        )}
                        {task.created_by_name && (
                            <div className={styles.detailItem}>
                                <span className={styles.detailLabel}>Created By</span>
                                <span className={styles.detailValue}>{task.created_by_name}</span>
                            </div>
                        )}
                    </div>
                    {task.description && (
                        <div className={styles.detailDesc}>
                            <span className={styles.detailLabel}>Description</span>
                            <p className={styles.detailDescText}>{task.description}</p>
                        </div>
                    )}
                    {task.rejection_reason && (
                        <div className={styles.detailRejection}>
                            <span className={styles.detailLabel}>Rejection Reason</span>
                            <p className={styles.detailDescText}>{task.rejection_reason}</p>
                        </div>
                    )}

                    <section className={styles.discussionSection} aria-label="Task discussion">
                        <div className={styles.discussionHeading}>
                            <div>
                                <span className={styles.detailLabel}>Task discussion</span>
                                <p>Comments and files from staff, managers, and administrators.</p>
                            </div>
                            <span>{comments.length}</span>
                        </div>

                        <div className={styles.commentComposer}>
                            <textarea
                                value={commentText}
                                onChange={(event) => setCommentText(event.target.value)}
                                placeholder="Write a task comment..."
                                aria-label="Task comment"
                            />
                            <div className={styles.commentComposerActions}>
                                <label className={styles.attachButton}>
                                    Attach PDF
                                    <input
                                        type="file"
                                        accept=".pdf,application/pdf"
                                        multiple
                                        onChange={(event) => setCommentFiles(Array.from(event.target.files || []))}
                                    />
                                </label>
                                {commentFiles.length > 0 && <span className={styles.selectedFiles}>{commentFiles.map((file) => file.name).join(', ')}</span>}
                                <button type="button" onClick={() => void submitComment()} disabled={commentSaving || (!commentText.trim() && commentFiles.length === 0)}>
                                    {commentSaving ? 'Posting...' : 'Post'}
                                </button>
                            </div>
                        </div>

                        <div className={styles.commentFeed}>
                            {commentsLoading ? (
                                <div className={styles.commentEmpty}>Loading discussion...</div>
                            ) : comments.length === 0 ? (
                                <div className={styles.commentEmpty}>No comments or files have been added yet.</div>
                            ) : comments.map((comment) => {
                                const role = String(comment.commenter_role || 'user').toLowerCase();
                                return (
                                    <article key={comment.comment_id} className={styles.commentItem}>
                                        <div className={styles.commentHeader}>
                                            <div>
                                                <strong>{comment.commenter_name || 'User'}</strong>
                                                <span className={`${styles.commentRole} ${styles[`commentRole_${role}`] || ''}`}>{role}</span>
                                            </div>
                                            <time>{comment.created_at ? new Date(comment.created_at).toLocaleString() : ''}</time>
                                        </div>
                                        {comment.comment_text && <p className={styles.commentText}>{comment.comment_text}</p>}
                                        {comment.attachment_path && Number(comment.attachment_archived || 0) !== 1 && (
                                            <div className={styles.commentAttachment}>
                                                <div>
                                                    <strong>{comment.attachment_name || 'Task file'}</strong>
                                                    <span>{comment.attachment_size ? `${(Number(comment.attachment_size) / 1024).toFixed(1)} KB` : 'PDF document'}</span>
                                                </div>
                                                <div>
                                                    <button type="button" onClick={() => setPreviewDocument({ name: comment.attachment_name || 'Task file', url: attachmentUrl(comment), mime: comment.attachment_mime })}>View</button>
                                                    <a href={attachmentUrl(comment, true)} download={comment.attachment_name || undefined}>Download</a>
                                                </div>
                                            </div>
                                        )}
                                    </article>
                                );
                            })}
                        </div>
                    </section>
                </div>
            </div>
        </div>
        <DocumentPreviewModal document={previewDocument} onClose={() => setPreviewDocument(null)} />
        </>
    );
}

// ── CreateTaskModal ───────────────────────────────────────────────────────────

interface CreateTaskModalProps {
    projects: ProjectRow[];
    staff: StaffRow[];
    initialColumn?: ColumnKey;
    onClose: () => void;
    onCreated: (task: TaskRow | null) => void;
}

const defaultForm = { title: '', description: '', project_id: '', assigned_to: '', priority: 'medium', due_date: '' };

function CreateTaskModal({ projects, staff, initialColumn, onClose, onCreated }: CreateTaskModalProps) {
    const [form, setForm] = useState({ ...defaultForm });
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

    const clearFieldError = (name: string) => {
        setFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const missing: Record<string, string> = {};
        if (!form.title.trim()) missing.title = 'Required.';
        if (!form.project_id) missing.project_id = 'Required.';
        if (!form.due_date) missing.due_date = 'Required.';
        if (Object.keys(missing).length > 0) { setFieldErrors(missing); return; }
        setFieldErrors({});

        const assignedStaff = staff.find((s) => String(s.id) === form.assigned_to);
        const assignedName = assignedStaff
            ? (assignedStaff.full_name || `${assignedStaff.first_name} ${assignedStaff.last_name}`.trim())
            : null;

        // Optimistic task — shown on board immediately
        const optimisticTask: TaskRow = {
            id: -Date.now(), // temporary negative id
            title: form.title.trim(),
            description: form.description.trim() || null,
            project_id: Number(form.project_id),
            project_name: projects.find((p) => String(p.id) === form.project_id)?.name ?? null,
            priority: form.priority as TaskRow['priority'],
            due_date: form.due_date || null,
            assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
            assigned_name: assignedName,
            status: 'pending',
            workflow_status: 'not_started',
        };

        // Close modal & paint board at once — no spinner
        onCreated(optimisticTask);

        // Fire-and-forget: persist in background, swap temp id for real one on success
        const payload: Record<string, unknown> = {
            title: form.title.trim(),
            description: form.description.trim() || null,
            project_id: Number(form.project_id),
            priority: form.priority,
            due_date: form.due_date || null,
            assigned_to: form.assigned_to ? Number(form.assigned_to) : null,
        };
        axios.post(`${API_BASE}/tasks.php`, payload, { withCredentials: true })
            .then((res) => {
                if (!res.data?.success) throw new Error(res.data?.message || 'Failed to create task');
                // Replace optimistic row with real server row (correct id, timestamps, etc.)
                onCreated(res.data.data as TaskRow);
            })
            .catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : 'Failed to create task';
                notifyError(msg);
                // Remove the optimistic row
                onCreated(null);
            });
    };

    return (
        <div className={styles.modalBackdrop} onClick={onClose}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div className={styles.modalHeader}>
                    <h2 className={styles.modalTitle}>New Task</h2>
                    <button className={styles.modalClose} onClick={onClose} aria-label="Close">×</button>
                </div>
                <form className={styles.modalBody} onSubmit={handleSubmit} noValidate>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel}>Title <span style={{ color: '#ef4444' }}>*</span></label>
                        <input
                            className={styles.formInput}
                            value={form.title}
                            onChange={(e) => { setForm(p => ({ ...p, title: e.target.value })); clearFieldError('title'); }}
                            placeholder="Task title"
                            maxLength={255}
                            autoFocus
                            required
                            aria-required="true"
                            aria-invalid={fieldErrors.title ? true : undefined}
                            style={fieldErrors.title ? { border: '2px solid #ef4444' } : undefined}
                        />
                        {fieldErrors.title && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.title}</div>}
                    </div>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel}>Project <span style={{ color: '#ef4444' }}>*</span></label>
                        <select
                            className={styles.formSelect}
                            value={form.project_id}
                            onChange={(e) => { setForm(p => ({ ...p, project_id: e.target.value })); clearFieldError('project_id'); }}
                            required
                            aria-required="true"
                            aria-invalid={fieldErrors.project_id ? true : undefined}
                            style={fieldErrors.project_id ? { border: '2px solid #ef4444' } : undefined}
                        >
                            <option value="">Select project…</option>
                            {projects.map((pr) => (
                                <option key={pr.id} value={pr.id}>{pr.name}</option>
                            ))}
                        </select>
                        {fieldErrors.project_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.project_id}</div>}
                    </div>
                    <div className={styles.formRow}>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>Assign To</label>
                            <select
                                className={styles.formSelect}
                                value={form.assigned_to}
                                onChange={(e) => setForm(p => ({ ...p, assigned_to: e.target.value }))}
                            >
                                <option value="">Unassigned</option>
                                {staff.map((s) => (
                                    <option key={s.id} value={s.id}>{s.full_name || `${s.first_name} ${s.last_name}`}</option>
                                ))}
                            </select>
                        </div>
                        <div className={styles.formGroup}>
                            <label className={styles.formLabel}>Priority</label>
                            <select
                                className={styles.formSelect}
                                value={form.priority}
                                onChange={(e) => setForm(p => ({ ...p, priority: e.target.value }))}
                            >
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="urgent">Urgent</option>
                            </select>
                        </div>
                    </div>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel}>Due Date <span style={{ color: '#ef4444' }}>*</span></label>
                        <input
                            type="datetime-local"
                            className={styles.formInput}
                            value={form.due_date}
                            onChange={(e) => { setForm(p => ({ ...p, due_date: e.target.value })); clearFieldError('due_date'); }}
                            required
                            aria-required="true"
                            aria-invalid={fieldErrors.due_date ? true : undefined}
                            style={fieldErrors.due_date ? { border: '2px solid #ef4444' } : undefined}
                        />
                        {fieldErrors.due_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.due_date}</div>}
                    </div>
                    <div className={styles.formGroup}>
                        <label className={styles.formLabel}>Description</label>
                        <textarea
                            className={styles.formTextarea}
                            value={form.description}
                            onChange={(e) => setForm(p => ({ ...p, description: e.target.value }))}
                            placeholder="Optional description…"
                            rows={3}
                        />
                    </div>
                    <div className={styles.modalFooter}>
                        <button type="button" className={styles.btnSecondary} onClick={onClose}>Cancel</button>
                        <button type="submit" className={styles.btnPrimary}>Create Task</button>
                    </div>
                </form>
            </div>
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function TasksBoardPage() {
    const { user, loading, logout } = useProtectedPage({ allowedRoles: ['admin', 'manager', 'staff'] });

    const [tasks, setTasks] = useState<TaskRow[]>([]);
    const [projects, setProjects] = useState<ProjectRow[]>([]);
    const [staff, setStaff] = useState<StaffRow[]>([]);
    const [dataLoading, setDataLoading] = useState(true);
    const [draggingId, setDraggingId] = useState<number | null>(null);
    const [dragOverCol, setDragOverCol] = useState<ColumnKey | null>(null);
    const [selectedTask, setSelectedTask] = useState<TaskRow | null>(null);
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [createInitialCol, setCreateInitialCol] = useState<ColumnKey>('backlog');
    const [assigneeFilter, setAssigneeFilter] = useState<'everyone' | number>('everyone');
    const dragLeaveTimers = useRef<Partial<Record<ColumnKey, ReturnType<typeof setTimeout>>>>({});

    const role = String(user?.role || '').trim().toLowerCase();
    const userId = Number(user?.id || 0);
    const canManageTasks = role === 'admin' || role === 'manager';
    const featureAccess = user?.role_feature_access;
    const hasMyTasksAccess = hasRoleFeatureAccess(role, 'my_tasks', featureAccess);
    const hasProjectsAccess = hasRoleFeatureAccess(role, 'projects', featureAccess);
    const hasAccess = role === 'admin' || hasMyTasksAccess || hasProjectsAccess;

    const fetchAll = useCallback(async () => {
        if (!user?.id) return;
        try {
            // Use task-workflow my_tasks for richer data
            const endpoint = (role === 'manager' || role === 'admin')
                ? `${API_BASE}/task-workflow.php?action=my_tasks`
                : `${API_BASE}/tasks.php?include_collaborations=1`;

            const [tasksRes, projectsRes] = await Promise.all([
                axios.get(endpoint, { withCredentials: true }),
                canManageTasks
                    ? axios.get(`${API_BASE}/projects.php`, { withCredentials: true })
                    : Promise.resolve(null),
            ]);

            // task-workflow returns { data: { tasks: [] } }, tasks.php returns { data: [] }
            let rawTasks: TaskRow[] = [];
            if (Array.isArray(tasksRes.data?.data?.tasks)) {
                rawTasks = tasksRes.data.data.tasks;
            } else if (Array.isArray(tasksRes.data?.data)) {
                rawTasks = tasksRes.data.data;
            }
            setTasks(rawTasks);

            if (projectsRes) {
                const rawProjects = Array.isArray(projectsRes.data?.data)
                    ? projectsRes.data.data
                    : Array.isArray(projectsRes.data)
                        ? projectsRes.data
                        : [];
                setProjects(rawProjects.map((p: Record<string, unknown>) => ({ id: Number(p.id), name: String(p.name || '') })));
            }
        } catch {
            notifyError('Failed to load tasks');
        } finally {
            setDataLoading(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id, role, canManageTasks]);

    const fetchStaff = useCallback(async () => {
        if (!canManageTasks) return;
        try {
            const res = await axios.get(`${API_BASE}/users.php`, { withCredentials: true });
            const raw = Array.isArray(res.data?.data) ? res.data.data : Array.isArray(res.data) ? res.data : [];
            setStaff(raw
                .filter((u: Record<string, unknown>) => String(u.role || '').toLowerCase() === 'staff')
                .map((u: Record<string, unknown>) => ({
                    id: Number(u.id),
                    full_name: String(u.full_name || `${u.first_name || ''} ${u.last_name || ''}`.trim()),
                    first_name: String(u.first_name || ''),
                    last_name: String(u.last_name || ''),
                }))
            );
        } catch {
            // Non-fatal
        }
    }, [canManageTasks]);

    useEffect(() => {
        if (user?.id) {
            void fetchAll();
            void fetchStaff();
        }
    }, [user?.id, fetchAll, fetchStaff]);

    useLiveSync(async () => {
        if (!user?.id) return;
        await fetchAll();
    });

    // Assignee list for filter dropdown (unique from tasks)
    const assigneeOptions = useMemo(() => {
        const map = new Map<number, string>();
        tasks.forEach((t) => {
            const name = getAssigneeName(t);
            if (t.assigned_to && name) {
                map.set(t.assigned_to, name);
            }
        });
        return Array.from(map.entries()).map(([id, name]) => ({ id, name }));
    }, [tasks]);

    const filteredTasks = useMemo(() => {
        if (assigneeFilter === 'everyone') return tasks;
        return tasks.filter((t) => Number(t.assigned_to) === assigneeFilter);
    }, [tasks, assigneeFilter]);

    const columnTasks = useMemo(() => {
        const cols: Record<ColumnKey, TaskRow[]> = { backlog: [], in_progress: [], review: [], done: [] };
        filteredTasks.forEach((t) => {
            const col = getColumnForTask(t);
            cols[col].push(t);
        });
        return cols;
    }, [filteredTasks]);

    const openCount = useMemo(() =>
        tasks.filter((t) => getColumnForTask(t) !== 'done').length,
    [tasks]);

    const projectCount = useMemo(() => {
        const ids = new Set(tasks.filter((t) => t.project_id).map((t) => t.project_id));
        return ids.size;
    }, [tasks]);

    // ── Drag & Drop ───────────────────────────────────────────────────────────

    const handleDragStart = useCallback((id: number) => {
        setDraggingId(id);
    }, []);

    const handleDragEnd = useCallback(() => {
        setDraggingId(null);
        setDragOverCol(null);
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, col: ColumnKey) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = canUserDropToColumn(role, col) ? 'move' : 'none';
        if (dragLeaveTimers.current[col]) {
            clearTimeout(dragLeaveTimers.current[col]);
            delete dragLeaveTimers.current[col];
        }
        setDragOverCol(col);
    }, [role]);

    const handleDragLeave = useCallback((_e: React.DragEvent, col: ColumnKey) => {
        dragLeaveTimers.current[col] = setTimeout(() => {
            setDragOverCol((prev) => (prev === col ? null : prev));
        }, 60);
    }, []);

    const handleDrop = useCallback(async (e: React.DragEvent, toCol: ColumnKey) => {
        e.preventDefault();
        setDragOverCol(null);
        const taskId = Number(e.dataTransfer.getData('taskId'));
        if (!taskId) return;

        const task = tasks.find((t) => t.id === taskId);
        if (!task) return;

        const fromCol = getColumnForTask(task);
        if (fromCol === toCol) return;

        // Permission check
        if (!canUserDragFrom(role, task, userId)) {
            notifyError('You do not have permission to move this task.');
            return;
        }
        if (!canUserDropToColumn(role, toCol)) {
            notifyError('You do not have permission to move tasks to this column.');
            return;
        }

        const { workflow_status: newWf, status: newSt } = getStatusPayloadForColumn(toCol);

        // Optimistic update
        const prev = tasks;
        setTasks((all) =>
            all.map((t) =>
                t.id === taskId
                    ? { ...t, workflow_status: newWf, status: newSt }
                    : t
            )
        );

        try {
            const res = await axios.post(
                `${API_BASE}/task-workflow.php?action=board_move`,
                { task_id: taskId, workflow_status: newWf, status: newSt },
                { withCredentials: true }
            );
            if (!res.data?.success) throw new Error(res.data?.message || 'Failed to update task');
        } catch (err: unknown) {
            setTasks(prev);
            const msg = err instanceof Error ? err.message : 'Failed to update task status';
            notifyError(msg);
        }
    }, [tasks, role, userId]);

    const handleTaskCreated = useCallback((newTask: TaskRow | null) => {
        if (newTask === null) {
            // Error: remove the optimistic row (negative id)
            setTasks((prev) => prev.filter((t) => t.id > 0));
            return;
        }
        if (newTask.id < 0) {
            // First call: optimistic row — prepend and close modal
            setTasks((prev) => [newTask, ...prev]);
            setShowCreateModal(false);
        } else {
            // Second call: real server row — replace optimistic row
            setTasks((prev) => {
                const hasOptimistic = prev.some((t) => t.id < 0);
                if (hasOptimistic) {
                    return prev.map((t) => (t.id < 0 ? newTask : t));
                }
                // No optimistic row (race condition — just prepend)
                return [newTask, ...prev];
            });
        }
    }, []);

    const handleOpenCreate = useCallback((col: ColumnKey = 'backlog') => {
        if (!canManageTasks) { notifyError('Only managers and admins can create tasks.'); return; }
        setCreateInitialCol(col);
        setShowCreateModal(true);
    }, [canManageTasks]);

    if (loading) return null;
    if (!hasAccess) {
        return (
            <Layout role={role} user={user} onLogout={logout}>
                <Head><title>Tasks Board</title></Head>
                <div style={{ padding: '48px 24px', textAlign: 'center', color: '#64748b' }}>
                    You don&apos;t have access to the Tasks Board.
                </div>
            </Layout>
        );
    }

    return (
        <Layout role={role} user={user} onLogout={logout}>
            <Head><title>Tasks Board</title></Head>

            {/* ── Header ───────────────────────────────────────── */}
            <div className={styles.pageHeader}>
                <div>
                    <p className={styles.pageHeaderLabel}>BOARD</p>
                    <h1 className={styles.pageHeaderTitle}>Tasks</h1>
                    {!dataLoading && (
                        <p className={styles.pageHeaderSub}>
                            {openCount} open task{openCount !== 1 ? 's' : ''} across {projectCount} project{projectCount !== 1 ? 's' : ''}
                        </p>
                    )}
                </div>
                <div className={styles.pageHeaderActions}>
                    {/* Assignee filter */}
                    <div className={styles.assigneeFilterWrapper}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                        </svg>
                        <select
                            className={styles.assigneeSelect}
                            value={assigneeFilter === 'everyone' ? 'everyone' : String(assigneeFilter)}
                            onChange={(e) => setAssigneeFilter(e.target.value === 'everyone' ? 'everyone' : Number(e.target.value))}
                            aria-label="Filter by assignee"
                        >
                            <option value="everyone">Everyone</option>
                            {userId > 0 && <option value={userId}>Me</option>}
                            {assigneeOptions
                                .filter((a) => a.id !== userId)
                                .map((a) => (
                                    <option key={a.id} value={a.id}>{a.name}</option>
                                ))
                            }
                        </select>
                    </div>
                    {canManageTasks && (
                        <button className={styles.newTaskBtn} onClick={() => handleOpenCreate('backlog')}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            New task
                        </button>
                    )}
                </div>
            </div>

            {/* ── Board ────────────────────────────────────────── */}
            <div className={styles.boardWrapper}>
                {dataLoading ? (
                    <div className={styles.boardLoading}>
                        <div className={styles.boardLoadingSpinner} />
                        <span>Loading tasks…</span>
                    </div>
                ) : (
                    <div className={styles.board}>
                        {COLUMNS.map((col) => {
                            const colTasks = columnTasks[col.key];
                            const isDragTarget = dragOverCol === col.key && draggingId !== null;
                            const canDrop = canUserDropToColumn(role, col.key);

                            return (
                                <div
                                    key={col.key}
                                    className={`${styles.column} ${isDragTarget && canDrop ? styles.columnDragOver : ''}`}
                                    onDragOver={(e) => handleDragOver(e, col.key)}
                                    onDragLeave={(e) => handleDragLeave(e, col.key)}
                                    onDrop={(e) => handleDrop(e, col.key)}
                                >
                                    {/* Column header */}
                                    <div className={styles.columnHeader}>
                                        <div className={styles.columnTitleRow}>
                                            <span
                                                className={styles.columnDot}
                                                style={{ background: col.dotColor }}
                                            />
                                            <span className={styles.columnLabel}>{col.label}</span>
                                            <span className={styles.columnCount}>{colTasks.length}</span>
                                        </div>
                                        {canManageTasks && (
                                            <button
                                                className={styles.columnAddBtn}
                                                onClick={() => handleOpenCreate(col.key)}
                                                title={`Add task to ${col.label}`}
                                                aria-label={`Add task to ${col.label}`}
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                                </svg>
                                            </button>
                                        )}
                                    </div>

                                    {/* Task cards */}
                                    <div className={styles.taskList}>
                                        {colTasks.length === 0 ? (
                                            <div className={styles.emptyColumn}>
                                                {isDragTarget && canDrop
                                                    ? 'Drop here'
                                                    : 'No tasks'}
                                            </div>
                                        ) : (
                                            colTasks.map((task) => (
                                                <TaskCard
                                                    key={task.id}
                                                    task={task}
                                                    draggingId={draggingId}
                                                    canDrag={canUserDragFrom(role, task, userId)}
                                                    onClick={() => setSelectedTask(task)}
                                                    onDragStart={handleDragStart}
                                                    onDragEnd={handleDragEnd}
                                                />
                                            ))
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* ── Modals ───────────────────────────────────────── */}
            {selectedTask && (
                <TaskDetailModal
                    task={selectedTask}
                    onClose={() => setSelectedTask(null)}
                />
            )}

            {showCreateModal && (
                <CreateTaskModal
                    projects={projects}
                    staff={staff}
                    initialColumn={createInitialCol}
                    onClose={() => setShowCreateModal(false)}
                    onCreated={handleTaskCreated}
                />
            )}
        </Layout>
    );
}
