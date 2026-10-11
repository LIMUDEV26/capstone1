import { useCallback, useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import ExpandIconButton from '@/components/ExpandIconButton';
import FloatingListPanel from '@/components/FloatingListPanel';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { isInlineDocumentPreviewable } from '../../components/DocumentPreviewModal';
import { notifyError, notifySuccess, promptAction, showCenteredCardNotification } from '@/utils/notify';
import { getApiBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { usePaginationSetting } from '@/utils/usePaginationSetting';

type ProjectAttachmentRow = {
    comment_id: number;
    task_id: number;
    task_title: string;
    attachment_name?: string | null;
    attachment_path?: string | null;
    attachment_mime?: string | null;
    attachment_size?: number | null;
    attachment_archived?: number | boolean;
    from_library?: number | boolean;
    commenter_name?: string | null;
    created_at?: string | null;
};

const PROJECT_DETAIL_PREVIEW_LIMIT = 3;

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

function timestampForSort(value: unknown) {
    const time = value ? new Date(String(value)).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
}

function sortTasksForDisplay(left: any, right: any) {
    const leftDone = ['completed', 'cancelled'].includes(String(left?.status || '').trim().toLowerCase()) ? 1 : 0;
    const rightDone = ['completed', 'cancelled'].includes(String(right?.status || '').trim().toLowerCase()) ? 1 : 0;
    if (leftDone !== rightDone) return leftDone - rightDone;

    const leftCreated = timestampForSort(left?.created_at);
    const rightCreated = timestampForSort(right?.created_at);
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;

    return Number(right?.id || 0) - Number(left?.id || 0);
}

function formatAttachmentSize(bytes: number | null | undefined) {
    const value = Number(bytes || 0);
    if (value <= 0) return '';
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

// Documents linked to this task from the central Document Management library.
function TaskLibraryDocs({ taskId, apiBase }: { taskId: number; apiBase: string }) {
    const [docs, setDocs] = useState<any[]>([]);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        if (!taskId) return;
        let active = true;
        (async () => {
            try {
                const res = await fetch(`${apiBase}/document-management.php?task_id=${taskId}&status=active`, { credentials: 'include' });
                const data = await res.json();
                if (active && data.success && Array.isArray(data.data)) {
                    setDocs(data.data);
                }
            } catch {
                // Library section stays hidden when unreachable.
            } finally {
                if (active) setLoaded(true);
            }
        })();
        return () => {
            active = false;
        };
    }, [apiBase, taskId]);

    if (!loaded || docs.length === 0) return null;

    return (
        <div style={{ border: '1px solid #dbeafe', borderRadius: '12px', background: '#f8fbff', padding: '14px 16px' }}>
            <div style={{ fontSize: '12px', color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', fontWeight: 800 }}>
                Library Documents ({docs.length})
            </div>
            <div style={{ display: 'grid', gap: '8px' }}>
                {docs.map((doc: any) => (
                    <div key={doc.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 9, padding: '8px 12px', flexWrap: 'wrap' }}>
                        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                            <div style={{ fontSize: '13px', fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {doc.title}
                            </div>
                            <div style={{ fontSize: '11px', color: '#64748b' }}>
                                {doc.document_type}{doc.file_size ? ` · ${formatAttachmentSize(Number(doc.file_size))}` : ''}
                            </div>
                        </div>
                        {doc.file_path ? (
                            <a
                                href={`${apiBase}/serve-file.php?path=${encodeURIComponent(doc.file_path)}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#1d4ed8', fontSize: '12px', fontWeight: 700, textDecoration: 'none', whiteSpace: 'nowrap' }}
                            >
                                Open File
                            </a>
                        ) : null}
                    </div>
                ))}
            </div>
        </div>
    );
}

export default function ProjectDetails() {
    const router = useRouter();
    const API_BASE = getApiBaseUrl();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const { id } = router.query;

    const [user, setUser] = useState<any>(null);
    const [project, setProject] = useState<any>(null);
    const [tasks, setTasks] = useState<any[]>([]);
    const [staff, setStaff] = useState<any[]>([]);
    const [clients, setClients] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);

    // Edit Project Modal
    const [showEditProject, setShowEditProject] = useState(false);
    const [editProjectForm, setEditProjectForm] = useState({
        name: '', description: '', client_id: '', manager_id: '', status: 'active', start_date: '', end_date: ''
    });
    const [editProjectError, setEditProjectError] = useState('');
    const [savingProject, setSavingProject] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [taskSearch, setTaskSearch] = useState('');
    const [taskStatusFilter, setTaskStatusFilter] = useState('all');
    const [taskDeadlineFilter, setTaskDeadlineFilter] = useState('all');
    const [taskView, setTaskView] = useState<'list' | 'board'>('list');
    const [projectAttachments, setProjectAttachments] = useState<ProjectAttachmentRow[]>([]);
    const [attachmentsLoading, setAttachmentsLoading] = useState(false);

    const defaultTaskForm = { title: '', description: '', assigned_to: '', priority: 'medium', due_date: '', deadline_reminder_at: '' };
    const defaultEditTaskForm = { title: '', description: '', assigned_to: '', priority: 'medium', due_date: '', deadline_reminder_at: '', status: 'pending' };
    const defaultCollaboratorForm = { user_id: '', shift_mode: 'none', shift_start: '', shift_end: '' };

    // Add / Edit Task Modal
    const [showAddTask, setShowAddTask] = useState(false);
    const [showEditTask, setShowEditTask] = useState(false);
    const [isEditTaskPanelOpen, setIsEditTaskPanelOpen] = useState(false);
    const [taskForm, setTaskForm] = useState(defaultTaskForm);
    const [editTaskForm, setEditTaskForm] = useState(defaultEditTaskForm);
    const [editCollaborators, setEditCollaborators] = useState<any[]>([]);
    const [initialEditCollaborators, setInitialEditCollaborators] = useState<any[]>([]);
    const [taskError, setTaskError] = useState('');
    const [editTaskError, setEditTaskError] = useState('');
    // Inline per-field "Required" messages for the Add/Edit Task forms.
    const [addTaskFieldErrors, setAddTaskFieldErrors] = useState<Record<string, string>>({});
    const [editTaskFieldErrors, setEditTaskFieldErrors] = useState<Record<string, string>>({});
    const [editProjectFieldErrors, setEditProjectFieldErrors] = useState<Record<string, string>>({});

    const clearEditProjectFieldError = (name: string) => {
        setEditProjectFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };
    const [taskDraftAssignments, setTaskDraftAssignments] = useState<Record<string, string>>({});
    const [savingProjectTaskChanges, setSavingProjectTaskChanges] = useState(false);
    // Per-task assignee draft inside the detail panel (manager assign button)
    const [panelAssignDraft, setPanelAssignDraft] = useState<Record<string, string>>({});
    const [savingPanelAssign, setSavingPanelAssign] = useState<Record<string, boolean>>({});

    // Delete Task Confirm
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [taskToDelete, setTaskToDelete] = useState<any>(null);
    const [taskToEdit, setTaskToEdit] = useState<any>(null);
    const [sendingReportTaskId, setSendingReportTaskId] = useState<number | null>(null);

    const [messages, setMessages] = useState<any[]>([]);
    const [expandedProjectList, setExpandedProjectList] = useState<'updates' | 'files' | null>(null);
    const [expandedProjectListPage, setExpandedProjectListPage] = useState(1);
    const [selectedTask, setSelectedTask] = useState<any | null>(null);
    const [workflowUploadTask, setWorkflowUploadTask] = useState<any | null>(null);
    const [workflowUploadFile, setWorkflowUploadFile] = useState<File | null>(null);
    const [workflowUploadPreviewUrl, setWorkflowUploadPreviewUrl] = useState<string | null>(null);
    const [workflowUploadNotes, setWorkflowUploadNotes] = useState('');
    const [workflowReviewDetails, setWorkflowReviewDetails] = useState<any | null>(null);
    const [workflowReviewLoading, setWorkflowReviewLoading] = useState(false);
    const [workflowReviewNotes, setWorkflowReviewNotes] = useState('');

    useEffect(() => {
        if (!taskError) return;
        void notifyError(taskError);
        setTaskError('');
    }, [taskError]);

    useEffect(() => {
        if (!editTaskError) return;
        void notifyError(editTaskError);
        setEditTaskError('');
    }, [editTaskError]);

    const viewerRole = String(user?.role || '').trim().toLowerCase();
    const viewerBranchId = Number(user?.branch_id || 0);
    const isManager = viewerRole === 'admin' || viewerRole === 'manager';
    const isAssignedManager = viewerRole === 'manager' && String(project?.manager_id || '') === String(user?.id || '');
    const canManageProject = viewerRole === 'admin' || isAssignedManager;
    const isTaskCollaborator = (task: any, targetUserId: any) => {
        if (!task || !targetUserId) return false;
        const collaborators = Array.isArray(task.collaborators) ? task.collaborators : [];
        return collaborators.some((collab: any) => String(collab?.user_id) === String(targetUserId));
    };
    const hasAccess = isManager || tasks.some((t: any) =>
        String(t.assigned_to) === String(user?.id) || isTaskCollaborator(t, user?.id)
    );

    const toDateTimeLocalValue = (value: any) => {
        if (!value) return '';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    };

    const minProjectDeadline = () => {
        const d = new Date();
        d.setDate(d.getDate() + 3);
        d.setSeconds(0, 0);
        const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    };

    const currentDateTimeLocalValue = () => {
        const now = new Date();
        const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
        return local.toISOString().slice(0, 16);
    };

    const formatCollaboratorShift = (collab: any) => {
        if (!collab) return '';
        const mode = String(collab.shift_mode || 'none');
        if (mode === 'current_time' && collab.shift_start) {
            const start = new Date(collab.shift_start);
            if (!Number.isNaN(start.getTime())) {
                return `starts ${start.toLocaleString()}`;
            }
        }
        if (mode === 'range' && collab.shift_start && collab.shift_end) {
            const start = new Date(collab.shift_start);
            const end = new Date(collab.shift_end);
            if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
                return `${start.toLocaleString()} - ${end.toLocaleString()}`;
            }
        }
        return '';
    };

    const getUserDisplayName = (u: any) => {
        if (!u) return 'Unassigned';
        if (u.full_name) return u.full_name;
        const full = `${u.first_name || ''} ${u.last_name || ''}`.trim();
        return full || u.username || u.email || 'Unknown User';
    };

    const normalizeUserRole = (u: any) => String(u?.role || '').trim().toLowerCase();
    const dedupeUsersById = (items: any[]) => items.filter((candidate: any, index: number, arr: any[]) => {
        return arr.findIndex((entry: any) => String(entry?.id) === String(candidate?.id)) === index;
    });
    const serializeCollaboratorDrafts = (items: any[]) => JSON.stringify(
        (Array.isArray(items) ? items : [])
            .map((collab: any) => ({
                user_id: String(collab?.user_id || '').trim(),
                shift_mode: String(collab?.shift_mode || 'none'),
                shift_start: String(collab?.shift_start || ''),
                shift_end: String(collab?.shift_end || ''),
            }))
            .filter((collab: any) => collab.user_id)
            .sort((a: any, b: any) => {
                if (a.user_id !== b.user_id) return a.user_id.localeCompare(b.user_id);
                if (a.shift_mode !== b.shift_mode) return a.shift_mode.localeCompare(b.shift_mode);
                if (a.shift_start !== b.shift_start) return a.shift_start.localeCompare(b.shift_start);
                return a.shift_end.localeCompare(b.shift_end);
            })
    );
    const usersById = new Map((staff || []).map((u: any) => [String(u.id), u]));
    const admins = (staff || []).filter((u: any) => normalizeUserRole(u) === 'admin');
    const allStaffUsers = (staff || []).filter((u: any) => normalizeUserRole(u) === 'staff');
    const managers = (staff || []).filter((u: any) => normalizeUserRole(u) === 'manager');

    const managerFromUsers = managers.find((u: any) => String(u.id) === String(project?.manager_id));
    const managerAssigneeOption = managerFromUsers || (
        project?.manager_id
            ? { id: project.manager_id, full_name: project.manager_name || 'Assigned Manager', role: 'manager' }
            : null
    );

    const canAssignStaffInBranch = isAssignedManager;
    const assignableStaffUsers = isAssignedManager
        ? allStaffUsers.filter((candidate: any) => viewerBranchId > 0 && Number(candidate?.branch_id || 0) === viewerBranchId)
        : [];
    const assignableUsers = dedupeUsersById(assignableStaffUsers);
    const resolveTaskAssigneeOptions = (selectedUserId?: string | number | null, fallbackLabel = '') => {
        const options = [...assignableUsers];
        const selectedKey = String(selectedUserId || '').trim();
        if (selectedKey && !options.some((candidate: any) => String(candidate?.id) === selectedKey)) {
            const legacyAssignee = usersById.get(selectedKey)
                || { id: selectedKey, full_name: fallbackLabel || `Current assignee #${selectedKey}`, role: 'staff' };
            options.unshift(legacyAssignee);
        }
        return dedupeUsersById(options);
    };
    const resolveCollaboratorStaffOptions = (selectedUserId?: string | number | null, fallbackLabel = '') => {
        const options = [...assignableStaffUsers];
        const selectedKey = String(selectedUserId || '').trim();
        if (selectedKey && !options.some((candidate: any) => String(candidate?.id) === selectedKey)) {
            const legacyCollaborator = usersById.get(selectedKey)
                || { id: selectedKey, full_name: fallbackLabel || `Current collaborator #${selectedKey}`, role: 'staff' };
            options.unshift(legacyCollaborator);
        }
        return dedupeUsersById(options);
    };

    const projectAssignedStaff = tasks.reduce((acc: any[], task: any) => {
        const appendUniqueStaff = (candidate: any) => {
            if (!candidate || candidate.role !== 'staff') return;
            if (acc.some((u) => String(u.id) === String(candidate.id))) return;
            acc.push(candidate);
        };

        if (task?.assigned_to) {
            const assigned = usersById.get(String(task.assigned_to));
            if (assigned) appendUniqueStaff(assigned);
        }

        const collaborators = Array.isArray(task?.collaborators) ? task.collaborators : [];
        collaborators.forEach((collab: any) => {
            const mapped = usersById.get(String(collab?.user_id));
            if (mapped) {
                appendUniqueStaff(mapped);
                return;
            }
            if (String(collab?.role || '').toLowerCase() === 'staff') {
                appendUniqueStaff({
                    id: collab.user_id,
                    full_name: collab.name || `User #${collab.user_id}`,
                    role: 'staff',
                });
            }
        });

        return acc;
    }, []);
    const fetchMessages = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/project_messages.php?project_id=${id}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setMessages(data.data || []);
        } catch (err) { console.error('Failed to fetch messages'); }
    }, [API_BASE, id]);

    useEffect(() => {
        if (!id || !hasAccess) return;
        void fetchMessages();
    }, [fetchMessages, hasAccess, id]);

    useEffect(() => {
        if (!hasAccess || tasks.length === 0) {
            setProjectAttachments([]);
            setAttachmentsLoading(false);
            return;
        }

        let active = true;

        const loadAttachments = async () => {
            setAttachmentsLoading(true);

            try {
                const results = await Promise.allSettled([
                    ...tasks.map(async (task: any) => {
                        const res = await fetch(`${API_BASE}/task-comments.php?task_id=${task.id}`, { credentials: 'include' });
                        const data = await res.json();
                        if (!data.success || !Array.isArray(data.data)) {
                            return [];
                        }

                        return data.data
                            .filter((comment: any) => comment?.attachment_path && Number(comment?.attachment_archived ?? 0) !== 1)
                            .map((comment: any) => ({
                                comment_id: Number(comment.comment_id || 0),
                                task_id: Number(task.id || 0),
                                task_title: String(task.title || `Task #${task.id}`),
                                attachment_name: comment.attachment_name || 'Attachment',
                                attachment_path: comment.attachment_path || '',
                                attachment_mime: comment.attachment_mime || '',
                                attachment_size: Number(comment.attachment_size || 0),
                                attachment_archived: Number(comment.attachment_archived || 0),
                                commenter_name: comment.commenter_name || '',
                                created_at: comment.created_at || '',
                                from_library: false,
                            }));
                    }),
                    // Documents linked from the central Document Management library.
                    (async () => {
                        try {
                            const res = await fetch(`${API_BASE}/document-management.php?project_id=${id}&status=active`, { credentials: 'include' });
                            const data = await res.json();
                            if (!data.success || !Array.isArray(data.data)) {
                                return [];
                            }
                            return data.data
                                .filter((doc: any) => doc?.file_path)
                                .map((doc: any) => ({
                                    comment_id: Number(doc.id || 0),
                                    task_id: Number(doc.task_id || 0),
                                    task_title: String(doc.task_title || (doc.task_id ? `Task #${doc.task_id}` : 'Project file')),
                                    attachment_name: doc.title || doc.file_name || 'Attachment',
                                    attachment_path: doc.file_path || '',
                                    attachment_mime: doc.mime_type || '',
                                    attachment_size: Number(doc.file_size || 0),
                                    attachment_archived: 0,
                                    commenter_name: doc.uploaded_by_name || '',
                                    created_at: doc.created_at || '',
                                    from_library: true,
                                }));
                        } catch {
                            return [];
                        }
                    })(),
                ]);

                if (!active) return;

                const seen = new Set<string>();
                const nextAttachments = results
                    .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
                    .filter((row: any) => {
                        // Task files mirrored into the library appear twice — keep one.
                        const key = `${row.task_id}|${row.attachment_path}`;
                        if (seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    })
                    .sort((left, right) => {
                        const leftTime = left.created_at ? new Date(left.created_at).getTime() : 0;
                        const rightTime = right.created_at ? new Date(right.created_at).getTime() : 0;
                        return rightTime - leftTime;
                    });

                setProjectAttachments(nextAttachments);
            } catch (error) {
                if (active) {
                    console.error('Failed to load project attachments', error);
                    setProjectAttachments([]);
                }
            } finally {
                if (active) {
                    setAttachmentsLoading(false);
                }
            }
        };

        void loadAttachments();

        return () => {
            active = false;
        };
    }, [API_BASE, hasAccess, id, tasks]);

    const checkSession = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/auth.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                setUser(data.data);
            } else {
                router.push('/');
            }
        } catch (err) {
            router.push('/');
        }
    }, [API_BASE, router]);

    const fetchData = useCallback(async () => {
        try {
            const [projRes, tasksRes, staffRes, clientsRes] = await Promise.all([
                fetch(`${API_BASE}/projects.php?id=${id}`, { credentials: 'include' }),
                fetch(`${API_BASE}/tasks.php?project_id=${id}`, { credentials: 'include' }),
                fetch(`${API_BASE}/users.php`, { credentials: 'include' }),
                fetch(`${API_BASE}/clients.php`, { credentials: 'include' }),
            ]);

            const projData = await projRes.json();
            const tasksData = await tasksRes.json();
            const staffData = await staffRes.json();
            const clientsData = await clientsRes.json();

            if (projData.success) setProject(projData.data);
            if (tasksData.success) {
                setTasks(tasksData.data);
                setTaskDraftAssignments({});
            }
            if (staffData.success) setStaff(staffData.data);
            if (clientsData.success) setClients(clientsData.data);

        } catch (err) { console.error('Failed to fetch data'); }
        finally { setLoading(false); }
    }, [API_BASE, id]);

    useEffect(() => {
        if (id) {
            void checkSession().then(() => fetchData());
        }
    }, [checkSession, fetchData, id]);

    const handleAssignTask = async (taskId: number, userId: string) => {
        // Only allow assigning to staff users (client-side guard)
        if (userId) {
            const targetUser = usersById.get(String(userId));
            if (targetUser && normalizeUserRole(targetUser) !== 'staff') {
                throw new Error('Only staff members can be assigned to tasks.');
            }
        }
        const assignedTo = userId ? parseInt(userId) : null;
        const res = await fetch(`${API_BASE}/tasks.php`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ id: taskId, assigned_to: assignedTo })
        });
        const data = await res.json();
        if (data.success) {
            const assignedUser = userId ? usersById.get(String(userId)) : null;
            setTasks(prev => prev.map(t => t.id === taskId ? { ...t, assigned_to: userId, assigned_name: assignedUser ? getUserDisplayName(assignedUser) : '' } : t));
        } else {
            throw new Error(data.message || 'Failed to assign task');
        }
    };

    const handleTaskDraftAssignmentChange = (task: any, nextUserId: string) => {
        const originalUserId = task?.assigned_to ? String(task.assigned_to) : '';
        setTaskDraftAssignments((previous) => {
            const next = { ...previous };
            if (String(nextUserId || '') === originalUserId) {
                delete next[String(task.id)];
            } else {
                next[String(task.id)] = String(nextUserId || '');
            }
            return next;
        });
    };

    const getTaskDraftAssignmentValue = (task: any) => {
        const taskKey = String(task?.id || '');
        return Object.prototype.hasOwnProperty.call(taskDraftAssignments, taskKey)
            ? taskDraftAssignments[taskKey]
            : String(task?.assigned_to || '');
    };

    const handleSaveProjectTaskChanges = async () => {
        const changes = Object.entries(taskDraftAssignments);
        if (changes.length === 0 || savingProjectTaskChanges) return;

        // Validate all assignments before firing any requests
        for (const [, userId] of changes) {
            if (userId) {
                const targetUser = usersById.get(String(userId));
                if (targetUser && normalizeUserRole(targetUser) !== 'staff') {
                    alert('Only staff members can be assigned to tasks.');
                    return;
                }
            }
        }

        setSavingProjectTaskChanges(true);
        try {
            // Fire all requests in parallel instead of sequentially
            const results = await Promise.all(
                changes.map(([taskId, userId]) =>
                    fetch(`${API_BASE}/tasks.php`, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({ id: Number(taskId), assigned_to: userId ? parseInt(userId, 10) : null }),
                    }).then((res) => res.json()).then((data) => {
                        if (!data.success) throw new Error(data.message || 'Failed to save task changes.');
                        return [taskId, userId] as [string, string];
                    })
                )
            );

            const updatedAssignments = Object.fromEntries(results);
            setTasks((previous) => previous.map((task: any) => {
                const taskKey = String(task?.id || '');
                if (!Object.prototype.hasOwnProperty.call(updatedAssignments, taskKey)) return task;
                const assignedUserId = updatedAssignments[taskKey];
                const assignedUser = assignedUserId ? usersById.get(String(assignedUserId)) : null;
                return {
                    ...task,
                    assigned_to: assignedUserId,
                    assigned_name: assignedUser ? getUserDisplayName(assignedUser) : '',
                };
            }));
            setTaskDraftAssignments({});
        } catch (error: any) {
            alert(error?.message || 'Error saving task changes.');
        } finally {
            setSavingProjectTaskChanges(false);
        }
    };

    const getWorkflowStatus = (task: any) => {
        const workflow = String(task?.workflow_status || '').trim().toLowerCase();
        if (workflow) return workflow;
        const legacy = String(task?.status || '').trim().toLowerCase();
        if (legacy === 'completed') return 'completed';
        if (legacy === 'in_progress') return 'in_progress';
        if (legacy === 'cancelled') return 'cancelled';
        return 'not_started';
    };

    const getWorkflowStatusLabel = (status: string) => {
        const labels: Record<string, string> = {
            not_started: 'Not Started',
            in_progress: 'In Progress',
            pending_manager: 'Pending Manager Review',
            rejected_by_manager: 'Rejected by Manager',
            pending_admin: 'Pending Admin Review',
            rejected_by_admin: 'Rejected by Admin',
            completed: 'Done',
            cancelled: 'Cancelled',
        };
        return labels[status] || String(status || 'Not Started').replace(/_/g, ' ');
    };

    const getWorkflowStatusStyles = (status: string) => {
        // Task workflow palette - completed/done is always green
        if (status === 'completed') return { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' };
        if (status === 'pending_manager') return { background: '#fef9c3', color: '#a16207', border: '1px solid #fde047' };
        if (status === 'pending_admin') return { background: '#ffedd5', color: '#c2410c', border: '1px solid #fdba74' };
        if (status === 'rejected_by_manager' || status === 'rejected_by_admin') return { background: '#ffe4e6', color: '#be123c', border: '1px solid #fecdd3' };
        if (status === 'in_progress') return { background: '#cffafe', color: '#0e7490', border: '1px solid #a5f3fc' };
        if (status === 'cancelled') return { background: '#f1f5f9', color: '#64748b', border: '1px solid #cbd5e1' };
        return { background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' }; // not_started
    };

    const handleStartWorkflowTask = async (task: any) => {
        if (!task?.id) return;
        try {
            const res = await fetch(`${API_BASE}/task-workflow.php?action=start_task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ task_id: task.id }),
            });
            const data = await res.json();
            if (!data.success) {
                alert(data.message || data.error || 'Failed to start task.');
                return;
            }
            await fetchData();
            setSelectedTask((current: any) => current?.id === task.id ? { ...current, workflow_status: 'in_progress', status: 'in_progress' } : current);
        } catch {
            alert('Error starting task.');
        }
    };

    const openWorkflowUploadModal = (task: any) => {
        setWorkflowUploadTask(task);
        setWorkflowUploadFile(null);
        if (workflowUploadPreviewUrl) URL.revokeObjectURL(workflowUploadPreviewUrl);
        setWorkflowUploadPreviewUrl(null);
        setWorkflowUploadNotes('');
    };

    const closeWorkflowUploadModal = () => {
        setWorkflowUploadTask(null);
        setWorkflowUploadFile(null);
        if (workflowUploadPreviewUrl) URL.revokeObjectURL(workflowUploadPreviewUrl);
        setWorkflowUploadPreviewUrl(null);
        setWorkflowUploadNotes('');
    };

    const handleWorkflowFileChange = (file: File | null) => {
        if (workflowUploadPreviewUrl) URL.revokeObjectURL(workflowUploadPreviewUrl);
        setWorkflowUploadFile(file);
        setWorkflowUploadPreviewUrl(file ? URL.createObjectURL(file) : null);
    };

    const handleWorkflowSubmitDocument = async () => {
        if (!workflowUploadTask?.id || !workflowUploadFile) {
            alert('Please select a document/file first.');
            return;
        }
        const formData = new FormData();
        formData.append('task_id', String(workflowUploadTask.id));
        formData.append('document', workflowUploadFile);
        formData.append('notes', workflowUploadNotes);
        try {
            const res = await fetch(`${API_BASE}/task-workflow.php?action=submit_document`, {
                method: 'POST',
                credentials: 'include',
                body: formData,
            });
            const data = await res.json();
            if (!data.success) {
                alert(data.message || data.error || 'Failed to submit document.');
                return;
            }
            closeWorkflowUploadModal();
            await fetchData();
            setSelectedTask((current: any) => current?.id === workflowUploadTask.id ? { ...current, workflow_status: 'pending_manager', status: 'in_progress' } : current);
        } catch {
            alert('Error submitting document.');
        }
    };

    const openWorkflowReviewModal = async (task: any) => {
        if (!task?.id) return;
        // The review modal replaces the task detail panel. Closing the panel
        // first also prevents its higher z-index from covering the review UI.
        setSelectedTask(null);
        setWorkflowReviewLoading(true);
        setWorkflowReviewDetails(null);
        setWorkflowReviewNotes('');
        try {
            const res = await fetch(`${API_BASE}/task-workflow.php?action=task_details&task_id=${task.id}`, { credentials: 'include' });
            const data = await res.json();
            if (!data.success) {
                alert(data.message || data.error || 'Failed to load task review details.');
                return;
            }
            setWorkflowReviewDetails(data.data || null);
        } catch {
            alert('Error loading task review details.');
        } finally {
            setWorkflowReviewLoading(false);
        }
    };

    const closeWorkflowReviewModal = () => {
        setWorkflowReviewDetails(null);
        setWorkflowReviewNotes('');
    };

    const handleWorkflowReviewSubmit = async (approved: boolean) => {
        const task = workflowReviewDetails?.task;
        if (!task?.id) return;
        if (!approved && !workflowReviewNotes.trim()) {
            alert('Please provide a rejection reason.');
            return;
        }
        const workflowStatus = getWorkflowStatus(task);
        const action = workflowStatus === 'pending_admin' || viewerRole === 'admin' ? 'admin_review' : 'manager_review';
        try {
            const res = await fetch(`${API_BASE}/task-workflow.php?action=${action}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    task_id: task.id,
                    approved,
                    review_notes: workflowReviewNotes,
                }),
            });
            const data = await res.json();
            if (!data.success) {
                alert(data.message || data.error || 'Failed to submit review.');
                return;
            }
            closeWorkflowReviewModal();
            setSelectedTask(null);
            await fetchData();
        } catch {
            alert('Error submitting review.');
        }
    };

    const handleSendCompletionReport = async (task: any) => {
        if (!task || task.status !== 'completed') return;

        const isResend = Number(task.has_completion_report ?? 0) === 1;

        const defaultReport = `Task "${task.title}" for project "${project?.name || task.project_name || 'Project'}" has been completed successfully.`;
        const promptLabel = isResend
            ? 'Update and resend completion report for the client (optional):'
            : 'Enter completion report for the client (optional):';
        const reportBody = await promptAction({
            title: isResend ? 'Resend completion report' : 'Send completion report',
            text: `Review the client report for task "${task.title}".`,
            inputLabel: promptLabel,
            inputValue: defaultReport,
            confirmButtonText: isResend ? 'Resend report' : 'Send report',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (reportBody === null) return;

        setSendingReportTaskId(task.id);
        try {
            const res = await fetch(`${API_BASE}/task-reports.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    task_id: task.id,
                    report_body: reportBody.trim()
                })
            });
            const data = await res.json();
            if (data.success) {
                alert(isResend ? 'Completion report resent to client successfully.' : 'Completion report sent to client successfully.');
                setTasks(prev => prev.map(t => t.id === task.id ? { ...t, has_completion_report: 1 } : t));
            } else {
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
                            if (project?.client_id) {
                                router.push(`/clients?edit=${project.client_id}`);
                            }
                        },
                    });
                } else {
                    alert(errorMessage);
                }
            }
        } catch (err) {
            alert('Error sending completion report.');
        } finally {
            setSendingReportTaskId(null);
        }
    };

    const handleSendProjectReport = async (reportKind: 'major_report') => {
        if (!project || !canManageProject) return;
        if (totalTasks <= 0 || completedTasks !== totalTasks) return;

        const reportReference = `LLB-PRJ-${String(project.id || 0).padStart(4, '0')}-FINAL`;
        const issueDate = new Date().toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
        const completionSummary = `${completedTasks}/${totalTasks} tasks completed`;
        const isResend = Number(project.has_major_completion_report ?? 0) === 1;
        const reportLabel = 'final report';
        const defaultReport = [
            'FINAL PROJECT REPORT',
            `Reference No.: ${reportReference}`,
            `Issue Date: ${issueDate}`,
            `Project: ${project.name}`,
            `Client: ${project.client_name || 'Client'}`,
            `Completion Summary: ${completionSummary}`,
            '',
            'Executive Summary:',
            'We are pleased to formally confirm that all agreed deliverables and planned tasks under the above project have been completed successfully and in accordance with the approved scope of work.',
            '',
            'Project Status:',
            '- All required tasks have been completed.',
            '- Supporting outputs have been prepared for client review and turnover as applicable.',
            '- The engagement is ready for formal closeout.',
            '',
            'This final report serves as formal confirmation that the project has been successfully completed.',
            '',
            'Prepared by:',
            'LLB Accountants',
        ].join('\n');
        const promptLabel = isResend
            ? `Update and resend the ${reportLabel} for this project (optional):`
            : `Enter the ${reportLabel} for this completed project (optional):`;
        const reportBody = await promptAction({
            title: isResend
                ? `Resend ${reportLabel}`
                : `Send ${reportLabel}`,
            text: `Review the ${reportLabel} for project "${project.name}".`,
            inputLabel: promptLabel,
            inputValue: defaultReport,
            confirmButtonText: isResend ? `Resend ${reportLabel}` : `Send ${reportLabel}`,
            cancelButtonText: 'Cancel',
            icon: 'question',
            large: true, // Use large textarea for better editing
        });
        if (reportBody === null) return;

        // Optimistic: update UI immediately, fire email in background
        setProject((prev: any) => prev ? { ...prev, has_major_completion_report: 1 } : prev);
        notifySuccess('Final report sent to client.');

        fetch(`${API_BASE}/task-reports.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({
                project_id: project.id,
                report_kind: reportKind,
                report_body: reportBody.trim(),
            })
        })
            .then((res) => res.json())
            .then((data) => {
                if (!data.success) {
                    // Roll back optimistic update and show the real error
                    setProject((prev: any) => prev ? { ...prev, has_major_completion_report: isResend ? 1 : 0 } : prev);
                    notifyError(data.message || 'Failed to send project report.');
                }
            })
            .catch(() => {
                setProject((prev: any) => prev ? { ...prev, has_major_completion_report: isResend ? 1 : 0 } : prev);
                notifyError('Error sending project report.');
            });
    };

    // Add Task
    const handleAddTask = async (e: any) => {
        e.preventDefault();
        setTaskError('');
        const addMissing: Record<string, string> = {};
        if (!taskForm.title.trim()) addMissing.title = 'Required.';
        if (!String(taskForm.due_date || '').trim()) addMissing.due_date = 'Required.';
        if (Object.keys(addMissing).length > 0) { setAddTaskFieldErrors(addMissing); return; }
        setAddTaskFieldErrors({});
        try {
            const payload: any = {
                title: taskForm.title,
                description: taskForm.description,
                project_id: id,
                priority: taskForm.priority,
            };
            if (canAssignStaffInBranch && taskForm.assigned_to) payload.assigned_to = parseInt(taskForm.assigned_to);
            if (taskForm.due_date) payload.due_date = taskForm.due_date;
            if (taskForm.deadline_reminder_at) payload.deadline_reminder_at = taskForm.deadline_reminder_at;

            const res = await fetch(`${API_BASE}/tasks.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                setShowAddTask(false);
                setAddTaskFieldErrors({});
                setTaskForm({ ...defaultTaskForm });
                const createdTask = data.data || {};
                const createdTaskId = Number(createdTask.id || createdTask.task_id || 0);
                const hasDisplayFields = Boolean(createdTask.title || createdTask.description || createdTask.status || createdTask.priority);
                if (createdTaskId > 0 && hasDisplayFields) {
                    const normalizedTask = {
                        ...createdTask,
                        id: createdTaskId,
                        collaborators: Array.isArray(createdTask.collaborators) ? createdTask.collaborators : [],
                    };
                    setTasks(prev => {
                        const withoutDupes = prev.filter((task: any) => Number(task?.id || 0) !== createdTaskId);
                        return [...withoutDupes, normalizedTask];
                    });
                } else {
                    await fetchData();
                }
            } else {
                setTaskError(data.message || 'Failed to create task');
            }
        } catch (err) { setTaskError('An error occurred'); }
    };

    const addEditCollaboratorRow = () => {
        setEditCollaborators((prev) => [...prev, { ...defaultCollaboratorForm }]);
    };

    const updateEditCollaboratorField = (index: number, patch: any) => {
        setEditCollaborators((prev) =>
            prev.map((item, currentIndex) => {
                if (currentIndex !== index) return item;
                const next = { ...item, ...patch };
                if (next.shift_mode === 'none') {
                    next.shift_start = '';
                    next.shift_end = '';
                } else if (next.shift_mode === 'current_time') {
                    next.shift_end = '';
                }
                return next;
            })
        );
    };

    const removeEditCollaboratorRow = (index: number) => {
        setEditCollaborators((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
    };

    const applyCurrentShiftToCollaboratorRow = (index: number) => {
        updateEditCollaboratorField(index, { shift_mode: 'current_time', shift_start: currentDateTimeLocalValue(), shift_end: '' });
    };

    const openEditTaskModal = (task: any) => {
        if (String(task?.status || '') === 'completed') {
            alert('This task is closed because it is completed. Change status first to reopen it.');
            return;
        }
        // Close the detail panel first
        setSelectedTask(null);
        // Small delay to allow the detail panel to close before opening edit
        setTimeout(() => {
            setTaskToEdit(task);
            setEditTaskError('');
            setEditTaskForm({
                title: task?.title || '',
                description: task?.description || '',
                assigned_to: task?.assigned_to ? String(task.assigned_to) : '',
                priority: task?.priority || 'medium',
                due_date: toDateTimeLocalValue(task?.due_date),
                deadline_reminder_at: toDateTimeLocalValue(task?.deadline_reminder_at),
                status: task?.status || 'pending',
            });

            const collaborators = Array.isArray(task?.collaborators) ? task.collaborators : [];
            const mappedCollaborators = collaborators
                .filter((collab: any) => String(collab?.role || '').toLowerCase() === 'staff')
                .map((collab: any) => ({
                    user_id: collab?.user_id ? String(collab.user_id) : '',
                    name: collab?.name || usersById.get(String(collab?.user_id))?.full_name || `User #${collab?.user_id}`,
                    shift_mode: collab?.shift_mode || 'none',
                    shift_start: toDateTimeLocalValue(collab?.shift_start),
                    shift_end: toDateTimeLocalValue(collab?.shift_end),
                }))
                .filter((collab: any) => collab.user_id !== String(task?.assigned_to || ''));

            setEditCollaborators(mappedCollaborators);
            setInitialEditCollaborators(mappedCollaborators);
            setShowEditTask(true);
            setIsEditTaskPanelOpen(true);
        }, 100);
    };

    const closeEditTaskPanel = () => {
        setIsEditTaskPanelOpen(false);
        setShowEditTask(false);
        setEditTaskFieldErrors({});
        setTaskToEdit(null);
        setEditTaskForm({ ...defaultEditTaskForm });
        setEditCollaborators([]);
        setInitialEditCollaborators([]);
    };

    const handleUpdateTask = async (e: any) => {
        e.preventDefault();
        if (!taskToEdit?.id) return;

        setEditTaskError('');
        const editMissing: Record<string, string> = {};
        if (!editTaskForm.title.trim()) editMissing.title = 'Required.';
        if (!String(editTaskForm.due_date || '').trim()) editMissing.due_date = 'Required.';
        if (Object.keys(editMissing).length > 0) { setEditTaskFieldErrors(editMissing); return; }
        setEditTaskFieldErrors({});

        const selectedAssignee = editTaskForm.assigned_to ? String(editTaskForm.assigned_to) : '';
        const collaboratorByUser = new Map<string, any>();
        const collaboratorsChanged = serializeCollaboratorDrafts(editCollaborators) !== serializeCollaboratorDrafts(initialEditCollaborators);

        for (const collaborator of editCollaborators) {
            const userId = String(collaborator?.user_id || '').trim();
            if (!userId) continue;
            if (userId === selectedAssignee) continue;
            if (collaboratorByUser.has(userId)) {
                setEditTaskError('Duplicate collaborator selected.');
                return;
            }

            const shiftMode = String(collaborator?.shift_mode || 'none');
            const normalized: any = {
                user_id: parseInt(userId, 10),
                shift_mode: shiftMode,
            };

            if (shiftMode === 'current_time') {
                normalized.shift_start = collaborator?.shift_start || currentDateTimeLocalValue();
            } else if (shiftMode === 'range') {
                if (!collaborator?.shift_start || !collaborator?.shift_end) {
                    setEditTaskError('Collaborator shift range requires both start and end datetime.');
                    return;
                }
                if (new Date(collaborator.shift_end).getTime() < new Date(collaborator.shift_start).getTime()) {
                    setEditTaskError('Collaborator shift end must be after start.');
                    return;
                }
                normalized.shift_start = collaborator.shift_start;
                normalized.shift_end = collaborator.shift_end;
            }

            collaboratorByUser.set(userId, normalized);
        }

        try {
            const originalAssignee = taskToEdit?.assigned_to ? String(taskToEdit.assigned_to) : '';
            const payload: any = {
                id: taskToEdit.id,
                title: editTaskForm.title,
                description: editTaskForm.description,
                priority: editTaskForm.priority,
            };

            if (canAssignStaffInBranch && selectedAssignee !== originalAssignee) {
                payload.assigned_to = selectedAssignee ? parseInt(selectedAssignee, 10) : null;
            }

            if (collaboratorsChanged) {
                payload.collaborators = Array.from(collaboratorByUser.values());
            }

            if (editTaskForm.due_date) {
                payload.due_date = editTaskForm.due_date;
            }

            if (editTaskForm.deadline_reminder_at) {
                payload.deadline_reminder_at = editTaskForm.deadline_reminder_at;
            } else {
                payload.deadline_reminder_at = null;
            }

            const res = await fetch(`${API_BASE}/tasks.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                setShowEditTask(false);
                setTaskToEdit(null);
                setEditTaskForm({ ...defaultEditTaskForm });
                setEditCollaborators([]);
                setInitialEditCollaborators([]);
                fetchData();
            } else {
                setEditTaskError(data.message || 'Failed to update task');
            }
        } catch (err) {
            setEditTaskError('An error occurred');
        }
    };

    // Archive Task
    const handleDeleteTask = async () => {
        if (!taskToDelete) return;
        try {
            const res = await fetch(`${API_BASE}/tasks.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: taskToDelete.id, status: 'cancelled' })
            });
            const data = await res.json();
            if (data.success) {
                fetchData();
            } else {
                alert(data.message || 'Failed to archive task');
            }
        } catch (err) { alert('Error archiving task'); }
        finally {
            setShowDeleteConfirm(false);
            setTaskToDelete(null);
        }
    };

    // Progress calculation
    const completedTasks = tasks.filter(t => t.status === 'completed').length;
    const totalTasks = tasks.length;
    const assignedTaskCount = tasks.filter((t: any) => Number(t?.assigned_to || 0) > 0).length;
    const unassignedTaskCount = Math.max(0, totalTasks - assignedTaskCount);
    const progressPercent = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
    const allProjectTasksCompleted = totalTasks > 0 && completedTasks === totalTasks;
    const hasMajorProjectReport = Number(project?.has_major_completion_report ?? 0) === 1;
    const filteredTasks = useMemo(() => {
        const term = taskSearch.trim().toLowerCase();
        const todayKey = formatDateKey(new Date());

        return tasks.filter((task: any) => {
            if (taskStatusFilter !== 'all' && getWorkflowStatus(task) !== taskStatusFilter) {
                return false;
            }

            if (taskDeadlineFilter !== 'all') {
                const dueKey = normalizeDateKey(task?.due_date);
                const taskIsOpen = isOpenTask(task?.status);
                if (taskDeadlineFilter === 'due_today' && (!taskIsOpen || dueKey !== todayKey)) {
                    return false;
                }
                if (taskDeadlineFilter === 'overdue' && (!taskIsOpen || !dueKey || dueKey >= todayKey)) {
                    return false;
                }
            }

            if (!term) {
                return true;
            }

            const haystack = [
                task?.title || '',
                task?.description || '',
                task?.status || '',
                getWorkflowStatusLabel(getWorkflowStatus(task)),
                task?.priority || '',
                task?.assigned_name || '',
            ].join(' ').toLowerCase();

            return haystack.includes(term);
        }).sort(sortTasksForDisplay);
    }, [taskDeadlineFilter, taskSearch, taskStatusFilter, tasks]);
    const paginatedTasks = filteredTasks.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
    const staffVisibleTasks = useMemo(() => (
        tasks.filter((task: any) => String(task?.assigned_to) === String(user?.id) || isTaskCollaborator(task, user?.id))
    ), [tasks, user?.id]);
    const visibleTaskCount = user?.role === 'staff' ? staffVisibleTasks.length : tasks.length;
    const visibleCompletedTaskCount = user?.role === 'staff'
        ? staffVisibleTasks.filter((task: any) => String(task?.status || '') === 'completed').length
        : completedTasks;
    const visibleProgressPercent = visibleTaskCount > 0 ? Math.round((visibleCompletedTaskCount / visibleTaskCount) * 100) : 0;
    const overdueTaskCount = useMemo(() => {
        const todayKey = formatDateKey(new Date());
        return tasks.filter((task: any) => {
            const dueKey = normalizeDateKey(task?.due_date);
            return !!dueKey && dueKey < todayKey && isOpenTask(task?.status);
        }).length;
    }, [tasks]);
    const nextDeadlineLabel = useMemo(() => {
        const upcomingTask = [...tasks]
            .filter((task: any) => {
                const dueKey = normalizeDateKey(task?.due_date);
                return !!dueKey && isOpenTask(task?.status);
            })
            .sort((left: any, right: any) => {
                const leftTime = left?.due_date ? new Date(left.due_date).getTime() : Number.MAX_SAFE_INTEGER;
                const rightTime = right?.due_date ? new Date(right.due_date).getTime() : Number.MAX_SAFE_INTEGER;
                return leftTime - rightTime;
            })[0];

        return upcomingTask?.due_date ? formatDateTime(upcomingTask.due_date, 'No upcoming deadline') : 'No upcoming deadline';
    }, [tasks]);
    const projectStatusPalette = useMemo(() => {
        // Keep project badge in navy/slate family (not task teal/cyan)
        if (project?.status === 'active') {
            return {
                background: '#eff6ff',
                color: '#1d4ed8',
                border: '1px solid #bfdbfe',
            };
        }
        if (project?.status === 'completed') {
            return {
                background: '#dcfce7',
                color: '#166534',
                border: '1px solid #86efac',
            };
        }
        if (project?.status === 'on_hold') {
            return {
                background: '#fff7ed',
                color: '#c2410c',
                border: '1px solid #fed7aa',
            };
        }
        if (project?.status === 'archived') {
            return {
                background: '#fef2f2',
                color: '#991b1b',
                border: '1px solid #fecaca',
            };
        }
        if (project?.status === 'pending') {
            return {
                background: '#fefce8',
                color: '#854d0e',
                border: '1px solid #fde68a',
            };
        }
        return {
            background: '#f1f5f9',
            color: '#475569',
            border: '1px solid #cbd5e1',
        };
    }, [project?.status]);
    const sortedMessages = useMemo(() => (
        [...messages]
            .sort((left, right) => {
                const leftTime = left?.created_at ? new Date(left.created_at).getTime() : 0;
                const rightTime = right?.created_at ? new Date(right.created_at).getTime() : 0;
                return rightTime - leftTime;
            })
    ), [messages]);
    const latestMessages = useMemo(() => sortedMessages.slice(0, PROJECT_DETAIL_PREVIEW_LIMIT), [sortedMessages]);
    const recentAttachments = useMemo(() => projectAttachments.slice(0, PROJECT_DETAIL_PREVIEW_LIMIT), [projectAttachments]);
    const paginatedExpandedMessages = useMemo(() => {
        // Expanded lists use the Settings → Pagination page size, same as every other list.
        const startIndex = (expandedProjectListPage - 1) * ITEMS_PER_PAGE;
        return sortedMessages.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [expandedProjectListPage, sortedMessages, ITEMS_PER_PAGE]);
    const paginatedExpandedAttachments = useMemo(() => {
        const startIndex = (expandedProjectListPage - 1) * ITEMS_PER_PAGE;
        return projectAttachments.slice(startIndex, startIndex + ITEMS_PER_PAGE);
    }, [expandedProjectListPage, projectAttachments, ITEMS_PER_PAGE]);

    const getStatusStyles = (status: string) => {
        if (status === 'completed') return { background: '#dcfce7', color: '#166534', border: '1px solid #86efac' };
        if (status === 'in_progress') return { background: '#cffafe', color: '#0e7490', border: '1px solid #a5f3fc' };
        if (status === 'cancelled') return { background: '#ffe4e6', color: '#be123c', border: '1px solid #fecdd3' };
        return { background: '#f5f3ff', color: '#6d28d9', border: '1px solid #ddd6fe' };
    };

    const getPriorityStyles = (priority: string) => {
        // Priority uses pink/amber/emerald chips, separate from project/task status families
        if (priority === 'high') return { background: '#fdf2f8', color: '#be185d', border: '1px solid #fbcfe8' };
        if (priority === 'medium') return { background: '#fffbeb', color: '#b45309', border: '1px solid #fde68a' };
        return { background: '#ecfdf5', color: '#047857', border: '1px solid #a7f3d0' };
    };

    const renderTaskDetailContent = (t: any) => {
        const assignedUser = t?.assigned_to ? usersById.get(String(t.assigned_to)) : null;
        const taskStaffAssignee = assignedUser?.role === 'staff' ? assignedUser : null;
        const taskCollaborators = Array.isArray(t?.collaborators) ? t.collaborators : [];
        const staffTaskCollaborators = taskCollaborators.filter((collab: any) =>
            String(collab?.role || '').toLowerCase() === 'staff' && String(collab?.user_id) !== String(t?.assigned_to || '')
        );
        const staffCollaboratorLabels = staffTaskCollaborators.map((collab: any) => {
            const display = collab?.name || usersById.get(String(collab?.user_id))?.full_name || `User #${collab?.user_id}`;
            const shift = formatCollaboratorShift(collab);
            return shift ? `${display} (${shift})` : display;
        });
        const managerCollaborator = assignedUser?.role === 'manager' ? assignedUser : managerAssigneeOption;
        const priorityStyles = getPriorityStyles(t.priority || 'medium');
        const hasCompletionReport = Number(t.has_completion_report ?? 0) === 1;
        const requiresCompletionProof = Number(t.require_completion_proof ?? 0) === 1;
        const workflowStatus = getWorkflowStatus(t);
        const workflowStatusStyles = getWorkflowStatusStyles(workflowStatus);
        const isTaskClosed = workflowStatus === 'completed' || String(t.status) === 'completed';
        const currentUserIsCollaborator = isTaskCollaborator(t, user?.id);
        const canSendCompletionReport = isTaskClosed && (canManageProject || String(t.assigned_to) === String(user?.id) || currentUserIsCollaborator);
        const canWorkOnTask = String(t.assigned_to) === String(user?.id) || currentUserIsCollaborator;
        const canStartWorkflow = viewerRole === 'staff' && canWorkOnTask && workflowStatus === 'not_started';
        const canUploadWorkflow = viewerRole === 'staff' && canWorkOnTask && ['in_progress', 'rejected_by_manager', 'rejected_by_admin'].includes(workflowStatus);
        const canManagerReviewWorkflow = isAssignedManager && workflowStatus === 'pending_manager';
        const canAdminReviewWorkflow = viewerRole === 'admin' && workflowStatus === 'pending_admin';

        return (
            <div style={{ display: 'grid', gap: '14px', paddingTop: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '10px', flexWrap: 'wrap' }}>
                    <div>
                        <div style={{ fontSize: '20px', fontWeight: 800, color: '#0f172a', lineHeight: 1.2 }}>{t.title}</div>
                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: 4 }}>Task #{t.id}</div>
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ padding: '5px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', ...workflowStatusStyles }}>
                            {getWorkflowStatusLabel(workflowStatus)}
                        </span>
                        <span style={{ padding: '5px 10px', borderRadius: '999px', fontSize: '11px', fontWeight: 'bold', ...priorityStyles }}>
                            {(t.priority || 'medium').toUpperCase()}
                        </span>
                    </div>
                </div>

                <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', background: '#f8fafc', padding: '14px 16px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Description</div>
                    <div style={{ fontSize: '14px', color: '#334155', lineHeight: 1.65 }}>
                        {t.description || 'No description provided.'}
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '12px' }}>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', background: '#ffffff', padding: '14px 16px' }}>
                        <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Schedule</div>
                        <div style={{ fontSize: '14px', color: '#0f172a', fontWeight: 700 }}>
                            {formatDateTime(t.due_date, 'No due date')}
                        </div>
                    </div>
                    <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', background: '#ffffff', padding: '14px 16px' }}>
                        <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Client Report</div>
                        <div style={{ fontSize: '14px', color: hasCompletionReport ? '#15803d' : '#334155', fontWeight: 700 }}>
                            {hasCompletionReport
                                ? `Sent${t.completion_report_sent_at ? ` (${new Date(t.completion_report_sent_at).toLocaleString()})` : ''}`
                                : 'Not yet sent'}
                        </div>
                    </div>
                </div>

                <div style={{ border: '1px solid #e2e8f0', borderRadius: '12px', background: '#ffffff', padding: '14px 16px' }}>
                    <div style={{ fontSize: '12px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px' }}>Collaborators</div>
                    <div style={{ display: 'grid', gap: '6px' }}>
                        <div style={{ fontSize: '13px', color: '#334155' }}>
                            <strong>Admin:</strong>{' '}
                            {admins.length > 0 ? admins.map((a: any) => getUserDisplayName(a)).join(', ') : 'Not available in this view'}
                        </div>
                        <div style={{ fontSize: '13px', color: '#334155' }}>
                            <strong>Manager:</strong>{' '}
                            {managerCollaborator ? getUserDisplayName(managerCollaborator) : 'Unassigned'}
                        </div>
                        <div style={{ fontSize: '13px', color: '#334155' }}>
                            <strong>Staff assignee:</strong>{' '}
                            {taskStaffAssignee ? getUserDisplayName(taskStaffAssignee) : (assignedUser ? `${getUserDisplayName(assignedUser)} (${assignedUser.role})` : 'Unassigned')}
                        </div>
                        <div style={{ fontSize: '13px', color: '#334155' }}>
                            <strong>Staff collaborators:</strong>{' '}
                            {staffCollaboratorLabels.length > 0 ? staffCollaboratorLabels.join(', ') : 'None'}
                        </div>
                    </div>
                </div>

                <div style={{ border: '1px solid #dbeafe', borderRadius: '12px', background: '#f8fbff', padding: '14px 16px' }}>
                    <div style={{ fontSize: '12px', color: '#1d4ed8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '8px', fontWeight: 800 }}>Approval Workflow</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ padding: '6px 10px', borderRadius: '999px', fontSize: '12px', fontWeight: 800, ...workflowStatusStyles }}>
                            {getWorkflowStatusLabel(workflowStatus)}
                        </span>
                        <span style={{ fontSize: '12px', color: '#475569' }}>
                            Staff must start the task, upload the completed document, then wait for manager and admin approval.
                        </span>
                    </div>
                </div>

                <TaskLibraryDocs taskId={t.id} apiBase={API_BASE} />

                {isAssignedManager ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        {/* Assign staff section */}
                        <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 12, padding: '14px 16px' }}>
                            <div style={{ fontSize: '11px', fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10 }}>
                                Assign Staff
                            </div>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <select
                                    value={
                                        Object.prototype.hasOwnProperty.call(panelAssignDraft, String(t.id))
                                            ? panelAssignDraft[String(t.id)]
                                            : String(t.assigned_to || '')
                                    }
                                    onChange={(e) => setPanelAssignDraft((prev) => ({ ...prev, [String(t.id)]: e.target.value }))}
                                    disabled={isTaskClosed}
                                    style={{
                                        flex: 1, padding: '9px 12px', borderRadius: '9px',
                                        border: '1px solid #cbd5e1', fontSize: '13px',
                                        color: '#1f2937', backgroundColor: isTaskClosed ? '#f1f5f9' : 'white',
                                        cursor: isTaskClosed ? 'not-allowed' : 'pointer',
                                    }}
                                >
                                    <option value="">Unassigned</option>
                                    {resolveTaskAssigneeOptions(t.assigned_to, t.assigned_name || '').map((candidate: any) => (
                                        <option key={candidate.id} value={candidate.id}>
                                            {getUserDisplayName(candidate)}
                                        </option>
                                    ))}
                                </select>
                                {!isTaskClosed && (() => {
                                    const draftVal = Object.prototype.hasOwnProperty.call(panelAssignDraft, String(t.id))
                                        ? panelAssignDraft[String(t.id)]
                                        : String(t.assigned_to || '');
                                    const currentVal = String(t.assigned_to || '');
                                    const isDirty = draftVal !== currentVal;
                                    const isSaving = !!savingPanelAssign[String(t.id)];
                                    return (
                                        <button
                                            type="button"
                                            disabled={!isDirty || isSaving}
                                            onClick={async () => {
                                                if (!isDirty || isSaving) return;
                                                setSavingPanelAssign((prev) => ({ ...prev, [String(t.id)]: true }));
                                                try {
                                                    await handleAssignTask(t.id, draftVal);
                                                    setPanelAssignDraft((prev) => {
                                                        const next = { ...prev };
                                                        delete next[String(t.id)];
                                                        return next;
                                                    });
                                                } catch (err: any) {
                                                    void notifyError(err?.message || 'Failed to assign task.');
                                                } finally {
                                                    setSavingPanelAssign((prev) => ({ ...prev, [String(t.id)]: false }));
                                                }
                                            }}
                                            style={{
                                                padding: '9px 16px', borderRadius: '9px', border: 'none',
                                                background: isDirty ? '#1e3a8a' : '#e2e8f0',
                                                color: isDirty ? '#fff' : '#94a3b8',
                                                fontSize: '12px', fontWeight: 700,
                                                cursor: isDirty && !isSaving ? 'pointer' : 'not-allowed',
                                                whiteSpace: 'nowrap', flexShrink: 0,
                                                transition: 'background 0.15s',
                                            }}
                                        >
                                            {isSaving ? 'Saving…' : 'Assign'}
                                        </button>
                                    );
                                })()}
                            </div>
                            {/* Current assignee label */}
                            <div style={{ marginTop: 8, fontSize: '12px', color: '#64748b' }}>
                                Currently assigned to:{' '}
                                <strong style={{ color: '#0f172a' }}>
                                    {t.assigned_to
                                        ? (usersById.get(String(t.assigned_to)) ? getUserDisplayName(usersById.get(String(t.assigned_to))) : (t.assigned_name || `Staff #${t.assigned_to}`))
                                        : 'No one'}
                                </strong>
                            </div>
                        </div>
                        {isTaskClosed ? (
                            <div style={{ padding: '10px 12px', borderRadius: '10px', backgroundColor: '#fef3c7', fontSize: '12px', color: '#b45309' }}>
                                Task closed because the admin confirmed it as done.
                            </div>
                        ) : null}
                        {(canManagerReviewWorkflow || canAdminReviewWorkflow) ? (
                            <button
                                type="button"
                                onClick={() => void openWorkflowReviewModal(t)}
                                style={{ alignSelf: 'flex-start', padding: '9px 13px', borderRadius: '9px', border: 'none', background: '#1e3a8a', color: '#fff', cursor: 'pointer', fontSize: '12px', fontWeight: 800 }}
                            >
                                View Submission
                            </button>
                        ) : null}
                    </div>
                ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '13px', color: '#334155' }}>
                            <strong>Access:</strong>{' '}
                            {String(t.assigned_to) === String(user?.id)
                                ? 'Primary assignee'
                                : (currentUserIsCollaborator ? 'Collaborator' : (t.assigned_name || 'Unassigned'))}
                        </span>
                        <span style={{ fontSize: '12px', color: requiresCompletionProof ? '#b45309' : '#475569' }}>
                            <strong>Document:</strong> Required before Done
                        </span>
                        {canStartWorkflow ? (
                            <button
                                type="button"
                                onClick={() => void handleStartWorkflowTask(t)}
                                style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', background: '#1d4ed8', color: '#fff' }}
                            >
                                Start Task
                            </button>
                        ) : null}
                        {canUploadWorkflow ? (
                            <button
                                type="button"
                                onClick={() => openWorkflowUploadModal(t)}
                                style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', background: '#15803d', color: '#fff' }}
                            >
                                Upload Document & Done
                            </button>
                        ) : null}
                        {workflowStatus === 'pending_manager' || workflowStatus === 'pending_admin' ? (
                            <span style={{ fontSize: '12px', color: '#b45309', fontWeight: 700 }}>Waiting for review.</span>
                        ) : null}
                        {canAdminReviewWorkflow ? (
                            <button type="button" onClick={() => void openWorkflowReviewModal(t)} style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', background: '#15803d', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>Review Submission</button>
                        ) : null}
                        {canManagerReviewWorkflow ? (
                            <button type="button" onClick={() => void openWorkflowReviewModal(t)} style={{ padding: '7px 12px', borderRadius: '8px', border: 'none', background: '#15803d', color: '#fff', fontSize: '12px', fontWeight: 700, cursor: 'pointer' }}>Review Submission</button>
                        ) : null}
                        {workflowStatus === 'completed' ? (
                            <span style={{ fontSize: '12px', color: '#15803d', fontWeight: 800 }}>Task is done.</span>
                        ) : null}
                    </div>
                )}

                <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <div style={{ fontSize: '13px', color: '#475569' }}>
                        Opened from the task list. Updates here apply immediately.
                    </div>
                    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        {canSendCompletionReport && viewerRole !== 'admin' ? (
                            <button
                                type="button"
                                onClick={() => handleSendCompletionReport(t)}
                                disabled={sendingReportTaskId === t.id}
                                title={hasCompletionReport ? 'Resend report' : 'Send report'}
                                aria-label={hasCompletionReport ? 'Resend report' : 'Send report'}
                                style={{
                                    padding: '8px 12px',
                                    borderRadius: '8px',
                                    border: 'none',
                                    cursor: sendingReportTaskId === t.id ? 'not-allowed' : 'pointer',
                                    background: hasCompletionReport ? '#0f766e' : '#1e3a8a',
                                    color: 'white',
                                    fontSize: '12px',
                                    fontWeight: 'bold',
                                    opacity: sendingReportTaskId === t.id ? 0.7 : 1
                                }}
                            >
                                {sendingReportTaskId === t.id ? 'Sending...' : (hasCompletionReport ? 'Resend report' : 'Send report')}
                            </button>
                        ) : null}

                        {isAssignedManager && !isTaskClosed ? (
                            <>
                                <button
                                    onClick={() => openEditTaskModal(t)}
                                    title="Edit Task"
                                    aria-label={`Edit ${t.title}`}
                                    style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                                >
                                    <CrudActionIcon action="edit" />
                                    Edit
                                </button>
                                <button
                                    onClick={() => { setTaskToDelete(t); setShowDeleteConfirm(true); }}
                                    title="Archive Task"
                                    aria-label={`Archive ${t.title}`}
                                    style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid #fecaca', background: '#fff1f2', color: '#be123c', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
                                >
                                    <CrudActionIcon action="archive" />
                                    Archive
                                </button>
                            </>
                        ) : null}
                    </div>
                </div>
            </div>
        );
    };

    useEffect(() => {
        setCurrentPage(1);
    }, [id, taskDeadlineFilter, taskSearch, taskStatusFilter]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filteredTasks.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [filteredTasks.length, currentPage, ITEMS_PER_PAGE]);

    useEffect(() => {
        setExpandedProjectListPage(1);
    }, [expandedProjectList, ITEMS_PER_PAGE]);

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
    if (!project) return <div>Project not found</div>;

    return (
        <Layout role={user?.role} user={user} onLogout={handleLogout}>
            <Head>
                <title>{project.name} - Details</title>
            </Head>

            {/* ── Top nav bar ── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
                <button
                    onClick={() => router.push('/projects')}
                    style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', color: '#475569', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 14px', fontSize: 13, fontWeight: 600 }}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                    Back to Projects
                </button>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ padding: '5px 12px', borderRadius: 6, fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.06em', ...projectStatusPalette }}>
                        {String(project.status || 'active').replace('_', ' ')}
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '5px 10px' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: '#475569', whiteSpace: 'nowrap' }}>Overall Progress</span>
                        <div style={{ width: 80, height: 5, background: '#e2e8f0', borderRadius: 999, overflow: 'hidden' }}>
                            <div style={{ height: '100%', width: `${progressPercent}%`, background: progressPercent === 100 ? 'linear-gradient(90deg,#16a34a,#22c55e)' : 'linear-gradient(90deg,#1d4ed8,#38bdf8)', borderRadius: 999, transition: 'width 0.4s ease' }} />
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 800, color: progressPercent === 100 ? '#16a34a' : '#1d4ed8', whiteSpace: 'nowrap' }}>{progressPercent}%</span>
                    </div>
                    {isAssignedManager && (
                        <button
                            type="button"
                            className="app-action-btn-primary"
                            onClick={() => setShowAddTask(true)}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                            Add Task
                        </button>
                    )}
                    {canManageProject && (
                        <button
                            type="button"
                            className="app-action-btn-primary"
                            onClick={() => {
                                setEditProjectForm({
                                    name: project.name || '',
                                    description: project.description || '',
                                    client_id: project.client_id ? String(project.client_id) : '',
                                    manager_id: project.manager_id ? String(project.manager_id) : '',
                                    status: project.status || 'active',
                                    start_date: toDateTimeLocalValue(project.start_date),
                                    end_date: toDateTimeLocalValue(project.end_date),
                                });
                                setEditProjectError('');
                                setShowEditProject(true);
                            }}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '7px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}
                        >
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                            Edit Project
                        </button>
                    )}
                </div>
            </div>

            {/* ── Project Header Card ── */}
            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 16, marginBottom: 20, overflow: 'hidden' }}>
                {/* Top accent strip */}
                <div style={{ height: 4, background: 'linear-gradient(90deg, #1e3a8a 0%, #3b82f6 60%, #06b6d4 100%)' }} />

                <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'stretch', gap: 16 }}>
                    {/* Title + description */}
                    <div style={{ flex: '1 1 0', minWidth: 0, maxWidth: '30%', display: 'flex', flexDirection: 'column', justifyContent: 'center', paddingRight: 16, borderRight: '1.5px solid #e2e8f0' }}>
                        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#0f172a', letterSpacing: '-0.02em', lineHeight: 1.2, wordBreak: 'break-word' }}>
                            {project.name}
                        </h1>
                        <p style={{ margin: '4px 0 0', fontSize: 11, color: '#64748b', lineHeight: 1.4 }}>
                            {project.description || 'No description added yet.'}
                        </p>
                    </div>

                    {/* Meta cards — no wrap, text truncates to stay on one line */}
                    <div style={{ flex: '2 1 0', display: 'flex', gap: 8, minWidth: 0, overflow: 'hidden', alignItems: 'stretch' }}>
                        {/* Client */}
                        <div style={{ flex: 1, minWidth: 0, padding: '8px 12px', background: '#f8fafc', border: '1.5px solid #cbd5e1', borderRadius: 9, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Client</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.client_name || '—'}</div>
                        </div>
                        {/* Services */}
                        <div style={{ flex: 1, minWidth: 0, padding: '8px 12px', background: '#f8fafc', border: '1.5px solid #cbd5e1', borderRadius: 9, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Services</div>
                            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {project.service_names ? (
                                    String(project.service_names).split(',').map((svc: string, idx: number) => (
                                        <span key={idx} style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 700, background: '#ede9fe', color: '#5b21b6', marginRight: 3 }}>
                                            {svc.trim()}
                                        </span>
                                    ))
                                ) : (
                                    <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>—</span>
                                )}
                            </div>
                        </div>
                        {/* Manager */}
                        <div style={{ flex: 1, minWidth: 0, padding: '8px 12px', background: '#f8fafc', border: '1.5px solid #cbd5e1', borderRadius: 9, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Manager</div>
                            {viewerRole === 'admin' ? (
                                <select
                                    value={String(project?.manager_id || '')}
                                    onChange={(e) => {
                                        const newManagerId = e.target.value ? parseInt(e.target.value) : null;
                                        fetch(`${API_BASE}/projects.php`, {
                                            method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                                            body: JSON.stringify({ id: project.id, manager_id: newManagerId })
                                        }).then(r => r.json()).then(d => {
                                            if (d.success) fetchData();
                                            else alert(d.message || 'Failed to reassign manager');
                                        }).catch(() => alert('Error reassigning manager'));
                                    }}
                                    style={{ width: '100%', padding: '4px 6px', borderRadius: 6, border: '1px solid #cbd5e1', background: '#fff', color: '#1f2937', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                                >
                                    <option value="">Unassigned</option>
                                    {managers.map((mgr: any) => (
                                        <option key={mgr.id} value={mgr.id}>{getUserDisplayName(mgr)}</option>
                                    ))}
                                </select>
                            ) : (
                                <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{project.manager_name || 'Unassigned'}</div>
                            )}
                        </div>
                        {/* Due Date */}
                        <div style={{ flex: 1, minWidth: 0, padding: '8px 12px', background: '#f8fafc', border: '1.5px solid #cbd5e1', borderRadius: 9, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                            <div style={{ fontSize: 9, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 3 }}>Due Date</div>
                            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{formatDateTime(project.end_date)}</div>
                        </div>
                        {/* Client Report (shown when all tasks done) */}
                        {canManageProject && allProjectTasksCompleted && (
                            <div style={{ flex: 1, minWidth: 0, padding: '8px 12px', background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 9, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 5 }}>
                                <div>
                                    <div style={{ fontSize: 9, fontWeight: 800, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 2 }}>Client Report</div>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#166534', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                        {hasMajorProjectReport
                                            ? `Sent${project?.major_completion_report_sent_at ? ` · ${new Date(project.major_completion_report_sent_at).toLocaleDateString()}` : ''}`
                                            : 'Not yet sent'}
                                    </div>
                                </div>
                                <button
                                    type="button"
                                    onClick={() => void handleSendProjectReport('major_report')}
                                    style={{ alignSelf: 'flex-start', padding: '4px 10px', borderRadius: 6, border: 'none', background: hasMajorProjectReport ? '#0f766e' : '#15803d', color: '#fff', cursor: 'pointer', fontWeight: 700, fontSize: 10, whiteSpace: 'nowrap' }}
                                >
                                    {hasMajorProjectReport ? 'Resend' : 'Send Report'}
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Stat chips row ── */}
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
                {[
                    { label: user?.role === 'staff' ? 'My Tasks' : 'Total Tasks', value: visibleTaskCount, sub: `${visibleCompletedTaskCount} done (${visibleProgressPercent}%)`, color: '#1d4ed8', bg: '#eff6ff', border: '#bfdbfe' },
                    ...(user?.role !== 'staff' ? [
                        { label: 'Assigned', value: assignedTaskCount, sub: 'With staff assignee', color: '#15803d', bg: '#f0fdf4', border: '#bbf7d0' },
                        { label: 'Unassigned', value: unassignedTaskCount, sub: 'Waiting for assignment', color: '#b45309', bg: '#fffbeb', border: '#fde68a' },
                    ] : []),
                    { label: 'Overdue', value: overdueTaskCount, sub: 'Past due date', color: '#dc2626', bg: '#fff1f2', border: '#fecdd3' },
                    { label: 'Updates', value: messages.length, sub: 'Activity notes', color: '#0f766e', bg: '#f0fdfa', border: '#99f6e4' },
                ].map((s) => (
                    <div key={s.label} style={{ flex: '1 1 110px', display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: '14px 16px', background: s.bg, border: `1px solid ${s.border}`, borderRadius: 10 }}>
                        <div style={{ fontSize: 24, fontWeight: 800, color: s.color, lineHeight: 1 }}>{s.value}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: s.color, marginTop: 4 }}>{s.label}</div>
                        <div style={{ fontSize: 10, color: s.color, opacity: 0.75, marginTop: 2 }}>{s.sub}</div>
                    </div>
                ))}
            </div>

            {/* ── Tasks Section ── */}
            <div>
                {/* Section header + filters + view toggle — all in one bar */}
                <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '10px 14px', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    {/* Title */}
                    <h2 style={{ margin: 0, fontSize: 14, fontWeight: 800, color: '#0f172a', whiteSpace: 'nowrap', flexShrink: 0 }}>
                        {user?.role === 'staff' ? 'My Tasks' : 'Task List'}
                    </h2>

                    {/* Search */}
                    <div style={{ flex: '2 1 160px' }}>
                        <SearchBar
                            storageKey="project:tasks"
                            placeholder="Search tasks…"
                            ariaLabel="Search tasks"
                            value={taskSearch}
                            onChange={setTaskSearch}
                            suggestions={collectSearchTerms(tasks, [
                                (t: any) => t?.title,
                                (t: any) => t?.assigned_name,
                                (t: any) => t?.status,
                                (t: any) => t?.priority,
                            ])}
                            inputStyle={{ padding: '7px 30px 7px 32px', borderRadius: 7, borderColor: '#cbd5e1', fontSize: 12 }}
                        />
                    </div>

                    {/* Status filter */}
                    <select value={taskStatusFilter} onChange={(e) => setTaskStatusFilter(e.target.value)} style={{ flex: '1 1 130px', padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12 }}>
                        <option value="all">All Statuses</option>
                        <option value="not_started">Not Started</option>
                        <option value="in_progress">In Progress</option>
                        <option value="pending_manager">Pending Manager Review</option>
                        <option value="pending_admin">Pending Admin Review</option>
                        <option value="rejected_by_manager">Rejected by Manager</option>
                        <option value="rejected_by_admin">Rejected by Admin</option>
                        <option value="completed">Done</option>
                        <option value="cancelled">Cancelled</option>
                    </select>

                    {/* Due date filter */}
                    <select value={taskDeadlineFilter} onChange={(e) => setTaskDeadlineFilter(e.target.value)} style={{ flex: '1 1 100px', padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1', background: '#fff', fontSize: 12 }}>
                        <option value="all">All Dates</option>
                        <option value="due_today">Due Today</option>
                        <option value="overdue">Overdue</option>
                    </select>

                    {/* View toggle */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 2, background: '#f1f5f9', borderRadius: 7, padding: 3, flexShrink: 0, marginLeft: 'auto' }}>
                        <button
                            type="button"
                            onClick={() => setTaskView('list')}
                            title="List view"
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '5px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                                fontSize: 12, fontWeight: 700,
                                background: taskView === 'list' ? '#fff' : 'transparent',
                                color: taskView === 'list' ? '#1e3a8a' : '#64748b',
                                boxShadow: taskView === 'list' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                            }}
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>
                                <line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>
                            </svg>
                            List
                        </button>
                        <button
                            type="button"
                            onClick={() => setTaskView('board')}
                            title="Board view"
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: 4,
                                padding: '5px 10px', borderRadius: 5, border: 'none', cursor: 'pointer',
                                fontSize: 12, fontWeight: 700,
                                background: taskView === 'board' ? '#fff' : 'transparent',
                                color: taskView === 'board' ? '#1e3a8a' : '#64748b',
                                boxShadow: taskView === 'board' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
                            }}
                        >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="11" rx="1"/>
                            </svg>
                            Board
                        </button>
                    </div>
                </div>

                {isAssignedManager && Object.keys(taskDraftAssignments).length > 0 && (
                    <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '12px', color: '#64748b' }}>
                            {Object.keys(taskDraftAssignments).length} assignment change{Object.keys(taskDraftAssignments).length === 1 ? '' : 's'} not yet saved.
                        </span>
                        <button
                            type="button"
                            className="app-action-btn-primary"
                            onClick={() => void handleSaveProjectTaskChanges()}
                            disabled={savingProjectTaskChanges}
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: savingProjectTaskChanges ? 'not-allowed' : 'pointer', opacity: savingProjectTaskChanges ? 0.7 : 1 }}
                        >
                            {savingProjectTaskChanges ? 'Saving...' : `Save ${Object.keys(taskDraftAssignments).length} change${Object.keys(taskDraftAssignments).length === 1 ? '' : 's'}`}
                        </button>
                    </div>
                )}
                {taskView === 'list' ? (
                    <>
                        {paginatedTasks.length === 0 ? (
                            <div style={{ background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '14px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                                <ZeroResults
                                    query={taskSearch}
                                    itemLabel="tasks"
                                    alternatives={getAlternativeSuggestions(taskSearch, collectSearchTerms(tasks, [
                                        (t: any) => t?.title,
                                        (t: any) => t?.assigned_name,
                                    ]))}
                                    onPickAlternative={(term) => setTaskSearch(term)}
                                    onClear={() => setTaskSearch('')}
                                />
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: 8 }}>
                                {paginatedTasks.map((t: any) => {
                                    const assignedUser = t?.assigned_to ? usersById.get(String(t.assigned_to)) : null;
                                    const workflowStatus = getWorkflowStatus(t);
                                    const workflowStatusStyles = getWorkflowStatusStyles(workflowStatus);
                                    const priorityStyles = getPriorityStyles(t.priority || 'medium');
                                    const hasCompletionReport = Number(t.has_completion_report ?? 0) === 1;
                                    const isTaskClosed = workflowStatus === 'completed' || String(t.status) === 'completed';
                                    const hasDraftAssignment = Object.prototype.hasOwnProperty.call(taskDraftAssignments, String(t.id));

                                    return (
                                        <div
                                            key={t.id}
                                            className="projectTaskRow"
                                            style={{
                                                display: 'grid',
                                                gridTemplateColumns: 'minmax(0, 1fr) 220px',
                                                gap: 0,
                                                alignItems: 'stretch',
                                                background: hasDraftAssignment ? '#dbeafe' : '#fff',
                                                border: `1px solid ${hasDraftAssignment ? '#3b82f6' : (isTaskClosed ? '#d1d5db' : '#e2e8f0')}`,
                                                borderRadius: 10,
                                                overflow: 'hidden',
                                                opacity: isTaskClosed ? 0.82 : 1,
                                            }}
                                        >
                                            {/* Main clickable area */}
                                            <button
                                                type="button"
                                                className="projectTaskCard"
                                                onClick={() => setSelectedTask(t)}
                                                style={{
                                                    width: '100%', textAlign: 'left', background: 'transparent',
                                                    border: 'none', padding: '8px 10px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4,
                                                }}
                                            >
                                                {/* Title + badges */}
                                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
                                                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', flex: 1, minWidth: 0 }}>{t.title}</span>
                                                    <span style={{ padding: '3px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, flexShrink: 0, ...workflowStatusStyles }}>
                                                        {getWorkflowStatusLabel(workflowStatus)}
                                                    </span>
                                                    <span style={{ padding: '3px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, flexShrink: 0, ...priorityStyles }}>
                                                        {(t.priority || 'medium').toUpperCase()}
                                                    </span>
                                                </div>
                                                {/* Description */}
                                                <div style={{ fontSize: 12, color: '#64748b', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical' }}>
                                                    {t.description || 'No description.'}
                                                </div>
                                                {/* Due date + report */}
                                                <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginTop: 2 }}>
                                                    <span style={{ fontSize: 11, color: '#64748b' }}>
                                                        Due: <strong style={{ color: '#475569' }}>{formatDateTime(t.due_date, 'Not set')}</strong>
                                                    </span>
                                                    {hasCompletionReport && (
                                                        <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '1px 7px' }}>Report sent</span>
                                                    )}
                                                </div>
                                            </button>

                                            {/* Staff / assign panel */}
                                            <div style={{
                                                borderLeft: '1px solid #e2e8f0',
                                                background: '#f8fafc',
                                                padding: '8px 10px',
                                                display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4,
                                            }}>
                                                <div style={{ fontSize: 10, fontWeight: 800, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Assignee</div>
                                                {isAssignedManager ? (
                                                    <select
                                                        value={getTaskDraftAssignmentValue(t)}
                                                        onClick={(e) => e.stopPropagation()}
                                                        onChange={(e) => handleTaskDraftAssignmentChange(t, e.target.value)}
                                                        disabled={isTaskClosed}
                                                        style={{ width: '100%', padding: '7px 10px', borderRadius: 7, border: '1px solid #cbd5e1', fontSize: 12, color: '#1f2937', background: isTaskClosed ? '#f1f5f9' : '#fff' }}
                                                    >
                                                        <option value="">Unassigned</option>
                                                        {resolveTaskAssigneeOptions(t.assigned_to, t.assigned_name || '').map((candidate: any) => (
                                                            <option key={candidate.id} value={candidate.id}>{getUserDisplayName(candidate)}</option>
                                                        ))}
                                                    </select>
                                                ) : (
                                                    <div style={{ padding: '7px 10px', borderRadius: 7, background: '#fff', border: '1px solid #e2e8f0', fontSize: 12, fontWeight: 700, color: '#334155' }}>
                                                        {assignedUser ? getUserDisplayName(assignedUser) : 'Unassigned'}
                                                    </div>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => setSelectedTask(t)}
                                                    style={{ padding: '6px 10px', borderRadius: 7, border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: 11, fontWeight: 700, textAlign: 'center' }}
                                                >
                                                    View details
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                        <Pagination
                            currentPage={currentPage}
                            totalItems={filteredTasks.length}
                            itemsPerPage={ITEMS_PER_PAGE}
                            onPageChange={setCurrentPage}
                            label="tasks"
                        />
                    </>
                ) : (
                    /* ── Kanban Board View ── */
                    (() => {
                        const boardColumns = [
                            {
                                id: 'backlog',
                                label: 'Backlog',
                                dot: '#6d28d9',
                                bg: '#faf5ff',
                                border: '#e9d5ff',
                                headerBg: '#7c3aed',
                                headerColor: '#ffffff',
                                statuses: ['not_started', 'cancelled'],
                            },
                            {
                                id: 'in_progress',
                                label: 'In Progress',
                                dot: '#0e7490',
                                bg: '#f0fdfe',
                                border: '#a5f3fc',
                                headerBg: '#0e7490',
                                headerColor: '#ffffff',
                                statuses: ['in_progress'],
                            },
                            {
                                id: 'review',
                                label: 'Review',
                                dot: '#a16207',
                                bg: '#fefce8',
                                border: '#fde68a',
                                headerBg: '#d97706',
                                headerColor: '#ffffff',
                                statuses: ['pending_manager', 'pending_admin', 'rejected_by_manager', 'rejected_by_admin'],
                            },
                            {
                                id: 'done',
                                label: 'Done',
                                dot: '#16a34a',
                                bg: '#f0fdf4',
                                border: '#86efac',
                                headerBg: '#16a34a',
                                headerColor: '#ffffff',
                                statuses: ['completed'],
                            },
                        ];

                        const boardTasks = filteredTasks;

                        return (
                            <div style={{ overflowX: 'auto', paddingBottom: 8 }}>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(260px, 1fr))', gap: 12, minWidth: 1040 }}>
                                    {boardColumns.map((col) => {
                                        const colTasks = boardTasks.filter((t: any) => col.statuses.includes(getWorkflowStatus(t)));
                                        return (
                                            <div key={col.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                {/* Column header */}
                                                <div style={{
                                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                                    padding: '10px 14px',
                                                    background: col.headerBg,
                                                    borderRadius: 10,
                                                }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                                        <span style={{ width: 9, height: 9, borderRadius: 999, background: 'rgba(255,255,255,0.5)', flexShrink: 0 }} />
                                                        <span style={{ fontWeight: 800, fontSize: 13, color: col.headerColor }}>{col.label}</span>
                                                    </div>
                                                    <span style={{ fontWeight: 700, fontSize: 12, color: col.headerColor, background: 'rgba(255,255,255,0.2)', borderRadius: 999, padding: '1px 8px', border: '1px solid rgba(255,255,255,0.3)' }}>
                                                        {colTasks.length}
                                                    </span>
                                                </div>
                                                {/* Cards */}
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                                    {colTasks.length === 0 ? (
                                                        <div style={{ padding: '20px 14px', textAlign: 'center', color: '#94a3b8', fontSize: 12, background: '#f8fafc', border: '1px dashed #e2e8f0', borderRadius: 10 }}>
                                                            No tasks
                                                        </div>
                                                    ) : colTasks.map((t: any) => {
                                                        const assignedUser = t?.assigned_to ? usersById.get(String(t.assigned_to)) : null;
                                                        const workflowStatus = getWorkflowStatus(t);
                                                        const priorityStyles = getPriorityStyles(t.priority || 'medium');
                                                        const hasCompletionReport = Number(t.has_completion_report ?? 0) === 1;
                                                        const isTaskClosed = workflowStatus === 'completed' || String(t.status) === 'completed';

                                                        return (
                                                            <div
                                                                key={t.id}
                                                                onClick={() => setSelectedTask(t)}
                                                                style={{
                                                                    background: '#fff',
                                                                    border: `1px solid ${isTaskClosed ? '#d1d5db' : '#e2e8f0'}`,
                                                                    borderRadius: 10,
                                                                    padding: '14px 14px 12px',
                                                                    cursor: 'pointer',
                                                                    opacity: isTaskClosed ? 0.82 : 1,
                                                                    transition: 'box-shadow 0.15s',
                                                                }}
                                                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 12px rgba(15,23,42,0.10)'; }}
                                                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.boxShadow = 'none'; }}
                                                            >
                                                                {/* Priority bar */}
                                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                                                                    <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 10, fontWeight: 700, ...priorityStyles }}>
                                                                        {(t.priority || 'medium').toUpperCase()}
                                                                    </span>
                                                                    {hasCompletionReport && (
                                                                        <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 999, padding: '1px 7px' }}>✓ Report</span>
                                                                    )}
                                                                </div>
                                                                {/* Title */}
                                                                <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', marginBottom: 6, lineHeight: 1.4 }}>
                                                                    {t.title}
                                                                </div>
                                                                {/* Description snippet */}
                                                                <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', lineHeight: 1.5 }}>
                                                                    {t.description || 'No description.'}
                                                                </div>
                                                                {/* Footer: due date + assignee avatar */}
                                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, borderTop: '1px solid #f1f5f9', paddingTop: 8 }}>
                                                                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#64748b' }}>
                                                                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                                            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                                                                        </svg>
                                                                        <span>{t.due_date ? new Date(t.due_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'No date'}</span>
                                                                    </div>
                                                                    <div
                                                                        title={assignedUser ? getUserDisplayName(assignedUser) : 'Unassigned'}
                                                                        style={{
                                                                            width: 26, height: 26, borderRadius: 999,
                                                                            background: assignedUser ? '#1e3a8a' : '#e2e8f0',
                                                                            color: assignedUser ? '#fff' : '#94a3b8',
                                                                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                                            fontSize: 10, fontWeight: 800, flexShrink: 0,
                                                                        }}
                                                                    >
                                                                        {assignedUser
                                                                            ? (getUserDisplayName(assignedUser).split(' ').map((w: string) => w[0]).slice(0, 2).join('').toUpperCase())
                                                                            : '?'
                                                                        }
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })()
                )}
                <style jsx>{`
                    @media (max-width: 860px) {
                        .projectTaskRow {
                            grid-template-columns: 1fr !important;
                        }
                        .projectTaskCard {
                            grid-template-columns: 1fr !important;
                        }
                    }
                `}</style>
            </div>

            <FloatingListPanel
                open={expandedProjectList !== null}
                onClose={() => setExpandedProjectList(null)}
                title={expandedProjectList === 'files' ? 'Project Files' : 'Recent Updates'}
                description={
                    expandedProjectList === 'files'
                        ? `${projectAttachments.length} attachment${projectAttachments.length === 1 ? '' : 's'} shared through project tasks.`
                        : `${sortedMessages.length} project update${sortedMessages.length === 1 ? '' : 's'} captured on this project.`
                }
            >
                {expandedProjectList === 'files' ? (
                    attachmentsLoading ? (
                        <div style={{ padding: '12px 0', color: '#64748b', fontSize: '13px' }}>Loading project files...</div>
                    ) : projectAttachments.length === 0 ? (
                        <div style={{ padding: '12px 0', color: '#64748b', fontSize: '13px' }}>No attachments have been shared on this project yet.</div>
                    ) : (
                        <>
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {paginatedExpandedAttachments.map((attachment) => (
                                    <div key={`expanded-${attachment.comment_id}-${attachment.task_id}`} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: 8 }}>
                                            <strong style={{ fontSize: '14px', color: '#1f2937' }}>{attachment.attachment_name || 'Attachment'}</strong>
                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                                {attachment.from_library ? (
                                                    <span style={{ fontSize: '10px', fontWeight: 800, background: '#eff6ff', color: '#1e3a8a', border: '1px solid #bfdbfe', borderRadius: 99, padding: '1px 7px' }}>
                                                        Library
                                                    </span>
                                                ) : null}
                                                <span style={{ fontSize: '12px', color: '#64748b' }}>{formatAttachmentSize(attachment.attachment_size)}</span>
                                            </span>
                                        </div>
                                        <div style={{ fontSize: '13px', color: '#475569', lineHeight: 1.55 }}>
                                            Task: <strong>{attachment.task_title}</strong>
                                        </div>
                                        <div style={{ fontSize: '12px', color: '#64748b', marginTop: 6 }}>
                                            Shared by {attachment.commenter_name || 'Unknown user'}{attachment.created_at ? ` on ${new Date(attachment.created_at).toLocaleString()}` : ''}
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => window.open(resolveBackendAssetUrl(attachment.attachment_path || ''), '_blank', 'noopener,noreferrer')}
                                            style={{ marginTop: 10, padding: '8px 12px', borderRadius: '9px', border: '1px solid #cbd5e1', background: '#fff', color: '#1d4ed8', cursor: 'pointer', fontWeight: 700, fontSize: '12px' }}
                                        >
                                            Open File
                                        </button>
                                    </div>
                                ))}
                            </div>
                            <Pagination
                                currentPage={expandedProjectListPage}
                                totalItems={projectAttachments.length}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={setExpandedProjectListPage}
                                label="files"
                            />
                        </>
                    )
                ) : (
                    sortedMessages.length === 0 ? (
                        <div style={{ padding: '12px 0', color: '#64748b', fontSize: '13px' }}>No project updates yet.</div>
                    ) : (
                        <>
                            <div style={{ display: 'grid', gap: '12px' }}>
                                {paginatedExpandedMessages.map((message) => (
                                    <div key={`expanded-message-${message.id}`} style={{ border: '1px solid #e2e8f0', borderRadius: '12px', padding: '14px', background: '#f8fafc' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: 8 }}>
                                            <strong style={{ fontSize: '14px', color: '#1f2937' }}>{message.sender_name || 'Project update'}</strong>
                                            <span style={{ fontSize: '12px', color: '#64748b' }}>
                                                {message.created_at ? new Date(message.created_at).toLocaleString() : ''}
                                            </span>
                                        </div>
                                        <div style={{ fontSize: '13px', color: '#475569', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                            {String(message?.message || message?.content || message?.body || message?.text || 'No message content.')}
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <Pagination
                                currentPage={expandedProjectListPage}
                                totalItems={sortedMessages.length}
                                itemsPerPage={ITEMS_PER_PAGE}
                                onPageChange={setExpandedProjectListPage}
                                label="updates"
                            />
                        </>
                    )
                )}
            </FloatingListPanel>

            <FloatingListPanel
                open={selectedTask !== null}
                onClose={() => setSelectedTask(null)}
                title={selectedTask?.title || 'Task Details'}
                description={selectedTask ? `Task #${selectedTask.id}` : undefined}
                width="min(980px, 96vw)"
            >
                {selectedTask ? renderTaskDetailContent(selectedTask) : null}
            </FloatingListPanel>

            {/* Workflow Upload Modal */}
            {workflowUploadTask && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.58)', zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ width: 'min(900px, 96vw)', background: '#fff', borderRadius: 16, boxShadow: '0 24px 70px rgba(15,23,42,0.28)', border: '1px solid #dbe4f0', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr auto', maxHeight: '92vh' }}>
                        {/* Header */}
                        <div style={{ padding: '18px 22px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                            <div>
                                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: '#0f172a' }}>Upload Document & Mark Done</h3>
                                <p style={{ margin: '4px 0 0', color: '#64748b', fontSize: 13 }}>Submit your completed PDF for manager review. PDF only, max 10 MB.</p>
                            </div>
                            <button type="button" onClick={closeWorkflowUploadModal} style={{ border: '1px solid #e2e8f0', background: '#fff', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontWeight: 700, color: '#64748b', fontSize: 13 }}>Cancel</button>
                        </div>
                        {/* Body — two columns when file chosen */}
                        <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: workflowUploadPreviewUrl ? '280px 1fr' : '1fr', overflow: 'hidden' }}>
                            {/* Left: form */}
                            <div style={{ overflowY: 'auto', padding: '20px 22px', borderRight: workflowUploadPreviewUrl ? '1px solid #e2e8f0' : 'none', display: 'flex', flexDirection: 'column', gap: 16 }}>
                                <div style={{ padding: '10px 14px', borderRadius: 10, background: '#f8fafc', border: '1px solid #e2e8f0', color: '#334155', fontSize: 13 }}>
                                    <strong>{workflowUploadTask.title}</strong>
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Document / File *</label>
                                    <input
                                        type="file"
                                        accept=".pdf"
                                        onChange={(e) => handleWorkflowFileChange(e.target.files?.[0] || null)}
                                        style={{ display: 'block', width: '100%', fontSize: 13, color: '#475569', fontWeight: 400 }}
                                    />
                                    {workflowUploadFile && (
                                        <div style={{ marginTop: 8, padding: '8px 12px', borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', fontSize: 12, color: '#065f46', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                            {workflowUploadFile.name}
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Notes (Optional)</label>
                                    <textarea
                                        value={workflowUploadNotes}
                                        onChange={(e) => setWorkflowUploadNotes(e.target.value)}
                                        rows={5}
                                        placeholder="Optional notes for the manager..."
                                        style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #cbd5e1', resize: 'vertical', fontFamily: 'inherit', color: '#0f172a', fontSize: 13 }}
                                    />
                                </div>
                            </div>
                            {/* Right: PDF preview */}
                            {workflowUploadPreviewUrl && (
                                <div style={{ minHeight: 0, background: '#f1f5f9', padding: 12, display: 'flex', flexDirection: 'column' }}>
                                    <div style={{ fontSize: 11, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>PDF Preview</div>
                                    <iframe
                                        src={workflowUploadPreviewUrl}
                                        title="PDF preview"
                                        style={{ flex: 1, width: '100%', border: '1px solid #cbd5e1', borderRadius: 10, background: '#fff' }}
                                    />
                                </div>
                            )}
                        </div>
                        {/* Footer */}
                        <div style={{ padding: '14px 22px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                            <button type="button" onClick={closeWorkflowUploadModal} style={{ padding: '9px 18px', borderRadius: 9, border: '1px solid #e2e8f0', background: '#fff', color: '#374151', cursor: 'pointer', fontWeight: 700, fontSize: 13 }}>Cancel</button>
                            <button type="button" onClick={() => void handleWorkflowSubmitDocument()} disabled={!workflowUploadFile} style={{ padding: '9px 22px', borderRadius: 9, border: 'none', background: workflowUploadFile ? '#15803d' : '#94a3b8', color: '#fff', cursor: workflowUploadFile ? 'pointer' : 'not-allowed', fontWeight: 800, fontSize: 13 }}>Done</button>
                        </div>
                    </div>
                </div>
            )}

            {/* Workflow Review Modal */}
            {(workflowReviewLoading || workflowReviewDetails) && (() => {
                const reviewTask = workflowReviewDetails?.task || {};
                const submissions = Array.isArray(workflowReviewDetails?.submissions) ? workflowReviewDetails.submissions : [];
                const latestSubmission = submissions[0] || null;
                const reviewWorkflowStatus = getWorkflowStatus(reviewTask);
                const isAdminReview = reviewWorkflowStatus === 'pending_admin';
                const documentUrl = latestSubmission?.submission_id
                    ? `${API_BASE}/task-workflow.php?action=view_submission&submission_id=${encodeURIComponent(String(latestSubmission.submission_id))}`
                    : '';
                const documentIsPreviewable = isInlineDocumentPreviewable({
                    name: latestSubmission?.file_name || 'Submission',
                    url: documentUrl,
                    mime: latestSubmission?.mime_type || '',
                });

                return (
                    <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.62)', zIndex: 1250, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                        <div style={{ width: 'min(1180px, 98vw)', height: '88vh', background: '#fff', borderRadius: 18, boxShadow: '0 30px 90px rgba(15,23,42,0.34)', border: '1px solid #dbe4f0', overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto 1fr auto' }}>
                            <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                                <div>
                                    <h3 style={{ margin: 0, fontSize: 18, color: '#0f172a' }}>{workflowReviewLoading ? 'Loading submission...' : reviewTask.title}</h3>
                                    <div style={{ marginTop: 6, color: '#64748b', fontSize: 13 }}>{isAdminReview ? 'Admin final review' : 'Manager review'} • {getWorkflowStatusLabel(reviewWorkflowStatus)}</div>
                                </div>
                                <button type="button" onClick={closeWorkflowReviewModal} style={{ border: '1px solid #cbd5e1', background: '#fff', color: '#334155', borderRadius: 10, padding: '7px 11px', cursor: 'pointer', fontWeight: 800 }}>Close</button>
                            </div>

                            <div style={{ minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(280px, 0.9fr) minmax(420px, 1.4fr)', gap: 0 }}>
                                <div style={{ overflowY: 'auto', padding: 18, borderRight: '1px solid #e2e8f0', background: '#f8fafc' }}>
                                    {workflowReviewLoading ? (
                                        <div style={{ color: '#64748b', fontSize: 14 }}>Loading task details...</div>
                                    ) : (
                                        <div style={{ display: 'grid', gap: 12 }}>
                                            <div style={{ padding: 12, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12 }}>
                                                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, marginBottom: 6 }}>Task</div>
                                                <div style={{ fontSize: 14, color: '#334155', lineHeight: 1.6 }}>{reviewTask.description || 'No description provided.'}</div>
                                            </div>
                                            <div style={{ padding: 12, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 12 }}>
                                                <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', fontWeight: 800, marginBottom: 6 }}>Submission</div>
                                                <div style={{ fontSize: 13, color: '#0f172a', fontWeight: 800 }}>{latestSubmission?.file_name || 'No file found'}</div>
                                                <div style={{ marginTop: 5, fontSize: 12, color: '#64748b' }}>{latestSubmission?.submitted_at ? new Date(latestSubmission.submitted_at).toLocaleString() : ''}</div>
                                                {latestSubmission?.notes ? <div style={{ marginTop: 8, fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap' }}>{latestSubmission.notes}</div> : null}
                                                {documentUrl && !documentIsPreviewable ? (
                                                    <div style={{ marginTop: 10, fontSize: 12, color: '#64748b' }}>This file type cannot be previewed in the browser. Use the explicit download link in the viewer.</div>
                                                ) : null}
                                            </div>
                                            {Array.isArray(workflowReviewDetails?.rejections) && workflowReviewDetails.rejections.length > 0 ? (
                                                <div style={{ padding: 12, background: '#fff1f2', border: '1px solid #fecaca', borderRadius: 12 }}>
                                                    <div style={{ fontSize: 11, color: '#be123c', textTransform: 'uppercase', fontWeight: 800, marginBottom: 6 }}>Previous rejection</div>
                                                    <div style={{ fontSize: 13, color: '#7f1d1d', lineHeight: 1.55 }}>{workflowReviewDetails.rejections[0]?.reason || '-'}</div>
                                                </div>
                                            ) : null}
                                            <label style={{ display: 'grid', gap: 6, color: '#334155', fontSize: 13, fontWeight: 800 }}>
                                                {isAdminReview ? 'Admin notes / rejection reason' : 'Manager notes / rejection reason'}
                                                <textarea
                                                    value={workflowReviewNotes}
                                                    onChange={(e) => setWorkflowReviewNotes(e.target.value)}
                                                    rows={6}
                                                    placeholder="Write approval notes or explain what must be corrected..."
                                                    style={{ width: '100%', padding: 10, borderRadius: 10, border: '1px solid #cbd5e1', resize: 'vertical', fontFamily: 'inherit', color: '#0f172a', background: '#fff' }}
                                                />
                                            </label>
                                        </div>
                                    )}
                                </div>
                                <div style={{ minHeight: 0, background: '#e2e8f0', padding: 12 }}>
                                    {documentUrl && documentIsPreviewable ? (
                                        <iframe src={documentUrl} title="Task submission document viewer" style={{ width: '100%', height: '100%', border: '1px solid #cbd5e1', borderRadius: 12, background: '#fff' }} />
                                    ) : documentUrl ? (
                                        <div style={{ height: '100%', borderRadius: 12, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: '#64748b', fontSize: 13 }}>
                                            <div>
                                                <div style={{ fontWeight: 700, color: '#334155' }}>Preview is not available for this file type.</div>
                                                <a href={documentUrl} download={latestSubmission?.file_name || 'submission'} style={{ display: 'inline-flex', marginTop: 12, padding: '8px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#1d4ed8', textDecoration: 'none', fontWeight: 700 }}>Download File</a>
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ height: '100%', borderRadius: 12, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748b', fontSize: 14 }}>No document available.</div>
                                    )}
                                </div>
                            </div>

                            <div style={{ padding: '14px 20px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
                                <button type="button" onClick={() => void handleWorkflowReviewSubmit(false)} disabled={workflowReviewLoading} style={{ padding: '10px 14px', borderRadius: 10, border: 'none', background: '#dc2626', color: '#fff', cursor: workflowReviewLoading ? 'not-allowed' : 'pointer', fontWeight: 800 }}>Reject</button>
                                <button type="button" onClick={() => void handleWorkflowReviewSubmit(true)} disabled={workflowReviewLoading} style={{ padding: '10px 14px', borderRadius: 10, border: 'none', background: '#15803d', color: '#fff', cursor: workflowReviewLoading ? 'not-allowed' : 'pointer', fontWeight: 800 }}>{isAdminReview ? 'Confirm Done' : 'Accept & Send to Admin'}</button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* Add Task Modal */}
            {showAddTask && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '500px', maxWidth: '90%' }}>
                        <h2 style={{ marginTop: 0, marginBottom: '20px', color: '#333' }}>Add New Task</h2>

                        <form onSubmit={handleAddTask} noValidate>
                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Task Title *</label>
                                <input
                                    type="text" value={taskForm.title}
                                    onChange={(e) => { setTaskForm({ ...taskForm, title: e.target.value }); if (addTaskFieldErrors.title) setAddTaskFieldErrors((prev) => { const next = { ...prev }; delete next.title; return next; }); }}
                                    required
                                    aria-required="true"
                                    aria-invalid={addTaskFieldErrors.title ? true : undefined}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: addTaskFieldErrors.title ? '2px solid #ef4444' : '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                                />
                                {addTaskFieldErrors.title && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{addTaskFieldErrors.title}</div>}
                            </div>

                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Description</label>
                                <textarea
                                    value={taskForm.description}
                                    onChange={(e) => setTaskForm({ ...taskForm, description: e.target.value })}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', minHeight: '70px', color: '#000', backgroundColor: '#fff' }}
                                />
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>
                                        {viewerRole === 'manager' ? 'Assign To (Staff in Your Branch)' : 'Assignee'}
                                    </label>
                                    {canAssignStaffInBranch ? (
                                        <select
                                            value={taskForm.assigned_to}
                                            onChange={(e) => setTaskForm({ ...taskForm, assigned_to: e.target.value })}
                                            style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}
                                        >
                                            <option value="">-- Unassigned --</option>
                                            {resolveTaskAssigneeOptions(taskForm.assigned_to).map((candidate: any) => (
                                                <option key={candidate.id} value={candidate.id}>
                                                    {getUserDisplayName(candidate)} (Staff)
                                                </option>
                                            ))}
                                        </select>
                                    ) : (
                                        <div style={{ padding: '10px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', color: '#64748b', fontSize: '13px' }}>
                                            Only the project manager can assign staff from their branch.
                                        </div>
                                    )}
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Priority</label>
                                    <select
                                        value={taskForm.priority}
                                        onChange={(e) => setTaskForm({ ...taskForm, priority: e.target.value })}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}
                                    >
                                        <option value="low">Low</option>
                                        <option value="medium">Medium</option>
                                        <option value="high">High</option>
                                    </select>
                                </div>
                            </div>

                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Due Date *</label>
                                <input
                                    type="datetime-local" value={taskForm.due_date}
                                    onChange={(e) => { setTaskForm({ ...taskForm, due_date: e.target.value }); if (addTaskFieldErrors.due_date) setAddTaskFieldErrors((prev) => { const next = { ...prev }; delete next.due_date; return next; }); }}
                                    required
                                    aria-required="true"
                                    aria-invalid={addTaskFieldErrors.due_date ? true : undefined}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: addTaskFieldErrors.due_date ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white' }}
                                />
                                {addTaskFieldErrors.due_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{addTaskFieldErrors.due_date}</div>}
                            </div>

                            <div style={{ marginBottom: '20px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Deadline Reminder</label>
                                <input
                                    type="datetime-local" value={taskForm.deadline_reminder_at}
                                    onChange={(e) => setTaskForm({ ...taskForm, deadline_reminder_at: e.target.value })}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#333', backgroundColor: 'white' }}
                                />
                                <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>An alert notification will be created at this time if the task is still open.</div>
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center' }}>
                                <button 
                                    type="button" 
                                    onClick={() => { setShowAddTask(false); setTaskError(''); setAddTaskFieldErrors({}); setTaskForm({ ...defaultTaskForm }); }}
                                    style={{ 
                                        background: 'transparent', 
                                        border: 'none', 
                                        padding: 0, 
                                        cursor: 'pointer', 
                                        color: '#64748b',
                                        fontWeight: 600,
                                        fontSize: 14
                                    }}
                                >
                                    Cancel
                                </button>
                                <button
                                    type="submit"
                                    title="Create Task"
                                    aria-label="Create Task"
                                    style={{
                                        background: '#2563eb',
                                        border: 'none',
                                        padding: '8px 18px',
                                        borderRadius: 8,
                                        cursor: 'pointer',
                                        color: '#fff',
                                        fontWeight: 700,
                                        fontSize: 14
                                    }}
                                >
                                    Save
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Edit Task Floating Panel */}
            {isEditTaskPanelOpen && taskToEdit && (
                <FloatingListPanel
                    open={isEditTaskPanelOpen}
                    onClose={closeEditTaskPanel}
                    title="Edit Task"
                    description={`Editing task #${taskToEdit.id}`}
                    width="min(640px, 96vw)"
                    zIndex={1100}
                >
                    <form onSubmit={handleUpdateTask} noValidate>
                        <div style={{ marginBottom: '15px' }}>
                            <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Task Title *</label>
                            <input
                                type="text"
                                value={editTaskForm.title}
                                onChange={(e) => { setEditTaskForm({ ...editTaskForm, title: e.target.value }); if (editTaskFieldErrors.title) setEditTaskFieldErrors((prev) => { const next = { ...prev }; delete next.title; return next; }); }}
                                required
                                aria-required="true"
                                aria-invalid={editTaskFieldErrors.title ? true : undefined}
                                style={{ width: '100%', padding: '10px', borderRadius: '6px', border: editTaskFieldErrors.title ? '2px solid #ef4444' : '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                            />
                            {editTaskFieldErrors.title && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editTaskFieldErrors.title}</div>}
                        </div>

                        <div style={{ marginBottom: '15px' }}>
                            <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Description</label>
                            <textarea
                                value={editTaskForm.description}
                                onChange={(e) => setEditTaskForm({ ...editTaskForm, description: e.target.value })}
                                style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', minHeight: '70px', color: '#000', backgroundColor: '#fff' }}
                            />
                        </div>


                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                            <div>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Assignee</label>
                                {canAssignStaffInBranch ? (
                                    <select
                                        value={editTaskForm.assigned_to}
                                        onChange={(e) => setEditTaskForm({ ...editTaskForm, assigned_to: e.target.value })}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}
                                    >
                                        <option value="">-- Unassigned --</option>
                                        {resolveTaskAssigneeOptions(editTaskForm.assigned_to, taskToEdit?.assigned_name || '').map((candidate: any) => (
                                            <option key={candidate.id} value={candidate.id}>
                                                {getUserDisplayName(candidate)} (Staff)
                                            </option>
                                        ))}
                                    </select>
                                ) : (
                                    <div style={{ padding: '10px', borderRadius: '6px', border: '1px solid #e2e8f0', backgroundColor: '#f8fafc', color: '#64748b', fontSize: '13px' }}>
                                        Only the project manager can assign staff from their branch.
                                    </div>
                                )}
                            </div>

                            <div>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Priority</label>
                                <select
                                    value={editTaskForm.priority}
                                    onChange={(e) => setEditTaskForm({ ...editTaskForm, priority: e.target.value })}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}
                                >
                                    <option value="low">Low</option>
                                    <option value="medium">Medium</option>
                                    <option value="high">High</option>
                                </select>
                            </div>
                        </div>

                        <div style={{ marginBottom: '20px' }}>
                            <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Due Date *</label>
                    <input
                        type="datetime-local"
                        value={editTaskForm.due_date}
                        onChange={(e) => { setEditTaskForm({ ...editTaskForm, due_date: e.target.value }); if (editTaskFieldErrors.due_date) setEditTaskFieldErrors((prev) => { const next = { ...prev }; delete next.due_date; return next; }); }}
                        required
                        aria-required="true"
                        aria-invalid={editTaskFieldErrors.due_date ? true : undefined}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: editTaskFieldErrors.due_date ? '2px solid #ef4444' : '1px solid #ccc', color: '#333', backgroundColor: 'white' }}
                    />
                    {editTaskFieldErrors.due_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editTaskFieldErrors.due_date}</div>}
                </div>

                <div style={{ marginBottom: '20px' }}>
                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Deadline Reminder</label>
                    <input
                        type="datetime-local"
                        value={editTaskForm.deadline_reminder_at}
                        onChange={(e) => setEditTaskForm({ ...editTaskForm, deadline_reminder_at: e.target.value })}
                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#333', backgroundColor: 'white' }}
                    />
                    <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>An alert notification will be created at this time if the task is still open.</div>
                </div>

                <div style={{ marginBottom: '20px', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', background: '#f8fafc' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
                                <div>
                                    <div style={{ fontSize: '13px', fontWeight: 'bold', color: '#334155' }}>Additional Collaborators (Staff)</div>
                                    <div style={{ fontSize: '11px', color: '#64748b' }}>Add staff who can access this task and optionally set shift windows.</div>
                                </div>
                                <button
                                    type="button"
                                    onClick={addEditCollaboratorRow}
                                    style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid #bfdbfe', background: '#eff6ff', color: '#1d4ed8', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}
                                >
                                    Add collaborator
                                </button>
                            </div>

                            {editCollaborators.length === 0 ? (
                                <div style={{ fontSize: '12px', color: '#94a3b8' }}>No additional collaborators.</div>
                            ) : (
                                <div style={{ display: 'grid', gap: '10px' }}>
                                    {editCollaborators.map((collab: any, index: number) => (
                                        <div key={`${collab.user_id || 'new'}-${index}`} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', background: 'white', padding: '10px' }}>
                                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px', alignItems: 'end', marginBottom: collab.shift_mode !== 'none' ? '8px' : 0 }}>
                                                <div style={{ minWidth: 0 }}>
                                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '12px' }}>Staff User</label>
                                                    <select
                                                        value={collab.user_id}
                                                        onChange={(e) => updateEditCollaboratorField(index, { user_id: e.target.value })}
                                                        style={{ width: '100%', minWidth: 0, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: 'white', color: '#333' }}
                                                    >
                                                        <option value="">-- Select staff --</option>
                                                        {resolveCollaboratorStaffOptions(collab.user_id, collab.name || '').map((candidate: any) => (
                                                            <option key={candidate.id} value={candidate.id}>
                                                                {getUserDisplayName(candidate)}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>

                                                <div style={{ minWidth: 0 }}>
                                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '12px' }}>Shift</label>
                                                    <select
                                                        value={collab.shift_mode || 'none'}
                                                        onChange={(e) => updateEditCollaboratorField(index, { shift_mode: e.target.value })}
                                                        style={{ width: '100%', minWidth: 0, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', backgroundColor: 'white', color: '#333' }}
                                                    >
                                                        <option value="none">No shift</option>
                                                        <option value="current_time">Current time</option>
                                                        <option value="range">Between dates</option>
                                                    </select>
                                                </div>

                                                <button
                                                    type="button"
                                                    onClick={() => removeEditCollaboratorRow(index)}
                                                    style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #fecaca', background: '#fff1f2', color: '#be123c', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold', width: '100%', maxWidth: '120px', whiteSpace: 'nowrap' }}
                                                >
                                                    Remove
                                                </button>
                                            </div>

                                            {collab.shift_mode === 'current_time' && (
                                                <div style={{ display: 'flex', gap: '8px', alignItems: 'end', flexWrap: 'wrap' }}>
                                                    <div style={{ flex: '1 1 240px', minWidth: 0 }}>
                                                        <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '12px' }}>Shift Start</label>
                                                        <input
                                                            type="datetime-local"
                                                            value={collab.shift_start}
                                                            onChange={(e) => updateEditCollaboratorField(index, { shift_start: e.target.value })}
                                                            style={{ width: '100%', minWidth: 0, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', color: '#333', backgroundColor: 'white' }}
                                                        />
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => applyCurrentShiftToCollaboratorRow(index)}
                                                        style={{ padding: '8px 10px', borderRadius: '6px', border: '1px solid #cbd5e1', background: '#f8fafc', color: '#334155', cursor: 'pointer', fontSize: '12px', whiteSpace: 'nowrap' }}
                                                    >
                                                        Set current
                                                    </button>
                                                </div>
                                            )}

                                            {collab.shift_mode === 'range' && (
                                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px' }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '12px' }}>Shift Start</label>
                                                        <input
                                                            type="datetime-local"
                                                            value={collab.shift_start}
                                                            onChange={(e) => updateEditCollaboratorField(index, { shift_start: e.target.value })}
                                                            style={{ width: '100%', minWidth: 0, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', color: '#333', backgroundColor: 'white' }}
                                                        />
                                                    </div>
                                                    <div style={{ minWidth: 0 }}>
                                                        <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '12px' }}>Shift End</label>
                                                        <input
                                                            type="datetime-local"
                                                            value={collab.shift_end}
                                                            onChange={(e) => updateEditCollaboratorField(index, { shift_end: e.target.value })}
                                                            style={{ width: '100%', minWidth: 0, padding: '8px', borderRadius: '6px', border: '1px solid #cbd5e1', color: '#333', backgroundColor: 'white' }}
                                                        />
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center' }}>
                            <button
                                type="button"
                                onClick={closeEditTaskPanel}
                                style={{ 
                                    background: 'transparent', 
                                    border: 'none', 
                                    padding: 0, 
                                    cursor: 'pointer', 
                                    color: '#64748b',
                                    fontWeight: 600,
                                    fontSize: 14
                                }}
                            >
                                Cancel
                            </button>
                            <button
                                type="submit"
                                title="Update Task"
                                aria-label="Update Task"
                                style={{ 
                                    background: 'transparent', 
                                    border: 'none', 
                                    padding: 0, 
                                    cursor: 'pointer', 
                                    color: '#2563eb',
                                    fontWeight: 600,
                                    fontSize: 14
                                }}
                            >
                                Update
                            </button>
                        </div>
                    </form>
                </FloatingListPanel>
            )}

            {/* Archive Task Confirmation */}
            {showDeleteConfirm && taskToDelete && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '400px', maxWidth: '90%', textAlign: 'center' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>Archive Task?</h3>
                        <p style={{ margin: '0 0 20px 0', color: '#666' }}>
                            Are you sure you want to archive <strong>{taskToDelete.title}</strong>?
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
                            <button onClick={() => { setShowDeleteConfirm(false); setTaskToDelete(null); }}
                                style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', color: '#666' }}>Cancel</button>
                            <button onClick={handleDeleteTask}
                                title="Archive"
                                aria-label="Archive task"
                                style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CrudActionIcon action="archive" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Edit Project Modal */}
            {showEditProject && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1050, padding: 16 }}>
                    <div style={{ background: '#fff', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '92vh', overflowY: 'auto', border: '1px solid #e2e8f0', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                        {/* Blue header */}
                        <div style={{ background: 'linear-gradient(135deg, #1e3a8a 0%, #1d4ed8 100%)', padding: '20px 24px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                            <div>
                                <div style={{ fontSize: 10, fontWeight: 800, color: 'rgba(255,255,255,0.6)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Project Management</div>
                                <h2 style={{ margin: 0, fontSize: 17, fontWeight: 800, color: '#fff' }}>Edit Project</h2>
                            </div>
                            <button type="button" onClick={() => setShowEditProject(false)} style={{ background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.2)', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', color: '#fff', fontSize: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1, flexShrink: 0 }}>×</button>
                        </div>

                        {/* Body */}
                        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
                            {editProjectError && (
                                <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: 13 }}>
                                    {editProjectError}
                                </div>
                            )}

                            <form noValidate onSubmit={async (e) => {
                                e.preventDefault();
                                if (savingProject) return;
                                const projMissing: Record<string, string> = {};
                                if (!String(editProjectForm.client_id || '').trim()) projMissing.client_id = 'Required.';
                                if (!String(editProjectForm.manager_id || '').trim()) projMissing.manager_id = 'Required.';
                                if (!String(editProjectForm.name || '').trim()) projMissing.name = 'Required.';
                                if (!String(editProjectForm.end_date || '').trim()) projMissing.end_date = 'Required.';
                                if (Object.keys(projMissing).length > 0) { setEditProjectFieldErrors(projMissing); return; }
                                setEditProjectFieldErrors({});
                                if (editProjectForm.end_date) {
                                    const minMs = new Date().getTime() + 3 * 24 * 60 * 60 * 1000;
                                    if (new Date(editProjectForm.end_date).getTime() < minMs) {
                                        setEditProjectError('Due date must be at least 3 days from today.');
                                        return;
                                    }
                                }
                                setSavingProject(true);
                                setEditProjectError('');
                                try {
                                    const res = await fetch(`${API_BASE}/projects.php`, {
                                        method: 'PUT',
                                        headers: { 'Content-Type': 'application/json' },
                                        credentials: 'include',
                                        body: JSON.stringify({ ...editProjectForm, id: project.id }),
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                        setProject((prev: any) => ({ ...prev, ...editProjectForm }));
                                        setShowEditProject(false);
                                        void notifySuccess('Project updated successfully!');
                                    } else {
                                        setEditProjectError(data.message || 'Failed to update project');
                                    }
                                } catch {
                                    setEditProjectError('An error occurred');
                                } finally {
                                    setSavingProject(false);
                                }
                            }}>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Client</label>
                                        <select name="client_id" value={editProjectForm.client_id} onChange={(e) => { setEditProjectForm((p) => ({ ...p, client_id: e.target.value })); clearEditProjectFieldError('client_id'); }}
                                            required aria-required="true" aria-invalid={editProjectFieldErrors.client_id ? true : undefined}
                                            style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: editProjectFieldErrors.client_id ? '2px solid #ef4444' : '1px solid #cbd5e1', background: '#fff', color: '#1f2937', fontSize: 13 }}>
                                            <option value="">— Select Client —</option>
                                            {clients.map((c: any) => (
                                                <option key={c.client_id} value={c.client_id}>{c.client_name}</option>
                                            ))}
                                        </select>
                                        {editProjectFieldErrors.client_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editProjectFieldErrors.client_id}</div>}
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Manager</label>
                                        <select name="manager_id" value={editProjectForm.manager_id} onChange={(e) => { setEditProjectForm((p) => ({ ...p, manager_id: e.target.value })); clearEditProjectFieldError('manager_id'); }}
                                            required aria-required="true" aria-invalid={editProjectFieldErrors.manager_id ? true : undefined}
                                            style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: editProjectFieldErrors.manager_id ? '2px solid #ef4444' : '1px solid #cbd5e1', background: '#fff', color: '#1f2937', fontSize: 13 }}>
                                            <option value="">— Select Manager —</option>
                                            {managers.map((m: any) => (
                                                <option key={m.id} value={m.id}>{m.first_name || ''} {m.last_name || ''}{!m.first_name && !m.last_name ? m.full_name || m.username : ''}</option>
                                            ))}
                                        </select>
                                        {editProjectFieldErrors.manager_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editProjectFieldErrors.manager_id}</div>}
                                    </div>
                                </div>

                                <div style={{ marginBottom: 14 }}>
                                    <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Project Name</label>
                                    <input type="text" value={editProjectForm.name} onChange={(e) => { setEditProjectForm((p) => ({ ...p, name: e.target.value })); clearEditProjectFieldError('name'); }} required
                                        aria-required="true" aria-invalid={editProjectFieldErrors.name ? true : undefined}
                                        style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: editProjectFieldErrors.name ? '2px solid #ef4444' : '1px solid #cbd5e1', color: '#0f172a', background: '#fff', fontSize: 13 }} />
                                    {editProjectFieldErrors.name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editProjectFieldErrors.name}</div>}
                                </div>

                                <div style={{ marginBottom: 14 }}>
                                    <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Description</label>
                                    <textarea value={editProjectForm.description} onChange={(e) => setEditProjectForm((p) => ({ ...p, description: e.target.value }))}
                                        style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #cbd5e1', minHeight: 80, color: '#0f172a', background: '#fff', fontSize: 13, resize: 'vertical', fontFamily: 'inherit' }} />
                                </div>

                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Start Date</label>
                                        <input type="datetime-local" value={editProjectForm.start_date} onChange={(e) => setEditProjectForm((p) => ({ ...p, start_date: e.target.value }))}
                                            style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #cbd5e1', color: '#1f2937', background: '#fff', fontSize: 13 }} />
                                    </div>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Due Date</label>
                                        <input type="datetime-local" value={editProjectForm.end_date} onChange={(e) => { setEditProjectForm((p) => ({ ...p, end_date: e.target.value })); clearEditProjectFieldError('end_date'); }}
                                            min={minProjectDeadline()}
                                            required aria-required="true" aria-invalid={editProjectFieldErrors.end_date ? true : undefined}
                                            style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: editProjectFieldErrors.end_date ? '2px solid #ef4444' : '1px solid #cbd5e1', color: '#1f2937', background: '#fff', fontSize: 13 }} />
                                        {editProjectFieldErrors.end_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{editProjectFieldErrors.end_date}</div>}
                                        <div style={{ marginTop: 5, fontSize: 11, color: '#64748b' }}>Must be at least 3 days from today.</div>
                                    </div>
                                </div>

                                <div style={{ marginBottom: 22 }}>
                                    <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 12, fontWeight: 700 }}>Status</label>
                                    <select value={editProjectForm.status} onChange={(e) => setEditProjectForm((p) => ({ ...p, status: e.target.value }))}
                                        style={{ width: '100%', padding: '9px 10px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff', color: '#1f2937', fontSize: 13 }}>
                                        <option value="active">Active</option>
                                        <option value="pending">Pending</option>
                                        <option value="completed">Completed</option>
                                        <option value="on_hold">On Hold</option>
                                        <option value="archived">Archived</option>
                                    </select>
                                </div>

                                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
                                    <button type="button" onClick={() => setShowEditProject(false)}
                                        style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #e2e8f0', background: '#fff', color: '#475569', cursor: 'pointer', fontWeight: 600, fontSize: 13 }}>
                                        Cancel
                                    </button>
                                    <button type="submit" disabled={savingProject}
                                        style={{ padding: '9px 22px', borderRadius: 8, border: 'none', background: savingProject ? '#93c5fd' : '#1d4ed8', color: '#fff', cursor: savingProject ? 'not-allowed' : 'pointer', fontWeight: 700, fontSize: 13 }}>
                                        {savingProject ? 'Saving…' : 'Save Changes'}
                                    </button>
                                </div>
                            </form>
                        </div>
                    </div>
                </div>
            )}

        </Layout>
    );
}

function MiniStatCard({
    label,
    value,
    detail,
    color,
}: {
    label: string;
    value: string | number;
    detail: string;
    color: string;
}) {
    return (
        <div style={{
            background: '#fff',
            border: '1px solid #e2e8f0',
            borderRadius: '10px',
            padding: '12px 16px',
            minWidth: '150px',
            flex: '1 1 0',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        }}>
            <div style={{ fontSize: '11px', color: '#64748b', fontWeight: 600, marginBottom: '4px' }}>{label}</div>
            <div style={{ fontSize: '22px', fontWeight: 800, color: color, lineHeight: 1.2 }}>{value}</div>
            <div style={{ fontSize: '11px', color: '#94a3b8', marginTop: '2px' }}>{detail}</div>
        </div>
    );
}
