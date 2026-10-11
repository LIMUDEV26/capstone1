import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../components/Layout';
import Pagination from '../components/Pagination';
import EditedBadge from '../components/EditedBadge';
import DocumentPreviewModal from '../components/DocumentPreviewModal';
import { useEditedIndicator } from '../components/useEditedIndicator';
import { getBackendBaseUrl, getAuthenticatedFileUrl } from '@/utils/network';
import { confirmAction, notifyError, promptAction, showLoadingModal, closeLoadingModal, showCenteredCardNotification } from '@/utils/notify';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import SearchBar from '../components/SearchBar';
import ZeroResults from '../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

const API_BASE_URL = getBackendBaseUrl();

type SessionUser = {
    id?: number;
    role?: string;
    first_name?: string;
    [key: string]: unknown;
};

type TaskRow = {
    id: number;
    title: string;
    description?: string | null;
    status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | string;
    workflow_status?: string;
    priority?: 'low' | 'medium' | 'high' | string;
    due_date?: string | null;
    project_id?: number;
    project_name?: string;
    client_name?: string;
    service_name?: string;
    has_completion_report?: number | boolean;
    completion_report_sent_at?: string | null;
    require_completion_proof?: number | boolean;
    started_at?: string | null;
    submitted_at?: string | null;
    submission_count?: number;
    latest_file?: string | null;
    rejection_reason?: string | null;
};

type WorkflowSubmission = {
    submission_id: number;
    task_id: number;
    submitted_by_name: string;
    file_name: string;
    file_path: string;
    file_size: number;
    mime_type?: string | null;
    notes: string;
    status: string;
    submitted_at: string;
    reviewed_by_name: string | null;
    reviewed_at: string | null;
    review_notes: string | null;
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
    updated_at?: string | null;
};

type TaskDocumentPreview = {
    name: string;
    url: string;
    mime?: string | null;
};

type ApiResponse<T> = {
    success?: boolean;
    message?: string;
    data?: T;
};

