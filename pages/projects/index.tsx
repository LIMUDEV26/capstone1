import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { useProtectedPage } from '@/components/AuthProvider';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import EditedBadge from '../../components/EditedBadge';
import PhoneInput from '@/components/PhoneInput';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { useEditedIndicator } from '../../components/useEditedIndicator';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import {
    DEFAULT_PHONE_COUNTRY_CODE,
    normalizeInternationalPhoneNumber,
    isPhoneDraftEmpty,
} from '@/utils/phone';

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

function toDateTimeLocalValue(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return '';
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function normalizeChecklistId(value: unknown) {
    const checklistId = Number(value);
    return Number.isInteger(checklistId) && checklistId > 0 ? checklistId : 0;
}

/** Due-date rule: at least 7 days out. The grace absorbs the ms race between auto-pick and validation. */
const DUE_DATE_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
const DUE_DATE_GRACE_MS = 10 * 60 * 1000;

/** Returns the datetime-local value for project due dates: today + 7 days (+ small buffer so it always passes validation) */
function defaultProjectDeadline() {
    const d = new Date(Date.now() + DUE_DATE_LEAD_MS + DUE_DATE_GRACE_MS);
    d.setSeconds(0, 0);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

/** True when the picked due date satisfies the 7-day rule (with grace for clock/rounding drift). */
function isDueDateValid(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) return false;
    return t + DUE_DATE_GRACE_MS >= Date.now() + DUE_DATE_LEAD_MS;
}

function formatDateTime(value: unknown) {
    const raw = String(value || '').trim();
    if (!raw) return '-';
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

function projectDisplayStatus(project: any) {
    const taskCount = Number(project?.task_count || 0);
    const completedTaskCount = Number(project?.completed_task_count || 0);
    if (taskCount > 0 && taskCount === completedTaskCount) return 'done';
    return String(project?.status || 'active').trim().toLowerCase();
}

function displayTimestamp(value: unknown) {
    const time = value ? new Date(String(value)).getTime() : 0;
    return Number.isFinite(time) ? time : 0;
}

function sortProjectsForDisplay(left: any, right: any, pinnedProjectIds: number[] = []) {
    const leftPinned = pinnedProjectIds.includes(Number(left?.id || 0)) ? 1 : 0;
    const rightPinned = pinnedProjectIds.includes(Number(right?.id || 0)) ? 1 : 0;
    if (leftPinned !== rightPinned) return rightPinned - leftPinned;

    const leftDone = ['done', 'completed', 'archived'].includes(projectDisplayStatus(left)) ? 1 : 0;
    const rightDone = ['done', 'completed', 'archived'].includes(projectDisplayStatus(right)) ? 1 : 0;
    if (leftDone !== rightDone) return leftDone - rightDone;

    const leftCreated = displayTimestamp(left?.created_at);
    const rightCreated = displayTimestamp(right?.created_at);
    if (leftCreated !== rightCreated) return rightCreated - leftCreated;

    return Number(right?.id || 0) - Number(left?.id || 0);
}

export default function Projects() {
    const router = useRouter();
    const { user, loading: authLoading, logout } = useProtectedPage();
    const API_BASE = getApiBaseUrl();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [projects, setProjects] = useState<any[]>([]);
    const { editedItems, markEdited } = useEditedIndicator();
    const [clients, setClients] = useState<any[]>([]);
    const [managers, setManagers] = useState<any[]>([]);
    const [allServices, setAllServices] = useState<any[]>([]);
    const [clientServices, setClientServices] = useState<any[]>([]); // Filtered for selected client
    const [selectedTasks, setSelectedTasks] = useState<number[]>([]); // Custom selection
    const [scopeServiceId, setScopeServiceId] = useState(''); // Service chosen first; its checklist shows below
    const [scopeListOpen, setScopeListOpen] = useState(false); // Checklist dropdown open
    const [addedScopeIds, setAddedScopeIds] = useState<string[]>([]); // Services added to project scope via +
    const [activeScopeId, setActiveScopeId] = useState(''); // Currently opened scope pill
    const [openScopeIds, setOpenScopeIds] = useState<string[]>([]); // Which service scope panels are unfolded (per service)
    const [loading, setLoading] = useState(true);
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [projectSearch, setProjectSearch] = useState('');
    const [projectStatusFilter, setProjectStatusFilter] = useState('all');
    const [deadlineFilter, setDeadlineFilter] = useState('all');
    const [managerFilter, setManagerFilter] = useState('all');
    const [clientFilter, setClientFilter] = useState('all');
    const [pinnedProjectIds, setPinnedProjectIds] = useState<number[]>([]);
    const [personalTaskSummaryByProject, setPersonalTaskSummaryByProject] = useState<Record<number, { total: number; completed: number; overdue: number }>>({});

    // Add Task Form State
    const [showAddTask, setShowAddTask] = useState(false);
    const [newTaskServiceId, setNewTaskServiceId] = useState('');
    const [newTaskName, setNewTaskName] = useState('');

    // Modals
    const [showModal, setShowModal] = useState(false);
    const [editingProject, setEditingProject] = useState<any>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [projectToDelete, setProjectToDelete] = useState<any>(null);
    const [activeDropdown, setActiveDropdown] = useState<number | null>(null);
    const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null);
    const dropdownMenuRef = useRef<HTMLDivElement | null>(null);
    const actionButtonRefs = useRef<Record<number, HTMLButtonElement | null>>({});
    const [startModal, setStartModal] = useState<{ project: any; managerId: string; contractSigned: boolean } | null>(null);
    const [isStarting, setIsStarting] = useState(false);

    // Client choice / inline new-client sub-modal state
    const [showClientChoice, setShowClientChoice] = useState(false);
    const [showNewClientSubModal, setShowNewClientSubModal] = useState(false);
    const [newClientFormData, setNewClientFormData] = useState({
        client_name: '',
        contact_first_name: '',
        contact_last_name: '',
        company_email: '',
        company_phone: DEFAULT_PHONE_COUNTRY_CODE,
        email: '',
        phone: DEFAULT_PHONE_COUNTRY_CODE,
        address: '',
        service_ids: [] as number[],
    });
    // Per-service selected checklist IDs for the New Client form
    const [newClientServiceChecklist, setNewClientServiceChecklist] = useState<Record<number, number[]>>({});
    const [newClientAvailableServices, setNewClientAvailableServices] = useState<any[]>([]);
    const [isCreatingClient, setIsCreatingClient] = useState(false);
    const [newClientError, setNewClientError] = useState('');

    // Form Data
    const [formData, setFormData] = useState({
        name: '',
        description: '',
        client_id: '',
        manager_id: '',
        status: 'active',
        start_date: '',
        end_date: defaultProjectDeadline()
    });
    // ── New Project wizard steps (mirrors Add Client modal): 0=Basic, 1=Services, 2=Review
    const [projectStep, setProjectStep] = useState(0);
    const [projectStepError, setProjectStepError] = useState('');

    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    const viewerRole = String(user?.role || '').trim().toLowerCase();
    const isAdmin = viewerRole === 'admin';
    const isCurrentManager = viewerRole === 'manager';
    const canPinProjects = isAdmin || isCurrentManager;
    const pinnedProjectsStorageKey = user?.id ? `capstone_project_pins_${user.id}` : '';
    const canManageProject = (project: any) => {
        if (isAdmin) return true;
        if (!isCurrentManager) return false;
        return String(project?.manager_id || '') === String(user?.id || '');
    };

    const getClientById = (clientId: string) => {
        return clients.find((client) => String(client.client_id) === String(clientId));
    };

    const getApplicableServicesForClient = (clientId: string, servicesSource = allServices) => {
        const client = getClientById(clientId);
        if (!client || !Array.isArray(client.services) || client.services.length === 0) {
            return [];
        }

        const clientAssignments = new Map<number, any>(
            client.services.map((service: any) => [Number(service.service_id), service])
        );
        return servicesSource
            .filter((service: any) => clientAssignments.has(Number(service.service_id)))
            .map((service: any) => ({
                ...service,
                selected_checklist_ids: clientAssignments.get(Number(service.service_id))?.selected_checklist_ids ?? null,
            }));
    };

    const buildGeneratedProjectName = (clientId: string, _servicesSource = allServices) => {
        const client = getClientById(clientId);
        if (!client) return '';
        const clientName = String(client.client_name || '').trim();
        const applicable = getApplicableServicesForClient(clientId, _servicesSource);
        const serviceNames = applicable
            .map((service: any) => String(service?.service_name || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()));
        if (serviceNames.length === 0) return clientName;
        if (!clientName) return serviceNames.join(' / ');
        return `${clientName} - ${serviceNames.join(' / ')}`;
    };
    // Tracks whether the user manually edited the auto-generated project name.
    // While false, changing the client refreshes the suggestion; once true, manual edits are preserved.
    const [isProjectNameEdited, setIsProjectNameEdited] = useState(false);

    // Live-sync: silently refresh projects in background.
    const silentRefreshProjects = useCallback(async () => {
        if (!user?.id) return;
        await Promise.all([fetchProjects(), fetchClients(), fetchManagers(), fetchPersonalTaskSummary()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [user?.id]);

    useLiveSync(silentRefreshProjects);

    // Route data should load only after the shared auth state is ready.
    /* eslint-disable react-hooks/exhaustive-deps */
    useEffect(() => {
        if (!user?.id) {
            if (!authLoading) {
                setLoading(false);
            }
            return;
        }

        let active = true;

        const loadProjectsPage = async () => {
            setLoading(true);
            try {
                await Promise.all([fetchProjects(), fetchClients(), fetchManagers(), fetchServices(), fetchPersonalTaskSummary()]);
            } finally {
                if (active) {
                    setLoading(false);
                }
            }
        };

        void loadProjectsPage();

        return () => {
            active = false;
        };
    }, [authLoading, user?.id]);
    /* eslint-enable react-hooks/exhaustive-deps */

    // Close dropdown on outside click/escape/viewport changes.
    useEffect(() => {
        const closeDropdown = () => {
            setActiveDropdown(null);
            setDropdownPosition(null);
        };

        const handleDocumentMouseDown = (event: MouseEvent) => {
            const target = event.target as Node | null;
            if (!target) return;

            if (dropdownMenuRef.current?.contains(target)) return;

            const clickedToggle = Object.values(actionButtonRefs.current).some((buttonEl) => {
                return buttonEl?.contains(target) ?? false;
            });
            if (clickedToggle) return;

            closeDropdown();
        };

        const handleEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                closeDropdown();
            }
        };

        document.addEventListener('mousedown', handleDocumentMouseDown);
        document.addEventListener('keydown', handleEscape);
        window.addEventListener('resize', closeDropdown);
        window.addEventListener('scroll', closeDropdown, true);

        return () => {
            document.removeEventListener('mousedown', handleDocumentMouseDown);
            document.removeEventListener('keydown', handleEscape);
            window.removeEventListener('resize', closeDropdown);
            window.removeEventListener('scroll', closeDropdown, true);
        };
    }, []);

    useEffect(() => {
        if (!error) return;
        void notifyError(error);
        setError('');
    }, [error]);

    useEffect(() => {
        if (!success) return;
        void notifySuccess(success);
        setSuccess('');
    }, [success]);

    useEffect(() => {
        if (!pinnedProjectsStorageKey || !canPinProjects || typeof window === 'undefined') {
            setPinnedProjectIds([]);
            return;
        }

        try {
            const parsed = JSON.parse(window.localStorage.getItem(pinnedProjectsStorageKey) || '[]');
            setPinnedProjectIds(Array.isArray(parsed) ? parsed.map((id) => Number(id)).filter((id) => id > 0) : []);
        } catch {
            setPinnedProjectIds([]);
        }
    }, [canPinProjects, pinnedProjectsStorageKey]);

    const fetchProjects = async () => {
        try {
            const res = await fetch(`${API_BASE}/projects.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setProjects(data.data);
        } catch (err) { console.error('Failed to fetch projects'); }
    };

    const fetchClients = async () => {
        try {
            const res = await fetch(`${API_BASE}/clients.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setClients(data.data);
        } catch (err) { console.error('Failed to fetch clients'); }
    };

    const fetchServices = async () => {
        try {
            const res = await fetch(`${API_BASE}/services.php?checklists=1`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setAllServices(data.data);
        } catch (err) { console.error('Failed to fetch services'); }
    };

    const fetchManagers = async () => {
        try {
            // Fetch users with manager role for the dropdown
            const res = await fetch(`${API_BASE}/users.php?role=manager`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setManagers(data.data);
        } catch (err) { console.error('Failed to fetch managers'); }
    };

    const fetchPersonalTaskSummary = async () => {
        const userId = Number(user?.id || 0);
        if (userId <= 0) {
            setPersonalTaskSummaryByProject({});
            return;
        }

        try {
            const res = await fetch(`${API_BASE}/tasks.php?assigned_to=${userId}&include_collaborations=1`, { credentials: 'include' });
            const data = await res.json();
            if (!data.success || !Array.isArray(data.data)) {
                setPersonalTaskSummaryByProject({});
                return;
            }

            const todayKey = formatDateKey(new Date());
            const summary = data.data.reduce((acc: Record<number, { total: number; completed: number; overdue: number }>, task: any) => {
                const projectId = Number(task?.project_id || 0);
                if (projectId <= 0) return acc;

                if (!acc[projectId]) {
                    acc[projectId] = { total: 0, completed: 0, overdue: 0 };
                }

                acc[projectId].total += 1;
                if (String(task?.status || '') === 'completed') {
                    acc[projectId].completed += 1;
                }

                const dueKey = normalizeDateKey(task?.due_date);
                const normalizedStatus = String(task?.status || '').trim().toLowerCase();
                if (dueKey && normalizedStatus !== 'completed' && normalizedStatus !== 'cancelled' && dueKey < todayKey) {
                    acc[projectId].overdue += 1;
                }

                return acc;
            }, {});

            setPersonalTaskSummaryByProject(summary);
        } catch (err) {
            console.error('Failed to fetch personal project task summary');
            setPersonalTaskSummaryByProject({});
        }
    };

    const togglePinProject = (project: any) => {
        if (!canPinProjects) return;

        const projectId = Number(project?.id || 0);
        if (projectId <= 0) return;

        const isAlreadyPinned = pinnedProjectIds.includes(projectId);
        const nextPinnedIds = isAlreadyPinned
            ? pinnedProjectIds.filter((id) => id !== projectId)
            : [projectId, ...pinnedProjectIds.filter((id) => id !== projectId)];

        setPinnedProjectIds(nextPinnedIds);
        if (pinnedProjectsStorageKey && typeof window !== 'undefined') {
            window.localStorage.setItem(pinnedProjectsStorageKey, JSON.stringify(nextPinnedIds));
        }
        setSuccess(isAlreadyPinned ? 'Project unpinned.' : 'Project pinned to the top.');
        setActiveDropdown(null);
    };

    const handleInputChange = (e: any) => {
        const { name, value } = e.target;
        const nextFormData = { ...formData, [name]: value };

        if (name === 'name' && !editingProject) {
            // Any manual typing marks the name as user-edited so client
            // changes no longer overwrite it. Clearing the field re-arms
            // the auto-generation.
            const generated = buildGeneratedProjectName(nextFormData.client_id);
            setIsProjectNameEdited(String(value || '').trim() !== '' && String(value) !== generated);
        }

        if (name === 'client_id') {
            updateClientServices(value);
            if (!editingProject && !isProjectNameEdited) {
                nextFormData.name = buildGeneratedProjectName(value);
            }
        }

        setFormData(nextFormData);
    };

    const applyClientServicesToProjectScope = (applicableServices: any[]) => {
        const serviceIds = applicableServices
            .map((service: any) => String(service.service_id || '').trim())
            .filter(Boolean);
        const checklistIds = applicableServices.flatMap((service: any) => {
            const availableIds = (Array.isArray(service.checklists) ? service.checklists : [])
                .map((item: any) => normalizeChecklistId(item.checklist_id))
                .filter(Boolean);
            const explicitlySelectedIds = (Array.isArray(service.selected_checklist_ids) ? service.selected_checklist_ids : [])
                .map((id: unknown) => normalizeChecklistId(id))
                .filter((id: number) => id > 0 && availableIds.includes(id));

            // Older client assignments did not store selected checklist IDs;
            // those assignments historically mean every active checklist task.
            return explicitlySelectedIds.length > 0 ? explicitlySelectedIds : availableIds;
        });

        setClientServices(applicableServices);
        setSelectedTasks(Array.from(new Set(checklistIds)));
        setScopeServiceId('');
        setScopeListOpen(false);
        setAddedScopeIds(serviceIds);
        setActiveScopeId(serviceIds[0] || '');
        setOpenScopeIds([]);
    };

    const updateClientServices = (clientId: string) => {
        if (!clientId) {
            setClientServices([]);
            setSelectedTasks([]);
            setScopeServiceId('');
            setScopeListOpen(false);
            setAddedScopeIds([]);
            setActiveScopeId('');
            return;
        }

        const applicableServices = getApplicableServicesForClient(clientId);
        applyClientServicesToProjectScope(applicableServices);
    };

    // ── Project Scope: + beside service dropdown adds a service to the scope.
    // Once added, the service is hidden from the dropdown choices. Removing it
    // from the scope returns it to the choices and unchecks its tasks.
    const addScopeService = () => {
        const id = String(scopeServiceId || '').trim();
        if (!id) return;
        if (addedScopeIds.includes(id)) {
            setActiveScopeId(id);
            setScopeListOpen(true);
            setOpenScopeIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
            return;
        }
        const stillAvailable = clientServices.some((s: any) => String(s.service_id) === id);
        if (!stillAvailable) return;
        setAddedScopeIds((prev) => [...prev, id]);
        setActiveScopeId(id);
        setScopeListOpen(true);
        setOpenScopeIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
        setScopeServiceId('');
    };

    const removeScopeService = (id: string) => {
        const key = String(id);
        setAddedScopeIds((prev) => prev.filter((item) => item !== key));
        const svc = clientServices.find((s: any) => String(s.service_id) === key);
        const checklistIds: number[] = Array.isArray(svc?.checklists)
            ? svc.checklists.map((cl: any) => Number(cl.checklist_id)).filter((n: number) => Number.isFinite(n))
            : [];
        if (checklistIds.length > 0) {
            setSelectedTasks((prev) => prev.filter((taskId) => !checklistIds.includes(Number(taskId))));
        }
        setActiveScopeId((prev) => (prev === key ? '' : prev));
        setScopeListOpen((prev) => (activeScopeId === key ? false : prev));
        setOpenScopeIds((prev) => prev.filter((item) => item !== key));
    };

    const toggleScopeOpen = (id: string) => {
        const key = String(id);
        setOpenScopeIds((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
    };

    // ── Floating checklist dropdowns (Step 2): panels render in a portal on
    // document.body with position:fixed, so opening one never resizes the modal.
    const scopeAnchorRefs = useRef<Record<string, HTMLElement | null>>({});
    const [scopeDropPos, setScopeDropPos] = useState<Record<string, { left: number; width: number; bottom: number; maxH: number }>>({});
    const scopeDropPosKey = useRef('');

    const updateScopeDropPos = useCallback(() => {
        if (typeof window === 'undefined') return;
        const next: Record<string, { left: number; width: number; bottom: number; maxH: number }> = {};
        openScopeIds.forEach((id) => {
            const el = scopeAnchorRefs.current[id];
            if (!el) return;
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return;
            // Dropup: anchor the panel's bottom just above the header, so it
            // always opens upward and never pushes content below.
            const width = Math.min(Math.max(r.width, 280), window.innerWidth - 16);
            const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
            const bottom = Math.max(8, window.innerHeight - r.top + 6);
            const maxH = Math.max(160, Math.min(330, r.top - 16));
            next[id] = { left: Math.round(left), width: Math.round(width), bottom: Math.round(bottom), maxH: Math.round(maxH) };
        });
        const key = JSON.stringify(next);
        if (key !== scopeDropPosKey.current) {
            scopeDropPosKey.current = key;
            setScopeDropPos(next);
        }
    }, [openScopeIds]);

    useEffect(() => {
        if (!showModal || editingProject || projectStep !== 1 || openScopeIds.length === 0) return;
        updateScopeDropPos();
        const t = window.setTimeout(updateScopeDropPos, 50);
        const onDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.closest('[data-scope-drop]') || target.closest('[data-scope-anchor]'))) return;
            setOpenScopeIds([]);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenScopeIds([]); };
        let raf = 0;
        const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateScopeDropPos); };
        window.addEventListener('mousedown', onDown);
        window.addEventListener('keydown', onKey);
        window.addEventListener('scroll', onMove, true);
        window.addEventListener('resize', onMove);
        return () => {
            window.clearTimeout(t);
            cancelAnimationFrame(raf);
            window.removeEventListener('mousedown', onDown);
            window.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', onMove, true);
            window.removeEventListener('resize', onMove);
        };
    }, [showModal, editingProject, projectStep, openScopeIds, addedScopeIds, clientServices, updateScopeDropPos]);

    const handleTaskToggle = (checklistIdValue: unknown) => {
        const checklistId = normalizeChecklistId(checklistIdValue);
        if (!checklistId) return;
        setSelectedTasks(prev =>
            prev.includes(checklistId)
                ? prev.filter(id => id !== checklistId)
                : [...prev, checklistId]
        );
    };

    const handleAddTask = async () => {
        const taskName = newTaskName.trim();
        const targetServiceId = String(newTaskServiceId || '').trim();
        if (!targetServiceId || !taskName) return;

        try {
            const res = await fetch(`${API_BASE}/services.php?type=checklist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    service_id: targetServiceId,
                    task_name: taskName,
                    is_required: 1
                })
            });
            const data = await res.json();

            if (data.success) {
                const createdChecklistId = normalizeChecklistId(data.data?.checklist_id);
                const createdChecklist = createdChecklistId ? {
                    checklist_id: createdChecklistId,
                    service_id: Number(targetServiceId),
                    task_name: taskName,
                    description: '',
                    is_required: 1,
                } : null;
                const addCreatedChecklist = (services: any[]) => services.map((service: any) => {
                    if (!createdChecklist || String(service.service_id) !== targetServiceId) return service;
                    const checklists = Array.isArray(service.checklists) ? service.checklists : [];
                    if (checklists.some((item: any) => normalizeChecklistId(item.checklist_id) === createdChecklistId)) {
                        return service;
                    }
                    return { ...service, checklists: [...checklists, createdChecklist] };
                });

                // Show a successfully created task immediately, even while the
                // refreshed service list is still on its way back from the API.
                if (createdChecklist) {
                    setAllServices(addCreatedChecklist);
                    setClientServices(addCreatedChecklist);
                    setSelectedTasks(prev => Array.from(new Set([...prev, createdChecklistId])));
                }

                // A task created for a service must have a visible home in Step 2.
                setAddedScopeIds(prev => prev.includes(targetServiceId) ? prev : [...prev, targetServiceId]);
                setActiveScopeId(targetServiceId);
                setOpenScopeIds(prev => prev.includes(targetServiceId) ? prev : [...prev, targetServiceId]);

                // 1. Refresh global services
                const servicesRes = await fetch(`${API_BASE}/services.php?checklists=1`, { credentials: 'include' });
                const servicesData = await servicesRes.json();

                if (servicesData.success) {
                    const updatedServices = Array.isArray(servicesData.data) ? servicesData.data : [];
                    const refreshedServices = addCreatedChecklist(updatedServices);
                    setAllServices(refreshedServices);

                    // 2. Re-filter client services to show the new task
                    // Need to replicate updateClientServices logic but with new data
                    if (formData.client_id) {
                        const applicableServices = getApplicableServicesForClient(formData.client_id, refreshedServices);
                        setClientServices(applicableServices);
                    }

                }

                // Keep the selected service for continuous entry, but clear the name.
                setNewTaskName('');
            } else {
                alert(data.message || 'Failed to add task');
            }
        } catch (err) {
            console.error(err);
            alert('An error occurred');
        }
    };

    const fetchNewClientAvailableServices = async () => {
        try {
            const res = await fetch(`${API_BASE}/services.php?checklists=1`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                const active = (Array.isArray(data.data) ? data.data : []).filter((s: any) => {
                    const desc = String(s.description ?? '').trim().toUpperCase();
                    return !desc.startsWith('[ARCHIVED]');
                });
                setNewClientAvailableServices(active);
            }
        } catch { console.error('Failed to fetch services for new client'); }
    };

    const openClientChoiceDialog = () => {
        setShowClientChoice(true);
    };

    const openNewClientSubModal = () => {
        setShowClientChoice(false);
        setNewClientFormData({
            client_name: '',
            contact_first_name: '',
            contact_last_name: '',
            company_email: '',
            company_phone: DEFAULT_PHONE_COUNTRY_CODE,
            email: '',
            phone: DEFAULT_PHONE_COUNTRY_CODE,
            address: '',
            service_ids: [],
        });
        setNewClientServiceChecklist({});
        setNewClientError('');
        void fetchNewClientAvailableServices();
        setShowNewClientSubModal(true);
    };

    const handleNewClientInputChange = (e: any) => {
        const { name, value } = e.target;
        setNewClientFormData((prev) => ({
            ...prev,
            [name]: value,
        }));
    };

    const handleNewClientServiceToggle = (serviceId: number, checked: boolean) => {
        setNewClientFormData((prev) => ({
            ...prev,
            service_ids: checked
                ? Array.from(new Set([...prev.service_ids.map(Number), serviceId]))
                : prev.service_ids.map(Number).filter((id) => id !== serviceId),
        }));

        if (checked) {
            // Start with empty selection — user picks checklist items manually
            setNewClientServiceChecklist((prev) => ({ ...prev, [serviceId]: [] }));
        } else {
            // Remove checklist selections for deselected service
            setNewClientServiceChecklist((prev) => {
                const next = { ...prev };
                delete next[serviceId];
                return next;
            });
        }
    };

    const handleNewClientChecklistToggle = (serviceId: number, checklistId: number, checked: boolean) => {
        setNewClientServiceChecklist((prev) => {
            const current = prev[serviceId] ?? [];
            return {
                ...prev,
                [serviceId]: checked
                    ? Array.from(new Set([...current, checklistId]))
                    : current.filter((id) => id !== checklistId),
            };
        });
    };

    const handleCreateNewClientInline = async () => {
        setNewClientError('');

        if (!newClientFormData.client_name.trim()) {
            setNewClientError('Company name is required.');
            return;
        }
        if (newClientFormData.service_ids.length === 0) {
            setNewClientError('Please select at least one service.');
            return;
        }

        const normalizedPhone = normalizeInternationalPhoneNumber(newClientFormData.phone, DEFAULT_PHONE_COUNTRY_CODE);
        if (!isPhoneDraftEmpty(newClientFormData.phone, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedPhone) {
            setNewClientError('Contact person phone must be a valid international number, e.g. +63985 323 4710.');
            return;
        }
        const normalizedCompanyPhone = normalizeInternationalPhoneNumber(newClientFormData.company_phone, DEFAULT_PHONE_COUNTRY_CODE);
        if (!isPhoneDraftEmpty(newClientFormData.company_phone, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedCompanyPhone) {
            setNewClientError('Company phone must be a valid international number, e.g. +63985 323 4710.');
            return;
        }

        setIsCreatingClient(true);
        try {
            const contact_person = `${newClientFormData.contact_first_name} ${newClientFormData.contact_last_name}`.trim();
            const service_assignments = newClientFormData.service_ids.map((id) => ({
                service_id: id,
                selected_checklist_ids: newClientServiceChecklist[Number(id)] ?? [],
            }));
            const res = await fetch(`${API_BASE}/clients.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    client_name: newClientFormData.client_name,
                    contact_first_name: newClientFormData.contact_first_name,
                    contact_last_name: newClientFormData.contact_last_name,
                    contact_person,
                    company_email: newClientFormData.company_email,
                    company_phone: normalizedCompanyPhone || '',
                    email: newClientFormData.email,
                    phone: normalizedPhone || '',
                    address: newClientFormData.address,
                    service_ids: newClientFormData.service_ids,
                    service_assignments,
                }),
            });
            // Read as text first: a non-JSON reply (e.g. a 500 HTML page)
            // would otherwise throw inside res.json() and hide the real cause.
            const rawNewClientBody = await res.text();
            let data: any = null;
            if (rawNewClientBody) {
                try {
                    data = JSON.parse(rawNewClientBody);
                } catch {
                    throw new Error(`Server returned ${res.status}: ${rawNewClientBody.slice(0, 200)}`);
                }
            }
            if (!data) {
                throw new Error(`Server returned ${res.status} with an empty response.`);
            }
            if (data.success) {
                const newClientId = Number(data?.data?.client_id || 0);
                // Refresh client list so the new client appears in the dropdown
                await fetchClients();
                // Auto-select the new client in the project form
                if (newClientId > 0) {
                    const newClientIdStr = String(newClientId);
                    const generatedForNewClient = (() => {
                        const clientName = String(newClientFormData.client_name || '').trim();
                        const names = newClientAvailableServices
                            .filter((s: any) => newClientFormData.service_ids.map(Number).includes(Number(s.service_id)))
                            .map((s: any) => String(s?.service_name || '').replace(/\s+/g, ' ').trim())
                            .filter(Boolean)
                            .sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()));
                        if (names.length === 0) return clientName;
                        if (!clientName) return names.join(' / ');
                        return `${clientName} - ${names.join(' / ')}`;
                    })();
                    setFormData((prev) => ({
                        ...prev,
                        client_id: newClientIdStr,
                        ...(isProjectNameEdited ? {} : { name: generatedForNewClient }),
                    }));
                    const createdClientServices = newClientAvailableServices
                        .filter((service: any) => newClientFormData.service_ids.map(Number).includes(Number(service.service_id)))
                        .map((service: any) => ({
                            ...service,
                            selected_checklist_ids: newClientServiceChecklist[Number(service.service_id)] ?? [],
                        }));
                    applyClientServicesToProjectScope(createdClientServices);
                }
                setShowNewClientSubModal(false);
                void notifySuccess(`Client "${newClientFormData.client_name}" created and selected.`);
            } else {
                setNewClientError(data.message || 'Failed to create client.');
            }
        } catch (newClientErr) {
            console.error(newClientErr);
            setNewClientError(newClientErr instanceof Error && newClientErr.message ? newClientErr.message : 'An error occurred while creating the client.');
        } finally {
            setIsCreatingClient(false);
        }
    };

    const resetForm = () => {
        setFormData({
            name: '',
            description: '',
            client_id: '',
            manager_id: isCurrentManager ? String(user?.id || '') : '',
            status: 'active',
            start_date: '',
            end_date: defaultProjectDeadline()
        });
        setEditingProject(null);
        setClientServices([]);
        setSelectedTasks([]);
        setScopeServiceId('');
        setActiveScopeId('');
        setAddedScopeIds([]);
        setScopeListOpen(false);
        setOpenScopeIds([]);
        setIsProjectNameEdited(false);
        setError('');
        setSuccess('');
    };

    const openAddModal = () => {
        resetForm();
        setProjectStep(0);
        setProjectStepError('');
        setShowModal(true);
    };

    const openEditModal = (p: any) => {
        setEditingProject(p);
        setFormData({
            name: p.name || '',
            description: p.description || '',
            client_id: p.client_id ? String(p.client_id) : '',
            manager_id: p.manager_id ? String(p.manager_id) : '',
            status: p.status || 'active',
            start_date: toDateTimeLocalValue(p.start_date),
            end_date: toDateTimeLocalValue(p.end_date)
        });
        setIsProjectNameEdited(false);
        setError('');
        setSuccess('');
        setProjectStepError('');
        setShowModal(true);
        setActiveDropdown(null);
        setDropdownPosition(null);
    };

    // ── Wizard navigation (Add mode only; Edit keeps the single-page form)
    const goToProjectStep = (step: number) => {
        if (editingProject) return;
        const next = Math.max(0, Math.min(2, step));
        setProjectStepError('');
        setProjectStep(next);
    };

    const canProceedFromBasicStep = () => {
        if (!formData.client_id) {
            setProjectStepError('Please select a client to continue.');
            return false;
        }
        if (!formData.manager_id && !isCurrentManager) {
            setProjectStepError('Please choose a manager to continue.');
            return false;
        }
        if (!String(formData.name || '').trim()) {
            setProjectStepError('Please enter a project name to continue.');
            return false;
        }
        // Auto-pick: never trap the user on an empty due date — fill it and validate the effective value.
        const effectiveEndDate = formData.end_date || defaultProjectDeadline();
        if (!formData.end_date) {
            setFormData((prev) => ({ ...prev, end_date: prev.end_date || defaultProjectDeadline() }));
        }
        if (!isDueDateValid(effectiveEndDate)) {
            setProjectStepError('Due date must be at least 7 days from today.');
            return false;
        }
        setProjectStepError('');
        return true;
    };

    const canProceedFromServicesStep = () => {
        if (clientServices.length === 0) {
            // Nothing to configure for this client — do not trap the user on this step.
            setProjectStepError('');
            return true;
        }
        if (addedScopeIds.length === 0) {
            setProjectStepError('Add at least one service with + to continue.');
            return false;
        }
        if (selectedTasks.length === 0) {
            setProjectStepError('Tick at least one checklist item to continue.');
            return false;
        }
        setProjectStepError('');
        return true;
    };

    useEffect(() => {
        if (editingProject || !formData.client_id || isProjectNameEdited) return;
        setFormData((prev) => ({
            ...prev,
            name: buildGeneratedProjectName(prev.client_id),
        }));
    }, [allServices, clients, editingProject, formData.client_id, isProjectNameEdited]);

    const handleSubmit = async (e: any) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        // Enter-key inside wizard fields should advance steps, not submit early.
        if (!editingProject && projectStep < 2) {
            if (projectStep === 0 && canProceedFromBasicStep()) { goToProjectStep(1); }
            else if (projectStep === 1 && canProceedFromServicesStep()) { goToProjectStep(2); }
            return;
        }

        if (!editingProject && !formData.client_id) {
            setProjectStepError('Please select a client before creating a project.');
            return;
        }

        if (!String(formData.name || '').trim()) {
            setProjectStepError('Please enter a project name.');
            return;
        }

        if (!formData.end_date) {
            setProjectStepError('Please choose a due date.');
            return;
        }
        if (!isDueDateValid(formData.end_date)) {
            setProjectStepError('Due date must be at least 7 days from today.');
            return;
        }
        setProjectStepError('');

        try {
            const isEdit = !!editingProject;
            const url = `${API_BASE}/projects.php`;
            const method = isEdit ? 'PUT' : 'POST';

            const payload = isEdit
                ? { ...formData, id: editingProject.id }
                : {
                    ...formData,
                    manager_id: isCurrentManager ? String(user?.id || '') : formData.manager_id,
                    custom_tasks: selectedTasks
                }; // Send custom tasks only on create

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                setSuccess(isEdit ? 'Project updated successfully!' : 'Project created successfully!');
                setShowModal(false);
                resetForm();

                if (isEdit && editingProject) {
                    // Optimistic update for PUT
                    setProjects((prev) =>
                        (prev || []).map((p) =>
                            p.id === editingProject.id ? { ...p, ...payload } : p
                        )
                    );
                    markEdited(editingProject.id);
                } else {
                    // Optimistic insert for POST
                    const newProject = {
                        id: Number(data?.data?.project_id || 0),
                        name: String(formData.name || '').trim(),
                        description: formData.description || '',
                        client_id: Number(formData.client_id || 0),
                        manager_id: Number(payload.manager_id || 0),
                        status: formData.status || 'active',
                        start_date: new Date().toISOString(),
                        end_date: formData.end_date,
                    };
                    setProjects((prev) => [newProject, ...(prev || [])]);
                }
            } else {
                setError(data.message || `Failed to ${isEdit ? 'update' : 'create'} project`);
            }
        } catch (err) {
            setError('An error occurred');
        }
    };

    const handleDeleteClick = (p: any) => {
        if (!canManageProject(p)) {
            setError('You can only archive projects assigned to you.');
            return;
        }
        setProjectToDelete(p);
        setShowDeleteConfirm(true);
        setActiveDropdown(null);
        setDropdownPosition(null);
    };

    const handleDeleteConfirm = async () => {
        if (!projectToDelete) return;

        try {
            const url = `${API_BASE}/projects.php?id=${projectToDelete.id}`;
            const res = await fetch(url, {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await res.json();

            if (data.success) {
                setProjects((prev) =>
                    (prev || []).map((p) =>
                        p.id === projectToDelete.id ? { ...p, status: 'archived' } : p
                    )
                );
                setShowDeleteConfirm(false);
                setProjectToDelete(null);
            } else {
                alert(data.message || 'Failed to archive project');
            }
        } catch (err) {
            alert('An error occurred while archiving');
        }
    };

    const toggleDropdown = (e: React.MouseEvent, projectId: number) => {
        e.preventDefault();
        e.stopPropagation();
        if (activeDropdown === projectId) {
            setActiveDropdown(null);
            setDropdownPosition(null);
            return;
        }

        const buttonRect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
        const menuWidth = 180;
        const viewportPadding = 8;
        const maxLeft = Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding);
        const computedLeft = Math.min(Math.max(buttonRect.right - menuWidth, viewportPadding), maxLeft);

        setDropdownPosition({
            top: buttonRect.bottom + 6,
            left: computedLeft,
        });
        setActiveDropdown(projectId);
    };

    const handleStartProject = async () => {
        if (!startModal) return;
        if (!startModal.managerId) {
            void notifyError('Please select a manager before starting the project.');
            return;
        }
        setIsStarting(true);
        try {
            const res = await fetch(`${API_BASE}/projects.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: startModal.project.id, manager_id: Number(startModal.managerId), start: true, contract_signed: startModal.contractSigned ? 1 : 0 })
            });
            const data = await res.json();
            if (res.ok && data.success) {
                setProjects((prev) =>
                    (prev || []).map((p) =>
                        p.id === startModal.project.id
                            ? { ...p, status: 'active', manager_id: Number(startModal.managerId), start_date: new Date().toISOString(), contract_signed: startModal.contractSigned ? 1 : 0 }
                            : p
                    )
                );
                setStartModal(null);
                void notifySuccess('Project started successfully.');
            } else {
                void notifyError(data.message || 'Failed to start project.');
            }
        } catch {
            void notifyError('An error occurred while starting the project.');
        } finally {
            setIsStarting(false);
        }
    };

    const doRestoreProject = async (projectId: number) => {
        const targetProject = projects.find((p) => Number(p.id) === Number(projectId));
        if (targetProject && !canManageProject(targetProject)) {
            setError('You can only restore projects assigned to you.');
            return;
        }
        try {
            const res = await fetch(`${API_BASE}/projects.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ id: projectId, status: 'active' })
            });
            const data = await res.json();
            if (data.success) {
                setProjects((prev) =>
                    (prev || []).map((p) =>
                        p.id === projectId ? { ...p, status: 'active' } : p
                    )
                );
            }
        } catch (err) { alert('Error restoring project'); }
    };

    const handleRestore = async (projectId: number) => {
        const targetProject = projects.find((p) => Number(p.id) === Number(projectId));
        if (targetProject && !canManageProject(targetProject)) {
            setError('You can only restore projects assigned to you.');
            return;
        }
        const label = (targetProject as { name?: string } | undefined)?.name || 'this project';
        const confirmed = await confirmAction({
            title: `Restore ${label}?`,
            text: 'This project will be returned to active projects.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        await doRestoreProject(projectId);
    };

    const handleRestoreAll = async (archived: any[]) => {
        const manageableArchived = archived.filter(canManageProject);
        if (manageableArchived.length === 0) {
            setError('No archived projects available to restore.');
            return;
        }
        const confirmed = await confirmAction({
            title: 'Restore all archived projects?',
            text: `This will restore ${manageableArchived.length} archived project(s) to active.`,
            confirmButtonText: 'Yes, restore all',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        for (const p of manageableArchived) { await doRestoreProject(p.id); }
        setProjects((prev) =>
            (prev || []).map((p) =>
                manageableArchived.some((a) => a.id === p.id) ? { ...p, status: 'active' } : p
            )
        );
    };

    const handleArchiveAll = async () => {
        const manageableActiveProjects = activeProjects.filter(canManageProject);
        if (manageableActiveProjects.length === 0) {
            alert('No active projects available to archive.');
            return;
        }

        const confirmed = await confirmAction({
            title: 'Archive all projects?',
            text: `This will archive ${manageableActiveProjects.length} ${manageableActiveProjects.length === 1 ? 'project' : 'projects'}. Are you sure?`,
            confirmButtonText: 'Archive All',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        for (const p of manageableActiveProjects) {
            try {
                const res = await fetch(`${API_BASE}/projects.php?id=${p.id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
                const data = await res.json();
                if (data.success) {
                    // Continue with next project
                }
            } catch (err) {
                console.error('Failed to archive project', p.id, err);
            }
        }
        setProjects((prev) =>
            (prev || []).map((p) =>
                manageableActiveProjects.some((a) => a.id === p.id) ? { ...p, status: 'archived' } : p
            )
        );
    };

    const tableHeaderStyle = { padding: '10px 12px', textAlign: 'left' as const, borderBottom: '2px solid #e2e8f0', color: '#475569', fontWeight: '600', fontSize: '12px' };
    const tableCellStyle = { padding: '13px 12px', borderBottom: '6px solid #f8fafc', color: '#1e293b', fontSize: '13px' };
    const tableRowHoverStyle = { transition: 'background-color 0.15s', cursor: 'default' };

    const activeProjects = projects.filter(p => p.status !== 'archived');
    const archivedProjects = projects.filter(p => p.status === 'archived');
    const visibleProjects = showArchiveView ? archivedProjects : activeProjects;
    const filteredProjects = useMemo(() => {
        const term = projectSearch.trim().toLowerCase();
        const todayKey = formatDateKey(new Date());
        const upcomingThreshold = new Date();
        upcomingThreshold.setDate(upcomingThreshold.getDate() + 7);
        const upcomingThresholdKey = formatDateKey(upcomingThreshold);

        return visibleProjects.filter((project: any) => {
            const normalizedStatus = String(project?.status || '').trim().toLowerCase();
            if (projectStatusFilter !== 'all' && normalizedStatus !== projectStatusFilter) {
                return false;
            }

            if (deadlineFilter !== 'all') {
                const deadlineKey = normalizeDateKey(project?.end_date);
                if (deadlineFilter === 'overdue' && (!deadlineKey || deadlineKey >= todayKey)) {
                    return false;
                }
                if (deadlineFilter === 'due_soon' && (!deadlineKey || deadlineKey < todayKey || deadlineKey > upcomingThresholdKey)) {
                    return false;
                }
            }

            if (managerFilter !== 'all' && String(project?.manager_id || '') !== managerFilter) {
                return false;
            }

            if (clientFilter !== 'all' && String(project?.client_id || '') !== clientFilter) {
                return false;
            }

            if (!term) {
                return true;
            }

            const haystack = [
                project?.name || '',
                project?.description || '',
                project?.client_name || '',
                project?.manager_name || '',
                project?.status || '',
            ].join(' ').toLowerCase();

            return haystack.includes(term);
        }).sort((left: any, right: any) => sortProjectsForDisplay(left, right, pinnedProjectIds));
    }, [clientFilter, deadlineFilter, managerFilter, pinnedProjectIds, projectSearch, projectStatusFilter, visibleProjects]);
    const paginatedProjects = filteredProjects.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    const overviewStats = useMemo(() => {
        const todayKey = formatDateKey(new Date());
        const dueSoonThreshold = new Date();
        dueSoonThreshold.setDate(dueSoonThreshold.getDate() + 7);
        const dueSoonThresholdKey = formatDateKey(dueSoonThreshold);

        return filteredProjects.reduce(
            (acc, project: any) => {
                const deadlineKey = normalizeDateKey(project?.end_date);
                const projectId = Number(project?.id || 0);
                const personalSummary = personalTaskSummaryByProject[projectId] || { total: 0, completed: 0, overdue: 0 };
                const totalTasks = Number(project?.task_count || 0);
                const assignedTasks = Number(project?.assigned_task_count || 0);
                const unassignedTasks = Number(project?.unassigned_task_count ?? Math.max(0, totalTasks - assignedTasks));

                acc.projects += 1;
                acc.myOpenTasks += Math.max(0, personalSummary.total - personalSummary.completed);
                acc.assignedTasks += assignedTasks;
                acc.unassignedTasks += unassignedTasks;

                if (deadlineKey) {
                    if (deadlineKey >= todayKey && deadlineKey <= dueSoonThresholdKey) {
                        acc.dueSoonProjects += 1;
                    }
                }

                return acc;
            },
            { projects: 0, dueSoonProjects: 0, assignedTasks: 0, unassignedTasks: 0, myOpenTasks: 0 }
        );
    }, [filteredProjects, personalTaskSummaryByProject]);

    useEffect(() => {
        setCurrentPage(1);
    }, [clientFilter, deadlineFilter, managerFilter, projectSearch, projectStatusFilter, showArchiveView]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filteredProjects.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [filteredProjects.length, currentPage]);

    // Lock background page scroll while the Add/Edit modal is open —
    // only the modal itself may scroll, the page behind stays put.
    useEffect(() => {
        if (!showModal) return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [showModal]);

    // Auto-pick Due Date for new projects: if empty when the modal opens,
    // default to 7 days from now so the user never starts blank.
    useEffect(() => {
        if (showModal && !editingProject && !formData.end_date) {
            setFormData((prev) => ({ ...prev, end_date: prev.end_date || defaultProjectDeadline() }));
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showModal, editingProject]);

    if (authLoading || loading) {

      return (

        <Layout role={String(user?.role || '')} user={user} onLogout={logout}>

          <div style={{ padding: 20 }}>Loading...</div>

        </Layout>

      );

    }

    return (
        <Layout role={user?.role} user={user} onLogout={logout}>
            <Head>
                <title>{showArchiveView ? 'Archived Projects' : 'Project Management'}</title>
            </Head>

            <div style={{ display: 'grid', gap: 12, marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <h1 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', margin: 0 }}>
                            {showArchiveView ? 'Archived Projects' : 'Project Management'}
                        </h1>
                        {!showArchiveView && user?.role !== 'staff' && (
                            <button
                                className="app-action-btn app-action-btn-primary"
                                onClick={openAddModal}
                                title="Add Project"
                                aria-label="Add Project"
                                style={{ height: '40px', padding: '0 18px', background: '#1e3a8a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                Add Project
                            </button>
                        )}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <button
                            className="app-action-btn app-action-btn-danger"
                            onClick={() => setShowArchiveView(!showArchiveView)}
                            title={showArchiveView ? 'Back to Active Projects' : 'View Archived Projects'}
                            aria-label={showArchiveView ? 'Back to Active Projects' : 'View Archived Projects'}
                            style={{ height: '36px', padding: '0 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}
                        >
                            <CrudActionIcon action="archive" />
                            {showArchiveView ? 'Back to Active' : `Archive (${archivedProjects.length})`}
                        </button>
                        {!showArchiveView ? (
                            <>
                                {activeProjects.some(canManageProject) && user?.role !== 'staff' && (
                                    <button
                                        className="app-action-btn app-action-btn-danger"
                                        onClick={handleArchiveAll}
                                        title="Archive All"
                                        aria-label="Archive All projects"
                                        style={{ height: '36px', padding: '0 16px', background: '#dc2626', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '6px' }}
                                    >
                                        <CrudActionIcon action="archive" />
                                        {isCurrentManager ? 'Archive Assigned' : 'Archive All'}
                                    </button>
                                )}
                            </>
                        ) : (
                            <>
                                {archivedProjects.some(canManageProject) && (
                                    <button className="app-action-btn app-action-btn-success" onClick={() => handleRestoreAll(archivedProjects)} title={isCurrentManager ? 'Restore assigned projects' : 'Restore All'} aria-label={isCurrentManager ? 'Restore assigned projects' : 'Restore All projects'} style={{ height: '36px', padding: '0 16px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                        <CrudActionIcon action="restore" />
                                    </button>
                                )}
                            </>
                        )}
                    </div>
                </div>

                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(200px, 1.4fr) minmax(140px, 0.7fr) minmax(140px, 0.7fr) minmax(150px, 0.75fr) minmax(140px, 0.7fr)',
                    gap: 12,
                    alignItems: 'end',
                    background: '#ffffff',
                    border: '1px solid #e2e8f0',
                    borderRadius: 12,
                    padding: '12px 14px',
                    boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04)'
                }}>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Search</span>
                        <SearchBar
                            storageKey="projects:list"
                            placeholder="Search project, client, or manager..."
                            ariaLabel="Search projects"
                            value={projectSearch}
                            onChange={setProjectSearch}
                            suggestions={collectSearchTerms(projects, [
                                (p: any) => p?.name,
                                (p: any) => p?.client_name,
                                (p: any) => p?.manager_name,
                                (p: any) => p?.status,
                            ])}
                            inputStyle={{ padding: '10px 30px 10px 32px', borderColor: '#cbd5e1', background: '#fff' }}
                        />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</span>
                        <select
                            value={projectStatusFilter}
                            onChange={(e) => setProjectStatusFilter(e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                        >
                            <option value="all">All Statuses</option>
                            <option value="active">Active</option>
                            <option value="completed">Completed</option>
                            <option value="on_hold">On Hold</option>
                            <option value="archived">Archived</option>
                        </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Due Date</span>
                        <select
                            value={deadlineFilter}
                            onChange={(e) => setDeadlineFilter(e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                        >
                            <option value="all">All Due Dates</option>
                            <option value="due_soon">Due In 7 Days</option>
                            <option value="overdue">Overdue</option>
                        </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Manager</span>
                        <select
                            value={managerFilter}
                            onChange={(e) => setManagerFilter(e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                        >
                            <option value="all">All Managers</option>
                            {managers.map(m => (
                                <option key={m.id} value={String(m.id)}>{m.first_name} {m.last_name}</option>
                            ))}
                        </select>
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Client</span>
                        <select
                            value={clientFilter}
                            onChange={(e) => setClientFilter(e.target.value)}
                            style={{ width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #cbd5e1', background: '#fff' }}
                        >
                            <option value="all">All Clients</option>
                            {clients.map(c => (
                                <option key={c.client_id} value={String(c.client_id)}>{c.client_name}</option>
                            ))}
                        </select>
                    </label>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', color: '#475569', fontSize: 12 }}>
                        <span><strong style={{ color: '#0f172a' }}>{overviewStats.projects}</strong> {showArchiveView ? 'archived' : 'projects'}</span>
                        <span><strong style={{ color: '#0f172a' }}>{overviewStats.dueSoonProjects}</strong> due soon</span>
                        <span><strong style={{ color: '#15803d' }}>{overviewStats.assignedTasks}</strong> assigned tasks</span>
                        <span><strong style={{ color: overviewStats.unassignedTasks > 0 ? '#b45309' : '#0f172a' }}>{overviewStats.unassignedTasks}</strong> unassigned tasks</span>
                        <span><strong style={{ color: '#0f172a' }}>{overviewStats.myOpenTasks}</strong> my open tasks</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                        <span style={{ color: '#64748b', fontWeight: 700 }}>Project status:</span>
                        {[
                            { label: 'Active', bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe' },
                            { label: 'On Hold', bg: '#fff7ed', text: '#c2410c', border: '#fed7aa' },
                            { label: 'Completed', bg: '#ecfdf5', text: '#047857', border: '#a7f3d0' },
                            { label: 'Archived', bg: '#f1f5f9', text: '#475569', border: '#cbd5e1' },
                        ].map((item) => (
                            <span key={item.label} style={{
                                display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px',
                                borderRadius: 999, background: item.bg, color: item.text, border: `1px solid ${item.border}`, fontWeight: 700
                            }}>
                                <span style={{ width: 7, height: 7, borderRadius: 999, background: item.text }} />
                                {item.label}
                            </span>
                        ))}
                    </div>
                </div>
            </div>

            {/* Projects Table */}
            <div style={{ background: '#f8fafc', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflowX: 'auto', padding: '6px' }}>
                <table className="llb-table llb-pin-first" style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse', background: '#f8fafc' }}>
                    <thead style={{ background: '#f8fafc' }}>
                        <tr>
                            <th style={{ ...tableHeaderStyle, width: '26%' }}>Project Name</th>
                            <th style={{ ...tableHeaderStyle, width: '14%' }}>Client</th>
                            <th style={{ ...tableHeaderStyle, width: '12%' }}>Manager</th>
                            <th style={{ ...tableHeaderStyle, width: '9%' }}>Status</th>
                            <th style={{ ...tableHeaderStyle, width: '9%' }} className="llb-num">Progress</th>
                            <th style={{ ...tableHeaderStyle, width: '8%' }} className="llb-num">Assigned</th>
                            <th style={{ ...tableHeaderStyle, width: '8%' }} className="llb-num">Unassigned</th>
                            <th style={{ ...tableHeaderStyle, width: '7%' }} className="llb-num">My Tasks</th>
                            <th style={{ ...tableHeaderStyle, width: '12%' }}>Due Date</th>
                            <th style={{ ...tableHeaderStyle, textAlign: 'center', width: '5%' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filteredProjects.length === 0 ? (
                            <tr>
                                <td colSpan={10} style={{ padding: '12px', textAlign: 'center', color: '#64748b', fontSize: '13px' }}>
                                    <ZeroResults
                                        query={projectSearch}
                                        itemLabel="projects"
                                        alternatives={getAlternativeSuggestions(projectSearch, collectSearchTerms(projects, [
                                            (p: any) => p?.name,
                                            (p: any) => p?.client_name,
                                            (p: any) => p?.manager_name,
                                        ]))}
                                        onPickAlternative={(term) => setProjectSearch(term)}
                                        onClear={() => setProjectSearch('')}
                                    />
                                </td>
                            </tr>
                        ) : paginatedProjects.map((p: any) => {
                            const isAssignedToCurrentManager = isCurrentManager && String(p?.manager_id || '') === String(user?.id || '');
                            const isPinnedProject = pinnedProjectIds.includes(Number(p?.id || 0));

                            return (
                            <tr
                                key={p.id}
                                style={{
                                    ...tableRowHoverStyle,
                                    backgroundColor: '#ffffff',
                                    outline: '1px solid #e2e8f0',
                                    outlineOffset: '-1px',
                                }}
                                onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f8fafc'}
                                onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#ffffff'}
                            >
                                <td style={tableCellStyle}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                                        <div
                                            onClick={() => router.push(`/projects/detail?id=${p.id}`)}
                                            style={{ fontWeight: '600', cursor: 'pointer', color: '#1e3a8a', fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                        >
                                            {p.name}
                                        </div>
                                        <EditedBadge editedAt={editedItems.get(p.id)} compact />
                                        {isPinnedProject && (
                                            <span style={{ flex: '0 0 auto', color: '#92400e', fontSize: 11, fontWeight: 800 }}>
                                                Pinned
                                            </span>
                                        )}
                                        {isAssignedToCurrentManager && (
                                            <span style={{ flex: '0 0 auto', color: '#2563eb', fontSize: 11, fontWeight: 800 }}>
                                                Assigned
                                            </span>
                                        )}
                                        {/* Contract signed badge (only show when signed) */}
                                        {String(p.status || '').toLowerCase() !== 'pending' && Number(p.contract_signed || 0) === 1 && (
                                            <span style={{ flex: '0 0 auto', fontSize: 10, fontWeight: 800, color: '#15803d', background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 999, padding: '1px 7px', whiteSpace: 'nowrap' }}>✓ Signed</span>
                                        )}
                                    </div>
                                </td>
                                <td style={tableCellStyle} className="llb-trunc" title={p.client_name || ''}>{p.client_name || '-'}</td>
                                <td style={tableCellStyle} className="llb-trunc" title={p.manager_name || ''}>{p.manager_name || '-'}</td>
                                <td style={tableCellStyle}>
                                    {(() => {
                                        if (showArchiveView) {
                                            return (
                                                <span style={{
                                                    padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: '600',
                                                    background: '#fee2e2', color: '#991b1b', textTransform: 'capitalize'
                                                }}>
                                                    Archived
                                                </span>
                                            );
                                        }
                                        const allDone = parseInt(p.task_count) > 0 && parseInt(p.task_count) === parseInt(p.completed_task_count);
                                        const displayStatus = allDone ? 'completed' : (p.status || 'active');
                                        // Project status palette (navy/slate family) - distinct from task workflow colors
                                        const badgeColors: Record<string, { bg: string; text: string; border: string; label: string }> = {
                                            active: { bg: '#eff6ff', text: '#1d4ed8', border: '#bfdbfe', label: 'Active' },
                                            completed: { bg: '#ecfdf5', text: '#047857', border: '#a7f3d0', label: 'Completed' },
                                            on_hold: { bg: '#fff7ed', text: '#c2410c', border: '#fed7aa', label: 'On Hold' },
                                            archived: { bg: '#f1f5f9', text: '#475569', border: '#cbd5e1', label: 'Archived' },
                                            pending: { bg: '#faf5ff', text: '#7c3aed', border: '#ddd6fe', label: 'Pending' },
                                        };
                                        const colors = badgeColors[displayStatus] || { bg: '#f8fafc', text: '#475569', border: '#e2e8f0', label: String(p.status || 'active') };
                                        return (
                                            <span style={{
                                                padding: '3px 8px', borderRadius: '12px', fontSize: '11px', fontWeight: '700',
                                                background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
                                                textTransform: 'capitalize', letterSpacing: '0.01em'
                                            }}>
                                                {colors.label}
                                            </span>
                                        );
                                    })()}
                                </td>
                                <td style={tableCellStyle} className="llb-num">
                                    {(() => {
                                        const totalTasks = Number(p.task_count || 0);
                                        const completedTasks = Number(p.completed_task_count || 0);
                                        return <span style={{ fontWeight: 600 }}>{completedTasks}/{totalTasks}</span>;
                                    })()}
                                </td>
                                <td style={tableCellStyle} className="llb-num">
                                    {(() => {
                                        const assignedTasks = Number(p.assigned_task_count ?? 0);
                                        return <span style={{ fontWeight: 600, color: '#15803d' }}>{assignedTasks}</span>;
                                    })()}
                                </td>
                                <td style={tableCellStyle} className="llb-num">
                                    {(() => {
                                        const totalTasks = Number(p.task_count || 0);
                                        const assignedTasks = Number(p.assigned_task_count ?? 0);
                                        const unassignedTasks = Number(p.unassigned_task_count ?? Math.max(0, totalTasks - assignedTasks));
                                        return <span style={{ fontWeight: 600, color: unassignedTasks > 0 ? '#b45309' : '#64748b' }}>{unassignedTasks}</span>;
                                    })()}
                                </td>
                                <td style={tableCellStyle} className="llb-num">
                                    {(() => {
                                        const summary = personalTaskSummaryByProject[Number(p.id)] || { total: 0, completed: 0, overdue: 0 };
                                        const openTasks = Math.max(0, summary.total - summary.completed);

                                        return <span style={{ fontWeight: 600 }}>{openTasks}</span>;
                                    })()}
                                </td>
                                <td style={tableCellStyle}>
                                    {(() => {
                                        const raw = String(p.end_date || '').trim();
                                        if (!raw) return <span style={{ color: '#94a3b8', fontSize: 12 }}>—</span>;
                                        const d = new Date(raw);
                                        if (Number.isNaN(d.getTime())) return <span style={{ fontSize: 12 }}>{raw}</span>;
                                        const todayKey = formatDateKey(new Date());
                                        const dueKey = formatDateKey(d);
                                        const isOverdue = dueKey < todayKey;
                                        const formatted = d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
                                        return (
                                            <span style={{ fontSize: 12, fontWeight: 600, color: isOverdue ? '#dc2626' : '#0f172a' }}>
                                                {formatted}
                                                {isOverdue && <span style={{ display: 'block', fontSize: 10, color: '#dc2626', fontWeight: 700 }}>Overdue</span>}
                                            </span>
                                        );
                                    })()}
                                </td>
                                <td style={{ ...tableCellStyle, textAlign: 'center', position: 'relative' }} className="llb-actions">
                                    {/* Start overlay for pending projects (admin only) */}
                                    {String(p.status || '').toLowerCase() === 'pending' && isAdmin && (
                                        <button
                                            onClick={() => setStartModal({ project: p, managerId: p.manager_id ? String(p.manager_id) : '', contractSigned: false })}
                                            title="Start project"
                                            style={{ padding: '4px 10px', background: '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '12px', fontWeight: 700, marginRight: 4 }}
                                        >
                                            ▶ Start
                                        </button>
                                    )}
                                    <button
                                        ref={(el) => { actionButtonRefs.current[p.id] = el; }}
                                        onClick={(e) => toggleDropdown(e, p.id)}
                                        aria-expanded={activeDropdown === p.id}
                                        aria-haspopup="menu"
                                        aria-label={`Actions for ${p.name}`}
                                        style={{ background: activeDropdown === p.id ? '#f1f5f9' : 'transparent', border: 'none', cursor: 'pointer', padding: '6px', borderRadius: '6px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                    >
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="#64748b">
                                            <circle cx="12" cy="5" r="2"></circle>
                                            <circle cx="12" cy="12" r="2"></circle>
                                            <circle cx="12" cy="19" r="2"></circle>
                                        </svg>
                                    </button>
                                    {/* Dropdown Menu */}
                                    {activeDropdown === p.id && dropdownPosition && (
                                        <div style={{
                                            position: 'fixed',
                                            top: dropdownPosition.top,
                                            left: dropdownPosition.left,
                                            background: 'white',
                                            border: '1px solid #e2e8f0', borderRadius: '8px',
                                            boxShadow: '0 8px 24px rgba(15, 23, 42, 0.24)',
                                            zIndex: 1400,
                                            minWidth: '140px',
                                            padding: '4px'
                                        }}
                                            ref={dropdownMenuRef}
                                            onClick={(e) => e.stopPropagation()}
                                            role="menu"
                                        >
                                            {!showArchiveView ? (
                                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                    <button onClick={() => router.push(`/projects/detail?id=${p.id}`)} title="View Details" aria-label={`View details for ${p.name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#1e3a8a', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                        <CrudActionIcon action="view" /> View
                                                    </button>
                                                    {canPinProjects && (
                                                        <button onClick={() => togglePinProject(p)} title={isPinnedProject ? 'Unpin this project' : 'Pin this project to the top'} aria-label={isPinnedProject ? `Unpin ${p.name}` : `Pin ${p.name} to the top`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#92400e', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fef3c7'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                            <CrudActionIcon action="pin" /> {isPinnedProject ? 'Unpin' : 'Pin to top'}
                                                        </button>
                                                    )}
                                                    {canManageProject(p) && (
                                                        <button onClick={() => openEditModal(p)} title="Edit" aria-label={`Edit ${p.name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#475569', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                            <CrudActionIcon action="edit" /> Edit
                                                        </button>
                                                    )}
                                                    {canManageProject(p) && (
                                                        <button onClick={() => handleDeleteClick(p)} title="Archive" aria-label={`Archive ${p.name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#dc2626', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#fef2f2'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                            <CrudActionIcon action="archive" /> Archive
                                                        </button>
                                                    )}
                                                </div>
                                            ) : (
                                                <div style={{ display: 'flex', flexDirection: 'column' }}>
                                                    <button onClick={() => router.push(`/projects/detail?id=${p.id}`)} title="View Details" aria-label={`View details for ${p.name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#1e3a8a', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f1f5f9'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                        <CrudActionIcon action="view" /> View
                                                    </button>
                                                    {canManageProject(p) && (
                                                        <button onClick={() => handleRestore(p.id)} title="Restore" aria-label={`Restore ${p.name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '8px 12px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', fontSize: '13px', color: '#16a34a', borderRadius: '6px' }} onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#f0fdf4'} onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}>
                                                            <CrudActionIcon action="restore" /> Restore
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </td>
                            </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            <Pagination
                currentPage={currentPage}
                totalItems={filteredProjects.length}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setCurrentPage}
                label={showArchiveView ? 'archived projects' : 'projects'}
            />

            {/* Add/Edit Modal */}
            {showModal && (
                <div
                    onWheel={(e) => e.stopPropagation()}
                    style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
                    overflow: 'hidden', padding: '16px'
                }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '600px', maxWidth: '96vw', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                            <h2 style={{ margin: 0, color: '#333' }}>
                                {editingProject ? 'Edit Project' : 'New Project'}
                            </h2>
                            {!editingProject && (
                                <button
                                    type="button"
                                    onClick={openClientChoiceDialog}
                                    title="Add Client"
                                    style={{
                                        padding: '8px 16px',
                                        borderRadius: '6px',
                                        border: '1px solid #1e3a8a',
                                        backgroundColor: '#1e3a8a',
                                        color: 'white',
                                        cursor: 'pointer',
                                        fontWeight: '600',
                                        fontSize: '14px',
                                        whiteSpace: 'nowrap',
                                        transition: 'all 0.2s',
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.backgroundColor = '#1e40af'}
                                    onMouseLeave={(e) => e.currentTarget.style.backgroundColor = '#1e3a8a'}
                                >
                                    + Client
                                </button>
                            )}
                        </div>

                        <form onSubmit={handleSubmit} noValidate>
                            {/* ── Wizard steps (Add mode only, mirrors Add Client) ── */}
                            {!editingProject && (
                                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                                    {[
                                        { key: 0, label: 'Basic' },
                                        { key: 1, label: 'Services' },
                                        { key: 2, label: 'Review' },
                                    ].map((tab) => {
                                        const isActive = projectStep === tab.key;
                                        const isDone = projectStep > tab.key;
                                        return (
                                            <button
                                                key={tab.key}
                                                type="button"
                                                onClick={() => {
                                                    // Allow going back freely; forward only via Next validation.
                                                    if (tab.key < projectStep) goToProjectStep(tab.key);
                                                    else if (tab.key === 1 && projectStep === 0 && canProceedFromBasicStep()) goToProjectStep(1);
                                                    else if (tab.key === 2 && projectStep === 1 && canProceedFromServicesStep()) goToProjectStep(2);
                                                }}
                                                style={{
                                                    flex: 1,
                                                    padding: '8px 6px',
                                                    borderRadius: 8,
                                                    border: isActive ? '1.5px solid #1e3a8a' : '1px solid #cbd5e1',
                                                    background: isActive ? '#1e3a8a' : isDone ? '#eff6ff' : '#fff',
                                                    color: isActive ? '#fff' : isDone ? '#1e3a8a' : '#64748b',
                                                    fontSize: 12,
                                                    fontWeight: 800,
                                                    cursor: 'pointer',
                                                }}
                                            >
                                                {tab.key + 1}. {tab.label}
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                            {projectStepError && (
                                <div role="alert" style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', fontSize: 12, fontWeight: 600 }}>
                                    {projectStepError}
                                </div>
                            )}
                            {/* ── STEP 1: Basic (Add mode) — full form in Edit mode ── */}
                            {(editingProject || projectStep === 0) && (
                                <>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Client</label>
                                    <select name="client_id" value={formData.client_id} onChange={handleInputChange} required
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}>
                                        <option value="">-- Select Client --</option>
                                        {clients.map(c => (
                                            <option key={c.client_id} value={c.client_id}>{c.client_name}</option>
                                        ))}
                                    </select>
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Manager</label>
                                    <select name="manager_id" value={formData.manager_id} onChange={handleInputChange} required={!editingProject} disabled={isCurrentManager}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}>
                                        <option value="">-- Select Manager --</option>
                                        {managers.length > 0 ? managers.map(m => (
                                            <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>
                                        )) : (
                                            /* If no managers, try showing all users for now fallback */
                                            <option disabled>No managers found</option>
                                        )}
                                    </select>
                                </div>
                            </div>

                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>
                                    Project Name {!editingProject && <span style={{ color: '#64748b', fontWeight: 400 }}>(auto-generated, editable)</span>}
                                </label>
                                <input
                                    type="text"
                                    name="name"
                                    value={formData.name}
                                    onChange={handleInputChange}
                                    required
                                    placeholder={editingProject ? '' : 'Choose a client first, then edit if needed'}
                                    style={{
                                        width: '100%',
                                        padding: '10px',
                                        borderRadius: '6px',
                                        border: '1px solid #ccc',
                                        color: '#000',
                                        backgroundColor: '#fff',
                                    }}
                                />
                                {!editingProject && (
                                    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                        <div style={{ fontSize: '12px', color: '#64748b' }}>
                                            {isProjectNameEdited
                                                ? 'You customized this name. It will be used as-is.'
                                                : 'Auto-generated from client + services. You can edit it before saving.'}
                                        </div>
                                        {isProjectNameEdited && formData.client_id && (
                                            <button
                                                type="button"
                                                onClick={() => {
                                                    setFormData((prev) => ({ ...prev, name: buildGeneratedProjectName(prev.client_id) }));
                                                    setIsProjectNameEdited(false);
                                                }}
                                                style={{ background: 'none', border: 'none', color: '#1e3a8a', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                            >
                                                Reset to generated
                                            </button>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Description <span style={{ color: '#64748b', fontWeight: 400 }}>(optional)</span></label>
                                <textarea name="description" value={formData.description} onChange={handleInputChange}
                                    placeholder="Add details about this project (optional)"
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', minHeight: '80px', color: '#000', backgroundColor: '#fff' }} />
                            </div>

                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Due Date <span style={{ marginLeft: 6, fontSize: '11px', fontWeight: 700, color: '#1e3a8a', background: '#eff6ff', borderRadius: 99, padding: '1px 8px' }}>Auto-picked</span></label>
                                <input type="datetime-local" name="end_date" value={formData.end_date} onChange={handleInputChange}
                                    onFocus={(e) => { try { (e.target as any).showPicker?.(); } catch { /* ignore */ } }}
                                    required
                                    min={defaultProjectDeadline()}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#333', backgroundColor: 'white' }} />
                                <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                                    <div style={{ fontSize: '12px', color: '#64748b' }}>
                                        {!editingProject ? 'Start date is recorded automatically when the project is created. ' : ''}
                                        Auto-set to 7 days from today. You can change it.
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setFormData((prev) => ({ ...prev, end_date: defaultProjectDeadline() }))}
                                        style={{ background: 'none', border: 'none', color: '#1e3a8a', fontSize: '12px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                    >
                                        Reset to auto
                                    </button>
                                </div>
                            </div>
                                </>
                            )}
                            {/* ── STEP 2: Services (Add mode only) ── */}
                            {!editingProject && projectStep === 1 && (
                            <>
                            {/* Service / Scope Selection */}
                            {!editingProject && clientServices.length > 0 && (
                                <div style={{ marginBottom: '20px', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '15px', background: '#f8fafc' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: 10, flexWrap: 'wrap' }}>
                                        <div>
                                            <h3 style={{ marginTop: 0, marginBottom: '2px', fontSize: '14px', color: '#2d3748' }}>Project Scope</h3>
                                            <p style={{ margin: 0, fontSize: '12px', color: '#718096' }}>
                                                The client&apos;s assigned services and checklist tasks are preselected. Adjust them here if needed.
                                            </p>
                                        </div>
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                                              {(() => {
                                                  const remainingServices = clientServices.filter(s => !addedScopeIds.includes(String(s.service_id)));
                                                  if (remainingServices.length === 0) return null;
                                                  return (<>
                                              <select
                                                 value={scopeServiceId}
                                                 onChange={(e) => {
                                                     setScopeServiceId(e.target.value);
                                                     setScopeListOpen(false);
                                                     if (!newTaskServiceId && e.target.value) setNewTaskServiceId(e.target.value);
                                                 }}
                                                 title="Choose a service"
                                                 aria-label="Choose a service"
                                                 style={{ padding: '7px 10px', borderRadius: '6px', border: '1px solid #94a3b8', fontSize: '13px', fontWeight: 600, color: '#1e3a8a', backgroundColor: '#fff', maxWidth: 200, cursor: 'pointer' }}
                                             >
                                                 <option value="">-- Service --</option>
                                                 {remainingServices.map(s => {
                                                     const total = Array.isArray(s.checklists) ? s.checklists.length : 0;
                                                     const picked = Array.isArray(s.checklists) ? s.checklists.filter((cl: any) => selectedTasks.includes(normalizeChecklistId(cl.checklist_id))).length : 0;
                                                     return (
                                                         <option key={s.service_id} value={s.service_id}>
                                                             {s.service_name}  {picked}/{total}
                                                         </option>
                                                     );
                                                 })}
                                             </select>
                                              {/* Show + only after a service is picked. Span (not <button>) so global button CSS can't turn it white/invisible. */}
                                              {!!scopeServiceId && remainingServices.some(s => String(s.service_id) === String(scopeServiceId)) && (
                                              <span
                                                  role="button"
                                                  tabIndex={0}
                                                  onClick={addScopeService}
                                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addScopeService(); } }}
                                                  title="Add this service to the project scope"
                                                  aria-label="Add service to scope"
                                                  style={{
                                                      width: 32, height: 32, borderRadius: '6px', border: '1px solid #000', cursor: 'pointer',
                                                      background: '#000', color: '#fff',
                                                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                                                  }}
                                              >
                                                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                              </span>
                                              )}
                                                  </>);
                                              })()}
                                              <button
                                                  type="button"
                                                  onClick={() => setShowAddTask(!showAddTask)}
                                                 title="Add Task"
                                                 aria-label="Add Task"
                                                 style={{ background: '#2563eb', border: '1px solid #2563eb', color: '#fff', fontSize: '13px', fontWeight: 700, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '7px 16px', borderRadius: 8, whiteSpace: 'nowrap' }}
                                             >
                                                 Add Task
                                             </button>
                                        </div>
                                    </div>

                                    {/* Add Task Form */}
                                    {showAddTask && (
                                        <div style={{ marginBottom: '15px', padding: '10px', background: '#e0f2fe', borderRadius: '6px', border: '1px solid #bae6fd' }}>
                                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr auto', gap: '8px', alignItems: 'center' }}>
                                                <select
                                                    value={newTaskServiceId}
                                                    onChange={(e) => setNewTaskServiceId(e.target.value)}
                                                    style={{ padding: '6px', borderRadius: '4px', border: '1px solid #94a3b8', fontSize: '13px', color: '#000', backgroundColor: '#fff' }}
                                                >
                                                    <option value="">Select Service...</option>
                                                    {clientServices.map(s => (
                                                        <option key={s.service_id} value={s.service_id}>{s.service_name}</option>
                                                    ))}
                                                </select>
                                                <input
                                                    type="text"
                                                    placeholder="New Task Name"
                                                    value={newTaskName}
                                                    onChange={(e) => setNewTaskName(e.target.value)}
                                                    style={{ padding: '6px', borderRadius: '4px', border: '1px solid #94a3b8', fontSize: '13px', width: '100%', color: '#000', backgroundColor: '#fff' }}
                                                />
                                                <button
                                                    type="button"
                                                    onClick={handleAddTask}
                                                    disabled={!newTaskServiceId || !newTaskName}
                                                    title="Add and Keep Adding"
                                                    style={{
                                                        background: '#1e3a8a', color: 'white', border: 'none', borderRadius: '4px',
                                                        width: '30px', height: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
                                                        opacity: (!newTaskServiceId || !newTaskName) ? 0.6 : 1
                                                    }}
                                                >
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                                                </button>
                                            </div>
                                        </div>
                                    )}

<div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                                                                                  {addedScopeIds.length === 0 && (
                                             <div style={{ fontSize: '12px', color: '#a0aec0' }}>Choose a service above and press + to add it, then tick its checklist items.</div>
                                         )}
                                         {/* ── Services strip: labeled segmented row | 1. Audit | 2. Tax | ── */}
                                         {addedScopeIds.length > 0 && (
                                             <div>
                                                 <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                                                     Services ({addedScopeIds.length})
                                                 </div>
                                                 <div style={{ display: 'flex', flexWrap: 'wrap', border: '1px solid #cbd5e1', borderRadius: 8, overflow: 'hidden', background: '#fff', width: 'fit-content', maxWidth: '100%' }}>
                                                 {addedScopeIds.map((id, svcIdx) => {
                                                     const scoped = clientServices.find(s => String(s.service_id) === id);
                                                     const items = Array.isArray(scoped?.checklists) ? scoped.checklists : [];
                                                     const scopedIds = items.map((cl: any) => normalizeChecklistId(cl.checklist_id)).filter(Boolean);
                                                     const pickedCount = scopedIds.filter((cid: number) => selectedTasks.includes(cid)).length;
                                                     const isOpen = openScopeIds.includes(id);
                                                     return (
                                                         <span
                                                             key={`pill-${id}`}
                                                             onClick={() => toggleScopeOpen(id)}
                                                             title="Click to show / hide its checklist below"
                                                             style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer', borderLeft: svcIdx > 0 ? '1px solid #cbd5e1' : 'none', background: isOpen ? '#1e3a8a' : '#fff', color: isOpen ? '#fff' : '#334155' }}
                                                         >
                                                             <span style={{ color: isOpen ? '#bfdbfe' : '#94a3b8' }}>{svcIdx + 1}.</span>
                                                             {scoped?.service_name || 'Service'} {pickedCount}/{items.length}
                                                              {/* Span (not <button>): global button CSS forces white bg + square corners, which made the X invisible. */}
                                                              <span
                                                                  role="button"
                                                                  tabIndex={0}
                                                                  onClick={(e) => { e.stopPropagation(); removeScopeService(id); }}
                                                                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removeScopeService(id); } }}
                                                                  title={`Remove ${scoped?.service_name || 'service'} from scope`}
                                                                  aria-label={`Remove ${scoped?.service_name || 'service'} from scope`}
                                                                  style={{ width: 20, height: 20, borderRadius: '50%', border: '1px solid #000', cursor: 'pointer', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: '#000', flexShrink: 0 }}
                                                              >
                                                                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
                                                              </span>
                                                         </span>
                                                     );
                                                 })}
                                             </div>
                                             </div>
                                         )}
                                         {/* ── Checklists grid: labeled, one column per service (= = = =). Click a header to float its checklist; panels overlay so the modal never resizes ── */}
                                         {addedScopeIds.length > 0 && (
                                             <div>
                                                 <div style={{ fontSize: 11, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                                                     Checklists
                                                 </div>
                                             <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12, alignItems: 'start' }}>
                                         {addedScopeIds.map((id, svcIdx) => {
                                             const scoped = clientServices.find(s => String(s.service_id) === id);
                                             const items = Array.isArray(scoped?.checklists) ? scoped.checklists : [];
                                             if (items.length === 0) {
                                                 return (
                                                 <div key={id} style={{ fontSize: '12px', color: '#a0aec0', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 10, padding: '12px' }}>
                                                     {scoped?.service_name || 'Service'} has no checklist items yet. Use Add Task to create some.
                                                 </div>
                                                 );
                                             }
                                             const scopedIds = items.map((cl: any) => normalizeChecklistId(cl.checklist_id)).filter(Boolean);
                                             const pickedCount = scopedIds.filter((cid: number) => selectedTasks.includes(cid)).length;
                                             const pickedItems = items.filter((cl: any) => selectedTasks.includes(normalizeChecklistId(cl.checklist_id)));
                                             const isOpen = openScopeIds.includes(id);
                                             return (
                                             <div key={id} style={{ background: '#fff', border: isOpen ? '2px solid #1e3a8a' : '1px solid #cbd5e1', borderRadius: 10, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                                                     <button
                                                         type="button"
                                                         ref={(el) => { scopeAnchorRefs.current[id] = el; }}
                                                         data-scope-anchor={id}
                                                         onClick={() => toggleScopeOpen(id)}
                                                         aria-expanded={isOpen}
                                                         title="Click to show / hide its checklist"
                                                         style={{
                                                             width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                                                             padding: '9px 12px', cursor: 'pointer',
                                                             border: 'none', borderBottom: '1px solid #f1f5f9',
                                                             background: '#fff', color: '#000', fontSize: '13px', fontWeight: 600,
                                                         }}
                                                     >
                                                         <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                             {svcIdx + 1}. {scoped?.service_name} checklist
                                                         </span>
                                                         <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                                                             <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 99, padding: '1px 9px', background: pickedCount > 0 ? '#1e3a8a' : '#f1f5f9', color: pickedCount > 0 ? '#fff' : '#64748b' }}>
                                                                 {pickedCount}/{items.length}
                                                             </span>
                                                             <span style={{ fontSize: 11, color: '#64748b' }}>{isOpen ? '▴' : '▾'}</span>
                                                         </span>
                                                     </button>
                                                     <div style={{ padding: '9px 12px 11px', display: 'grid', gap: 6, background: pickedItems.length > 0 ? '#f8fbff' : '#fff' }}>
                                                         {pickedItems.length === 0 ? (
                                                             <span style={{ fontSize: 12, color: '#94a3b8' }}>No checklist tasks selected yet.</span>
                                                         ) : (
                                                             <>
                                                                 <span style={{ fontSize: 10.5, fontWeight: 800, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Selected tasks</span>
                                                                 <div style={{ display: 'grid', gap: 5, maxHeight: 112, overflowY: 'auto' }}>
                                                                     {pickedItems.map((item: any) => {
                                                                         const checklistId = normalizeChecklistId(item.checklist_id);
                                                                         return (
                                                                             <div key={`selected-scope-task-${checklistId}`} style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0, fontSize: 12, color: '#1e293b' }}>
                                                                                 <span aria-hidden="true" style={{ color: '#1d4ed8', fontWeight: 900 }}>✓</span>
                                                                                 <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.task_name}</span>
                                                                             </div>
                                                                         );
                                                                     })}
                                                                 </div>
                                                             </>
                                                         )}
                                                     </div>
                                             </div>
                                             );
                                         })}
                                             </div>
                                             </div>
                                         )}
                                        {selectedTasks.length > 0 && (
                                            <div style={{ fontSize: '12px', color: '#1e3a8a', fontWeight: 600 }}>
                                                {selectedTasks.length} task{selectedTasks.length === 1 ? '' : 's'} selected in total
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}
                            {!editingProject && clientServices.length === 0 && (
                                <div style={{ marginBottom: '20px', border: '1px solid #fde68a', borderRadius: 8, padding: '12px', background: '#fffbeb', color: '#92400e', fontSize: '12px', fontWeight: 600 }}>
                                    This client has no active services. You can continue without checklist tasks, or add services to this client first.
                                </div>
                            )}
                            </>
                            )}

                            {/* ── STEP 3: Review (Add mode only) ── */}
                            {!editingProject && projectStep === 2 && (() => {
                                const reviewClient = clients.find((c: any) => String(c.client_id) === String(formData.client_id));
                                const reviewManager = managers.find((m: any) => String(m.id) === String(formData.manager_id));
                                const scopedServices = clientServices.filter((s: any) => addedScopeIds.includes(String(s.service_id)));
                                const rowStyle = { display: 'flex', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderBottom: '1px solid #e2e8f0', fontSize: 13 };
                                return (
                                    <div style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: 16, background: '#f8fafc', marginBottom: 15 }}>
                                        <h3 style={{ margin: '0 0 10px', fontSize: 14, color: '#1e293b' }}>Review &amp; Save</h3>
                                        <div>
                                            <div style={rowStyle}>
                                                <span style={{ color: '#64748b', fontWeight: 600 }}>Client</span>
                                                <span style={{ fontWeight: 700, color: '#0f172a' }}>{reviewClient ? reviewClient.client_name : '—'}</span>
                                            </div>
                                            <div style={rowStyle}>
                                                <span style={{ color: '#64748b', fontWeight: 600 }}>Manager</span>
                                                <span style={{ fontWeight: 700, color: '#0f172a' }}>
                                                    {reviewManager ? `${reviewManager.first_name} ${reviewManager.last_name}` : (isCurrentManager ? 'You' : '—')}
                                                </span>
                                            </div>
                                            <div style={rowStyle}>
                                                <span style={{ color: '#64748b', fontWeight: 600 }}>Project Name</span>
                                                <span style={{ fontWeight: 700, color: '#0f172a' }}>{formData.name || '—'}</span>
                                            </div>
                                            <div style={rowStyle}>
                                                <span style={{ color: '#64748b', fontWeight: 600 }}>Due Date</span>
                                                <span style={{ fontWeight: 700, color: '#0f172a' }}>{formData.end_date ? new Date(formData.end_date).toLocaleString() : '—'}</span>
                                            </div>
                                            {String(formData.description || '').trim() !== '' && (
                                                <div style={rowStyle}>
                                                    <span style={{ color: '#64748b', fontWeight: 600 }}>Description</span>
                                                    <span style={{ color: '#334155', textAlign: 'right', maxWidth: '60%' }}>{formData.description}</span>
                                                </div>
                                            )}
                                        </div>

                                        <div style={{ marginTop: 12 }}>
                                            <div style={{ fontSize: 12, fontWeight: 800, color: '#1e3a8a', marginBottom: 6 }}>Project Scope</div>
                                            {scopedServices.length === 0 ? (
                                                <div style={{ fontSize: 12, color: '#64748b' }}>
                                                    No services added — the project will be created without checklist tasks.
                                                </div>
                                            ) : (
                                                <div style={{ display: 'grid', gap: 6 }}>
                                                    {scopedServices.map((s: any) => {
                                                        const total = Array.isArray(s.checklists) ? s.checklists.length : 0;
                                                        const picked = Array.isArray(s.checklists) ? s.checklists.filter((cl: any) => selectedTasks.includes(normalizeChecklistId(cl.checklist_id))).length : 0;
                                                        return (
                                                            <div key={`review-scope-${s.service_id}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 7, padding: '7px 10px', fontSize: 12 }}>
                                                                <span style={{ fontWeight: 700, color: '#0f172a' }}>{s.service_name}</span>
                                                                <span style={{ color: picked > 0 ? '#1e3a8a' : '#b91c1c', fontWeight: 600 }}>{picked}/{total} tasks</span>
                                                            </div>
                                                        );
                                                    })}
                                                </div>
                                            )}
                                            <div style={{ marginTop: 8, fontSize: 12, color: '#64748b' }}>
                                                {selectedTasks.length} checklist task{selectedTasks.length === 1 ? '' : 's'} will be copied into this project.
                                            </div>
                                        </div>
                                    </div>
                                );
                            })()}


                            {editingProject && (
                                <div style={{ marginBottom: '20px' }}>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Status</label>
                                    <select name="status" value={formData.status} onChange={handleInputChange}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', backgroundColor: 'white', color: '#333' }}>
                                        <option value="active">Active</option>
                                        <option value="completed">Completed</option>
                                        <option value="on_hold">On Hold</option>
                                        <option value="archived">Archived</option>
                                    </select>
                                </div>
                            )}

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', gap: 10 }}>
                                    {!editingProject && projectStep > 0 && (
                                        <button
                                            type="button"
                                            onClick={() => goToProjectStep(projectStep - 1)}
                                            style={{ padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: 7, background: '#fff', color: '#374151', fontSize: 13, cursor: 'pointer', fontWeight: 600 }}
                                        >
                                            ← Back
                                        </button>
                                    )}
                                    {!editingProject && projectStep < 2 && (() => {
                                        const basicValid = !!(formData.client_id && (formData.manager_id || isCurrentManager) && String(formData.name || '').trim() && isDueDateValid(formData.end_date));
                                        const servicesValid = clientServices.length === 0 || (addedScopeIds.length > 0 && selectedTasks.length > 0);
                                        const canGoNext = projectStep === 0 ? basicValid : servicesValid;
                                        return (
                                            <button
                                                type="button"
                                                disabled={!canGoNext}
                                                onClick={() => goToProjectStep(projectStep + 1)}
                                                title={!canGoNext ? (projectStep === 0 ? 'Fill in client, manager, project name and due date first' : 'Add at least one service with + and tick at least one checklist item') : undefined}
                                                style={{ padding: '7px 14px', border: `1px solid ${canGoNext ? '#d1d5db' : '#e2e8f0'}`, borderRadius: 7, background: canGoNext ? '#fff' : '#f1f5f9', color: canGoNext ? '#374151' : '#94a3b8', fontSize: 13, cursor: canGoNext ? 'pointer' : 'not-allowed', fontWeight: 600 }}
                                            >
                                                Next →
                                            </button>
                                        );
                                    })()}
                                </div>
                                <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
                                    <button
                                        type="button"
                                        onClick={() => { setShowModal(false); resetForm(); }}
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
                                    {(editingProject || projectStep === 2) && (
                                        <button
                                            type="submit"
                                            title={editingProject ? 'Update Project' : 'Create Project'}
                                            aria-label={editingProject ? 'Update Project' : 'Create Project'}
                                            style={{
                                                padding: '8px 22px',
                                                background: '#be123c',
                                                border: 'none',
                                                borderRadius: 8,
                                                cursor: 'pointer',
                                                color: '#fff',
                                                fontWeight: 700,
                                                fontSize: 13
                                            }}
                                        >
                                            {editingProject ? 'Update' : 'Save'}
                                        </button>
                                    )}
                                </div>
                            </div>
                        </form>
                    </div>
                </div >
            )
            }

            {/* Floating service-checklist dropdowns (Step 2) — fixed overlay on body, never extends the modal */}
            {showModal && !editingProject && projectStep === 1 && !showClientChoice && typeof document !== 'undefined' && createPortal(
                <>
                    {openScopeIds.map((id) => {
                        const scoped = clientServices.find((s: any) => String(s.service_id) === String(id));
                        const items = Array.isArray(scoped?.checklists) ? scoped.checklists : [];
                        const pos = scopeDropPos[id];
                        if (!scoped || items.length === 0 || !pos) return null;
                        const scopedIds = items.map((cl: any) => normalizeChecklistId(cl.checklist_id)).filter(Boolean);
                        const svcNum = addedScopeIds.indexOf(String(id)) + 1;
                        return (
                            <div
                                key={`scope-drop-${id}`}
                                data-scope-drop={id}
                                style={{
                                    position: 'fixed', left: pos.left, width: pos.width, bottom: pos.bottom, zIndex: 2000,
                                    background: '#fff', border: '2px solid #1e3a8a', borderRadius: 10,
                                    boxShadow: '0 -12px 32px rgba(15, 23, 42, 0.22)',
                                    display: 'flex', flexDirection: 'column', overflow: 'hidden',
                                    maxHeight: pos.maxH,
                                }}
                            >
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', borderBottom: '1px solid #f1f5f9', background: '#fff' }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                        {svcNum > 0 ? `${svcNum}. ` : ''}{scoped.service_name} checklist
                                    </div>
                                    <div style={{ display: 'flex', gap: 12, flexShrink: 0 }}>
                                        <button
                                            type="button"
                                            onClick={() => setSelectedTasks(prev => Array.from(new Set([...prev, ...scopedIds])))}
                                            style={{ background: 'none', border: 'none', color: '#1e3a8a', fontSize: '12px', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                                        >
                                            Select all
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setSelectedTasks(prev => prev.filter(taskId => !scopedIds.includes(taskId)))}
                                            style={{ background: 'none', border: 'none', color: '#64748b', fontSize: '12px', fontWeight: 700, cursor: 'pointer', padding: 0 }}
                                        >
                                            Clear
                                        </button>
                                    </div>
                                </div>
                                <div style={{ overflowY: 'auto', padding: 6 }}>
                                    {items.map((cl: any, itemIdx: number) => {
                                        const checklistId = normalizeChecklistId(cl.checklist_id);
                                        const checked = selectedTasks.includes(checklistId);
                                        return (
                                            <label
                                                key={checklistId || `checklist-${itemIdx}`}
                                                style={{
                                                    display: 'flex', alignItems: 'center', gap: 8,
                                                    borderRadius: 7, padding: '8px 10px', cursor: 'pointer',
                                                    background: checked ? '#eff6ff' : 'transparent',
                                                }}
                                                onMouseEnter={(e) => { if (!checked) e.currentTarget.style.background = '#f8fafc'; }}
                                                onMouseLeave={(e) => { if (!checked) e.currentTarget.style.background = 'transparent'; }}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => handleTaskToggle(checklistId)}
                                                    style={{ margin: 0, flexShrink: 0 }}
                                                />
                                                <span style={{ fontSize: '12px', fontWeight: 700, color: '#94a3b8', minWidth: 20, flexShrink: 0 }}>{itemIdx + 1}.</span>
                                                <span style={{ fontSize: '13px', color: '#333' }}>{cl.task_name}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>
                        );
                    })}
                </>,
                document.body
            )}

            {/* Delete/Archive Confirmation Modal */}
            {showDeleteConfirm && projectToDelete && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '400px', maxWidth: '90%', textAlign: 'center' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>Archive Project?</h3>
                        <p style={{ margin: '0 0 20px 0', color: '#666' }}>
                            Are you sure you want to archive <strong>{projectToDelete.name}</strong>? This will hide it from active lists.
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
                            <button onClick={() => { setShowDeleteConfirm(false); setProjectToDelete(null); }} style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', color: '#666' }}>Cancel</button>
                            <button onClick={handleDeleteConfirm} title="Archive" aria-label="Archive project" style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                <CrudActionIcon action="archive" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Start Project Modal */}
            {startModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}>
                    <div style={{ background: '#fff', borderRadius: '12px', width: '440px', maxWidth: '95%', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
                        {/* Header */}
                        <div style={{ background: '#7c3aed', padding: '20px 24px', color: '#fff' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8, marginBottom: '6px' }}>Start Project</div>
                            <div style={{ fontSize: '18px', fontWeight: 800, lineHeight: 1.2 }}>{startModal.project.name}</div>
                            {startModal.project.client_name && (
                                <div style={{ fontSize: '13px', opacity: 0.85, marginTop: '4px' }}>Client: {startModal.project.client_name}</div>
                            )}
                        </div>

                        {/* Body */}
                        <div style={{ padding: '24px' }}>
                            <p style={{ margin: '0 0 18px 0', fontSize: '13px', color: '#374151', lineHeight: 1.6 }}>
                                Assign a manager then click <strong>Start</strong> to activate this project. Once started it cannot be set back to pending.
                            </p>

                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Assign Manager <span style={{ color: '#dc2626' }}>*</span>
                            </label>
                            <select
                                value={startModal.managerId}
                                onChange={(e) => setStartModal((prev) => prev ? { ...prev, managerId: e.target.value } : prev)}
                                required
                                aria-required="true"
                                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid #d1d5db', fontSize: '14px', color: '#111827', background: '#fff', marginBottom: '20px' }}
                            >
                                <option value="">-- Select Manager --</option>
                                {managers.map((m: any) => (
                                    <option key={m.id} value={String(m.id)}>{m.first_name} {m.last_name}</option>
                                ))}
                            </select>

                            {/* Contract signed toggle */}
                            <label style={{ display: 'block', marginBottom: '6px', fontSize: '12px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                Contract Status
                            </label>
                            <div style={{ display: 'flex', gap: 8, marginBottom: '20px' }}>
                                <button
                                    type="button"
                                    onClick={() => setStartModal((prev) => prev ? { ...prev, contractSigned: true } : prev)}
                                    style={{
                                        flex: 1, padding: '10px 0', borderRadius: '8px', border: `2px solid ${startModal.contractSigned ? '#16a34a' : '#d1d5db'}`,
                                        background: startModal.contractSigned ? '#f0fdf4' : '#fff', color: startModal.contractSigned ? '#15803d' : '#374151',
                                        cursor: 'pointer', fontSize: '13px', fontWeight: 700, transition: 'all 0.15s'
                                    }}
                                >✓ Contract Signed</button>
                                <button
                                    type="button"
                                    onClick={() => setStartModal((prev) => prev ? { ...prev, contractSigned: false } : prev)}
                                    style={{
                                        flex: 1, padding: '10px 0', borderRadius: '8px', border: `2px solid ${!startModal.contractSigned ? '#dc2626' : '#d1d5db'}`,
                                        background: !startModal.contractSigned ? '#fef2f2' : '#fff', color: !startModal.contractSigned ? '#dc2626' : '#374151',
                                        cursor: 'pointer', fontSize: '13px', fontWeight: 700, transition: 'all 0.15s'
                                    }}
                                >✗ Not Signed</button>
                            </div>

                            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                                <button
                                    onClick={() => setStartModal(null)}
                                    disabled={isStarting}
                                    style={{ padding: '9px 18px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', color: '#374151', fontSize: '13px' }}
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={() => void handleStartProject()}
                                    disabled={isStarting || !startModal.managerId}
                                    style={{ padding: '9px 22px', background: !startModal.managerId || isStarting ? '#a78bfa' : '#7c3aed', color: '#fff', border: 'none', borderRadius: '6px', cursor: !startModal.managerId || isStarting ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 700 }}
                                >
                                    {isStarting ? 'Starting…' : '▶ Start Project'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {/* Client Choice Dialog */}
            {showClientChoice && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1200 }}>
                    <div style={{ background: '#fff', borderRadius: '12px', width: '400px', maxWidth: '92%', overflow: 'hidden', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
                        <div style={{ background: '#1e3a8a', padding: '18px 22px', color: '#fff' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8, marginBottom: '4px' }}>Add Client</div>
                            <div style={{ fontSize: '17px', fontWeight: 800 }}>How would you like to proceed?</div>
                        </div>
                        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowClientChoice(false);
                                    // Scroll project form to client dropdown
                                }}
                                style={{
                                    padding: '14px 20px', border: '2px solid #1e3a8a', borderRadius: '10px',
                                    background: '#eff6ff', color: '#1e3a8a', cursor: 'pointer',
                                    fontSize: '14px', fontWeight: 700, textAlign: 'left',
                                    display: 'flex', flexDirection: 'column', gap: '4px'
                                }}
                            >
                                <span>✔ Existing Client</span>
                                <span style={{ fontSize: '12px', fontWeight: 400, color: '#475569' }}>
                                    Pick an existing client from the dropdown in the project form.
                                </span>
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setShowClientChoice(false);
                                    setShowModal(false);
                                    router.push('/clients?action=add&returnTo=/projects');
                                }}
                                style={{
                                    padding: '14px 20px', border: '2px solid #16a34a', borderRadius: '10px',
                                    background: '#f0fdf4', color: '#15803d', cursor: 'pointer',
                                    fontSize: '14px', fontWeight: 700, textAlign: 'left',
                                    display: 'flex', flexDirection: 'column', gap: '4px'
                                }}
                            >
                                <span>+ New Client</span>
                                <span style={{ fontSize: '12px', fontWeight: 400, color: '#475569' }}>
                                    Go to Client Management to create a new client, then return here.
                                </span>
                            </button>
                        </div>
                        <div style={{ padding: '0 22px 18px', display: 'flex', justifyContent: 'flex-end' }}>
                            <button
                                type="button"
                                onClick={() => setShowClientChoice(false)}
                                style={{ background: 'transparent', border: 'none', color: '#64748b', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* New Client Sub-Modal (inline creation) */}
            {showNewClientSubModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1300, padding: '20px' }}>
                    <div style={{ background: '#fff', borderRadius: '12px', width: '640px', maxWidth: '100%', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.25)' }}>
                        {/* Header */}
                        <div style={{ background: '#15803d', padding: '18px 22px', color: '#fff' }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', opacity: 0.8, marginBottom: '4px' }}>New Client</div>
                            <div style={{ fontSize: '17px', fontWeight: 800 }}>Create Client &amp; Auto-Select</div>
                        </div>

                        <div style={{ padding: '22px' }}>
                            {newClientError && (
                                <div style={{ marginBottom: '14px', padding: '10px 14px', background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: '8px', color: '#b91c1c', fontSize: '13px' }}>
                                    {newClientError}
                                </div>
                            )}

                            {/* Company Name */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>
                                    Company Name <span style={{ color: '#dc2626' }}>*</span>
                                </label>
                                <input
                                    type="text"
                                    name="client_name"
                                    value={newClientFormData.client_name}
                                    onChange={handleNewClientInputChange}
                                    placeholder="e.g. Acme Corp"
                                    required
                                    aria-required="true"
                                    aria-invalid={newClientError && !newClientFormData.client_name.trim() ? true : undefined}
                                    style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: newClientError && !newClientFormData.client_name.trim() ? '2px solid #ef4444' : '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff' }}
                                />
                                {newClientError && !newClientFormData.client_name.trim() && (
                                    <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>Required.</div>
                                )}
                            </div>

                            {/* Company Email + Phone */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Company Email</label>
                                    <input
                                        type="email"
                                        name="company_email"
                                        value={newClientFormData.company_email}
                                        onChange={handleNewClientInputChange}
                                        placeholder="company@example.com"
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Company Phone</label>
                                    <PhoneInput
                                        name="company_phone"
                                        value={newClientFormData.company_phone}
                                        onChange={(company_phone) => setNewClientFormData((prev) => ({ ...prev, company_phone }))}
                                        ariaLabel="New client company phone number"
                                        countryAriaLabel="New client company country calling code"
                                    />
                                </div>
                            </div>

                            {/* Contact Person */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Contact First Name</label>
                                    <input
                                        type="text"
                                        name="contact_first_name"
                                        value={newClientFormData.contact_first_name}
                                        onChange={handleNewClientInputChange}
                                        placeholder="First Name"
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Contact Last Name</label>
                                    <input
                                        type="text"
                                        name="contact_last_name"
                                        value={newClientFormData.contact_last_name}
                                        onChange={handleNewClientInputChange}
                                        placeholder="Last Name"
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff' }}
                                    />
                                </div>
                            </div>

                            {/* Contact Email + Phone */}
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Contact Email</label>
                                    <input
                                        type="email"
                                        name="email"
                                        value={newClientFormData.email}
                                        onChange={handleNewClientInputChange}
                                        placeholder="contact@example.com"
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff' }}
                                    />
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Contact Phone</label>
                                    <PhoneInput
                                        name="phone"
                                        value={newClientFormData.phone}
                                        onChange={(phone) => setNewClientFormData((prev) => ({ ...prev, phone }))}
                                        ariaLabel="New client contact phone number"
                                        countryAriaLabel="New client contact country calling code"
                                    />
                                </div>
                            </div>

                            {/* Address */}
                            <div style={{ marginBottom: '14px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Address</label>
                                <textarea
                                    name="address"
                                    value={newClientFormData.address}
                                    onChange={handleNewClientInputChange}
                                    placeholder="Full address"
                                    style={{ width: '100%', padding: '9px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '13px', color: '#111827', background: '#fff', minHeight: '70px', resize: 'vertical' }}
                                />
                            </div>

                            {/* Services */}
                            <div style={{ marginBottom: '18px', border: '1px solid #e2e8f0', borderRadius: '8px', padding: '14px', background: '#f8fafc' }}>
                                <div style={{ fontSize: '13px', fontWeight: 700, color: '#374151', marginBottom: '10px' }}>
                                    Services <span style={{ color: '#dc2626' }}>*</span>
                                    <span style={{ fontSize: '12px', fontWeight: 400, color: '#64748b', marginLeft: 8 }}>Select at least one</span>
                                </div>
                                {newClientAvailableServices.length === 0 ? (
                                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>Loading services…</p>
                                ) : (
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '8px' }}>
                                        {newClientAvailableServices.map((s: any) => {
                                            const sid = Number(s.service_id);
                                            const checked = newClientFormData.service_ids.map(Number).includes(sid);
                                            return (
                                                <label
                                                    key={sid}
                                                    style={{
                                                        display: 'flex', alignItems: 'center', gap: '8px',
                                                        padding: '8px 10px', borderRadius: '6px',
                                                        border: checked ? '1px solid #1e3a8a' : '1px solid #cbd5e1',
                                                        background: checked ? '#eff6ff' : '#fff',
                                                        cursor: 'pointer', fontSize: '13px', color: checked ? '#1e3a8a' : '#374151', fontWeight: checked ? 600 : 400
                                                    }}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={(e) => handleNewClientServiceToggle(sid, e.target.checked)}
                                                        style={{ margin: 0 }}
                                                    />
                                                    {s.service_name}
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}

                                {/* Checklist items for each selected service */}
                                {newClientFormData.service_ids.length > 0 && (() => {
                                    const selectedServices = newClientAvailableServices.filter(
                                        (s: any) => newClientFormData.service_ids.map(Number).includes(Number(s.service_id))
                                    );
                                    const servicesWithChecklists = selectedServices.filter(
                                        (s: any) => Array.isArray(s.checklists) && s.checklists.length > 0
                                    );
                                    if (servicesWithChecklists.length === 0) return null;
                                    return (
                                        <div style={{ marginTop: '14px', borderTop: '1px solid #e2e8f0', paddingTop: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                                            <div style={{ fontSize: '12px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                                Tasks / Checklist Items
                                            </div>
                                            {servicesWithChecklists.map((s: any) => {
                                                const sid = Number(s.service_id);
                                                const selectedIds = newClientServiceChecklist[sid] ?? [];
                                                return (
                                                    <div key={sid}>
                                                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#1e3a8a', marginBottom: '6px' }}>
                                                            {s.service_name}
                                                        </div>
                                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '6px' }}>
                                                            {s.checklists.map((cl: any) => {
                                                                const clId = Number(cl.checklist_id);
                                                                const clChecked = selectedIds.includes(clId);
                                                                return (
                                                                    <label
                                                                        key={clId}
                                                                        style={{
                                                                            display: 'flex', alignItems: 'center', gap: '7px',
                                                                            padding: '6px 10px', borderRadius: '6px',
                                                                            border: clChecked ? '1px solid #1d4ed8' : '1px solid #cbd5e1',
                                                                            background: clChecked ? '#eff6ff' : '#fff',
                                                                            cursor: 'pointer', fontSize: '12px',
                                                                            color: clChecked ? '#1e40af' : '#374151',
                                                                            fontWeight: clChecked ? 600 : 400,
                                                                        }}
                                                                    >
                                                                        <input
                                                                            type="checkbox"
                                                                            checked={clChecked}
                                                                            onChange={(e) => handleNewClientChecklistToggle(sid, clId, e.target.checked)}
                                                                            style={{ margin: 0, accentColor: '#1e3a8a' }}
                                                                        />
                                                                        {cl.task_name}
                                                                    </label>
                                                                );
                                                            })}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    );
                                })()}
                            </div>

                            {/* Footer buttons */}
                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                                <button
                                    type="button"
                                    onClick={() => setShowNewClientSubModal(false)}
                                    disabled={isCreatingClient}
                                    style={{ padding: '9px 18px', background: 'transparent', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', color: '#374151', fontSize: '13px' }}
                                >
                                    Back
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleCreateNewClientInline()}
                                    disabled={isCreatingClient}
                                    style={{
                                        padding: '9px 22px',
                                        background: isCreatingClient ? '#86efac' : '#15803d',
                                        color: '#fff', border: 'none', borderRadius: '6px',
                                        cursor: isCreatingClient ? 'not-allowed' : 'pointer',
                                        fontSize: '13px', fontWeight: 700
                                    }}
                                >
                                    {isCreatingClient ? 'Creating…' : 'Create & Select'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Layout >
    );
}