function formatDateKey(date: Date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function normalizeDateKey(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const directMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (directMatch) {
        return directMatch[1];
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) {
        return '';
    }

    return formatDateKey(parsed);
}

function formatDateTime(value: unknown, emptyLabel = '-') {
    const raw = String(value || '').trim();
    if (!raw) return emptyLabel;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function isOpenTask(status: unknown) {
    const normalized = String(status || '').trim().toLowerCase();
    return normalized !== 'completed' && normalized !== 'cancelled';
}

export default function MyTasksPage() {
    const ITEMS_PER_PAGE = usePaginationSetting();
    const router = useRouter();
    const [user, setUser] = useState<SessionUser | null>(null);
    const [tasks, setTasks] = useState<TaskRow[]>([]);
    const { editedItems, markEdited } = useEditedIndicator();
    const [loading, setLoading] = useState(true);
    const [sendingReportTaskId, setSendingReportTaskId] = useState<number | null>(null);
    const [taskViewMode, setTaskViewMode] = useState<'list' | 'card'>('list');
    const [error, setError] = useState('');
    const [search, setSearch] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [priorityFilter, setPriorityFilter] = useState('all');
    const [deadlineFilter, setDeadlineFilter] = useState('all');
    const [currentPage, setCurrentPage] = useState(1);
    const [expandedTaskId, setExpandedTaskId] = useState<number | null>(null);
    const [taskComments, setTaskComments] = useState<TaskCommentRow[]>([]);
    const [taskCommentsLoading, setTaskCommentsLoading] = useState(false);
    const [taskCommentSaving, setTaskCommentSaving] = useState(false);
    const [taskCommentText, setTaskCommentText] = useState('');
    const [taskCommentReplyTarget, setTaskCommentReplyTarget] = useState<TaskCommentRow | null>(null);
    const [taskCommentAttachments, setTaskCommentAttachments] = useState<File[]>([]);
    const [taskAttachmentActionCommentId, setTaskAttachmentActionCommentId] = useState<number | null>(null);
    const taskCommentFileInputRef = useRef<HTMLInputElement | null>(null);

    // Workflow state
    const [showSubmitModal, setShowSubmitModal] = useState(false);
    const [submitTaskId, setSubmitTaskId] = useState<number | null>(null);
    const [submitFile, setSubmitFile] = useState<File | null>(null);
    const [submitFilePreviewUrl, setSubmitFilePreviewUrl] = useState<string | null>(null);
    const [submitNotes, setSubmitNotes] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [showReviewModal, setShowReviewModal] = useState(false);
    const [reviewTaskId, setReviewTaskId] = useState<number | null>(null);
    const [reviewApproved, setReviewApproved] = useState(true);
    const [reviewNotes, setReviewNotes] = useState('');
    const [reviewing, setReviewing] = useState(false);
    const [taskSubmissions, setTaskSubmissions] = useState<WorkflowSubmission[]>([]);
    const [submissionsLoading, setSubmissionsLoading] = useState(false);
    const [submissionDocumentPreview, setSubmissionDocumentPreview] = useState<TaskDocumentPreview | null>(null);

    // Live-sync: silently re-fetch tasks in background.
    useLiveSync(async () => {
        const userId = Number(user?.id || 0);
        if (!userId) return;
        await fetchMyTasks(userId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    useEffect(() => {
        const init = async () => {
            try {
                const sessionRes = await fetch(`${API_BASE_URL}/api/auth.php`, { credentials: 'include' });
                const sessionData = (await sessionRes.json()) as ApiResponse<SessionUser>;
                if (!sessionData.success || !sessionData.data) {
                    router.push('/');
                    return;
                }

                const role = String(sessionData.data.role || '').toLowerCase();
                if (!['staff', 'manager', 'admin'].includes(role)) {
                    router.push('/dashboard');
                    return;
                }

                setUser(sessionData.data);
                const currentUserId = Number(sessionData.data.id || 0);
                if (currentUserId > 0) {
                    await fetchMyTasks(currentUserId);
                }
            } catch {
                router.push('/');
            } finally {
                setLoading(false);
            }
        };

        init();
    }, [router]);

    useEffect(() => {
        if (!router.isReady) return;

        const queryStatus = typeof router.query.status === 'string' ? router.query.status : 'all';
        const queryDeadline = typeof router.query.filter === 'string' ? router.query.filter : 'all';
        const allowedStatuses = new Set(['all', 'pending', 'in_progress', 'completed', 'cancelled']);
        const allowedDeadlines = new Set(['all', 'due_today', 'overdue']);

        setStatusFilter(allowedStatuses.has(queryStatus) ? queryStatus : 'all');
        setDeadlineFilter(allowedDeadlines.has(queryDeadline) ? queryDeadline : 'all');
    }, [router.isReady, router.query.filter, router.query.status]);

    const fetchMyTasks = async (userId: number) => {
        setError('');
        const role = String(user?.role || '').toLowerCase();
        try {
            // Managers and admins fetch from task-workflow API to see all relevant tasks
            if (role === 'manager' || role === 'admin') {
                const res = await fetch(`${API_BASE_URL}/api/task-workflow.php?action=my_tasks`, { credentials: 'include' });
                const data = await res.json();
                if (data.success && data.data?.tasks) {
                    setTasks(data.data.tasks);
                } else {
                    setTasks([]);
                    setError(data.message || data.error || 'Failed to load tasks.');
                }
            } else {
                const res = await fetch(`${API_BASE_URL}/api/tasks.php?assigned_to=${userId}&include_collaborations=1`, { credentials: 'include' });
                const data = (await res.json()) as ApiResponse<TaskRow[]>;
                if (data.success && Array.isArray(data.data)) {
                    setTasks(data.data);
                } else {
                    setTasks([]);
                    setError(data.message || 'Failed to load tasks.');
                }
            }
        } catch {
            setTasks([]);
            setError('Failed to load tasks.');
        }
    };

    const fetchTaskSubmissions = async (taskId: number) => {
        setSubmissionsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/task-workflow.php?action=task_details&task_id=${taskId}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success && data.data?.submissions) {
                setTaskSubmissions(data.data.submissions);
            } else {
                setTaskSubmissions([]);
            }
        } catch {
            setTaskSubmissions([]);
        } finally {
            setSubmissionsLoading(false);
        }
    };

    const handleStartTask = async (taskId: number) => {
        setError('');
        try {
            const res = await fetch(`${API_BASE_URL}/api/task-workflow.php?action=start_task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ task_id: taskId }),
            });
            const data = await res.json();
            if (data.success) {
                // Update local state immediately so the button switches to "Upload Document & Done"
                // without closing the expanded task panel
                setTasks((prev) => prev.map((t) =>
                    t.id === taskId ? { ...t, workflow_status: 'in_progress', status: 'in_progress' } : t
                ));
                markEdited(taskId);
            } else {
                setError(data.message || data.error || 'Failed to start task');
            }
        } catch {
            setError('Error starting task');
        }
    };

    const handleOpenSubmitModal = (taskId: number) => {
        setSubmitTaskId(taskId);
        if (submitFilePreviewUrl) URL.revokeObjectURL(submitFilePreviewUrl);
        setSubmitFile(null);
        setSubmitFilePreviewUrl(null);
        setSubmitNotes('');
        setShowSubmitModal(true);
    };

    const handleSubmitFileChange = (file: File | null) => {
        if (submitFilePreviewUrl) URL.revokeObjectURL(submitFilePreviewUrl);
        if (file) {
            const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
            const isPdf = file.type === 'application/pdf' || ext === 'pdf';
            if (!isPdf) {
                void notifyError('Only PDF files are allowed. Please select a valid PDF document.');
                setSubmitFile(null);
                setSubmitFilePreviewUrl(null);
                return;
            }
            if (file.size > 10 * 1024 * 1024) {
                void notifyError('File size exceeds the 10 MB limit. Please choose a smaller PDF.');
                setSubmitFile(null);
                setSubmitFilePreviewUrl(null);
                return;
            }
        }
        setSubmitFile(file);
        setSubmitFilePreviewUrl(file ? URL.createObjectURL(file) : null);
    };

    const handleSubmitDocument = async () => {
        if (!submitFile || !submitTaskId) {
            setError('Please select a file');
            return;
        }
        setSubmitting(true);
        setError('');
        try {
            const formData = new FormData();
            formData.append('task_id', submitTaskId.toString());
            formData.append('document', submitFile);
            formData.append('notes', submitNotes);
            const res = await fetch(`${API_BASE_URL}/api/task-workflow.php?action=submit_document`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();
            if (data.success) {
                setShowSubmitModal(false);
                const currentUserId = Number(user?.id || 0);
                if (currentUserId > 0) await fetchMyTasks(currentUserId);
                markEdited(submitTaskId);
                setExpandedTaskId(null);
            } else {
                setError(data.message || data.error || 'Failed to submit document');
            }
        } catch {
            setError('Error submitting document');
        } finally {
            setSubmitting(false);
        }
    };

    const handleOpenReviewModal = (taskId: number, approved: boolean) => {
        setExpandedTaskId(null);
        setReviewTaskId(taskId);
        setReviewApproved(approved);
        setReviewNotes('');
        setShowReviewModal(true);
    };

    const handleSubmitReview = async () => {
        if (!reviewTaskId) return;
        if (!reviewApproved && !reviewNotes.trim()) {
            setError('Rejection reason is required');
            return;
        }
        setReviewing(true);
        setError('');
        try {
            const role = String(user?.role || '').toLowerCase();
            const action = role === 'admin' ? 'admin_review' : 'manager_review';
            const res = await fetch(`${API_BASE_URL}/api/task-workflow.php?action=${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    task_id: reviewTaskId,
                    approved: reviewApproved,
                    review_notes: reviewNotes,
                }),
            });
            const data = await res.json();
            if (data.success) {
                setShowReviewModal(false);
                const currentUserId = Number(user?.id || 0);
                if (currentUserId > 0) await fetchMyTasks(currentUserId);
                markEdited(reviewTaskId);
                setExpandedTaskId(null);
            } else {
                setError(data.message || data.error || 'Failed to submit review');
            }
        } catch {
            setError('Error submitting review');
        } finally {
            setReviewing(false);
        }
    };

    const handleLogout = async () => {
        await fetch(`${API_BASE_URL}/api/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const handleSendCompletionReport = async (task: TaskRow) => {
        if (!task || task.status !== 'completed') return;

        const defaultReport = `Task "${task.title}" has been completed successfully.`;
        const isResend = Number(task.has_completion_report ?? 0) === 1;
        const promptLabel = isResend
            ? 'Update and resend completion report for the client (optional):'
            : 'Enter completion report for the client (optional):';
        const reportBody = await promptAction({
            title: isResend ? 'Resend completion report' : 'Send completion report',
            text: `Review the client report for "${task.title}".`,
            inputLabel: promptLabel,
            inputValue: defaultReport,
            confirmButtonText: isResend ? 'Resend report' : 'Send report',
            cancelButtonText: 'Cancel',
            icon: 'question',
            large: true, // Use large textarea for better editing
        });
        if (reportBody === null) return;

        setSendingReportTaskId(task.id);
        setError('');

        // Show loading modal with clock loader
        showLoadingModal(
            'Sending Completion Report...',
            'Preparing and sending report to client. This may take a moment...'
        );

        try {
            const res = await fetch(`${API_BASE_URL}/api/task-reports.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    task_id: task.id,
                    report_body: reportBody.trim(),
                }),
            });
            const data = (await res.json()) as ApiResponse<null>;
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
                            // Redirect to the project detail page where they can access client info
                            if (task.project_id) {
                                router.push(`/projects/detail?id=${task.project_id}`);
                            } else {
                                router.push('/clients');
                            }
                        },
                    });
                } else {
                    setError(errorMessage);
                }
                return;
            }
            closeLoadingModal();
            setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, has_completion_report: 1, completion_report_sent_at: new Date().toISOString() } : t)));
            markEdited(task.id);
        } catch {
            setError('Failed to send completion report.');
        } finally {
            setSendingReportTaskId(null);
        }
    };

    const clearTaskCommentAttachments = () => {
        setTaskCommentAttachments([]);
        if (taskCommentFileInputRef.current) {
            taskCommentFileInputRef.current.value = '';
        }
    };

    const resetTaskDiscussionComposer = () => {
        setTaskCommentText('');
        setTaskCommentReplyTarget(null);
    };

    const addTaskCommentAttachments = (fileList: FileList | null) => {
        if (!fileList || fileList.length === 0) return;
        const incoming = Array.from(fileList);
        setTaskCommentAttachments((previous) => {
            const next = [...previous];
            incoming.forEach((file) => {
                const duplicate = next.some(
                    (existing) =>
                        existing.name === file.name &&
                        existing.size === file.size &&
                        existing.lastModified === file.lastModified
                );
                if (!duplicate) {
                    next.push(file);
                }
            });
            return next;
        });
    };

    const removeTaskCommentAttachmentAt = (index: number) => {
        setTaskCommentAttachments((previous) => previous.filter((_, idx) => idx !== index));
    };

    const fetchTaskComments = useCallback(async (taskId: number) => {
        setTaskCommentsLoading(true);
        try {
            const res = await fetch(`${API_BASE_URL}/api/task-comments.php?task_id=${taskId}`, { credentials: 'include' });
            const data = (await res.json()) as ApiResponse<TaskCommentRow[]>;
            if (data.success && Array.isArray(data.data)) {
                setTaskComments(data.data);
            } else {
                setTaskComments([]);
            }
        } catch {
            setTaskComments([]);
        } finally {
            setTaskCommentsLoading(false);
        }
    }, []);

    const submitTaskComment = async (task: TaskRow) => {
        const trimmed = taskCommentText.trim();
        if (!trimmed) {
            setError('Write a comment/reply first.');
            return;
        }

        setTaskCommentSaving(true);
        setError('');
        try {
            const formData = new FormData();
            formData.append('task_id', String(task.id));
            formData.append('comment_text', trimmed);
            if (taskCommentReplyTarget) formData.append('parent_comment_id', String(taskCommentReplyTarget.comment_id));

            const res = await fetch(`${API_BASE_URL}/api/task-comments.php`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = (await res.json()) as ApiResponse<{ comment_id: number }>;
            if (!data.success) {
                setError(data.message || 'Failed to post task comment.');
                return;
            }

            resetTaskDiscussionComposer();
            await fetchTaskComments(task.id);
        } catch {
            setError('Failed to post task comment.');
        } finally {
            setTaskCommentSaving(false);
        }
    };

    const uploadTaskDocuments = async (task: TaskRow) => {
        if (taskCommentAttachments.length === 0) {
            setError('Select at least one document/file first.');
            return;
        }

        setTaskCommentSaving(true);
        setError('');
        try {
            const formData = new FormData();
            formData.append('task_id', String(task.id));
            taskCommentAttachments.forEach((file) => {
                formData.append('attachments[]', file);
            });

            const res = await fetch(`${API_BASE_URL}/api/task-comments.php`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = (await res.json()) as ApiResponse<{ comment_id: number }>;
            if (!data.success) {
                setError(data.message || 'Failed to upload documents/files.');
                return;
            }

            clearTaskCommentAttachments();
            await fetchTaskComments(task.id);
        } catch {
            setError('Failed to upload documents/files.');
        } finally {
            setTaskCommentSaving(false);
        }
    };

    const setTaskDocumentArchiveStatus = async (task: TaskRow, commentId: number, archived: boolean) => {
        setTaskAttachmentActionCommentId(commentId);
        setError('');
        try {
            const res = await fetch(`${API_BASE_URL}/api/task-comments.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    action: 'archive_attachment',
                    comment_id: commentId,
                    archived: archived ? 1 : 0,
                }),
            });
            const data = (await res.json()) as ApiResponse<null>;
            if (!data.success) {
                setError(data.message || 'Failed to update document/file archive status.');
                return;
            }
            await fetchTaskComments(task.id);
        } catch {
            setError('Failed to update document/file archive status.');
        } finally {
            setTaskAttachmentActionCommentId(null);
        }
    };

    const removeTaskDocument = async (task: TaskRow, commentId: number) => {
        const confirmed = await confirmAction({
            title: 'Remove uploaded file?',
            text: 'Remove this uploaded document/file?',
            confirmButtonText: 'Remove',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        setTaskAttachmentActionCommentId(commentId);
        setError('');
        try {
            const res = await fetch(`${API_BASE_URL}/api/task-comments.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    action: 'remove_attachment',
                    comment_id: commentId,
                }),
            });
            const data = (await res.json()) as ApiResponse<null>;
            if (!data.success) {
                setError(data.message || 'Failed to remove document/file.');
                return;
            }
            await fetchTaskComments(task.id);
        } catch {
            setError('Failed to remove document/file.');
        } finally {
            setTaskAttachmentActionCommentId(null);
        }
    };

    const openTaskDocumentPreview = (comment: TaskCommentRow) => {
        if (!comment.attachment_path || !comment.comment_id) {
            setError('Document/file path not found.');
            return;
        }

        setSubmissionDocumentPreview({
            name: comment.attachment_name || 'Document',
            url: `${API_BASE_URL}/api/task-comments.php?action=view_attachment&comment_id=${encodeURIComponent(String(comment.comment_id))}`,
            mime: comment.attachment_mime || '',
        });
    };

    const openWorkflowSubmissionPreview = (submission: WorkflowSubmission) => {
        const submissionId = Number(submission.submission_id || 0);
        if (!submissionId) {
            setError('Submission ID not found.');
            return;
        }

        setExpandedTaskId(null);
        setSubmissionDocumentPreview({
            name: submission.file_name || 'Submission',
            url: `${API_BASE_URL}/api/task-workflow.php?action=view_submission&submission_id=${encodeURIComponent(String(submissionId))}`,
            mime: submission.mime_type || '',
        });
    };

    const visibleTasks = useMemo(() => {
        const term = search.trim().toLowerCase();
        const todayKey = formatDateKey(new Date());

        return tasks.filter((task) => {
            if (statusFilter !== 'all' && String(task.status) !== statusFilter) return false;
            if (priorityFilter !== 'all' && String(task.priority || 'medium') !== priorityFilter) return false;
            if (deadlineFilter !== 'all') {
                const dueKey = normalizeDateKey(task.due_date);
                const taskIsOpen = isOpenTask(task.status);
                if (deadlineFilter === 'due_today' && (!taskIsOpen || dueKey !== todayKey)) return false;
                if (deadlineFilter === 'overdue' && (!taskIsOpen || !dueKey || dueKey >= todayKey)) return false;
            }
            if (!term) return true;

            const haystack = [
                task.title || '',
                task.description || '',
                task.project_name || '',
                task.client_name || '',
                task.service_name || '',
                task.status || '',
                task.priority || '',
            ]
                .join(' ')
                .toLowerCase();

            return haystack.includes(term);
        });
    }, [deadlineFilter, priorityFilter, search, statusFilter, tasks]);

    const summary = useMemo(() => {
        return visibleTasks.reduce(
            (acc, task) => {
                if (task.status === 'pending') acc.pending += 1;
                if (task.status === 'in_progress') acc.inProgress += 1;
                if (task.status === 'completed') acc.completed += 1;
                if (task.status === 'cancelled') acc.cancelled += 1;
                const dueKey = normalizeDateKey(task.due_date);
                if (dueKey && isOpenTask(task.status)) {
                    const todayKey = formatDateKey(new Date());
                    if (dueKey === todayKey) acc.dueToday += 1;
                    if (dueKey < todayKey) acc.overdue += 1;
                }
                return acc;
            },
            { pending: 0, inProgress: 0, completed: 0, cancelled: 0, dueToday: 0, overdue: 0 }
        );
    }, [visibleTasks]);

    const paginatedTasks = visibleTasks.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        setCurrentPage(1);
    }, [deadlineFilter, priorityFilter, search, statusFilter]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(visibleTasks.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [visibleTasks.length, currentPage]);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    useEffect(() => {
        if (expandedTaskId === null) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setExpandedTaskId(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [expandedTaskId]);

    useEffect(() => {
        if (expandedTaskId === null) {
            setTaskComments([]);
            setTaskCommentText('');
            setTaskCommentReplyTarget(null);
            setTaskCommentAttachments([]);
            if (taskCommentFileInputRef.current) {
                taskCommentFileInputRef.current.value = '';
            }
            setTaskAttachmentActionCommentId(null);
            return;
        }
        setTaskSubmissions([]);
        void fetchTaskComments(expandedTaskId);
        void fetchTaskSubmissions(expandedTaskId);
    }, [expandedTaskId, fetchTaskComments]);

    const discussionComments = useMemo(
        () => taskComments.filter((comment) => String(comment.comment_text || '').trim() !== ''),
        [taskComments]
    );

    const taskDocumentComments = useMemo(
        () => taskComments.filter((comment) => String(comment.attachment_path || '').trim() !== ''),
        [taskComments]
    );

    const activeTaskDocuments = useMemo(
        () => taskDocumentComments.filter((comment) => Number(comment.attachment_archived ?? 0) !== 1),
        [taskDocumentComments]
    );

    const archivedTaskDocuments = useMemo(
        () => taskDocumentComments.filter((comment) => Number(comment.attachment_archived ?? 0) === 1),
        [taskDocumentComments]
    );

    if (loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={handleLogout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }
    const expandedTask = expandedTaskId === null
        ? null
        : tasks.find((task) => task.id === expandedTaskId) || null;
    return (
        <Layout role={user?.role as string | undefined} user={user} onLogout={handleLogout}>
            <Head><title>My Tasks</title></Head>
            <div style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
                <div style={{ marginBottom: 12 }}>
                    <h1 style={{ margin: '0 0 4px 0', fontSize: 14, color: '#1f2937' }}>My Tasks</h1>
                    <p style={{ margin: 0, color: '#64748b', fontSize: 13 }}>Track your assigned tasks and update progress status.</p>
                </div>
                <div className="myTasksFilters" style={{ marginBottom: 12, display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) repeat(3, minmax(132px, 160px)) auto', gap: 8, alignItems: 'center' }}>
                        <label style={{ minWidth: 0 }}>
                            <SearchBar
                                storageKey="mytasks:list"
                                placeholder="Search task, project, client..."
                                ariaLabel="Search tasks"
                                value={search}
                                onChange={setSearch}
                                suggestions={collectSearchTerms(tasks, [
                                    (t: any) => t.title,
                                    (t: any) => t.project_name,
                                    (t: any) => t.client_name,
                                    (t: any) => t.service_name,
                                    (t: any) => t.status,
                                ])}
                                inputStyle={{ height: 38, borderColor: '#cbd5e1' }}
                            />
                        </label>
                        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}>
                            <option value="all">All Status</option>
                            <option value="pending">Pending</option>
                            <option value="in_progress">In Progress</option>
                            <option value="completed">Completed</option>
                            <option value="cancelled">Cancelled</option>
                        </select>
                        <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)} style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}>
                            <option value="all">All Priority</option>
                            <option value="high">High</option>
                            <option value="medium">Medium</option>
                            <option value="low">Low</option>
                        </select>
                        <select value={deadlineFilter} onChange={(e) => setDeadlineFilter(e.target.value)} style={{ height: 38, padding: '0 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}>
                            <option value="all">All Deadlines</option>
                            <option value="due_today">Due Today</option>
                            <option value="overdue">Overdue</option>
                        </select>
                        <div style={{ display: 'flex', gap: 4, background: '#f1f5f9', borderRadius: 8, padding: 2, height: 38 }}>
                            <button
                                type="button"
                                onClick={() => setTaskViewMode('list')}
                                style={{ height: 34, padding: '0 10px', borderRadius: 7, border: 'none', background: taskViewMode === 'list' ? '#fff' : 'transparent', color: taskViewMode === 'list' ? '#111827' : '#64748b', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: taskViewMode === 'list' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}
                            >
                                List
                            </button>
                            <button
                                type="button"
                                onClick={() => setTaskViewMode('card')}
                                style={{ height: 34, padding: '0 10px', borderRadius: 7, border: 'none', background: taskViewMode === 'card' ? '#fff' : 'transparent', color: taskViewMode === 'card' ? '#111827' : '#64748b', fontSize: 12, fontWeight: 700, cursor: 'pointer', boxShadow: taskViewMode === 'card' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}
                            >
                                Card
                            </button>
                        </div>
                    </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12 }}>
                    <StatCard label="Pending" value={summary.pending} color="#92400e" background="#fef3c7" />
                    <StatCard label="In Progress" value={summary.inProgress} color="#1d4ed8" background="#dbeafe" />
                    <StatCard label="Completed" value={summary.completed} color="#166534" background="#dcfce7" />
                    <StatCard label="Cancelled" value={summary.cancelled} color="#b91c1c" background="#fee2e2" />
                    <StatCard label="Due Today" value={summary.dueToday} color="#1e40af" background="#dbeafe" />
                    <StatCard label="Overdue" value={summary.overdue} color="#b91c1c" background="#fee2e2" />
                </div>

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, margin: '2px 0 8px' }}>
                    <h2 style={{ margin: 0, color: '#1f2937', fontSize: 14 }}>Task List</h2>
                    <span style={{ color: '#64748b', fontSize: 12 }}>{visibleTasks.length} task{visibleTasks.length === 1 ? '' : 's'}</span>
                </div>

                {visibleTasks.length === 0 ? (
                    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, padding: 12, textAlign: 'center', color: '#64748b' }}>
                        <ZeroResults
                            query={search}
                            itemLabel="tasks"
                            alternatives={getAlternativeSuggestions(search, collectSearchTerms(tasks, [
                                (t: any) => t.title,
                                (t: any) => t.project_name,
                                (t: any) => t.client_name,
                            ]))}
                            onPickAlternative={(term) => setSearch(term)}
                            onClear={() => setSearch('')}
                        />
                    </div>
                ) : taskViewMode === 'card' ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 190px))', justifyContent: 'start', gap: 4 }}>
                        {paginatedTasks.map((task) => {
                            const hasCompletionReport = Number(task.has_completion_report ?? 0) === 1;
                            const normalizedStatus = String(task.status || 'pending');
                            return (
                                <div key={task.id} role="button" tabIndex={0} aria-label={`Open task ${task.title}`} onClick={() => setExpandedTaskId(task.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedTaskId(task.id); } }} style={{ background: 'white', border: '1px solid #e2e8f0', borderRadius: 8, boxShadow: '0 1px 2px rgba(0,0,0,0.08)', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, aspectRatio: '1 / 1', overflowY: 'auto', scrollbarWidth: 'thin', cursor: 'pointer' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                                        <div>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                                                <span style={{ fontSize: 12, fontWeight: 700, color: '#1f2937' }}>{task.title}</span>
                                                <EditedBadge editedAt={editedItems.get(task.id)} compact />
                                            </div>
                                            <div style={{ fontSize: 11, color: '#64748b' }}>Task #{task.id}</div>
                                            <div style={{ fontSize: 10, color: '#2563eb', fontWeight: 700 }}>Click to expand</div>
                                        </div>
                                        <span style={statusPill(normalizedStatus)}>{formatStatusLabel(normalizedStatus)}</span>
                                    </div>
                                    <div style={{ fontSize: 10, color: '#475569', lineHeight: 1.2, minHeight: 16, maxHeight: 22, overflow: 'hidden' }}>{task.description || 'No description provided.'}</div>
                                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                                        <span style={priorityPill(task.priority || 'medium')}>{String(task.priority || 'medium').toUpperCase()}</span>
                                        <span style={{ padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0' }}>Due: {formatDateTime(task.due_date)}</span>
                                        <span style={{ padding: '2px 6px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: '#ede9fe', color: '#5b21b6' }}>{task.service_name || 'No service'}</span>
                                    </div>
                                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 7, background: '#f8fafc', padding: 5, display: 'grid', gap: 1 }}>
                                        <div style={{ fontSize: 10, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><strong>Project:</strong> {task.project_name || '-'}</div>
                                        <div style={{ fontSize: 10, color: '#334155', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}><strong>Client:</strong> {task.client_name || '-'}</div>
                                    </div>
                                    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                        <div style={{ fontSize: 10, color: '#475569' }}>
                                            <strong>Client Report:</strong>{' '}
                                            {hasCompletionReport ? (<span style={{ color: '#15803d', fontWeight: 700 }}>Sent{task.completion_report_sent_at ? ` (${new Date(task.completion_report_sent_at).toLocaleString()})` : ''}</span>) : ('Not yet sent')}
                                        </div>
                                        <span style={{ color: '#94a3b8', fontSize: 10 }}>Open task to set proof and complete.</span>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, overflowX: 'auto', overflowY: 'hidden' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: '40px minmax(180px, 1.4fr) minmax(160px, 1fr) minmax(100px, .8fr) 90px minmax(140px, .9fr) 110px 130px', minWidth: 960, gap: 0, background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '8px 12px', fontSize: 11, fontWeight: 700, color: '#475569' }}>
                            <div>#</div>
                            <div>Task</div>
                            <div>Project / Client</div>
                            <div>Service</div>
                            <div>Priority</div>
                            <div>Due</div>
                            <div>Status</div>
                            <div>Workflow</div>
                        </div>
                        {paginatedTasks.map((task) => {
                            const normalizedStatus = String(task.status || 'pending');
                            const wfStatus = String(task.workflow_status || task.status || '');
                            return (
                                <div key={task.id} role="button" tabIndex={0} aria-label={`Open task ${task.title}`} onClick={() => setExpandedTaskId(task.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedTaskId(task.id); } }} style={{ display: 'grid', gridTemplateColumns: '40px minmax(180px, 1.4fr) minmax(160px, 1fr) minmax(100px, .8fr) 90px minmax(140px, .9fr) 110px 130px', minWidth: 960, gap: 0, padding: '9px 12px', borderBottom: '1px solid #f1f5f9', fontSize: 12, color: '#334155', cursor: 'pointer', alignItems: 'center', transition: 'background 0.15s' }} onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#f8fafc'; }} onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = '#fff'; }}>
                                    <div style={{ color: '#94a3b8', fontWeight: 700 }} className="llb-tabular">{task.id}</div>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
                                            <span style={{ fontWeight: 700, color: '#1f2937', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.title}>{task.title}</span>
                                            <EditedBadge editedAt={editedItems.get(task.id)} compact />
                                        </div>
                                        <div style={{ fontSize: 10, color: '#2563eb', fontWeight: 700 }}>Click to expand</div>
                                    </div>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.project_name || ''}>{task.project_name || '-'}</div>
                                        <div style={{ fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.client_name || ''}>{task.client_name || '-'}</div>
                                    </div>
                                    <div style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={task.service_name || ''}>{task.service_name || '-'}</div>
                                    <div><span style={priorityPill(task.priority || 'medium')}>{String(task.priority || 'medium').toUpperCase()}</span></div>
                                    <div style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{formatDateTime(task.due_date)}</div>
                                    <div><span style={statusPill(normalizedStatus)}>{formatStatusLabel(normalizedStatus)}</span></div>
                                    <div><span style={workflowStatusPill(wfStatus)}>{formatWorkflowStatusLabel(wfStatus)}</span></div>
                                </div>
                            );
                        })}
                    </div>
                )}

                {expandedTask && (
                    <div
                        onClick={() => setExpandedTaskId(null)}
                        style={{
                            position: 'fixed',
                            inset: 0,
                            background: 'rgba(15,23,42,0.55)',
                            zIndex: 30000,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 16,
                        }}
                    >
                        <div
                            onClick={(e) => e.stopPropagation()}
                            style={{
                                width: 'min(680px, 96vw)',
                                maxHeight: '92vh',
                                background: '#fff',
                                borderRadius: 12,
                                border: '1px solid #dbe2ea',
                                boxShadow: '0 20px 60px rgba(0,0,0,0.28)',
                                display: 'flex',
                                flexDirection: 'column',
                                overflow: 'hidden',
                            }}
                        >
                            {/* Header */}
                            <div style={{ padding: '14px 18px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                                <div style={{ minWidth: 0 }}>
                                    <div style={{ fontSize: 15, fontWeight: 800, color: '#0f172a', lineHeight: 1.3 }}>
                                        {expandedTask.title}
                                    </div>
                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Task #{expandedTask.id}</div>
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                                    <span style={workflowStatusPill(expandedTask.workflow_status || expandedTask.status || '')}>
                                        {formatWorkflowStatusLabel(expandedTask.workflow_status || expandedTask.status || '')}
                                    </span>
                                    <button
                                        onClick={() => setExpandedTaskId(null)}
                                        style={{ border: '1px solid #e2e8f0', background: '#fff', color: '#374151', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                                    >
                                        Close
                                    </button>
                                </div>
                            </div>

                            <div style={{ padding: '16px 18px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

                                {/* Meta row */}
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Project</div>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{expandedTask.project_name || '—'}</div>
                                    </div>
                                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Client</div>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{expandedTask.client_name || '—'}</div>
                                    </div>
                                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Due Date</div>
                                        <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{formatDateTime(expandedTask.due_date)}</div>
                                    </div>
                                    <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Priority</div>
                                        <div><span style={priorityPill(expandedTask.priority || 'medium')}>{String(expandedTask.priority || 'medium').toUpperCase()}</span></div>
                                    </div>
                                </div>

                                {/* Description */}
                                {expandedTask.description && (
                                    <div style={{ background: '#fafcff', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>Description</div>
                                        <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.6 }}>{expandedTask.description}</div>
                                    </div>
                                )}

                                {/* Rejection notice */}
                                {expandedTask.rejection_reason && (
                                    <div style={{ fontSize: 12, color: '#dc2626', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px' }}>
                                        <strong>Rejection Reason:</strong> {expandedTask.rejection_reason}
                                    </div>
                                )}

                                {/* Workflow action */}
                                {(() => {
                                    const wf = expandedTask.workflow_status || '';
                                    const role = String(user?.role || '').toLowerCase();
                                    const isStaff = role === 'staff';
                                    const isManager = role === 'manager';
                                    const isAdmin = role === 'admin';
                                    const showAnyButton = (isStaff && (wf === 'not_started' || wf === 'in_progress' || wf === 'rejected_by_manager' || wf === 'rejected_by_admin'))
                                        || ((isManager || isAdmin) && wf === 'pending_manager')
                                        || (isAdmin && wf === 'pending_admin');
                                    if (!showAnyButton) return null;
                                    return (
                                        <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                                            <div>
                                                <div style={{ fontSize: 10, fontWeight: 800, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 4 }}>Action Required</div>
                                                <div style={{ fontSize: 12, color: '#166534' }}>
                                                    {isStaff && wf === 'not_started' && 'Click Start Task to begin working.'}
                                                    {isStaff && wf === 'in_progress' && 'Upload your completed work to submit for review.'}
                                                    {isStaff && (wf === 'rejected_by_manager' || wf === 'rejected_by_admin') && 'Your submission was rejected. Re-upload and resubmit.'}
                                                    {(isManager || isAdmin) && wf === 'pending_manager' && 'Review and confirm or reject this submission.'}
                                                    {isAdmin && wf === 'pending_admin' && 'Final admin review required.'}
                                                </div>
                                            </div>
                                            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                                {isStaff && wf === 'not_started' && (
                                                    <button onClick={() => void handleStartTask(expandedTask.id)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#2563eb', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                                        Start Task
                                                    </button>
                                                )}
                                                {isStaff && (wf === 'in_progress' || wf === 'rejected_by_manager' || wf === 'rejected_by_admin') && (
                                                    <button onClick={() => handleOpenSubmitModal(expandedTask.id)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                                                        Upload Document & Done
                                                    </button>
                                                )}
                                                {(isManager || isAdmin) && wf === 'pending_manager' && (
                                                    <>
                                                        <button onClick={() => handleOpenReviewModal(expandedTask.id, true)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Confirm</button>
                                                        <button onClick={() => handleOpenReviewModal(expandedTask.id, false)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Reject</button>
                                                    </>
                                                )}
                                                {isAdmin && wf === 'pending_admin' && (
                                                    <>
                                                        <button onClick={() => handleOpenReviewModal(expandedTask.id, true)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#16a34a', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Confirm</button>
                                                        <button onClick={() => handleOpenReviewModal(expandedTask.id, false)} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Reject</button>
                                                    </>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Submissions */}
                                {submissionsLoading ? (
                                    <div style={{ color: '#64748b', fontSize: 12 }}>Loading submissions...</div>
                                ) : taskSubmissions.length > 0 ? (
                                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                                        <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Submissions ({taskSubmissions.length})</div>
                                        <div style={{ display: 'grid', gap: 6 }}>
                                            {taskSubmissions.map((sub, idx) => {
                                                // "Edit" is only for the latest submission that is still pending
                                                // AND the task can still accept a resubmission
                                                const isLatest = idx === taskSubmissions.length - 1;
                                                const taskCanResubmit = ['in_progress', 'rejected_by_manager', 'rejected_by_admin', 'pending_manager'].includes(
                                                    expandedTask.workflow_status || ''
                                                );
                                                const showEditBtn =
                                                    String(user?.role || '').toLowerCase() === 'staff' &&
                                                    isLatest &&
                                                    sub.status === 'pending' &&
                                                    taskCanResubmit;
                                                return (
                                                <div key={sub.submission_id} style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '8px 10px', background: '#f8fafc' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                                                        <div style={{ minWidth: 0, flex: 1 }}>
                                                            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>{sub.file_name}</div>
                                                            <div style={{ fontSize: 11, color: '#64748b' }}>
                                                                Submitted by {sub.submitted_by_name} on {sub.submitted_at ? new Date(sub.submitted_at).toLocaleString() : '-'}
                                                            </div>
                                                            {sub.notes && <div style={{ fontSize: 11, color: '#475569', fontStyle: 'italic' }}>"{sub.notes}"</div>}
                                                            {sub.reviewed_by_name && (
                                                                <div style={{ fontSize: 11, color: '#64748b' }}>
                                                                    Reviewed by {sub.reviewed_by_name}{sub.reviewed_at ? ` on ${new Date(sub.reviewed_at).toLocaleString()}` : ''}
                                                                </div>
                                                            )}
                                                            {sub.review_notes && (
                                                                <div style={{ fontSize: 11, color: '#475569', marginTop: 2 }}>
                                                                    <strong>Review:</strong> {sub.review_notes}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0, flexWrap: 'wrap' }}>
                                                            <span style={{
                                                                padding: '2px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700,
                                                                background: sub.status === 'approved' ? '#dcfce7' : sub.status === 'rejected' ? '#fee2e2' : '#fef3c7',
                                                                color: sub.status === 'approved' ? '#166534' : sub.status === 'rejected' ? '#b91c1c' : '#92400e',
                                                            }}>
                                                                {(sub.status || 'pending').toUpperCase()}
                                                            </span>
                                                            <button type="button" onClick={() => openWorkflowSubmissionPreview(sub)} style={{ padding: '5px 9px', borderRadius: 8, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>View</button>
                                                            <a href={getAuthenticatedFileUrl(sub.file_path || '')} download={sub.file_name} style={{ padding: '5px 9px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#374151', fontSize: 11, fontWeight: 700, cursor: 'pointer', textDecoration: 'none', display: 'inline-block' }}>Download</a>
                                                            {showEditBtn && (
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setExpandedTaskId(null);
                                                                        // pre-fill notes from the existing submission
                                                                        setSubmitTaskId(expandedTask.id);
                                                                        if (submitFilePreviewUrl) URL.revokeObjectURL(submitFilePreviewUrl);
                                                                        setSubmitFile(null);
                                                                        setSubmitFilePreviewUrl(null);
                                                                        setSubmitNotes(sub.notes || '');
                                                                        setShowSubmitModal(true);
                                                                    }}
                                                                    style={{ padding: '5px 9px', borderRadius: 8, border: '1px solid #fde68a', background: '#fefce8', color: '#a16207', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                                                    title="Replace this submission with a new PDF"
                                                                >
                                                                    ✏ Edit
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ) : null}

                                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Client Report</div>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
                                        <div style={{ fontSize: 13, color: '#334155' }}>
                                            {Number(expandedTask.has_completion_report ?? 0) === 1 ? (
                                                <span style={{ color: '#15803d', fontWeight: 700 }}>
                                                    Sent{expandedTask.completion_report_sent_at ? ` (${new Date(expandedTask.completion_report_sent_at).toLocaleString()})` : ''}
                                                </span>
                                            ) : (
                                                'Not yet sent'
                                            )}
                                        </div>
                                        {String(expandedTask.status || '') === 'completed' ? (
                                            <button
                                                type="button"
                                                disabled={sendingReportTaskId === expandedTask.id}
                                                onClick={() => void handleSendCompletionReport(expandedTask)}
                                                title={Number(expandedTask.has_completion_report ?? 0) === 1 ? 'Resend report' : 'Send report'}
                                                aria-label={Number(expandedTask.has_completion_report ?? 0) === 1 ? 'Resend report' : 'Send report'}
                                                style={{
                                                    padding: '7px 12px',
                                                    borderRadius: 8,
                                                    border: 'none',
                                                    background: '#1e3a8a',
                                                    color: '#fff',
                                                    fontSize: 12,
                                                    fontWeight: 700,
                                                    cursor: sendingReportTaskId === expandedTask.id ? 'not-allowed' : 'pointer',
                                                    opacity: sendingReportTaskId === expandedTask.id ? 0.75 : 1,
                                                }}
                                            >
                                                {sendingReportTaskId === expandedTask.id ? 'Sending...' : (Number(expandedTask.has_completion_report ?? 0) === 1 ? 'Resend report' : 'Send report')}
                                            </button>
                                        ) : (
                                            <span style={{ color: '#94a3b8', fontSize: 12 }}>Complete the task first.</span>
                                        )}
                                    </div>
                                </div>

                                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                                        Task Files ({activeTaskDocuments.length})
                                    </div>
                                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: activeTaskDocuments.length || archivedTaskDocuments.length ? 10 : 0 }}>
                                        <input
                                            ref={taskCommentFileInputRef}
                                            type="file"
                                            multiple
                                            accept=".pdf,application/pdf"
                                            onChange={(event) => addTaskCommentAttachments(event.target.files)}
                                            style={{ maxWidth: 260, fontSize: 12 }}
                                            aria-label="Choose task files"
                                        />
                                        <button
                                            type="button"
                                            onClick={() => void uploadTaskDocuments(expandedTask)}
                                            disabled={taskCommentSaving || taskCommentAttachments.length === 0}
                                            style={{ padding: '6px 10px', borderRadius: 7, border: 'none', background: '#1e3a8a', color: '#fff', fontSize: 11, fontWeight: 700, cursor: taskCommentSaving || taskCommentAttachments.length === 0 ? 'not-allowed' : 'pointer', opacity: taskCommentSaving || taskCommentAttachments.length === 0 ? 0.65 : 1 }}
                                        >
                                            {taskCommentSaving ? 'Uploading...' : `Upload${taskCommentAttachments.length ? ` (${taskCommentAttachments.length})` : ''}`}
                                        </button>
                                    </div>
                                    {taskCommentAttachments.length > 0 && (
                                        <div style={{ display: 'grid', gap: 4, marginBottom: 10 }}>
                                            {taskCommentAttachments.map((file, index) => (
                                                <div key={`${file.name}-${file.lastModified}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 11, color: '#475569' }}>
                                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                                                    <button type="button" onClick={() => removeTaskCommentAttachmentAt(index)} style={{ border: 0, background: 'transparent', color: '#dc2626', cursor: 'pointer' }}>Remove</button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {activeTaskDocuments.length === 0 ? (
                                        <div style={{ color: '#64748b', fontSize: 12 }}>No uploaded task files.</div>
                                    ) : (
                                        <div style={{ display: 'grid', gap: 6 }}>
                                            {activeTaskDocuments.map((file) => {
                                                const fileUrl = `${API_BASE_URL}/api/task-comments.php?action=view_attachment&comment_id=${encodeURIComponent(String(file.comment_id))}`;
                                                return (
                                                    <div key={file.comment_id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '8px 9px', border: '1px solid #e2e8f0', borderRadius: 8, background: '#f8fafc' }}>
                                                        <div style={{ minWidth: 0 }}>
                                                            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.attachment_name || 'Task document'}</div>
                                                            <div style={{ fontSize: 10, color: '#64748b' }}>Uploaded by {file.commenter_name || 'User'}{file.created_at ? ` · ${new Date(file.created_at).toLocaleString()}` : ''}</div>
                                                        </div>
                                                        <div style={{ display: 'flex', gap: 5, flexShrink: 0 }}>
                                                            <button type="button" onClick={() => openTaskDocumentPreview(file)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>View</button>
                                                            <a href={`${fileUrl}&download=1`} download={file.attachment_name || undefined} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontSize: 10, fontWeight: 700, textDecoration: 'none' }}>Download</a>
                                                            <button type="button" disabled={taskAttachmentActionCommentId === file.comment_id} onClick={() => void setTaskDocumentArchiveStatus(expandedTask, file.comment_id, true)} style={{ padding: '5px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#475569', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Archive</button>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {archivedTaskDocuments.length > 0 && (
                                        <details style={{ marginTop: 10 }}>
                                            <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#64748b' }}>Archived files ({archivedTaskDocuments.length})</summary>
                                            <div style={{ display: 'grid', gap: 6, marginTop: 7 }}>
                                                {archivedTaskDocuments.map((file) => (
                                                    <div key={file.comment_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '7px 9px', border: '1px solid #e2e8f0', borderRadius: 7 }}>
                                                        <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11 }}>{file.attachment_name || 'Task document'}</span>
                                                        <div style={{ display: 'flex', gap: 5 }}>
                                                            <button type="button" onClick={() => void setTaskDocumentArchiveStatus(expandedTask, file.comment_id, false)} style={{ padding: '4px 7px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#1d4ed8', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Restore</button>
                                                            <button type="button" onClick={() => void removeTaskDocument(expandedTask, file.comment_id)} style={{ padding: '4px 7px', borderRadius: 6, border: '1px solid #fecaca', background: '#fff', color: '#dc2626', fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>Remove</button>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </details>
                                    )}
                                </div>

                                <div style={{ border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px', background: '#fff' }}>
                                    <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                                        Task Discussion
                                    </div>

                                    {taskCommentReplyTarget && (
                                        <div style={{ marginBottom: 10, padding: '8px 10px', borderRadius: 8, border: '1px solid #dbeafe', background: '#eff6ff', color: '#1e3a8a', fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                                            <span>
                                                Replying to {taskCommentReplyTarget.commenter_name || 'User'}: &quot;{taskCommentReplyTarget.comment_text || '-'}&quot;
                                            </span>
                                            <button
                                                type="button"
                                                onClick={() => setTaskCommentReplyTarget(null)}
                                                style={{ border: 'none', background: 'transparent', color: '#1e3a8a', cursor: 'pointer', fontWeight: 700 }}
                                            >
                                                Clear
                                            </button>
                                        </div>
                                    )}

                                    <div style={{ display: 'grid', gap: 8 }}>
                                        <textarea
                                            value={taskCommentText}
                                            onChange={(e) => setTaskCommentText(e.target.value)}
                                            placeholder="Write a comment or reply..."
                                            required
                                            aria-required="true"
                                            aria-label="Comment (required)"
                                            style={{
                                                width: '100%',
                                                minHeight: 72,
                                                padding: '10px 12px',
                                                borderRadius: 8,
                                                border: '1px solid #cbd5e1',
                                                resize: 'vertical',
                                                fontSize: 13,
                                                color: '#334155',
                                                fontFamily: 'inherit',
                                            }}
                                        />
                                        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                                            <button
                                                type="button"
                                                onClick={() => void submitTaskComment(expandedTask)}
                                                disabled={taskCommentSaving || !taskCommentText.trim()}
                                                style={{
                                                    padding: '7px 12px',
                                                    borderRadius: 8,
                                                    border: 'none',
                                                    background: '#1e3a8a',
                                                    color: '#fff',
                                                    fontSize: 12,
                                                    fontWeight: 700,
                                                    cursor: taskCommentSaving || !taskCommentText.trim() ? 'not-allowed' : 'pointer',
                                                    opacity: taskCommentSaving || !taskCommentText.trim() ? 0.7 : 1,
                                                }}
                                            >
                                                {taskCommentSaving ? 'Posting...' : 'Post Comment'}
                                            </button>
                                        </div>
                                    </div>

                                    <div style={{ marginTop: 12, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}>
                                        {taskCommentsLoading ? (
                                            <div style={{ color: '#64748b', fontSize: 13 }}>Loading comments...</div>
                                        ) : discussionComments.length === 0 ? (
                                            <div style={{ color: '#64748b', fontSize: 13 }}>No comments yet.</div>
                                        ) : (
                                            <div style={{ display: 'grid', gap: 8 }}>
                                                {discussionComments.map((comment) => {
                                                    const roleColor: Record<string, string> = { admin: '#7c3aed', manager: '#0369a1', staff: '#16a34a' };
                                                    const roleBg: Record<string, string> = { admin: '#f5f3ff', manager: '#e0f2fe', staff: '#f0fdf4' };
                                                    const role = (comment.commenter_role || '').toLowerCase();
                                                    return (
                                                    <div
                                                        key={comment.comment_id}
                                                        style={{
                                                            border: '1px solid #e2e8f0',
                                                            borderRadius: 10,
                                                            padding: '9px 10px',
                                                            background: comment.parent_comment_id ? '#f8fafc' : '#fff',
                                                            marginLeft: comment.parent_comment_id ? 18 : 0,
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 5, flexWrap: 'wrap' }}>
                                                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                                                {comment.parent_comment_id && (
                                                                    <span style={{ fontSize: 10, color: '#2563eb', fontWeight: 700, marginRight: 2 }}>↩ Reply</span>
                                                                )}
                                                                <strong style={{ color: '#0f172a', fontSize: 13 }}>{comment.commenter_name || 'User'}</strong>
                                                                {role && (
                                                                    <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 20, color: roleColor[role] || '#64748b', background: roleBg[role] || '#f1f5f9', textTransform: 'capitalize' }}>
                                                                        {role}
                                                                    </span>
                                                                )}
                                                            </div>
                                                            <span style={{ fontSize: 11, color: '#94a3b8', whiteSpace: 'nowrap' }}>
                                                                {comment.created_at ? new Date(comment.created_at).toLocaleString() : '-'}
                                                            </span>
                                                        </div>
                                                        <div style={{ color: '#334155', fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>
                                                            {comment.comment_text || '-'}
                                                        </div>
                                                        <div style={{ marginTop: 7 }}>
                                                            <button
                                                                type="button"
                                                                onClick={() => setTaskCommentReplyTarget(comment)}
                                                                style={{ border: 'none', background: 'transparent', color: '#1e3a8a', fontSize: 12, cursor: 'pointer', padding: 0, fontWeight: 700 }}
                                                            >
                                                                Reply
                                                            </button>
                                                        </div>
                                                    </div>
                                                    );
                                                })}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                        </div>
                    </div>
                )}

                <Pagination
                    currentPage={currentPage}
                    totalItems={visibleTasks.length}
                    itemsPerPage={ITEMS_PER_PAGE}
                    onPageChange={setCurrentPage}
                    label="tasks"
                />
            </div>

            {/* Submit Document Modal */}
            {showSubmitModal && (
                <div
                    style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 40000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                    onClick={() => { setShowSubmitModal(false); if (submitFilePreviewUrl) URL.revokeObjectURL(submitFilePreviewUrl); setSubmitFilePreviewUrl(null); if (submitTaskId) setExpandedTaskId(submitTaskId); }}
                >
                    <div
                        onClick={(e) => e.stopPropagation()}
                        style={{ width: submitFilePreviewUrl ? 'min(1160px, 97vw)' : 'min(520px, 97vw)', background: '#fff', borderRadius: 16, border: '1px solid #dbe2ea', boxShadow: '0 20px 60px rgba(0,0,0,0.28)', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr auto', maxHeight: '92vh', transition: 'width 0.2s' }}
                    >
                        {/* Header */}
                        <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <div style={{ fontSize: 16, fontWeight: 700, color: '#111827' }}>Submit Document</div>
                                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>PDF files only · Max 10 MB · A preview will appear once you select a file.</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => { setShowSubmitModal(false); handleSubmitFileChange(null); if (submitTaskId) setExpandedTaskId(submitTaskId); }}
                                style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontWeight: 700, color: '#64748b', fontSize: 12, flexShrink: 0 }}
                            >✕ Close</button>
                        </div>

                        {/* Body */}
                        <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: submitFilePreviewUrl ? '300px 1fr' : '1fr', overflow: 'hidden' }}>

                            {/* Left: form */}
                            <div style={{ overflowY: 'auto', padding: '18px 20px', borderRight: submitFilePreviewUrl ? '1px solid #e2e8f0' : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>

                                {/* Drop-zone */}
                                <div>
                                    <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                        PDF File <span style={{ color: '#e53e3e' }}>*</span>
                                    </label>
                                    <label
                                        htmlFor="my-tasks-pdf-input"
                                        style={{
                                            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                            gap: 8, padding: '20px 14px', borderRadius: 12,
                                            border: submitFile ? '2px solid #16a34a' : '2px dashed #94a3b8',
                                            background: submitFile ? '#f0fdf4' : '#f8fafc',
                                            cursor: 'pointer', textAlign: 'center', transition: 'border-color 0.15s, background 0.15s',
                                        }}
                                        onDragOver={(e) => e.preventDefault()}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            const f = e.dataTransfer.files?.[0] ?? null;
                                            handleSubmitFileChange(f);
                                            const inp = document.getElementById('my-tasks-pdf-input') as HTMLInputElement | null;
                                            if (inp) inp.value = '';
                                        }}
                                    >
                                        {submitFile ? (
                                            <>
                                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                                    <polyline points="14 2 14 8 20 8"/>
                                                    <text x="6" y="19" fontSize="6" fill="#16a34a" stroke="none" fontWeight="700">PDF</text>
                                                </svg>
                                                <span style={{ fontSize: 13, fontWeight: 700, color: '#15803d', wordBreak: 'break-all', maxWidth: '100%' }}>{submitFile.name}</span>
                                                <span style={{ fontSize: 11, color: '#22c55e' }}>{(submitFile.size / 1024).toFixed(1)} KB · Click or drop to replace</span>
                                            </>
                                        ) : (
                                            <>
                                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                                    <polyline points="14 2 14 8 20 8"/>
                                                    <line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 12 15 15"/>
                                                </svg>
                                                <span style={{ fontSize: 13, fontWeight: 600, color: '#475569' }}>Click to browse or drag &amp; drop</span>
                                                <span style={{ fontSize: 11, color: '#94a3b8' }}>PDF only · Max 10 MB</span>
                                            </>
                                        )}
                                    </label>
                                    <input
                                        id="my-tasks-pdf-input"
                                        type="file"
                                        accept=".pdf,application/pdf"
                                        required
                                        aria-required="true"
                                        aria-label="PDF document (required)"
                                        style={{ display: 'none' }}
                                        onChange={(e) => { handleSubmitFileChange(e.target.files?.[0] ?? null); e.target.value = ''; }}
                                    />
                                    {submitFile && (
                                        <button type="button" onClick={() => handleSubmitFileChange(null)}
                                            style={{ marginTop: 6, fontSize: 12, color: '#dc2626', background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontWeight: 600 }}>
                                            ✕ Remove file
                                        </button>
                                    )}
                                </div>

                                {/* Notes */}
                                <div>
                                    <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 4 }}>
                                        Notes <span style={{ fontWeight: 400, color: '#94a3b8' }}>(optional)</span>
                                    </label>
                                    <textarea value={submitNotes} onChange={(e) => setSubmitNotes(e.target.value)} rows={5} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 12, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }} placeholder="Add notes about your submission…" />
                                </div>

                                {/* Reminder */}
                                <div style={{ padding: '9px 11px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', fontSize: 11, color: '#92400e', lineHeight: 1.6 }}>
                                    <strong>Reminder:</strong> Only PDF files are accepted. The document must be complete and ready for manager review.
                                </div>
                            </div>

                            {/* Right: live PDF viewer */}
                            {submitFilePreviewUrl && (
                                <div style={{ minHeight: 0, background: '#f1f5f9', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                                        <span style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em' }}>PDF Preview</span>
                                        <span style={{ fontSize: 11, color: '#94a3b8' }}>Rendered in-browser · Read-only</span>
                                    </div>
                                    <iframe src={submitFilePreviewUrl} title="PDF preview" style={{ flex: 1, width: '100%', border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff', minHeight: 420 }} />
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div style={{ padding: '12px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
                            {!submitFile && (
                                <span style={{ fontSize: 12, color: '#94a3b8', marginRight: 'auto' }}>Select a PDF file to enable submission.</span>
                            )}
                            <button type="button" onClick={() => { setShowSubmitModal(false); handleSubmitFileChange(null); if (submitTaskId) setExpandedTaskId(submitTaskId); }} style={{ padding: '7px 14px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                            <button type="button" onClick={() => void handleSubmitDocument()} disabled={!submitFile || submitting} title="Submit Document" aria-label="Submit Document" style={{ padding: '7px 16px', borderRadius: 8, border: 'none', background: !submitFile || submitting ? '#94a3b8' : '#16a34a', color: '#fff', fontSize: 12, fontWeight: 700, cursor: !submitFile || submitting ? 'not-allowed' : 'pointer' }}>
                                {submitting ? 'Submitting…' : 'Submit & Done'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Review Modal */}
            {showReviewModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', zIndex: 40000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
                    onClick={() => setShowReviewModal(false)}>
                    <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(500px, 96vw)', background: '#fff', borderRadius: 12, border: '1px solid #dbe2ea', boxShadow: '0 20px 60px rgba(0,0,0,0.28)', padding: 20 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: '#111827', marginBottom: 4 }}>{reviewApproved ? 'Confirm Task' : 'Reject Task'}</div>
                        <div style={{ fontSize: 12, color: '#64748b', marginBottom: 16 }}>
                            {reviewApproved ? 'Confirm this submission and move it forward in the workflow.' : 'Provide a reason for rejection.'}
                        </div>
                        <div>
                            <label style={{ fontSize: 12, fontWeight: 700, color: '#374151', display: 'block', marginBottom: 4 }}>{reviewApproved ? 'Notes (Optional)' : 'Rejection Reason *'}</label>
                            <textarea value={reviewNotes} onChange={(e) => setReviewNotes(e.target.value)} rows={4} required={!reviewApproved} aria-required={!reviewApproved ? 'true' : undefined} aria-label={reviewApproved ? 'Review notes (optional)' : 'Rejection reason (required)'} style={{ width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid #cbd5e1', fontSize: 12, resize: 'vertical', fontFamily: 'inherit' }} placeholder={reviewApproved ? 'Add any comments...' : 'Explain what needs to be corrected...'} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16, borderTop: '1px solid #e2e8f0', paddingTop: 14 }}>
                            <button onClick={() => setShowReviewModal(false)} style={{ padding: '7px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#374151', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
                            <button onClick={() => void handleSubmitReview()} disabled={(!reviewApproved && !reviewNotes.trim()) || reviewing} style={{ padding: '7px 12px', borderRadius: 8, border: 'none', background: (!reviewApproved && !reviewNotes.trim()) || reviewing ? '#94a3b8' : reviewApproved ? '#16a34a' : '#dc2626', color: '#fff', fontSize: 12, fontWeight: 700, cursor: (!reviewApproved && !reviewNotes.trim()) || reviewing ? 'not-allowed' : 'pointer' }}>
                                {reviewing ? 'Submitting...' : reviewApproved ? 'Confirm' : 'Reject'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            <DocumentPreviewModal document={submissionDocumentPreview} onClose={() => setSubmissionDocumentPreview(null)} />
        </Layout>
    );
}

function StatCard({ label, value, color, background }: { label: string; value: number; color: string; background: string }) {
    return (
        <div style={{ background, border: '1px solid rgba(15,23,42,0.06)', borderRadius: 10, padding: '10px 12px' }}>
            <div style={{ fontSize: 12, color }}>{label}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color }}>{value}</div>
        </div>
    );
}

function formatStatusLabel(status: string): string {
    if (status === 'in_progress') return 'In Progress';
    return String(status).replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function statusPill(status: string): CSSProperties {
    const value = String(status || '').toLowerCase();
    if (value === 'completed') {
        return {
            background: '#dcfce7',
            color: '#166534',
            borderRadius: 999,
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 700,
        };
    }
    if (value === 'in_progress') {
        return {
            background: '#dbeafe',
            color: '#1e40af',
            borderRadius: 999,
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 700,
        };
    }
    if (value === 'cancelled') {
        return {
            background: '#fee2e2',
            color: '#b91c1c',
            borderRadius: 999,
            padding: '2px 6px',
            fontSize: 10,
            fontWeight: 700,
        };
    }
    return {
        background: '#fef3c7',
        color: '#92400e',
        borderRadius: 999,
        padding: '2px 6px',
        fontSize: 10,
        fontWeight: 700,
    };
}

function priorityPill(priority: string): CSSProperties {
    const value = String(priority).toLowerCase();
    if (value === 'high') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#fdf2f8', color: '#be185d', border: '1px solid #fbcfe8', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'medium') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a', fontSize: 11, fontWeight: 800 };
    }
    return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0', fontSize: 11, fontWeight: 800 };
}

function workflowStatusPill(status: string): CSSProperties {
    const value = String(status || '').toLowerCase();
    if (value === 'completed') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#dcfce7', color: '#166534', border: '1px solid #86efac', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'pending_manager') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#fef9c3', color: '#a16207', border: '1px solid #fde047', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'pending_admin') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#ffedd5', color: '#c2410c', border: '1px solid #fdba74', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'rejected_by_manager' || value === 'rejected_by_admin') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#ffe4e6', color: '#be123c', border: '1px solid #fecdd3', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'in_progress') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#cffafe', color: '#0e7490', border: '1px solid #a5f3fc', fontSize: 11, fontWeight: 800 };
    }
    if (value === 'cancelled') {
        return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#f1f5f9', color: '#64748b', border: '1px solid #cbd5e1', fontSize: 11, fontWeight: 800 };
    }
    return { display: 'inline-flex', alignItems: 'center', padding: '3px 8px', borderRadius: 999, background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe', fontSize: 11, fontWeight: 800 };
}

function formatWorkflowStatusLabel(status: string): string {
    const labels: Record<string, string> = {
        not_started: 'Not Started',
        in_progress: 'In Progress',
        pending_manager: 'Pending Manager',
        pending_admin: 'Pending Admin',
        rejected_by_manager: 'Rejected by Manager',
        rejected_by_admin: 'Rejected by Admin',
        completed: 'Completed',
        cancelled: 'Cancelled'
    };
    const value = String(status || '').trim().toLowerCase();
    return labels[value] || formatStatusLabel(value || 'pending');
}

