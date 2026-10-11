import { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import FloatingListPanel from '../../components/FloatingListPanel';
import EditedBadge from '../../components/EditedBadge';
import PhoneInput from '@/components/PhoneInput';
import { useEditedIndicator } from '../../components/useEditedIndicator';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import {
    DEFAULT_PHONE_COUNTRY_CODE,
    formatPhoneDisplay,
    getPhoneInputDefault,
    isPhoneDraftEmpty,
    normalizeInternationalPhoneNumber,
    sanitizeInternationalPhoneDraft,
} from '@/utils/phone';

type ServiceChecklistItem = {
    checklist_id: number;
    task_name: string;
    description?: string | null;
    is_deleted?: number | boolean;
};

type AvailableService = {
    service_id: number;
    service_name: string;
    description?: string | null;
    checklists?: ServiceChecklistItem[];
    selected_checklist_ids?: number[] | null;
};

type ManagerOption = {
    id: number | string;
    first_name?: string | null;
    last_name?: string | null;
    status?: string | null;
};

type ClientServiceAssignment = AvailableService;
type ClientAdditionalContact = {
    first_name: string;
    last_name: string;
    email: string;
    phone: string;
};

type ProjectPromptClient = {
    client_id: number;
    client_name: string;
    project_name: string;
    manager_id: string;
    end_date: string;
    custom_tasks: number[];
    contract_sent?: boolean;
    pending_agreement?: boolean;
    contract_note?: string;
};

const buildClientProjectName = (clientName: unknown, services: unknown): string => {
    const normalizedClient = String(clientName ?? '').replace(/\s+/g, ' ').trim();
    const serviceNames = (Array.isArray(services) ? services : [])
        .map((service: any) => String(service?.service_name ?? '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .sort((a: string, b: string) => a.toLowerCase().localeCompare(b.toLowerCase()));
    if (!normalizedClient && serviceNames.length === 0) return '';
    if (serviceNames.length === 0) return normalizedClient;
    if (!normalizedClient) return serviceNames.join(' / ');
    return `${normalizedClient} - ${serviceNames.join(' / ')}`;
};

const createEmptyAdditionalContact = (): ClientAdditionalContact => ({
    first_name: '',
    last_name: '',
    email: '',
    phone: DEFAULT_PHONE_COUNTRY_CODE
});

const normalizeClientContactText = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

const formatClientContactName = (contact: ClientAdditionalContact) => (
    [contact.first_name, contact.last_name].map(normalizeClientContactText).filter(Boolean).join(' ').trim()
);

const parseClientAdditionalContacts = (raw: unknown): ClientAdditionalContact[] => {
    let source = raw;

    if (!source) return [];

    if (typeof source === 'string') {
        const trimmed = source.trim();
        if (!trimmed) return [];

        try {
            source = JSON.parse(trimmed);
        } catch {
            return [];
        }
    }

    if (source && typeof source === 'object' && !Array.isArray(source)) {
        const sourceObject = source as any;
        if (Array.isArray(sourceObject.additional_contacts)) {
            source = sourceObject.additional_contacts;
        } else if (Array.isArray(sourceObject.additional)) {
            source = sourceObject.additional;
        } else if (Array.isArray(sourceObject.contacts)) {
            source = sourceObject.contacts;
        } else {
            source = [];
        }
    }

    if (!Array.isArray(source)) return [];

    return source
        .map((contact: any) => ({
            first_name: normalizeClientContactText(contact?.first_name ?? contact?.firstName ?? ''),
            last_name: normalizeClientContactText(contact?.last_name ?? contact?.lastName ?? ''),
            email: String(contact?.email ?? '').trim(),
            phone: String(contact?.phone ?? contact?.contact_number ?? contact?.contactNumber ?? '').trim()
        }))
        .filter((contact) => contact.first_name || contact.last_name || contact.email || contact.phone);
};

function toDateTimeLocalValue(value: Date) {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
}

function getDefaultProjectDueDateValue() {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(17, 0, 0, 0);
    return toDateTimeLocalValue(nextWeek);
}

function resolveDefaultManagerId(source: ManagerOption[], user: any) {
    const activeManagers = Array.isArray(source)
        ? source.filter((manager) => String(manager?.status || 'active') !== 'inactive')
        : [];
    const currentUserId = String(user?.id || '');
    const currentUserRole = String(user?.role || '').trim().toLowerCase();

    if (currentUserRole === 'manager') {
        const currentManager = activeManagers.find((manager) => String(manager?.id) === currentUserId);
        if (currentManager) {
            return String(currentManager.id);
        }
    }

    if (activeManagers.length === 1) {
        return String(activeManagers[0].id);
    }

    return '';
}

export default function Clients() {
    const router = useRouter();
    const API_BASE = getApiBaseUrl();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [user, setUser] = useState<any>(null);
    const [clients, setClients] = useState<any[]>([]);
    const { editedItems, markEdited } = useEditedIndicator();
    const [availableServices, setAvailableServices] = useState<AvailableService[]>([]);
    const [loading, setLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);
    const [clientTableDensity, setClientTableDensity] = useState<'compact' | 'default' | 'comfortable'>('compact');

    // Filters
    const [filterService, setFilterService] = useState('');       // service_id string or ''
    const [filterProjects, setFilterProjects] = useState('');     // '' | 'has' | 'none'
    const [filterClientStatus, setFilterClientStatus] = useState(''); // '' | 'active' | 'inactive'
    const [filterRegFrom, setFilterRegFrom] = useState('');       // YYYY-MM-DD
    const [filterRegTo, setFilterRegTo] = useState('');           // YYYY-MM-DD
    const [showFilters, setShowFilters] = useState(false);

    // Modals
    const [showModal, setShowModal] = useState(false);
    const [editingClient, setEditingClient] = useState<any>(null);
    const [viewClient, setViewClient] = useState<any>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [showArchiveAllConfirm, setShowArchiveAllConfirm] = useState(false);
    const [clientToDelete, setClientToDelete] = useState<any>(null);
    const [projectPromptClient, setProjectPromptClient] = useState<ProjectPromptClient | null>(null);
    const [managers, setManagers] = useState<ManagerOption[]>([]);
    const [isCreatingProject, setIsCreatingProject] = useState(false);
    const [collapsedViewServiceChecklistIds, setCollapsedViewServiceChecklistIds] = useState<number[]>([]);
    const [activeViewChecklistServiceId, setActiveViewChecklistServiceId] = useState<number | null>(null);
    const [selectedClientForProjects, setSelectedClientForProjects] = useState<any>(null);
    const [clientProjects, setClientProjects] = useState<any[]>([]);
    const [isLoadingProjects, setIsLoadingProjects] = useState(false);
    const [isArchivingAll, setIsArchivingAll] = useState(false);
    // Row actions kebab menu: client_id of the row whose ⋮ menu is open (null = closed).
    const [openActionsMenuId, setOpenActionsMenuId] = useState<any>(null);
    // Fixed overlay position of the open kebab menu (rendered via portal so table overflow can't clip it).
    const [openActionsMenuPos, setOpenActionsMenuPos] = useState<{ top: number; left: number; dir: 'up' | 'down' } | null>(null);

    // Close the row actions dropdown on outside click / Escape / scroll / resize.
    // (The menu is a fixed overlay, so any scroll would leave it detached.)
    useEffect(() => {
        if (openActionsMenuId === null) return;
        const closeActionsMenu = () => { setOpenActionsMenuId(null); setOpenActionsMenuPos(null); };
        const onDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && target.closest('[data-actions-menu]')) return;
            closeActionsMenu();
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeActionsMenu(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('scroll', closeActionsMenu, true);
        window.addEventListener('resize', closeActionsMenu);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
            window.removeEventListener('scroll', closeActionsMenu, true);
            window.removeEventListener('resize', closeActionsMenu);
        };
    }, [openActionsMenuId]);

    // Row actions shown inside the row's 3-dots dropdown menu.
    const clientRowActions = (client: any) => ([
        String(client.latest_contract_status || '').toLowerCase() === 'accepted' && Number(client.project_count || 0) <= 0
            ? { label: 'Create Project', icon: 'create', color: '#15803d', run: openAcceptedClientProjectPrompt }
            : null,
        { label: 'View', icon: 'view', color: '#1d4ed8', run: openViewModal },
        { label: 'Edit', icon: 'edit', color: '#0f766e', run: openEditModal },
        { label: 'Archive', icon: 'archive', color: '#dc2626', run: handleArchiveClick }
    ].filter(Boolean) as { label: string; icon: any; color: string; run: (client: any) => void }[]);

    // Open (or toggle) the row actions menu as a fixed overlay positioned at the kebab button.
    // A fixed portal overlay can't be clipped by the table cell's `overflow: hidden`.
    const toggleActionsMenu = (client: any, event: React.MouseEvent<HTMLButtonElement>) => {
        if (openActionsMenuId === client.client_id) {
            setOpenActionsMenuId(null);
            setOpenActionsMenuPos(null);
            return;
        }
        const rect = event.currentTarget.getBoundingClientRect();
        const MENU_W = 190;
        const MENU_H = Math.max(48, clientRowActions(client).length * 42 + 16);
        const gap = 6;
        const openUp = rect.bottom + gap + MENU_H > window.innerHeight && rect.top - gap - MENU_H > 0;
        setOpenActionsMenuId(client.client_id);
        setOpenActionsMenuPos({
            top: openUp ? rect.top - gap - MENU_H : rect.bottom + gap,
            left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
            dir: openUp ? 'up' : 'down'
        });
    };

    // Form Data
    const [formData, setFormData] = useState({
        client_name: '',
        contact_first_name: '',
        contact_last_name: '',
        company_email: '',
        company_phone: DEFAULT_PHONE_COUNTRY_CODE,
        email: '',
        phone: DEFAULT_PHONE_COUNTRY_CODE,
        additional_contacts: [] as ClientAdditionalContact[],
        address: '',
        service_ids: [] as number[]
    });
    const [checklistDraftByService, setChecklistDraftByService] = useState<Record<number, { task_name: string; description: string }>>({});
    const [collapsedServiceChecklistIds, setCollapsedServiceChecklistIds] = useState<number[]>([]);
    const [activeChecklistServiceId, setActiveChecklistServiceId] = useState<number | null>(null);
    const [selectedChecklistItems, setSelectedChecklistItems] = useState<Record<number, number[]>>({});  // serviceId -> [checklistIds]
    const [checklistSearch, setChecklistSearch] = useState('');
    // Floating full-detail view for a checklist task (opened via double-click).
    const [floatingTask, setFloatingTask] = useState<{ task_name: string; description: string; service_name: string } | null>(null);
    // On edit, services stay locked until the user clicks Edit Services.
    const [servicesEditable, setServicesEditable] = useState(true);
    // Modal active tab: 'basic' | 'contact' | 'services'
    const [modalTab, setModalTab] = useState<'basic' | 'contact' | 'services'>('basic');
    // Inline per-field "Required" messages for the Add/Edit Client form.
    const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
    // Inline per-field "Required" messages for the Create Project dialog.
    const [projectPromptErrors, setProjectPromptErrors] = useState<Record<string, string>>({});

    const clearFieldError = (name: string) => {
        setFieldErrors((prev) => {
            if (!prev[name]) return prev;
            const next = { ...prev };
            delete next[name];
            return next;
        });
    };

    // Address autocomplete (OpenStreetMap Nominatim, same as Branches)
    type AddressSuggestion = { display_name: string; lat: string; lon: string };
    const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([]);
    const [addressSearching, setAddressSearching] = useState(false);
    const [showAddressDropdown, setShowAddressDropdown] = useState(false);
    const addressDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const addressAnchorRef = useRef<HTMLTextAreaElement | null>(null);
    // Floating position of the address dropdown (portal on body so the modal never clips it).
    const [addrDropPos, setAddrDropPos] = useState<{ left: number; width: number; maxH: number; top?: number; bottom?: number } | null>(null);
    const addrDropPosKey = useRef('');

    const updateAddrDropPos = useCallback(() => {
        if (typeof window === 'undefined') return;
        const el = addressAnchorRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const width = Math.min(Math.max(r.width, 280), window.innerWidth - 16);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        const roomBelow = window.innerHeight - r.bottom - 8;
        let pos: { left: number; width: number; maxH: number; top?: number; bottom?: number };
        if (roomBelow >= 200) {
            pos = { left: Math.round(left), width: Math.round(width), maxH: Math.round(Math.min(260, roomBelow)), top: Math.round(r.bottom + 4) };
        } else {
            // Dropup: not enough room below, open above the field.
            pos = { left: Math.round(left), width: Math.round(width), maxH: Math.round(Math.max(140, Math.min(260, r.top - 16))), bottom: Math.round(Math.max(8, window.innerHeight - r.top + 4)) };
        }
        const key = JSON.stringify(pos);
        if (key !== addrDropPosKey.current) {
            addrDropPosKey.current = key;
            setAddrDropPos(pos);
        }
    }, []);

    // Keep the floating address dropdown positioned; dismiss on outside click / Escape.
    useEffect(() => {
        if (!showModal || modalTab !== 'basic' || !showAddressDropdown || addressSuggestions.length === 0) return;
        updateAddrDropPos();
        const t = window.setTimeout(updateAddrDropPos, 50);
        const onDown = (e: MouseEvent) => {
            const target = e.target as HTMLElement | null;
            if (target && (target.closest('[data-addr-drop]') || target.closest('[data-addr-anchor]'))) return;
            setShowAddressDropdown(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAddressDropdown(false); };
        let raf = 0;
        const onMove = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(updateAddrDropPos); };
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
    }, [showModal, modalTab, showAddressDropdown, addressSuggestions, updateAddrDropPos]);

    const searchAddress = useCallback((query: string) => {
        if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
        if (!query.trim() || query.trim().length < 3) {
            setAddressSuggestions([]);
            setShowAddressDropdown(false);
            return;
        }
        addressDebounceRef.current = setTimeout(async () => {
            setAddressSearching(true);
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=0`,
                    { headers: { 'Accept-Language': 'en' } }
                );
                const results: AddressSuggestion[] = await res.json();
                setAddressSuggestions(results);
                setShowAddressDropdown(results.length > 0);
            } catch {
                setAddressSuggestions([]);
            } finally {
                setAddressSearching(false);
            }
        }, 500);
    }, []);

    const handleAddressInputChange = (e: any) => {
        const value = String(e.target.value ?? '');
        setFormData((prev) => ({ ...prev, address: value }));
        searchAddress(value);
    };

    const acceptAddressSuggestion = (suggestion: AddressSuggestion) => {
        setFormData((prev) => ({ ...prev, address: suggestion.display_name }));
        setShowAddressDropdown(false);
        setAddressSuggestions([]);
    };

    // Clear any pending address search on unmount.
    useEffect(() => {
        return () => {
            if (addressDebounceRef.current) clearTimeout(addressDebounceRef.current);
        };
    }, []);

    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');


    // Live-sync: silently refresh client data in background.
    useLiveSync(async () => {
        if (!user) return;
        await Promise.all([fetchClients(), fetchAvailableServices(), fetchManagers()]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    useEffect(() => {
        checkSession();
    }, []);

    // Auto-open add modal when ?action=add is in URL
    useEffect(() => {
        if (!router.isReady) return;

        const action = router.query.action;
        if (action === 'add') {
            openAddModal();
            // Clean up the URL (keep returnTo in state via sessionStorage, not URL)
            const returnTo = String(router.query.returnTo || '').trim();
            if (returnTo) {
                try { sessionStorage.setItem('clientFormReturnTo', returnTo); } catch { /* ignore */ }
            }
            router.replace('/clients', undefined, { shallow: true });
        }
    }, [router.isReady, router.query.action]);

    // Auto-open edit modal when ?edit=<client_id> is in URL
    useEffect(() => {
        if (!router.isReady || clients.length === 0) return;

        const editClientId = router.query.edit;
        if (editClientId) {
            const clientToEdit = clients.find(c => String(c.client_id) === String(editClientId));
            if (clientToEdit) {
                openEditModal(clientToEdit);
                // Clean up the URL without the edit parameter
                router.replace('/clients', undefined, { shallow: true });
            }
        }
    }, [router.isReady, router.query.edit, clients]);

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

    const projectPromptClientId = Number(projectPromptClient?.client_id || 0);
    const projectPromptManagerId = String(projectPromptClient?.manager_id || '');
    const currentUserId = Number(user?.id || 0);
    const currentUserRole = String(user?.role || '');

    useEffect(() => {
        if (!projectPromptClientId || projectPromptManagerId) return;

        const defaultManagerId = resolveDefaultManagerId(managers, { id: currentUserId, role: currentUserRole });
        if (!defaultManagerId) return;

        setProjectPromptClient((prev) => (
            prev ? { ...prev, manager_id: defaultManagerId } : prev
        ));
    }, [currentUserId, currentUserRole, managers, projectPromptClientId, projectPromptManagerId]);

    const checkSession = async () => {
        try {
            // Start data fetches optimistically in parallel with auth (auth is
            // served from the in-memory cache after the first page load).
            const [authRes] = await Promise.all([
                fetch(`${API_BASE}/auth.php`, { credentials: 'include' }),
                fetchClients(),
                fetchAvailableServices(),
                fetchManagers(),
            ]);
            const data = await authRes.json();
            if (data.success) {
                setUser(data.data);
            } else {
                router.push('/');
            }
        } catch {
            router.push('/');
        } finally {
            setLoading(false);
        }
    };

    const fetchClients = async () => {
        try {
            const res = await fetch(`${API_BASE}/clients.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setClients(data.data);
        } catch (err) { console.error('Failed to fetch clients'); }
    };

    const fetchAvailableServices = async () => {
        try {
            const res = await fetch(`${API_BASE}/services.php?checklists=1`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) {
                const activeServices = (Array.isArray(data.data) ? data.data : [])
                    .filter((s: AvailableService) => {
                        const desc = String(s.description ?? '').trim().toUpperCase();
                        return !desc.startsWith('[ARCHIVED]');
                    })
                    .map((s: AvailableService) => ({
                        ...s,
                        // PHP/mysqli often returns numeric IDs as strings; normalize so edit selection matches.
                        service_id: Number(s.service_id),
                        checklists: Array.isArray(s.checklists)
                            ? s.checklists
                                .filter((cl: ServiceChecklistItem) => Number(cl?.is_deleted || 0) !== 1)
                                .map((cl: ServiceChecklistItem) => ({
                                    ...cl,
                                    checklist_id: Number(cl.checklist_id)
                                }))
                            : []
                    }))
                    .filter((s: AvailableService) => Number.isFinite(s.service_id) && s.service_id > 0);
                setAvailableServices(activeServices);
            }
        } catch (err) { console.error('Failed to fetch services'); }
    };

    const fetchManagers = async () => {
        try {
            const res = await fetch(`${API_BASE}/users.php?role=manager&status=active`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setManagers(Array.isArray(data.data) ? data.data : []);
        } catch { console.error('Failed to fetch managers'); }
    };

    const handleInputChange = (e: any) => {
        const { name, value } = e.target;
        setFormData({
            ...formData,
            [name]: value
        });
        clearFieldError(name);
    };

    const addAdditionalContact = () => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: [...prev.additional_contacts, createEmptyAdditionalContact()]
        }));
    };

    const updateAdditionalContact = (index: number, field: keyof ClientAdditionalContact, value: string) => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: prev.additional_contacts.map((contact, i) => (
                i === index
                    ? { ...contact, [field]: value }
                    : contact
            ))
        }));
    };

    const removeAdditionalContact = (index: number) => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: prev.additional_contacts.filter((_, i) => i !== index)
        }));
    };

    const splitContactPerson = (value: string) => {
        const normalized = String(value || '').trim().replace(/\s+/g, ' ');
        if (!normalized) {
            return { first: '', last: '' };
        }

        const parts = normalized.split(' ');
        return {
            first: parts[0] || '',
            last: parts.slice(1).join(' ')
        };
    };

    const resetForm = () => {
        setFormData({
            client_name: '',
            contact_first_name: '',
            contact_last_name: '',
            company_email: '',
            company_phone: DEFAULT_PHONE_COUNTRY_CODE,
            email: '',
            phone: DEFAULT_PHONE_COUNTRY_CODE,
            additional_contacts: [],
            address: '',
            service_ids: []
        });
        setChecklistDraftByService({});
        setCollapsedServiceChecklistIds([]);
        setSelectedChecklistItems({});
        setActiveChecklistServiceId(null);
        setServicesEditable(true);
        setAddressSuggestions([]);
        setShowAddressDropdown(false);
        setEditingClient(null);
        setError('');
        setSuccess('');
        setFieldErrors({});
    };


    const handleServiceSelectionChange = (serviceId: number, checked: boolean) => {
        const normalizedServiceId = Number(serviceId);
        const nextServiceIds = checked
            ? Array.from(new Set([...formData.service_ids.map(Number), normalizedServiceId]))
            : formData.service_ids.map(Number).filter(id => id !== normalizedServiceId);

        setFormData(prev => ({
            ...prev,
            service_ids: nextServiceIds
        }));

        if (checked) {
            setActiveChecklistServiceId(prev => prev ?? normalizedServiceId);
        } else {
            setActiveChecklistServiceId(prev =>
                Number(prev) === normalizedServiceId
                    ? (nextServiceIds.length > 0 ? nextServiceIds[0] : null)
                    : prev
            );
        }

        if (!checked) {
            setChecklistDraftByService(prev => {
                const next = { ...prev };
                delete next[normalizedServiceId];
                return next;
            });
            setCollapsedServiceChecklistIds(prev => prev.filter(id => Number(id) !== normalizedServiceId));
            setSelectedChecklistItems(prev => {
                const next = { ...prev };
                delete next[normalizedServiceId];
                return next;
            });
        } else {
            setCollapsedServiceChecklistIds(prev => prev.filter(id => Number(id) !== normalizedServiceId));
        }
    };

    const updateChecklistDraft = (serviceId: number, field: 'task_name' | 'description', value: string) => {
        setChecklistDraftByService(prev => ({
            ...prev,
            [serviceId]: {
                task_name: prev[serviceId]?.task_name ?? '',
                description: prev[serviceId]?.description ?? '',
                [field]: value
            }
        }));
    };

    const handleAddChecklistTask = async (serviceId: number) => {
        const draft = checklistDraftByService[serviceId] || { task_name: '', description: '' };
        const task_name = String(draft.task_name || '').trim();
        const description = String(draft.description || '').trim();

        if (!task_name) {
            setError('Task name is required to add a checklist item.');
            return;
        }

        setError('');
        setSuccess('');

        try {
            const res = await fetch(`${API_BASE}/services.php?type=checklist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ service_id: serviceId, task_name, description, is_required: 1 })
            });
            const data = await res.json();

            if (data.success) {
                setChecklistDraftByService(prev => ({
                    ...prev,
                    [serviceId]: { task_name: '', description: '' }
                }));
                setSuccess('Checklist item added and saved permanently.');
                await fetchAvailableServices();
            } else {
                setError(data.message || 'Failed to add checklist item.');
            }
        } catch (err) {
            setError('An error occurred while adding checklist item.');
        }
    };

    const toggleServiceChecklistCollapse = (serviceId: number) => {
        setCollapsedServiceChecklistIds(prev =>
            prev.includes(serviceId)
                ? prev.filter(id => id !== serviceId)
                : [...prev, serviceId]
        );
    };

    const toggleChecklistItem = (serviceId: number, checklistId: number) => {
        setSelectedChecklistItems(prev => {
            const current = prev[serviceId] || [];
            const isSelected = current.includes(checklistId);

            return {
                ...prev,
                [serviceId]: isSelected
                    ? current.filter(id => id !== checklistId)
                    : [...current, checklistId]
            };
        });
    };

    const isChecklistItemSelected = (serviceId: number, checklistId: number): boolean => {
        return (selectedChecklistItems[serviceId] || []).includes(checklistId);
    };

    const handleRemoveChecklistTask = async (checklistId: number, taskName: string) => {
        const confirmed = typeof window === 'undefined'
            ? true
            : await confirmAction({
                title: 'Remove checklist task?',
                text: `Remove checklist task "${taskName}"?`,
                confirmButtonText: 'Remove',
                icon: 'warning',
                danger: true,
            });
        if (!confirmed) return;

        setError('');
        setSuccess('');

        try {
            const res = await fetch(`${API_BASE}/services.php?type=checklist&id=${checklistId}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await res.json();
            if (data.success) {
                setSuccess('Checklist item removed successfully.');
                await fetchAvailableServices();
            } else {
                setError(data.message || 'Failed to remove checklist item.');
            }
        } catch (err) {
            setError('An error occurred while removing checklist item.');
        }
    };

    const openAddModal = () => {
        resetForm();
        setServicesEditable(true);
        setModalTab('basic');
        setShowModal(true);
    };

    const openEditModal = async (c: any) => {
        let client = c;
        const clientId = Number(c?.client_id || 0);

        // Fetch the current assignment rows instead of relying only on the list snapshot.
        if (clientId > 0) {
            try {
                const res = await fetch(`${API_BASE}/clients.php?id=${encodeURIComponent(clientId)}`, {
                    credentials: 'include'
                });
                const data = await res.json();
                if (data.success && data.data) {
                    client = { ...c, ...data.data };
                }
            } catch {
                // The list row is still usable if the detail request fails.
            }
        }

        const contact = splitContactPerson(client.contact_person || '');
        const additionalContacts = parseClientAdditionalContacts(client.additional_contacts);
        const clientServices: ClientServiceAssignment[] = Array.isArray(client.services) ? client.services : [];
        const assignedServiceIds = Array.from(new Set<number>([
            ...clientServices.map((service: any) => Number(
                service?.service_id ?? service?.serviceId ?? service?.id
            )),
            ...(Array.isArray(client.service_ids) ? client.service_ids.map((id: unknown) => Number(id)) : [])
        ].filter((id: number): id is number => Number.isFinite(id) && id > 0)));

        setEditingClient(client);
        setServicesEditable(false);
        setFormData({
            client_name: client.client_name || '',
            contact_first_name: contact.first,
            contact_last_name: contact.last,
            company_email: client.company_email || '',
            company_phone: getPhoneInputDefault(client.company_phone),
            email: client.email || '',
            phone: getPhoneInputDefault(client.phone),
            additional_contacts: additionalContacts.map((additionalContact) => ({
                ...additionalContact,
                phone: getPhoneInputDefault(additionalContact.phone)
            })),
            address: client.address || '',
            service_ids: assignedServiceIds
        });
        const initialServiceId = assignedServiceIds.length > 0 ? assignedServiceIds[0] : null;
        setActiveChecklistServiceId(initialServiceId);
        setError('');
        setSuccess('');
        setChecklistDraftByService({});
        setCollapsedServiceChecklistIds([]);
        const selectedChecklistItemsByService: Record<number, number[]> = {};
        clientServices.forEach((service: any) => {
            const serviceId = Number(service?.service_id);
            const selectedIds = Array.isArray(service?.selected_checklist_ids)
                ? service.selected_checklist_ids
                : [];
            if (serviceId > 0 && selectedIds.length > 0) {
                selectedChecklistItemsByService[serviceId] = Array.from(new Set(
                    selectedIds.map((id: unknown) => Number(id)).filter((id: number) => Number.isFinite(id) && id > 0)
                ));
            }
        });
        setSelectedChecklistItems(selectedChecklistItemsByService);
        setAddressSuggestions([]);
        setShowAddressDropdown(false);
        setModalTab('basic');
        setShowModal(true);
        // Project auto-creation happens on successful Update when the client still has no project.
    };


    const openViewModal = (c: any) => {
        setViewClient(c);
        setCollapsedViewServiceChecklistIds([]);
        const initialServiceId = c.services && c.services.length > 0 ? Number(c.services[0].service_id) : null;
        setActiveViewChecklistServiceId(initialServiceId);
    };

    const closeViewModal = () => {
        setViewClient(null);
        setCollapsedViewServiceChecklistIds([]);
        setActiveViewChecklistServiceId(null);
    };

    const toggleViewServiceChecklistCollapse = (serviceId: number) => {
        setCollapsedViewServiceChecklistIds(prev =>
            prev.includes(serviceId)
                ? prev.filter(id => id !== serviceId)
                : [...prev, serviceId]
        );
    };

    const getServiceChecklistItems = (serviceId: number) => {
        const service = availableServices.find((s) => Number(s.service_id) === Number(serviceId));
        return Array.isArray(service?.checklists) ? service.checklists : [];
    };

    const handleSubmit = async (e: any) => {
        e.preventDefault();
        setError('');
        setSuccess('');

        // Required-field check with inline per-field messages (jumps to the tab holding the first gap).
        const missing: Record<string, string> = {};
        if (!String(formData.client_name || '').trim()) missing.client_name = 'Required.';
        if (!String(formData.company_email || '').trim()) missing.company_email = 'Required.';
        if (!String(formData.email || '').trim()) missing.email = 'Required.';
        if (Object.keys(missing).length > 0) {
            setFieldErrors(missing);
            if (missing.client_name || missing.company_email) setModalTab('basic');
            else if (missing.email) setModalTab('contact');
            return;
        }
        setFieldErrors({});

        if (!Array.isArray(formData.service_ids) || formData.service_ids.length === 0) {
            setError('Please select at least one service.');
            return;
        }

        const normalizedPhone = normalizeInternationalPhoneNumber(formData.phone, DEFAULT_PHONE_COUNTRY_CODE);
        if (!isPhoneDraftEmpty(formData.phone, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedPhone) {
            setError('Contact person phone number must be a valid international number with a country code, like +63985 323 4710.');
            return;
        }

        const normalizedCompanyPhone = normalizeInternationalPhoneNumber(formData.company_phone, DEFAULT_PHONE_COUNTRY_CODE);
        if (!isPhoneDraftEmpty(formData.company_phone, DEFAULT_PHONE_COUNTRY_CODE) && !normalizedCompanyPhone) {
            setError('Company phone number must be a valid international number with a country code, like +63985 323 4710.');
            return;
        }

        const normalizedAdditionalContacts: ClientAdditionalContact[] = [];
        for (let i = 0; i < formData.additional_contacts.length; i += 1) {
            const contact = formData.additional_contacts[i];
            const firstName = normalizeClientContactText(contact.first_name);
            const lastName = normalizeClientContactText(contact.last_name);
            const email = String(contact.email || '').trim();
            const hasPhoneDraft = !isPhoneDraftEmpty(contact.phone, DEFAULT_PHONE_COUNTRY_CODE);
            const normalizedAdditionalPhone = normalizeInternationalPhoneNumber(contact.phone, DEFAULT_PHONE_COUNTRY_CODE);

            if (hasPhoneDraft && !normalizedAdditionalPhone) {
                setError(`Additional contact #${i + 1} phone number must be a valid international number with a country code, like +63985 323 4710.`);
                return;
            }

            if (!firstName && !lastName && !email && !normalizedAdditionalPhone) {
                continue;
            }

            normalizedAdditionalContacts.push({
                first_name: firstName,
                last_name: lastName,
                email,
                phone: normalizedAdditionalPhone || ''
            });
        }

        try {
            const isEdit = !!editingClient;
            const url = `${API_BASE}/clients.php`;
            const method = isEdit ? 'PUT' : 'POST';
            const contact_person = `${formData.contact_first_name} ${formData.contact_last_name}`.trim();
            const service_assignments = formData.service_ids.map((serviceId) => ({
                service_id: serviceId,
                selected_checklist_ids: selectedChecklistItems[Number(serviceId)] || []
            }));
            const selectedChecklistIdsForProject = Array.from(new Set(
                Object.values(selectedChecklistItems)
                    .flat()
                    .map(Number)
                    .filter((id) => Number.isFinite(id) && id > 0)
            ));
            const basePayload = {
                client_name: formData.client_name,
                contact_first_name: formData.contact_first_name,
                contact_last_name: formData.contact_last_name,
                contact_person,
                company_email: formData.company_email,
                company_phone: normalizedCompanyPhone || '',
                email: formData.email,
                phone: normalizedPhone || '',
                additional_contacts: normalizedAdditionalContacts,
                address: formData.address,
                service_ids: formData.service_ids,
                service_assignments
            };

            const payload = isEdit
                ? { ...basePayload, client_id: editingClient.client_id }
                : basePayload;

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            // Read as text first: a non-JSON reply (e.g. a 500 HTML page)
            // would otherwise throw inside res.json() and hide the real cause.
            const rawBody = await res.text();
            let data: any = null;
            if (rawBody) {
                try {
                    data = JSON.parse(rawBody);
                } catch {
                    throw new Error(`Server returned ${res.status}: ${rawBody.slice(0, 200)}`);
                }
            }
            if (!data) {
                throw new Error(`Server returned ${res.status} with an empty response.`);
            }

            if (data.success) {
                const defaultSuccess = isEdit ? 'Client updated successfully!' : 'Client added successfully!';
                const selectedServiceIds = formData.service_ids.map(Number).filter((id) => Number.isFinite(id) && id > 0);
                const assignedServices = selectedServiceIds.map((serviceId) => {
                    const fromAvailable = availableServices.find((s) => Number(s.service_id) === serviceId);
                    return {
                        service_id: serviceId,
                        service_name: fromAvailable?.service_name || `Service #${serviceId}`,
                        description: fromAvailable?.description ?? null,
                        selected_checklist_ids: selectedChecklistItems[serviceId] || []
                    };
                });
                const editedClientSnapshot = isEdit && editingClient ? { ...editingClient } : null;
                setShowModal(false);
                resetForm();

                if (isEdit && editedClientSnapshot) {
                    const editedClientId = Number(editedClientSnapshot.client_id || 0);
                    const existingProjectCount = Number(editedClientSnapshot.project_count || 0);
                    const needsProjectSetup =
                        existingProjectCount <= 0
                        || editedClientSnapshot.needs_project_setup === 1
                        || editedClientSnapshot.needs_project_setup === '1'
                        || editedClientSnapshot.needs_project_setup === true;

                    // Keep services array in local state so re-opening edit shows current selections.
                    setClients((prev) =>
                        (prev || []).map((c) =>
                            Number(c.client_id) === editedClientId
                                ? {
                                    ...c,
                                    client_name: payload.client_name,
                                    contact_person: payload.contact_person,
                                    company_email: payload.company_email,
                                    company_phone: payload.company_phone,
                                    email: payload.email,
                                    phone: payload.phone,
                                    additional_contacts: payload.additional_contacts,
                                    address: payload.address,
                                    services: assignedServices
                                }
                                : c
                        )
                    );
                    markEdited(editedClientId);

                    if (needsProjectSetup && editedClientId > 0) {
                        setSuccess('Client updated. Project setup remains locked until the client accepts the contract from their email.');
                    } else {
                        setSuccess(data.message || defaultSuccess);
                    }

                    // Re-sync from server so renewal fields and assignment status stay accurate.
                    void fetchClients();
                } else {
                    // Optimistic insert for POST
                    const newClient = {
                        client_id: Number(data?.data?.client_id || 0),
                        client_name: String(payload.client_name || '').trim(),
                        contact_person: payload.contact_person || '',
                        company_email: payload.company_email || '',
                        company_phone: payload.company_phone || '',
                        email: payload.email || '',
                        phone: payload.phone || '',
                        additional_contacts: payload.additional_contacts || [],
                        address: payload.address || '',
                        status: 'active',
                        registration_date: new Date().toISOString().split('T')[0],
                        needs_project_setup: 0,
                        project_count: 1,
                        services: assignedServices
                    };
                    setClients((prev) => [newClient, ...(prev || [])]);
                    void fetchClients();

                    // If the user arrived here from another page (e.g. Projects), redirect back.
                    let returnTo = '';
                    try { returnTo = sessionStorage.getItem('clientFormReturnTo') || ''; } catch { /* ignore */ }
                    if (returnTo) {
                        try { sessionStorage.removeItem('clientFormReturnTo'); } catch { /* ignore */ }
                        void notifySuccess(`Client "${String(payload.client_name || '').trim()}" created successfully.`);
                        router.push(returnTo);
                        return;
                    }

                    // No auto-generated contract — admin uploads the signed contract from Contract Management.
                    setSuccess(data.message || 'Client added successfully.');
                }
            } else {

                setError(data.message || `Failed to ${isEdit ? 'update' : 'add'} client`);
            }
        } catch (err) {
            console.error(err);
            setError(err instanceof Error && err.message ? err.message : 'An error occurred');
        }
    };

    const handleCreateProjectForClient = async () => {
        if (!projectPromptClient) return;

        if (projectPromptClient.pending_agreement) {
            setError('Project creation is pending until the client accepts the agreement from their email.');
            return;
        }

        const trimmedProjectName = String(projectPromptClient.project_name || '').replace(/\s+/g, ' ').trim();
        const promptMissing: Record<string, string> = {};
        if (!trimmedProjectName) promptMissing.project_name = 'Required.';
        if (!projectPromptClient.manager_id) promptMissing.manager_id = 'Required.';
        if (!projectPromptClient.end_date) promptMissing.end_date = 'Required.';
        if (Object.keys(promptMissing).length > 0) {
            setProjectPromptErrors(promptMissing);
            return;
        }
        setProjectPromptErrors({});

        setIsCreatingProject(true);

        try {
            const res = await fetch(`${API_BASE}/projects.php`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    name: trimmedProjectName,
                    client_id: projectPromptClient.client_id,
                    manager_id: Number(projectPromptClient.manager_id),
                    end_date: projectPromptClient.end_date,
                    custom_tasks: projectPromptClient.custom_tasks
                })
            });
            const raw = await res.text();
            let data: any = null;
            try {
                data = raw ? JSON.parse(raw) : null;
            } catch {
                data = null;
            }

            if (!res.ok || !data?.success) {
                const messageFromPayload = String(data?.message || '').trim();
                const messageFromBody = raw && !messageFromPayload
                    ? raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
                    : '';
                setError(
                    messageFromPayload
                    || messageFromBody
                    || 'Failed to create project for this client.'
                );
                return;
            }

            const createdProjectId = Number(data?.data?.project_id || 0);
            const promptClientName = projectPromptClient.client_name;
            const promptClientId = projectPromptClient.client_id;

            // Clear the needs_project_setup flag after successful project creation
            try {
                await fetch(`${API_BASE}/clients.php`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        client_id: promptClientId,
                        needs_project_setup: 0
                    })
                });
            } catch (err) {
                console.error('Failed to update needs_project_setup flag:', err);
            }

            setProjectPromptClient(null);
            setProjectPromptErrors({});
            // Update the single client's flag locally — no need to refetch the whole list
            setClients((prev: any[]) => prev.map((cl: any) =>
                Number(cl.client_id) === promptClientId ? { ...cl, needs_project_setup: 0 } : cl
            ));
            setSuccess(`Project created for ${promptClientName}.`);

            if (createdProjectId > 0) {
                await router.push(`/projects/detail?id=${createdProjectId}`);
            }
        } catch {
            setError('An error occurred while creating the project.');
        } finally {
            setIsCreatingProject(false);
        }
    };

    const openAcceptedClientProjectPrompt = (client: any) => {
        const clientId = Number(client?.client_id || 0);
        if (clientId <= 0) return;

        const checklistIds: number[] = Array.from(new Set(
            (Array.isArray(client?.services) ? client.services : [])
                .flatMap((service: any) => Array.isArray(service?.selected_checklist_ids) ? service.selected_checklist_ids : [])
                .map(Number)
                .filter((id: number) => Number.isFinite(id) && id > 0)
        ));

        setProjectPromptClient({
            client_id: clientId,
            client_name: String(client?.client_name || 'this client'),
            project_name: buildClientProjectName(client?.client_name, client?.services),
            manager_id: resolveDefaultManagerId(managers, user),
            end_date: getDefaultProjectDueDateValue(),
            custom_tasks: checklistIds,
            pending_agreement: false,
            contract_sent: true,
            contract_note: 'Agreement accepted.'
        });
    };

    const handleSkipProjectCreation = async () => {
        if (!projectPromptClient) return;

        const promptClient = projectPromptClient;

        if (promptClient.pending_agreement) {
            setProjectPromptClient(null);
            setProjectPromptErrors({});
            setSuccess(`Project setup for ${promptClient.client_name} is pending until the agreement is accepted.`);
            return;
        }

        // Clear the needs_project_setup flag when user explicitly skips
        try {
            await fetch(`${API_BASE}/clients.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({
                    client_id: promptClient.client_id,
                    needs_project_setup: 0
                })
            });
        } catch (err) {
            console.error('Failed to update needs_project_setup flag:', err);
        }

        setProjectPromptClient(null);
        // Update the single client's flag locally — no need to refetch the whole list
        setClients((prev: any[]) => prev.map((cl: any) =>
            Number(cl.client_id) === promptClient.client_id ? { ...cl, needs_project_setup: 0 } : cl
        ));
        setSuccess(`Client ${promptClient.client_name} created successfully.`);
    };

    const handleProjectPromptChange = (field: 'manager_id' | 'end_date' | 'project_name', value: string) => {
        setProjectPromptClient((prev) => (
            prev ? { ...prev, [field]: value } : prev
        ));
        setProjectPromptErrors((prev) => {
            if (!prev[field]) return prev;
            const next = { ...prev };
            delete next[field];
            return next;
        });
    };

    const handleArchiveClick = (c: any) => {
        setClientToDelete(c);
        setShowDeleteConfirm(true);
    };

    const handleDeleteConfirm = async () => {
        if (!clientToDelete) return;

        try {
            const url = `${API_BASE}/clients.php?id=${clientToDelete.client_id}`;
            const res = await fetch(url, { method: 'DELETE', credentials: 'include' });
            const data = await res.json();

            if (data.success) {
                setClients((prev) =>
                    (prev || []).map((c) =>
                        c.client_id === clientToDelete.client_id ? { ...c, status: 'inactive' } : c
                    )
                );
                setShowDeleteConfirm(false);
                setClientToDelete(null);
            } else {
                alert(data.message || 'Failed to archive client');
            }
        } catch (err) {
            alert('An error occurred while archiving');
        }
    };

    const doRestoreClient = async (clientId: number) => {
        try {
            const res = await fetch(`${API_BASE}/clients.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ client_id: clientId, status: 'active' })
            });
            const data = await res.json();
            if (data.success) {
                setClients((prev) =>
                    (prev || []).map((c) =>
                        c.client_id === clientId ? { ...c, status: 'active' } : c
                    )
                );
            }
        } catch (err) { alert('Error restoring client'); }
    };

    const handleRestore = async (clientId: number) => {
        const target = clients.find(c => c.client_id === clientId);
        const label = target?.client_name || 'this client';
        const confirmed = await confirmAction({
            title: `Restore ${label}?`,
            text: 'This client will be returned to active clients.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        await doRestoreClient(clientId);
    };

    const handleArchiveAll = async () => {
        const active = clients.filter(c => c.status === 'active');

        if (active.length === 0) {
            alert('No active clients available to archive.');
            return;
        }

        setShowArchiveAllConfirm(true);
    };

    const handleArchiveAllConfirm = async () => {
        const active = clients.filter(c => c.status === 'active');

        if (active.length === 0) {
            setShowArchiveAllConfirm(false);
            alert('No active clients available to archive.');
            return;
        }

        setIsArchivingAll(true);

        for (const c of active) {
            try {
                const res = await fetch(`${API_BASE}/clients.php?id=${c.client_id}`, {
                    method: 'DELETE',
                    credentials: 'include'
                });
                const data = await res.json();
                if (data.success) {
                    // Continue with next client
                }
            } catch (err) {
                console.error('Failed to archive client', c.client_id, err);
            }
        }
        setClients((prev) =>
            (prev || []).map((c) =>
                active.some((a) => a.client_id === c.client_id) ? { ...c, status: 'inactive' } : c
            )
        );
        setIsArchivingAll(false);
        setShowArchiveAllConfirm(false);
    };

    const handleRestoreAll = async () => {
        const archived = clients.filter(c => c.status === 'inactive');
        if (archived.length === 0) {
            alert('No archived clients to restore.');
            return;
        }
        const confirmed = await confirmAction({
            title: 'Restore all archived clients?',
            text: `This will restore ${archived.length} archived client(s) to active.`,
            confirmButtonText: 'Yes, restore all',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        for (const c of archived) { await doRestoreClient(c.client_id); }
        setClients((prev) =>
            (prev || []).map((c) =>
                archived.some((a) => a.client_id === c.client_id) ? { ...c, status: 'active' } : c
            )
        );
    };

    const handleClientClick = async (c: any) => {
        if (selectedClientForProjects?.client_id === c.client_id) {
            setSelectedClientForProjects(null);
            setClientProjects([]);
            return;
        }

        setSelectedClientForProjects(c);
        setIsLoadingProjects(true);
        setClientProjects([]);

        try {
            const res = await fetch(`${API_BASE}/projects.php?client_id=${c.client_id}`, { credentials: 'include' });
            const data = await res.json();
            if (data.success && Array.isArray(data.data)) {
                setClientProjects(data.data);
            } else {
                setClientProjects([]);
            }
        } catch {
            setClientProjects([]);
        } finally {
            setIsLoadingProjects(false);
        }
    };

    // Filter clients
    const activeClients = clients.filter(c => c.status === 'active');
    const archivedClients = clients.filter(c => c.status === 'inactive');

    const activeFilterCount = [filterService, filterProjects, filterClientStatus, filterRegFrom, filterRegTo].filter(Boolean).length;

    const normalizedSearchTerm = searchTerm.toLowerCase();
    const normalizedSearchDigits = searchTerm.replace(/[\s-]+/g, '').toLowerCase();
    const filtered = (showArchiveView ? archivedClients : activeClients).filter(c => {
        // Search term
        if (normalizedSearchTerm) {
            const matchesSearch =
                (c.client_name?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.contact_person?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.email?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.company_email?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.phone?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.company_phone?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (formatPhoneDisplay(c.phone)?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (formatPhoneDisplay(c.company_phone)?.toLowerCase() || '').includes(normalizedSearchTerm) ||
                (c.phone?.toLowerCase() || '').includes(normalizedSearchDigits) ||
                (c.company_phone?.toLowerCase() || '').includes(normalizedSearchDigits) ||
                parseClientAdditionalContacts(c.additional_contacts).some((contact) =>
                    [formatClientContactName(contact), contact.email, contact.phone, formatPhoneDisplay(contact.phone)].some((value) =>
                        String(value || '').toLowerCase().includes(normalizedSearchTerm)
                    )
                );
            if (!matchesSearch) return false;
        }

        // Service filter
        if (filterService) {
            const clientServiceIds = Array.isArray(c.services)
                ? (c.services as any[]).map((s: any) => String(s.service_id))
                : [];
            if (!clientServiceIds.includes(filterService)) return false;
        }

        // Projects filter
        if (filterProjects === 'has' && !(Number(c.project_count || 0) > 0)) return false;
        if (filterProjects === 'none' && Number(c.project_count || 0) > 0) return false;

        // Client status filter (only meaningful on active view — archive view is always inactive)
        if (!showArchiveView && filterClientStatus && c.status !== filterClientStatus) return false;

        // Registration date range
        if (filterRegFrom || filterRegTo) {
            const regDate = c.registration_date ? c.registration_date.slice(0, 10) : '';
            if (filterRegFrom && regDate < filterRegFrom) return false;
            if (filterRegTo && regDate > filterRegTo) return false;
        }

        return true;
    });
    const clientSearchCorpus = collectSearchTerms(clients, [
        (c: any) => c.client_name,
        (c: any) => c.contact_person,
        (c: any) => c.email,
        (c: any) => c.company_email,
        (c: any) => c.phone,
        (c: any) => c.company_phone,
    ]);
    const paginatedClients = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        setCurrentPage(1);
    }, [showArchiveView, searchTerm, filterService, filterProjects, filterClientStatus, filterRegFrom, filterRegTo]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [filtered.length, currentPage]);

    useEffect(() => {
        if (formData.service_ids.length === 0) {
            if (activeChecklistServiceId !== null) setActiveChecklistServiceId(null);
            return;
        }

        const hasActive = formData.service_ids.some(id => Number(id) === Number(activeChecklistServiceId));
        if (!hasActive) {
            setActiveChecklistServiceId(Number(formData.service_ids[0]));
        }
    }, [formData.service_ids, activeChecklistServiceId]);

    useEffect(() => {
        const clientServices: ClientServiceAssignment[] = Array.isArray(viewClient?.services) ? viewClient.services : [];
        if (clientServices.length === 0) {
            if (activeViewChecklistServiceId !== null) setActiveViewChecklistServiceId(null);
            return;
        }

        const hasActive = clientServices.some((s) => Number(s.service_id) === Number(activeViewChecklistServiceId));
        if (!hasActive) {
            setActiveViewChecklistServiceId(Number(clientServices[0].service_id));
        }
    }, [viewClient, activeViewChecklistServiceId]);

    const selectedServiceIdSet = new Set(formData.service_ids.map(Number));
    const selectedServices = availableServices.filter((s) => selectedServiceIdSet.has(Number(s.service_id)));
    const isServiceSelected = (serviceId: number | string) => selectedServiceIdSet.has(Number(serviceId));
    const canEditServices = !editingClient || servicesEditable;

    const viewClientServices: ClientServiceAssignment[] = Array.isArray(viewClient?.services) ? viewClient.services : [];
    const activeFormChecklistService = selectedServices.find((s) => Number(s.service_id) === Number(activeChecklistServiceId)) || null;
    const activeViewChecklistService = viewClientServices.find((s) => Number(s.service_id) === Number(activeViewChecklistServiceId)) || null;
    const activeFormChecklistItems = Array.isArray(activeFormChecklistService?.checklists) ? activeFormChecklistService.checklists : [];
    const activeViewChecklistItems = activeViewChecklistService ? (() => {
        const all = getServiceChecklistItems(activeViewChecklistService.service_id);
        const selectedIds = Array.isArray(activeViewChecklistService.selected_checklist_ids)
            ? activeViewChecklistService.selected_checklist_ids.map(Number)
            : [];
        if (selectedIds.length === 0) return all;
        return all.filter((item: any) => selectedIds.includes(Number(item.checklist_id)));
    })() : [];
    const isActiveFormChecklistCollapsed = activeFormChecklistService ? collapsedServiceChecklistIds.includes(activeFormChecklistService.service_id) : false;
    const isActiveViewChecklistCollapsed = activeViewChecklistService ? collapsedViewServiceChecklistIds.includes(activeViewChecklistService.service_id) : false;
    const activeFormChecklistDraft = activeFormChecklistService
        ? (checklistDraftByService[activeFormChecklistService.service_id] || { task_name: '', description: '' })
        : { task_name: '', description: '' };
    const viewAdditionalContacts = parseClientAdditionalContacts(viewClient?.additional_contacts);

    const tableHeaderStyle = { padding: '12px 15px', textAlign: 'left' as const, borderBottom: '2px solid #e2e8f0', color: '#4a5568', fontWeight: 'bold', fontSize: '14px' };
    const tableCellStyle = { padding: '12px 15px', borderBottom: '1px solid #e2e8f0', color: '#2d3748', fontSize: '14px' };

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
            <Head>
                <title>{showArchiveView ? 'Archived Clients' : 'Client Management'}</title>
            </Head>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <h1 style={{ fontSize: '18px', fontWeight: 'bold', color: '#1a202c', margin: 0 }}>
                        {showArchiveView ? 'Archived Clients' : 'Client Management'}
                    </h1>
                    {!showArchiveView && (
                        <button
                            className="app-action-btn app-action-btn-primary"
                            onClick={openAddModal}
                            title="Add Client"
                            aria-label="Add Client"
                            style={{ height: '40px', padding: '0 18px', fontWeight: 'bold', fontSize: '13px', whiteSpace: 'nowrap', flex: '0 0 auto' }}
                        >
                            Add Client
                        </button>
                    )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    <button
                        className="app-action-btn"
                        onClick={() => setShowArchiveView(!showArchiveView)}
                        title={showArchiveView ? 'Back to Active Clients' : 'View Archived Clients'}
                        style={{ whiteSpace: 'nowrap', flex: '0 0 auto', height: '36px', padding: '0 12px' }}
                    >
                        {showArchiveView ? 'Back to Active' : `Archive (${archivedClients.length})`}
                    </button>
                    {!showArchiveView ? (
                        <>
                            {activeClients.length > 0 && (
                                <button
                                    className="app-action-btn app-action-btn-danger"
                                    onClick={handleArchiveAll}
                                    title="Archive All"
                                    aria-label="Archive All"
                                    style={{ whiteSpace: 'nowrap', flex: '0 0 auto', height: '36px', padding: '0 16px' }}
                                >
                                    <CrudActionIcon action="archive" />
                                    Archive All
                                </button>
                            )}
                        </>
                    ) : (
                        <>
                            {archivedClients.length > 0 && (
                                <button
                                    className="app-action-btn app-action-btn-success"
                                    onClick={handleRestoreAll}
                                    title="Restore All"
                                    aria-label="Restore All clients"
                                    style={{ whiteSpace: 'nowrap', flex: '0 0 auto', height: '36px', padding: '0 16px' }}
                                >
                                    <CrudActionIcon action="restore" />
                                    Restore All
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            {/* Search + Filter Bar */}
            <div style={{ marginBottom: '16px', background: '#fff', border: '1px solid #e2e8f0', borderRadius: '12px', padding: '12px 14px', boxShadow: '0 1px 2px rgba(15,23,42,0.04)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                    {/* Search */}
                    <div style={{ flex: '1 1 220px', minWidth: '160px' }}>
                        <SearchBar
                            storageKey="clients:list"
                            placeholder="Search clients..."
                            ariaLabel="Search clients"
                            value={searchTerm}
                            onChange={setSearchTerm}
                            suggestions={clientSearchCorpus}
                            inputStyle={{ height: '38px', borderColor: '#cbd5e1', fontSize: '13px' }}
                        />
                    </div>

                    {/* Toggle filters button */}
                    <button
                        type="button"
                        onClick={() => setShowFilters((p) => !p)}
                        style={{
                            height: '38px',
                            padding: '0 14px',
                            borderRadius: '8px',
                            border: `1px solid ${activeFilterCount > 0 ? '#1e3a8a' : '#cbd5e1'}`,
                            background: activeFilterCount > 0 ? '#eff6ff' : '#f8fafc',
                            color: activeFilterCount > 0 ? '#1e3a8a' : '#475569',
                            fontSize: '13px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
                        </svg>
                        Filters
                        {activeFilterCount > 0 && (
                            <span style={{
                                minWidth: '18px', height: '18px', borderRadius: '999px',
                                background: '#1e3a8a', color: '#fff',
                                fontSize: '11px', fontWeight: 800,
                                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px'
                            }}>
                                {activeFilterCount}
                            </span>
                        )}
                    </button>

                    {/* Result count */}
                    <span style={{ fontSize: '12px', color: '#64748b', whiteSpace: 'nowrap' }}>
                        <strong style={{ color: '#0f172a' }}>{filtered.length}</strong> client{filtered.length !== 1 ? 's' : ''}
                    </span>

                    <button
                        type="button"
                        className="clients-density-toggle"
                        onClick={() => setClientTableDensity((current) => current === 'compact' ? 'default' : current === 'default' ? 'comfortable' : 'compact')}
                        title="Cycle table density: compact, default, comfortable"
                        aria-label={`Table density: ${clientTableDensity}. Click to change.`}
                    >
                        Density: {clientTableDensity === 'default' ? 'Default' : clientTableDensity.charAt(0).toUpperCase() + clientTableDensity.slice(1)}
                    </button>

                    {/* Clear all filters */}
                    {(activeFilterCount > 0 || searchTerm) && (
                        <button
                            type="button"
                            onClick={() => {
                                setSearchTerm('');
                                setFilterService('');
                                setFilterProjects('');
                                setFilterClientStatus('');
                                setFilterRegFrom('');
                                setFilterRegTo('');
                            }}
                            style={{
                                height: '38px',
                                padding: '0 12px',
                                borderRadius: '8px',
                                border: '1px solid #fca5a5',
                                background: '#fef2f2',
                                color: '#b91c1c',
                                fontSize: '12px',
                                fontWeight: 600,
                                cursor: 'pointer',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            Clear all
                        </button>
                    )}
                </div>

                {/* Expanded filter row */}
                {showFilters && (
                    <div style={{
                        marginTop: '12px',
                        paddingTop: '12px',
                        borderTop: '1px solid #f1f5f9',
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                        gap: '10px',
                    }}>
                        {/* Service */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Service</span>
                            <select
                                value={filterService}
                                onChange={(e) => setFilterService(e.target.value)}
                                style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${filterService ? '#1e3a8a' : '#cbd5e1'}`, background: filterService ? '#eff6ff' : '#fff', fontSize: '13px', color: '#0f172a' }}
                            >
                                <option value="">All Services</option>
                                {availableServices.map((s) => (
                                    <option key={s.service_id} value={String(s.service_id)}>{s.service_name}</option>
                                ))}
                            </select>
                        </label>

                        {/* Projects */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Projects</span>
                            <select
                                value={filterProjects}
                                onChange={(e) => setFilterProjects(e.target.value)}
                                style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${filterProjects ? '#1e3a8a' : '#cbd5e1'}`, background: filterProjects ? '#eff6ff' : '#fff', fontSize: '13px', color: '#0f172a' }}
                            >
                                <option value="">All Clients</option>
                                <option value="has">Has Projects</option>
                                <option value="none">No Projects</option>
                            </select>
                        </label>

                        {/* Client Status (only relevant when not in archive view) */}
                        {!showArchiveView && (
                            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</span>
                                <select
                                    value={filterClientStatus}
                                    onChange={(e) => setFilterClientStatus(e.target.value)}
                                    style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${filterClientStatus ? '#1e3a8a' : '#cbd5e1'}`, background: filterClientStatus ? '#eff6ff' : '#fff', fontSize: '13px', color: '#0f172a' }}
                                >
                                    <option value="">All Statuses</option>
                                    <option value="active">Active</option>
                                    <option value="inactive">Inactive</option>
                                </select>
                            </label>
                        )}

                        {/* Registered From */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Registered From</span>
                            <input
                                type="date"
                                value={filterRegFrom}
                                onChange={(e) => setFilterRegFrom(e.target.value)}
                                style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${filterRegFrom ? '#1e3a8a' : '#cbd5e1'}`, background: filterRegFrom ? '#eff6ff' : '#fff', fontSize: '13px', color: '#0f172a' }}
                            />
                        </label>

                        {/* Registered To */}
                        <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                            <span style={{ fontSize: '11px', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Registered To</span>
                            <input
                                type="date"
                                value={filterRegTo}
                                onChange={(e) => setFilterRegTo(e.target.value)}
                                style={{ height: '36px', padding: '0 10px', borderRadius: '7px', border: `1px solid ${filterRegTo ? '#1e3a8a' : '#cbd5e1'}`, background: filterRegTo ? '#eff6ff' : '#fff', fontSize: '13px', color: '#0f172a' }}
                            />
                        </label>
                    </div>
                )}

                {/* Active filter chips */}
                {activeFilterCount > 0 && (
                    <div style={{ marginTop: '10px', display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                        {filterService && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1e3a8a', fontSize: '12px', fontWeight: 600, border: '1px solid #bfdbfe' }}>
                                Service: {availableServices.find((s) => String(s.service_id) === filterService)?.service_name ?? filterService}
                                <button type="button" onClick={() => setFilterService('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a8a', padding: 0, lineHeight: 1, fontWeight: 800, fontSize: '13px' }}>×</button>
                            </span>
                        )}
                        {filterProjects && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1e3a8a', fontSize: '12px', fontWeight: 600, border: '1px solid #bfdbfe' }}>
                                Projects: {filterProjects === 'has' ? 'Has Projects' : 'No Projects'}
                                <button type="button" onClick={() => setFilterProjects('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a8a', padding: 0, lineHeight: 1, fontWeight: 800, fontSize: '13px' }}>×</button>
                            </span>
                        )}
                        {filterClientStatus && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1e3a8a', fontSize: '12px', fontWeight: 600, border: '1px solid #bfdbfe', textTransform: 'capitalize' }}>
                                Status: {filterClientStatus}
                                <button type="button" onClick={() => setFilterClientStatus('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a8a', padding: 0, lineHeight: 1, fontWeight: 800, fontSize: '13px' }}>×</button>
                            </span>
                        )}
                        {filterRegFrom && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1e3a8a', fontSize: '12px', fontWeight: 600, border: '1px solid #bfdbfe' }}>
                                From: {filterRegFrom}
                                <button type="button" onClick={() => setFilterRegFrom('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a8a', padding: 0, lineHeight: 1, fontWeight: 800, fontSize: '13px' }}>×</button>
                            </span>
                        )}
                        {filterRegTo && (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px', padding: '3px 10px', borderRadius: '999px', background: '#eff6ff', color: '#1e3a8a', fontSize: '12px', fontWeight: 600, border: '1px solid #bfdbfe' }}>
                                To: {filterRegTo}
                                <button type="button" onClick={() => setFilterRegTo('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#1e3a8a', padding: 0, lineHeight: 1, fontWeight: 800, fontSize: '13px' }}>×</button>
                            </span>
                        )}
                    </div>
                )}
            </div>



            {/* Clients Table */}
            <div className="clients-list-shell" style={{ background: 'white', borderRadius: '10px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'visible' }}>
                <table className="llb-table llb-pin-first clients-list-table" data-density={clientTableDensity} style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
                    <colgroup>
                        <col style={{ width: '22%' }} />
                        <col style={{ width: '14%' }} />
                        <col style={{ width: '18%' }} />
                        <col />
                        <col style={{ width: '64px' }} />
                        <col style={{ width: '84px' }} />
                        <col style={{ width: showArchiveView ? '70px' : '132px' }} />
                    </colgroup>
                    <thead style={{ background: '#f8fafc' }}>
                        <tr>
                            <th style={tableHeaderStyle}>Client Name</th>
                            <th style={tableHeaderStyle}>Contact</th>
                            <th style={tableHeaderStyle}>Services</th>
                            <th style={tableHeaderStyle}>Contact Details</th>
                            <th style={tableHeaderStyle} className="llb-num">Projects</th>
                            <th style={tableHeaderStyle}>Status</th>
                            <th style={{ ...tableHeaderStyle, textAlign: 'center' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {filtered.length === 0 ? (
                            <tr>
                                <td colSpan={7} style={{ padding: '8px', textAlign: 'center', color: '#666', fontSize: '14px' }}>
                                    {showArchiveView && !searchTerm.trim() ? 'No archived clients.' : (
                                        <ZeroResults
                                            query={searchTerm}
                                            itemLabel="clients"
                                            alternatives={getAlternativeSuggestions(searchTerm, clientSearchCorpus)}
                                            onPickAlternative={(term) => setSearchTerm(term)}
                                            onClear={() => setSearchTerm('')}
                                        />
                                    )}
                                </td>
                            </tr>
                        ) : paginatedClients.map((c: any, clientRowIndex: number) => (
                            <tr key={c.client_id} style={{ transition: 'background-color 0.2s' }}>
                                <td style={tableCellStyle}>
                                    <div
                                        className="llb-ellipsis"
                                        style={{ fontWeight: 'bold', cursor: 'pointer', color: '#1e3a8a', display: 'flex', alignItems: 'center', gap: '5px', whiteSpace: 'nowrap' }}
                                        onClick={() => handleClientClick(c)}
                                        title={`${c.client_name} — registered ${c.registration_date ? new Date(c.registration_date).toLocaleDateString() : 'date unavailable'}`}
                                    >
                                        <span className="llb-ellipsis">{c.client_name}</span>
                                        <EditedBadge editedAt={editedItems.get(c.client_id)} compact />
                                        <span style={{ color: '#94a3b8', fontSize: '10px', fontWeight: 500, flexShrink: 0 }}>
                                            {c.registration_date ? new Date(c.registration_date).toLocaleDateString() : '-'}
                                        </span>
                                    </div>
                                </td>
                                <td style={tableCellStyle}>
                                    <div className="llb-ellipsis" title={c.contact_person || '-'} style={{ whiteSpace: 'nowrap' }}>
                                        {c.contact_person || '-'}
                                        {parseClientAdditionalContacts(c.additional_contacts).length > 0 && (
                                            <span style={{ marginLeft: '5px', color: '#64748b', fontSize: '10px' }}>
                                                +{parseClientAdditionalContacts(c.additional_contacts).length}
                                            </span>
                                        )}
                                    </div>
                                </td>
                                <td style={tableCellStyle} className="llb-trunc" title={Array.isArray(c.services) ? (c.services as ClientServiceAssignment[]).map((s) => s.service_name).join(' - ') : ''}>
                                    {c.services && c.services.length > 0
                                        ? (c.services as ClientServiceAssignment[]).map((s) => s.service_name).join(' - ')
                                        : '-'}
                                </td>
                                <td style={tableCellStyle}>
                                    <div
                                        className="llb-ellipsis"
                                        title={[c.company_email, formatPhoneDisplay(c.company_phone), c.email, formatPhoneDisplay(c.phone)].filter(Boolean).join(' • ') || '-'}
                                        style={{ fontSize: '12px', whiteSpace: 'nowrap' }}
                                    >
                                        {[c.email || c.company_email, formatPhoneDisplay(c.phone) || formatPhoneDisplay(c.company_phone)].filter(Boolean).join(' • ') || '-'}
                                    </div>
                                </td>
                                <td style={tableCellStyle} className="llb-num">
                                    <span style={{ background: '#eff6ff', color: '#1e3a8a', padding: '2px 8px', borderRadius: '10px', fontSize: '12px', fontWeight: 'bold' }}>
                                        {c.project_count || 0}
                                    </span>
                                </td>
                                <td style={tableCellStyle}>
                                    {!showArchiveView ? (
                                        <select
                                            id={`client-status-${c.client_id}`}
                                            value={c.status}
                                            aria-label={`Status for ${c.client_name}`}
                                            onChange={async (event) => {
                                                const newStatus = event.target.value;
                                                setClients((previous: any[]) => previous.map((client: any) =>
                                                    client.client_id === c.client_id ? { ...client, status: newStatus } : client
                                                ));
                                                markEdited(c.client_id);
                                                try {
                                                    await fetch(`${API_BASE}/clients.php`, {
                                                        method: 'PUT',
                                                        headers: { 'Content-Type': 'application/json' },
                                                        credentials: 'include',
                                                        body: JSON.stringify({ client_id: c.client_id, status: newStatus })
                                                    });
                                                } catch { /* optimistic state remains visible */ }
                                            }}
                                        >
                                            <option value="active">Active</option>
                                            <option value="inactive">Inactive</option>
                                        </select>
                                    ) : (
                                        <span className="clients-archived-label">Archived</span>
                                    )}
                                </td>
                                <td style={{ ...tableCellStyle, textAlign: 'center', position: 'relative' }} className="llb-actions">
                                    {showArchiveView ? (
                                        <div style={{ display: 'flex', justifyContent: 'center' }}>
                                            <button
                                                onClick={() => handleRestore(c.client_id)}
                                                title="Restore"
                                                aria-label={`Restore ${c.client_name}`}
                                                style={{
                                                    width: '34px',
                                                    height: '34px',
                                                    background: '#16a34a',
                                                    color: 'white',
                                                    border: 'none',
                                                    borderRadius: '8px',
                                                    cursor: 'pointer',
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center'
                                                }}
                                            >
                                                <CrudActionIcon action="restore" />
                                            </button>
                                        </div>
                                    ) : (
                                        <div
                                            data-actions-menu
                                            style={{ display: 'flex', justifyContent: 'center' }}
                                        >
                                            <button
                                                onClick={(event) => toggleActionsMenu(c, event)}
                                                title="Actions"
                                                aria-label={`Actions for ${c.client_name}`}
                                                aria-haspopup="menu"
                                                aria-expanded={openActionsMenuId === c.client_id}
                                                style={{
                                                    width: '34px',
                                                    height: '34px',
                                                    background: openActionsMenuId === c.client_id ? '#e2e8f0' : '#f8fafc',
                                                    color: '#475569',
                                                    border: '1px solid #e2e8f0',
                                                    borderRadius: '8px',
                                                    cursor: 'pointer',
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center'
                                                }}
                                            >
                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                                    <circle cx="12" cy="5" r="2" />
                                                    <circle cx="12" cy="12" r="2" />
                                                    <circle cx="12" cy="19" r="2" />
                                                </svg>
                                            </button>
                                        </div>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pagination
                currentPage={currentPage}
                totalItems={filtered.length}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setCurrentPage}
                label={showArchiveView ? 'archived clients' : 'clients'}
            />

            {openActionsMenuId !== null && openActionsMenuPos !== null && typeof document !== 'undefined' && (() => {
                const openClient = (clients || []).find((row: any) => row.client_id === openActionsMenuId);
                if (!openClient) return null;
                const runAndClose = (fn: (client: any) => void) => {
                    setOpenActionsMenuId(null);
                    setOpenActionsMenuPos(null);
                    fn(openClient);
                };
                return createPortal(
                    <div
                        data-actions-menu
                        role="menu"
                        aria-label={`Actions for ${openClient.client_name}`}
                        className="clients-actions-menu"
                        data-direction={openActionsMenuPos.dir}
                        style={{ top: openActionsMenuPos.top, left: openActionsMenuPos.left }}
                    >
                        {clientRowActions(openClient).map((item) => (
                            <button
                                key={item.label}
                                role="menuitem"
                                onClick={() => runAndClose(item.run)}
                                style={{ color: item.color }}
                            >
                                <CrudActionIcon action={item.icon} />
                                <span>{item.label}</span>
                            </button>
                        ))}
                    </div>,
                    document.body
                );
            })()}

            {selectedClientForProjects && (
                <FloatingListPanel
                    open={!!selectedClientForProjects}
                    onClose={() => { setSelectedClientForProjects(null); setClientProjects([]); }}
                    title={selectedClientForProjects.client_name}
                    description="Select a project to open its details."
                    width="480px"
                >
                    {isLoadingProjects ? (
                        <div style={{ padding: '12px', color: '#64748b' }}>Loading projects...</div>
                    ) : clientProjects.length === 0 ? (
                        <div style={{ padding: '12px', color: '#94a3b8' }}>No projects found for this client.</div>
                    ) : (
                        <div style={{ display: 'grid', gap: '6px' }}>
                            {clientProjects.map((project: any) => (
                                <button
                                    key={project.id}
                                    type="button"
                                    onClick={() => router.push(`/projects/detail?id=${project.id}`)}
                                    style={{
                                        textAlign: 'left',
                                        padding: '10px 12px',
                                        borderRadius: '10px',
                                        border: '1px solid #e2e8f0',
                                        background: '#ffffff',
                                        color: '#0f172a',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: '10px'
                                    }}
                                >
                                    <span style={{ fontWeight: 600, fontSize: '13px' }}>{project.name}</span>
                                    <span style={{ fontSize: '11px', color: project.status === 'completed' ? '#15803d' : project.status === 'in_progress' ? '#1d4ed8' : '#64748b', textTransform: 'capitalize' }}>
                                        {project.status || 'active'}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                </FloatingListPanel>
            )}

            {floatingTask && (
                <FloatingListPanel
                    open={floatingTask !== null}
                    onClose={() => setFloatingTask(null)}
                    title={floatingTask.task_name}
                    description={floatingTask.service_name ? `From service: ${floatingTask.service_name}` : undefined}
                    width="min(560px, 94vw)"
                >
                    <div style={{ paddingTop: 16 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                            Description
                        </div>
                        <div style={{ fontSize: 14, lineHeight: 1.7, color: '#0f172a', whiteSpace: 'pre-wrap', overflowWrap: 'break-word' }}>
                            {floatingTask.description.trim() !== '' ? floatingTask.description : 'No description for this task.'}
                        </div>
                    </div>
                </FloatingListPanel>
            )}

            {/* View Client Modal */}
            {viewClient && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1000
                }}>
                    <div style={{
                        background: 'white',
                        borderRadius: '12px',
                        width: '1100px',
                        maxWidth: '96vw',
                        maxHeight: '92vh',
                        overflow: 'hidden',
                        display: 'flex',
                        flexDirection: 'column'
                    }}>
                        <div style={{
                            padding: '18px 20px',
                            borderBottom: '1px solid #e2e8f0',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center'
                        }}>
                            <div>
                                <h2 style={{ margin: 0, color: '#1e3a8a' }}>Client Details</h2>
                                <p style={{ margin: '4px 0 0 0', color: '#64748b', fontSize: '12px' }}>
                                    View complete client information, services, and checklist templates.
                                </p>
                            </div>
                            <button
                                onClick={closeViewModal}
                                title="Close"
                                aria-label="Close"
                                style={{
                                    border: 'none',
                                    background: 'transparent',
                                    color: '#64748b',
                                    fontSize: '14px',
                                    lineHeight: 1,
                                    cursor: 'pointer'
                                }}
                            >
                                x
                            </button>
                        </div>

                        <div style={{ padding: '18px 20px', overflowY: 'auto' }}>
                            <div style={{
                                border: '1px solid #dbe4f0',
                                borderRadius: '10px',
                                padding: '12px',
                                background: '#f8fafc',
                                marginBottom: '14px'
                            }}>
                                <div style={{ fontSize: '14px', fontWeight: 700, color: '#1f2937' }}>{viewClient.client_name || '-'}</div>
                                <div style={{ marginTop: '5px', color: '#475569', fontSize: '13px' }}>
                                    Registered: {viewClient.registration_date ? new Date(viewClient.registration_date).toLocaleDateString() : '-'}
                                </div>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '12px', marginBottom: '14px' }}>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Contact Person</div>
                                    <div style={{ color: '#1f2937', fontWeight: 600, fontSize: '14px' }}>{viewClient.contact_person || '-'}</div>
                                </div>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Company Email</div>
                                    <div style={{ color: '#1f2937', fontWeight: 600, fontSize: '14px' }}>{viewClient.company_email || '-'}</div>
                                </div>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Company Phone</div>
                                    <div style={{ color: '#1f2937', fontWeight: 600, fontSize: '14px' }}>{formatPhoneDisplay(viewClient.company_phone) || '-'}</div>
                                </div>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Contact Person Email</div>
                                    <div style={{ color: '#1f2937', fontWeight: 600, fontSize: '14px' }}>{viewClient.email || '-'}</div>
                                </div>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Contact Person Phone</div>
                                    <div style={{ color: '#1f2937', fontWeight: 600, fontSize: '14px' }}>{formatPhoneDisplay(viewClient.phone) || '-'}</div>
                                </div>
                                <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                    <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Status</div>
                                    <span style={{
                                        color: viewClient.status === 'active' ? '#15803d' : '#b91c1c',
                                        background: viewClient.status === 'active' ? '#dcfce7' : '#fee2e2',
                                        borderRadius: '999px',
                                        padding: '3px 10px',
                                        fontSize: '12px',
                                        fontWeight: 700,
                                        textTransform: 'capitalize'
                                    }}>
                                        {viewClient.status || '-'}
                                    </span>
                                </div>
                            </div>

                            {viewAdditionalContacts.length > 0 && (
                                <div style={{ marginBottom: '14px', border: '1px solid #dbe4f0', borderRadius: '10px', padding: '12px', background: '#f8fafc' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                                        <h3 style={{ margin: 0, color: '#1f2937', fontSize: '14px' }}>Additional Contact Persons</h3>
                                        <span style={{ fontSize: '12px', color: '#475569' }}>{viewAdditionalContacts.length} contact(s)</span>
                                    </div>
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '10px' }}>
                                        {viewAdditionalContacts.map((contact, index) => (
                                            <div key={`view-additional-contact-${index}`} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '10px', background: '#ffffff' }}>
                                                <div style={{ color: '#1f2937', fontWeight: 700, fontSize: '13px', marginBottom: '5px' }}>
                                                    {formatClientContactName(contact) || `Additional Contact #${index + 1}`}
                                                </div>
                                                <div style={{ color: '#475569', fontSize: '12px' }}>{contact.email || '-'}</div>
                                                <div style={{ color: '#475569', fontSize: '12px', marginTop: '3px' }}>{formatPhoneDisplay(contact.phone) || '-'}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div style={{ marginBottom: '14px', border: '1px solid #e2e8f0', borderRadius: '10px', padding: '12px' }}>
                                <div style={{ color: '#64748b', fontSize: '12px', marginBottom: '6px' }}>Address</div>
                                <div style={{ color: '#1f2937', fontSize: '14px', whiteSpace: 'pre-wrap' }}>{viewClient.address || '-'}</div>
                            </div>

                            <div style={{ border: '1px solid #cbd5e1', borderRadius: '10px', padding: '12px', background: '#f8fafc' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px', gap: '8px', flexWrap: 'wrap' }}>
                                    <h3 style={{ margin: 0, color: '#1f2937', fontSize: '14px' }}>Services and Checklist</h3>
                                    <span style={{ fontSize: '12px', color: '#475569' }}>
                                        {viewClientServices.length} service(s)
                                    </span>
                                </div>

                                {viewClientServices.length === 0 ? (
                                    <p style={{ margin: 0, color: '#94a3b8', fontSize: '13px' }}>No active services assigned.</p>
                                ) : (
                                    <>
                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '8px', marginBottom: '10px' }}>
                                            {viewClientServices.map((service) => {
                                                const isActive = Number(activeViewChecklistServiceId) === Number(service.service_id);
                                                return (
                                                    <button
                                                        key={`view-checklist-btn-${service.service_id}`}
                                                        type="button"
                                                        onClick={() => setActiveViewChecklistServiceId(Number(service.service_id))}
                                                        style={{
                                                            border: isActive ? '1px solid #1e3a8a' : '1px solid #cbd5e1',
                                                            background: isActive ? '#1e3a8a' : '#fff',
                                                            color: isActive ? '#fff' : '#334155',
                                                            borderRadius: '8px',
                                                            padding: '8px 10px',
                                                            fontSize: '12px',
                                                            fontWeight: 700,
                                                            cursor: 'pointer',
                                                            overflow: 'hidden',
                                                            textOverflow: 'ellipsis',
                                                            whiteSpace: 'nowrap'
                                                        }}
                                                        title={service.service_name}
                                                        aria-label={`Show ${service.service_name} checklist`}
                                                    >
                                                        {service.service_name}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        {activeViewChecklistService && (
                                            <div style={{ border: '1px solid #dbe4f0', borderRadius: '8px', background: 'white', padding: '10px' }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px', gap: '8px' }}>
                                                    <span style={{ fontSize: '14px', fontWeight: 700, color: '#1f2937' }}>{activeViewChecklistService.service_name}</span>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                                        <span style={{ fontSize: '11px', color: '#64748b' }}>{activeViewChecklistItems.length} item(s)</span>
                                                        <button
                                                            type="button"
                                                            onClick={() => toggleViewServiceChecklistCollapse(activeViewChecklistService.service_id)}
                                                            style={{
                                                                border: '1px solid #cbd5e1',
                                                                borderRadius: '4px',
                                                                background: '#f8fafc',
                                                                color: '#334155',
                                                                fontSize: '11px',
                                                                padding: '3px 8px',
                                                                cursor: 'pointer'
                                                            }}
                                                        >
                                                            {isActiveViewChecklistCollapsed ? 'Maximize' : 'Minimize'}
                                                        </button>
                                                    </div>
                                                </div>

                                                {!isActiveViewChecklistCollapsed && (
                                                    activeViewChecklistItems.length === 0 ? (
                                                        <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px' }}>
                                                            No checklist items available for this service.
                                                        </p>
                                                    ) : (
                                                        <div style={{ display: 'grid', gap: '6px' }}>
                                                            {activeViewChecklistItems.map((item: any) => (
                                                                <div key={`view-checklist-${item.checklist_id}`} style={{ border: '1px solid #e2e8f0', borderRadius: '6px', padding: '8px' }}>
                                                                    <div style={{ color: '#1f2937', fontSize: '12px', fontWeight: 700 }}>{item.task_name}</div>
                                                                    {item.description && (
                                                                        <div style={{ color: '#64748b', fontSize: '12px', marginTop: '3px' }}>{item.description}</div>
                                                                    )}
                                                                </div>
                                                            ))}
                                                        </div>
                                                    )
                                                )}
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        </div>

                        <div style={{
                            padding: '14px 20px',
                            borderTop: '1px solid #e2e8f0',
                            display: 'flex',
                            justifyContent: 'flex-end',
                            gap: '10px',
                            background: 'white'
                        }}>
                            <button
                                type="button"
                                onClick={closeViewModal}
                                style={{
                                    padding: '10px 16px',
                                    border: '1px solid #cbd5e1',
                                    borderRadius: '6px',
                                    background: 'white',
                                    color: '#334155',
                                    cursor: 'pointer',
                                    fontWeight: 600
                                }}
                            >
                                Close
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    const targetClient = viewClient;
                                    closeViewModal();
                                    openEditModal(targetClient);
                                }}
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    border: 'none',
                                    borderRadius: '8px',
                                    background: '#0f766e',
                                    color: 'white',
                                    cursor: 'pointer',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center'
                                }}
                                title="Edit Client"
                                aria-label="Edit Client"
                            >
                                <CrudActionIcon action="edit" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Add/Edit Modal */}
            {showModal && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '20px'
                }}>
                    <div style={{ background: 'white', borderRadius: '14px', width: '780px', maxWidth: '100%', maxHeight: '90vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(15,23,42,0.18)', overflow: 'hidden' }}>

                        {/* Modal header */}
                        <div style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
                            <div>
                                <div style={{ fontSize: '11px', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginBottom: '3px' }}>
                                    {editingClient ? 'Edit Client' : 'Add New Client'}
                                </div>
                                <div style={{ fontSize: '16px', fontWeight: 800, color: '#fff' }}>
                                    {formData.client_name || (editingClient ? 'Client Details' : 'New Client')}
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={() => { setShowModal(false); resetForm(); }}
                                style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', borderRadius: '8px', width: '32px', height: '32px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: '16px', lineHeight: 1, flexShrink: 0 }}
                                title="Close"
                                aria-label="Close modal"
                            >
                                ×
                            </button>
                        </div>

                        {/* Tab bar */}
                        {(() => {
                            const tabDone = {
                                basic: formData.client_name.trim() !== '',
                                contact: (formData.contact_first_name.trim() !== '' || formData.contact_last_name.trim() !== '') && formData.email.trim() !== '',
                                services: formData.service_ids.length > 0 &&
                                    formData.service_ids.every((sid) => (selectedChecklistItems[Number(sid)] || []).length > 0),
                            };
                            return (
                            <div style={{ display: 'flex', borderBottom: '1px solid #e2e8f0', background: '#f8fafc', flexShrink: 0 }}>
                                {([
                                    { key: 'basic', label: 'Basic Info', icon: '🏢' },
                                    { key: 'contact', label: 'Contacts', icon: '👤', badge: formData.additional_contacts.length > 0 ? formData.additional_contacts.length + 1 : undefined },
                                    { key: 'services', label: 'Services', icon: '⚙', badge: formData.service_ids.length > 0 ? formData.service_ids.length : undefined, warn: formData.service_ids.length === 0 },
                                ] as { key: 'basic'|'contact'|'services'; label: string; icon: string; badge?: number; warn?: boolean }[]).map((tab) => {
                                    const done = tabDone[tab.key];
                                    const isActive = modalTab === tab.key;
                                    return (
                                        <button
                                            key={tab.key}
                                            type="button"
                                            onClick={() => setModalTab(tab.key)}
                                            style={{
                                                padding: '10px 18px',
                                                fontSize: '13px',
                                                fontWeight: isActive ? 700 : 500,
                                                color: isActive ? '#1e3a8a' : '#64748b',
                                                background: 'transparent',
                                                border: 'none',
                                                borderBottom: `2px solid ${isActive ? '#1e3a8a' : 'transparent'}`,
                                                cursor: 'pointer',
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '6px',
                                                whiteSpace: 'nowrap',
                                                transition: 'all 0.15s',
                                                marginBottom: '-1px',
                                            }}
                                        >
                                            <span>{tab.icon}</span>
                                            <span>{tab.label}</span>
                                            {/* Green check when tab fields are complete */}
                                            {done ? (
                                                <span
                                                    title="Complete"
                                                    style={{
                                                        width: '16px', height: '16px', borderRadius: '50%',
                                                        background: '#16a34a',
                                                        color: '#fff',
                                                        fontSize: '9px', fontWeight: 900,
                                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                        flexShrink: 0, lineHeight: 1,
                                                    }}
                                                >✓</span>
                                            ) : (
                                                <>
                                                    {tab.badge !== undefined && (
                                                        <span style={{ minWidth: '18px', height: '18px', borderRadius: '999px', background: isActive ? '#1e3a8a' : '#cbd5e1', color: isActive ? '#fff' : '#475569', fontSize: '10px', fontWeight: 800, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>
                                                            {tab.badge}
                                                        </span>
                                                    )}
                                                    {tab.warn && (
                                                        <span style={{ width: '7px', height: '7px', borderRadius: '50%', background: '#dc2626', flexShrink: 0 }} title="Required" />
                                                    )}
                                                </>
                                            )}
                                        </button>
                                    );
                                })}
                            </div>
                            );
                        })()}

                        {/* Scrollable body */}
                        <form onSubmit={handleSubmit} noValidate style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                            <div style={{ padding: '20px 22px', flex: 1 }}>

                            {/* ── TAB: Basic Info ── */}
                            {modalTab === 'basic' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                    <div>
                                        <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Company Name <span style={{ color: '#dc2626' }}>*</span></label>
                                        <input type="text" name="client_name" value={formData.client_name} onChange={handleInputChange} required aria-required="true" aria-invalid={fieldErrors.client_name ? true : undefined}
                                            style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: fieldErrors.client_name ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="e.g. Acme Corp" />
                                        {fieldErrors.client_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.client_name}</div>}
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                        <div>
                                            <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Company Email <span style={{ color: '#dc2626' }}>*</span></label>
                                            <input type="email" name="company_email" value={formData.company_email} onChange={handleInputChange} required aria-required="true" aria-invalid={fieldErrors.company_email ? true : undefined}
                                                style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: fieldErrors.company_email ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="company@example.com" />
                                            {fieldErrors.company_email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.company_email}</div>}
                                        </div>
                                        <div>
                                            <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Company Phone</label>
                                            <PhoneInput
                                                name="company_phone"
                                                value={formData.company_phone}
                                                onChange={(company_phone) => setFormData((prev) => ({ ...prev, company_phone }))}
                                                ariaLabel="Company phone number"
                                                countryAriaLabel="Company phone country calling code"
                                            />
                                            <div style={{ marginTop: '4px', color: '#6b7280', fontSize: '11px' }}>Choose a country code; Philippines (+63) is the default.</div>
                                        </div>
                                    </div>

                                    <div>
                                        <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>
                                            Address
                                            {addressSearching && (
                                                <span style={{ marginLeft: 8, color: '#94a3b8', fontSize: '12px', fontWeight: 400 }}>Searching…</span>
                                            )}
                                        </label>
                                        <textarea
                                            ref={addressAnchorRef}
                                            data-addr-anchor="1"
                                            name="address" value={formData.address} onChange={handleAddressInputChange}
                                            onFocus={() => { if (addressSuggestions.length > 0) setShowAddressDropdown(true); }}
                                            autoComplete="off"
                                            style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: '1px solid #d1d5db', minHeight: '72px', color: '#111827', backgroundColor: '#fff', fontSize: '13px', resize: 'vertical' }} placeholder="Type to search a suggested address, or enter it manually" />
                                    </div>
                                </div>
                            )}

                            {/* ── TAB: Contacts ── */}
                            {modalTab === 'contact' && (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                                    {/* Primary contact person */}
                                    <div style={{ border: '1px solid #e2e8f0', borderRadius: '10px', padding: '14px', background: '#f8fafc' }}>
                                        <div style={{ fontSize: '12px', fontWeight: 700, color: '#374151', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Primary Contact</div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '12px' }}>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>First Name</label>
                                                <input type="text" name="contact_first_name" value={formData.contact_first_name} onChange={handleInputChange}
                                                    style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="First Name" />
                                            </div>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Last Name</label>
                                                <input type="text" name="contact_last_name" value={formData.contact_last_name} onChange={handleInputChange}
                                                    style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="Last Name" />
                                            </div>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Email <span style={{ color: '#dc2626' }}>*</span></label>
                                                <input type="email" name="email" value={formData.email} onChange={handleInputChange} required aria-required="true" aria-invalid={fieldErrors.email ? true : undefined}
                                                    style={{ width: '100%', padding: '9px 12px', borderRadius: '7px', border: fieldErrors.email ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="contact@example.com" />
                                                {fieldErrors.email && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{fieldErrors.email}</div>}
                                            </div>
                                            <div>
                                                <label style={{ display: 'block', marginBottom: '5px', color: '#374151', fontSize: '13px', fontWeight: 600 }}>Phone</label>
                                                <PhoneInput
                                                    name="phone"
                                                    value={formData.phone}
                                                    onChange={(phone) => setFormData((prev) => ({ ...prev, phone }))}
                                                    ariaLabel="Primary contact phone number"
                                                    countryAriaLabel="Primary contact country calling code"
                                                />
                                                <div style={{ marginTop: '4px', color: '#6b7280', fontSize: '11px' }}>Choose a country code; Philippines (+63) is the default.</div>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Additional contacts */}
                                    <div style={{ border: '1px solid #dbe4f0', borderRadius: '10px', padding: '14px', background: '#f8fafc' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                                            <div style={{ fontSize: '12px', fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                                Additional Contacts {formData.additional_contacts.length > 0 && <span style={{ background: '#e0e7ff', color: '#3730a3', borderRadius: '999px', padding: '1px 7px', fontSize: '11px', fontWeight: 800, marginLeft: 6 }}>{formData.additional_contacts.length}</span>}
                                            </div>
                                            <button type="button" onClick={addAdditionalContact} title="Add another contact" aria-label="Add another contact"
                                                style={{ border: '1px solid #fecdd3', background: '#fff1f2', color: '#be123c', borderRadius: '8px', padding: '6px 12px', cursor: 'pointer', fontWeight: 700, fontSize: '12px' }}>
                                                + Add Contact
                                            </button>
                                        </div>
                                        {formData.additional_contacts.length === 0 ? (
                                            <div style={{ color: '#94a3b8', fontSize: '12px', padding: '8px 0' }}>No additional contacts added.</div>
                                        ) : (
                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                                                {formData.additional_contacts.map((contact, index) => (
                                                    <div key={`additional-contact-${index}`} style={{ border: '1px solid #e2e8f0', borderRadius: '8px', padding: '12px', background: '#ffffff' }}>
                                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                                                            <strong style={{ color: '#334155', fontSize: '12px' }}>Contact #{index + 1}</strong>
                                                            <button type="button" onClick={() => removeAdditionalContact(index)}
                                                                style={{ border: 'none', background: 'transparent', color: '#dc2626', cursor: 'pointer', fontWeight: 700, fontSize: '12px' }}>Remove</button>
                                                        </div>
                                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                                                            <div>
                                                                <label style={{ display: 'block', marginBottom: '4px', color: '#555', fontSize: '12px' }}>First Name</label>
                                                                <input type="text" value={contact.first_name} onChange={(e) => updateAdditionalContact(index, 'first_name', e.target.value)}
                                                                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="First Name" />
                                                            </div>
                                                            <div>
                                                                <label style={{ display: 'block', marginBottom: '4px', color: '#555', fontSize: '12px' }}>Last Name</label>
                                                                <input type="text" value={contact.last_name} onChange={(e) => updateAdditionalContact(index, 'last_name', e.target.value)}
                                                                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="Last Name" />
                                                            </div>
                                                        </div>
                                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                                                            <div>
                                                                <label style={{ display: 'block', marginBottom: '4px', color: '#555', fontSize: '12px' }}>Email</label>
                                                                <input type="email" value={contact.email} onChange={(e) => updateAdditionalContact(index, 'email', e.target.value)}
                                                                    style={{ width: '100%', padding: '8px 10px', borderRadius: '6px', border: '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: '13px' }} placeholder="contact@example.com" />
                                                            </div>
                                                            <div>
                                                                <label style={{ display: 'block', marginBottom: '4px', color: '#555', fontSize: '12px' }}>Phone</label>
                                                                <PhoneInput
                                                                    value={contact.phone}
                                                                    onChange={(value) => updateAdditionalContact(index, 'phone', value)}
                                                                    ariaLabel={`Additional contact ${index + 1} phone number`}
                                                                    countryAriaLabel={`Additional contact ${index + 1} country calling code`}
                                                                    inputStyle={{ padding: '8px 10px' }}
                                                                    selectStyle={{ padding: '8px 6px', width: 155 }}
                                                                />
                                                            </div>
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                            {/* ── TAB: Services ── */}
                            {modalTab === 'services' && (
                            <div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr', gap: '16px' }}>
                                    {/* Services Card */}
                                    <div style={{
                                        background: canEditServices
                                            ? 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)'
                                            : 'linear-gradient(135deg, #f8fafc 0%, #eef2f7 100%)',
                                        border: '1px solid #e2e8f0',
                                        borderRadius: '10px',
                                        padding: '16px',
                                        boxShadow: '0 2px 8px rgba(15, 23, 42, 0.06)',
                                        opacity: canEditServices ? 1 : 0.92
                                    }}>
                                        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fb7185" strokeWidth="2">
                                                    <circle cx="12" cy="12" r="10"></circle>
                                                    <line x1="12" y1="8" x2="12" y2="16"></line>
                                                    <line x1="8" y1="12" x2="16" y2="12"></line>
                                                </svg>
                                                <h3 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#1e293b' }}>
                                                    {canEditServices ? 'Select Services' : 'Assigned Services'}
                                                </h3>
                                            </div>
                                            {editingClient && (
                                                <button
                                                    type="button"
                                                    onClick={() => setServicesEditable((prev) => !prev)}
                                                    style={{
                                                        border: canEditServices ? '1px solid #cbd5e1' : '1px solid #99f6e4',
                                                        background: canEditServices ? '#ffffff' : '#ecfeff',
                                                        color: canEditServices ? '#475569' : '#0f766e',
                                                        borderRadius: '8px',
                                                        padding: '5px 10px',
                                                        fontSize: '11px',
                                                        fontWeight: 700,
                                                        cursor: 'pointer',
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '5px',
                                                        flexShrink: 0
                                                    }}
                                                    title={canEditServices ? 'Lock services' : 'Edit services'}
                                                    aria-label={canEditServices ? 'Done editing services' : 'Edit services'}
                                                >
                                                    <CrudActionIcon action="edit" />
                                                    {canEditServices ? 'Done' : 'Edit Services'}
                                                </button>
                                            )}
                                        </div>
                                        {!canEditServices && (
                                            <p style={{ margin: '0 0 10px 0', color: '#64748b', fontSize: '11px' }}>
                                                Locked. Click <strong>Edit Services</strong> to change.
                                            </p>
                                        )}

                                        <div style={{
                                            background: canEditServices ? 'white' : '#f8fafc',
                                            border: '1px solid #e2e8f0',
                                            borderRadius: '8px',
                                            padding: '12px',
                                            maxHeight: '300px',
                                            overflowY: 'auto',
                                            pointerEvents: canEditServices ? 'auto' : 'none'
                                        }}>
                                            {availableServices.length === 0 ? (
                                                <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px', textAlign: 'center', padding: '20px 0' }}>
                                                    No services available.<br/>Create them in Service Management.
                                                </p>
                                            ) : (
                                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                                    {(canEditServices
                                                        ? availableServices
                                                        : availableServices.filter((s) => isServiceSelected(s.service_id))
                                                    ).map((s) => {
                                                        const selected = isServiceSelected(s.service_id);
                                                        return (
                                                        <label
                                                            key={s.service_id}
                                                            htmlFor={`srv-${s.service_id}`}
                                                            style={{
                                                                display: 'flex',
                                                                alignItems: 'center',
                                                                gap: '10px',
                                                                fontSize: '13px',
                                                                color: canEditServices ? '#1f2937' : '#475569',
                                                                cursor: canEditServices ? 'pointer' : 'default',
                                                                border: selected ? '1px solid #fecdd3' : '1px solid #e2e8f0',
                                                                background: selected ? '#fff1f2' : '#fafbfc',
                                                                borderRadius: '8px',
                                                                padding: '10px 12px',
                                                                transition: 'all 0.2s ease',
                                                                fontWeight: selected ? '600' : '500'
                                                            }}
                                                        >
                                                            <input
                                                                type="checkbox"
                                                                id={`srv-${s.service_id}`}
                                                                checked={selected}
                                                                disabled={!canEditServices}
                                                                onChange={(e) => {
                                                                    if (!canEditServices) return;
                                                                    handleServiceSelectionChange(Number(s.service_id), e.target.checked);
                                                                }}
                                                                style={{
                                                                    width: '16px',
                                                                    height: '16px',
                                                                    cursor: canEditServices ? 'pointer' : 'not-allowed',
                                                                    accentColor: '#fb7185',
                                                                    flexShrink: 0
                                                                }}
                                                            />
                                                            <span style={{ flex: 1 }}>{s.service_name}</span>
                                                            {selected && (
                                                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fb7185" strokeWidth="2.5">
                                                                    <polyline points="20 6 9 17 4 12"></polyline>
                                                                </svg>
                                                            )}
                                                        </label>
                                                        );
                                                    })}
                                                    {!canEditServices && formData.service_ids.length === 0 && (
                                                        <p style={{ margin: 0, color: '#94a3b8', fontSize: '12px', textAlign: 'center', padding: '12px 0' }}>
                                                            No services assigned.
                                                        </p>
                                                    )}

                                                </div>
                                            )}
                                        </div>
                                        {formData.service_ids.length === 0 && canEditServices && (
                                            <p style={{ margin: '8px 0 0 0', color: '#b91c1c', fontSize: '11px', fontWeight: 600 }}>
                                                ⚠ Select at least one service
                                            </p>
                                        )}
                                    </div>


                                    {/* Checklist Card */}
                                    <div style={{
                                        background: 'linear-gradient(135deg, #fefce8 0%, #fef3c7 100%)',
                                        border: '1px solid #fde68a',
                                        borderRadius: '10px',
                                        padding: '16px',
                                        boxShadow: '0 2px 8px rgba(251, 191, 36, 0.15)'
                                    }}>
                                        <div style={{ marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2">
                                                <path d="M9 11l3 3L22 4"></path>
                                                <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path>
                                            </svg>
                                            <h3 style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#92400e' }}>Service Checklist Tasks</h3>
                                        </div>
                                        <p style={{ margin: '0 0 10px 0', color: '#78350f', fontSize: '11px' }}>
                                            Select tasks to include when creating projects
                                        </p>
                                        <div style={{
                                            background: 'white',
                                            border: '1px solid #fde68a',
                                            borderRadius: '8px',
                                            padding: '10px',
                                            maxHeight: '300px',
                                            overflowY: 'auto'
                                        }}>
                                        {selectedServices.length === 0 ? (
                                            <div style={{
                                                padding: '20px',
                                                textAlign: 'center',
                                                color: '#94a3b8',
                                                background: 'white',
                                                borderRadius: '6px',
                                                border: '1px dashed #cbd5e1',
                                                fontSize: '11px'
                                            }}>
                                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" style={{ margin: '0 auto 6px' }}>
                                                    <path d="M9 11l3 3L22 4"></path>
                                                    <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path>
                                                </svg>
                                                <div style={{ fontWeight: '600', marginBottom: '2px', fontSize: '11px' }}>No services selected</div>
                                                <div style={{ fontSize: '10px' }}>Select services above to view checklist tasks</div>
                                            </div>
                                        ) : (
                                            <>
                                                <style dangerouslySetInnerHTML={{ __html: `
                                                    @keyframes cascadeSlideIn {
                                                        from {
                                                            opacity: 0;
                                                            transform: translateX(-15px);
                                                        }
                                                        to {
                                                            opacity: 1;
                                                            transform: translateX(0);
                                                        }
                                                    }
                                                    @keyframes serviceExpand {
                                                        from {
                                                            max-height: 0;
                                                            opacity: 0;
                                                        }
                                                        to {
                                                            max-height: 1500px;
                                                            opacity: 1;
                                                        }
                                                    }
                                                `}} />

                                                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginBottom: '10px' }}>
                                                    {selectedServices.map((service) => {
                                                        const isActive = Number(activeChecklistServiceId) === Number(service.service_id);
                                                        const selectedCount = (selectedChecklistItems[service.service_id] || []).length;
                                                        const totalCount = Array.isArray(service.checklists) ? service.checklists.length : 0;

                                                        return (
                                                            <button
                                                                key={`form-checklist-btn-${service.service_id}`}
                                                                type="button"
                                                                onClick={() => { setActiveChecklistServiceId(Number(service.service_id)); setChecklistSearch(''); }}
                                                                style={{
                                                                    border: isActive ? '1px solid #fb7185' : '1px solid #cbd5e1',
                                                                    background: isActive ? '#fff1f2' : '#fff',
                                                                    color: isActive ? '#be123c' : '#334155',
                                                                    borderRadius: '6px',
                                                                    padding: '6px 10px',
                                                                    fontSize: '11px',
                                                                    fontWeight: '600',
                                                                    cursor: 'pointer',
                                                                    display: 'flex',
                                                                    alignItems: 'center',
                                                                    gap: '5px',
                                                                    transition: 'all 0.2s ease',
                                                                    boxShadow: isActive ? '0 2px 6px rgba(251, 113, 133, 0.16)' : 'none'
                                                                }}
                                                                title={`${service.service_name}: ${selectedCount}/${totalCount} tasks selected`}
                                                            >
                                                                <span>{service.service_name}</span>
                                                                <span style={{
                                                                    background: isActive ? '#ffe4e6' : '#f1f5f9',
                                                                    color: isActive ? '#be123c' : '#475569',
                                                                    padding: '2px 5px',
                                                                    borderRadius: '8px',
                                                                    fontSize: '10px',
                                                                    fontWeight: '700'
                                                                }}>
                                                                    {selectedCount}/{totalCount}
                                                                </span>
                                                            </button>
                                                        );
                                                    })}
                                                </div>

                                                {activeFormChecklistService && (
                                                    <div
                                                        key={`service-checklist-${activeFormChecklistService.service_id}`}
                                                        style={{
                                                            background: 'white',
                                                            borderRadius: '6px',
                                                            padding: '8px',
                                                            boxShadow: '0 1px 4px rgba(15, 23, 42, 0.06)',
                                                            animation: 'serviceExpand 0.3s ease-out'
                                                        }}
                                                    >
                                                        <div style={{
                                                             display: 'flex',
                                                             alignItems: 'center',
                                                             gap: '6px',
                                                             marginBottom: '8px',
                                                             paddingBottom: '6px',
                                                             borderBottom: '1px solid #ffe4e6'
                                                         }}>
                                                             <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fb7185" strokeWidth="2">
                                                                 <path d="M9 11l3 3L22 4"></path>
                                                                 <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11"></path>
                                                             </svg>
                                                             <h4 style={{ margin: 0, fontSize: '11px', fontWeight: '700', color: '#1e293b' }}>
                                                                 {activeFormChecklistService.service_name}
                                                             </h4>
                                                             <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
                                                                 <SearchBar
                                                                     storageKey="clients:checklist"
                                                                     placeholder="Search tasks..."
                                                                     ariaLabel="Search checklist tasks"
                                                                     value={checklistSearch}
                                                                     onChange={setChecklistSearch}
                                                                     suggestions={collectSearchTerms(activeFormChecklistItems, [
                                                                         (cl: any) => cl.task_name,
                                                                     ])}
                                                                      inputStyle={{
                                                                          padding: '4px 22px 4px 24px',
                                                                         fontSize: '10px',
                                                                         border: '1px solid #fecdd3',
                                                                         borderRadius: '5px',
                                                                         background: '#fff7f7',
                                                                     }}
                                                                 />
                                                             </div>
                                                             <span style={{
                                                                 fontSize: '9px',
                                                                 color: '#64748b',
                                                                 fontWeight: '600',
                                                                 whiteSpace: 'nowrap',
                                                                 flexShrink: 0
                                                             }}>
                                                                 {activeFormChecklistItems.length} {activeFormChecklistItems.length === 1 ? 'task' : 'tasks'}
                                                             </span>
                                                         </div>

                                                        {activeFormChecklistItems.length === 0 ? (
                                                            <div style={{
                                                                padding: '16px',
                                                                textAlign: 'center',
                                                                color: '#94a3b8',
                                                                background: '#f8fafc',
                                                                borderRadius: '4px',
                                                                border: '1px dashed #cbd5e1',
                                                                fontSize: '10px'
                                                            }}>
                                                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#cbd5e1" strokeWidth="1.5" style={{ margin: '0 auto 6px' }}>
                                                                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                                                    <line x1="9" y1="9" x2="15" y2="15"></line>
                                                                    <line x1="15" y1="9" x2="9" y2="15"></line>
                                                                </svg>
                                                                <div style={{ fontWeight: '600', marginBottom: '2px' }}>No tasks available</div>
                                                                <div style={{ fontSize: '9px' }}>Add tasks in Services page</div>
                                                            </div>
                                                        ) : (
                                                            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', alignItems: 'flex-start' }}>
                                                                {(() => {
                                                                    const q = checklistSearch.toLowerCase().trim();
                                                                    // Title-only search: match task_name, ignore the tagline description.
                                                                    const filtered = q
                                                                        ? activeFormChecklistItems.filter((cl: any) =>
                                                                            (cl.task_name || '').toLowerCase().includes(q)
                                                                          )
                                                                        : activeFormChecklistItems;
                                                                    if (filtered.length === 0) return (
                                                                        <div style={{ padding: '6px', textAlign: 'center', color: '#94a3b8', fontSize: '10px', width: '100%' }}>
                                                                            <ZeroResults
                                                                                query={checklistSearch}
                                                                                itemLabel="tasks"
                                                                                alternatives={getAlternativeSuggestions(checklistSearch, collectSearchTerms(activeFormChecklistItems, [
                                                                                    (cl: any) => cl.task_name,
                                                                                ]))}
                                                                                onPickAlternative={(term) => setChecklistSearch(term)}
                                                                                onClear={() => setChecklistSearch('')}
                                                                                clearLabel="Clear"
                                                                            />
                                                                        </div>
                                                                    );
                                                                    return filtered.map((cl: any, index: number) => {
                                                                    const isSelected = isChecklistItemSelected(activeFormChecklistService.service_id, cl.checklist_id);
                                                                    const hasDescription = cl.description && cl.description.trim() !== '';

                                                                    return (
                                                                        <div
                                                                            key={cl.checklist_id}
                                                                            style={{
                                                                                display: 'inline-flex',
                                                                                alignItems: 'center',
                                                                                gap: '6px',
                                                                                padding: '4px 8px',
                                                                                background: isSelected ? '#fff1f2' : '#fafbfc',
                                                                                border: isSelected ? '1px solid #fecdd3' : '1px solid #e2e8f0',
                                                                                borderLeft: isSelected ? '3px solid #fb7185' : '3px solid #cbd5e1',
                                                                                borderRadius: '5px',
                                                                                cursor: 'pointer',
                                                                                transition: 'all 0.2s ease',
                                                                                animation: `cascadeSlideIn 0.4s ease-out ${index * 0.08}s both`,
                                                                                maxWidth: '100%'
                                                                            }}
                                                                            onClick={() => toggleChecklistItem(activeFormChecklistService.service_id, cl.checklist_id)}
                                                                            onDoubleClick={() => setFloatingTask({ task_name: cl.task_name || 'Untitled task', description: cl.description || '', service_name: activeFormChecklistService.service_name || '' })}
                                                                            title="Click to select. Double-click to view full details."
                                                                            onMouseEnter={(e) => {
                                                                                e.currentTarget.style.transform = 'translateX(3px)';
                                                                                e.currentTarget.style.boxShadow = '0 2px 8px rgba(251, 113, 133, 0.12)';
                                                                            }}
                                                                            onMouseLeave={(e) => {
                                                                                e.currentTarget.style.transform = 'translateX(0)';
                                                                                e.currentTarget.style.boxShadow = 'none';
                                                                            }}
                                                                        >
                                                                            <input
                                                                                type="checkbox"
                                                                                checked={isSelected}
                                                                                onChange={() => {}}
                                                                                style={{
                                                                                    width: '14px',
                                                                                    height: '14px',
                                                                                    cursor: 'pointer',
                                                                                    accentColor: '#fb7185',
                                                                                    flexShrink: 0
                                                                                }}
                                                                            />
                                                                            <span style={{
                                                                                display: 'inline-flex',
                                                                                alignItems: 'center',
                                                                                justifyContent: 'center',
                                                                                width: '16px',
                                                                                height: '16px',
                                                                                borderRadius: '3px',
                                                                                background: isSelected ? '#fb7185' : '#cbd5e1',
                                                                                color: 'white',
                                                                                fontSize: '9px',
                                                                                fontWeight: '700',
                                                                                flexShrink: 0
                                                                            }}>
                                                                                {index + 1}
                                                                            </span>
                                                                            <div style={{ display: 'flex', flexDirection: 'column', gap: hasDescription ? '1px' : 0, minWidth: 0 }}>
                                                                                <div style={{
                                                                                    fontSize: '11px',
                                                                                    color: isSelected ? '#be123c' : '#334155',
                                                                                    fontWeight: '600',
                                                                                    lineHeight: '1.2',
                                                                                    whiteSpace: 'nowrap'
                                                                                }}>
                                                                                    {cl.task_name}
                                                                                </div>
                                                                                {hasDescription && (
                                                                                    <div style={{
                                                                                        fontSize: '9px',
                                                                                        color: isSelected ? '#475569' : '#64748b',
                                                                                        lineHeight: '1.2',
                                                                                        overflow: 'hidden',
                                                                                        textOverflow: 'ellipsis',
                                                                                        whiteSpace: 'nowrap',
                                                                                        maxWidth: '400px'
                                                                                    }}>
                                                                                        {cl.description}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        </div>
                                                                    );
                                                                    });
                                                                })()}
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </>
                                        )}
                                        </div>
                                        <p style={{ margin: '8px 0 0 0', color: '#78350f', fontSize: '10px' }}>
                                            Selected tasks will be used as templates when creating projects. Double-click a task to view its full details.
                                        </p>
                                    </div>
                                </div>
                            </div>
                            )}

                            </div>{/* end padding wrapper */}

                            {/* Sticky footer */}
                            <div style={{ borderTop: '1px solid #e2e8f0', padding: '12px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, background: '#f8fafc' }}>
                                {/* Tab navigation hints */}
                                <div style={{ display: 'flex', gap: '6px' }}>
                                    {modalTab !== 'basic' && (
                                        <button type="button" onClick={() => setModalTab(modalTab === 'services' ? 'contact' : 'basic')}
                                            style={{ padding: '7px 14px', border: '1px solid #d1d5db', borderRadius: '7px', background: '#fff', color: '#374151', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}>
                                            ← Back
                                        </button>
                                    )}
                                    {modalTab !== 'services' && (() => {
                                        const canGoNext = modalTab === 'basic'
                                            ? formData.client_name.trim() !== ''
                                            : (formData.contact_first_name.trim() !== '' || formData.contact_last_name.trim() !== '') && formData.email.trim() !== '';
                                        return (
                                            <button type="button"
                                                disabled={!canGoNext}
                                                onClick={() => { if (canGoNext) setModalTab(modalTab === 'basic' ? 'contact' : 'services'); }}
                                                title={!canGoNext ? (modalTab === 'basic' ? 'Please enter a Company Name first' : 'Please fill in contact name and email first') : undefined}
                                                style={{ padding: '7px 14px', border: `1px solid ${canGoNext ? '#d1d5db' : '#e2e8f0'}`, borderRadius: '7px', background: canGoNext ? '#fff' : '#f1f5f9', color: canGoNext ? '#374151' : '#94a3b8', fontSize: '13px', cursor: canGoNext ? 'pointer' : 'not-allowed', fontWeight: 600 }}>
                                                Next →
                                            </button>
                                        );
                                    })()}
                                </div>
                                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                    {formData.service_ids.length === 0 && (
                                        <span style={{ fontSize: '12px', color: '#b91c1c', fontWeight: 600 }}>
                                            ⚠ Select at least one service
                                        </span>
                                    )}
                                    <button type="submit"
                                        title={editingClient ? 'Update Client' : 'Create Client'}
                                        aria-label={editingClient ? 'Update Client' : 'Create Client'}
                                        disabled={formData.service_ids.length === 0}
                                        style={{
                                            padding: '8px 22px',
                                            background: formData.service_ids.length === 0 ? '#e2e8f0' : '#be123c',
                                            border: 'none',
                                            borderRadius: '8px',
                                            cursor: formData.service_ids.length === 0 ? 'not-allowed' : 'pointer',
                                            color: formData.service_ids.length === 0 ? '#94a3b8' : '#fff',
                                            fontWeight: 700,
                                            fontSize: '13px',
                                        }}
                                    >
                                        {editingClient ? 'Update' : 'Save'}
                                    </button>
                                </div>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Floating address suggestions — portal on body so the modal never clips it */}
            {showModal && modalTab === 'basic' && showAddressDropdown && addressSuggestions.length > 0 && typeof document !== 'undefined' && createPortal(
                <div
                    data-addr-drop="1"
                    style={{
                        position: 'fixed',
                        ...(addrDropPos?.top !== undefined ? { top: addrDropPos.top } : {}),
                        ...(addrDropPos?.bottom !== undefined ? { bottom: addrDropPos.bottom } : {}),
                        left: addrDropPos?.left ?? 8,
                        width: addrDropPos?.width ?? 280,
                        background: 'white',
                        border: '1px solid #e2e8f0',
                        borderRadius: '8px',
                        boxShadow: '0 12px 32px rgba(15, 23, 42, 0.22)',
                        zIndex: 3000,
                        maxHeight: addrDropPos?.maxH ?? 260,
                        overflowY: 'auto',
                    }}
                >
                    <div style={{ padding: '6px 10px 4px', fontSize: '11px', color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
                        Suggested addresses — click to accept
                    </div>
                    {addressSuggestions.map((s, i) => (
                        <button
                            key={i}
                            type="button"
                            onClick={() => acceptAddressSuggestion(s)}
                            style={{
                                display: 'block',
                                width: '100%',
                                textAlign: 'left',
                                padding: '9px 12px',
                                background: 'none',
                                border: 'none',
                                borderBottom: i < addressSuggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
                                cursor: 'pointer',
                                fontSize: '13px',
                                color: '#1f2937',
                                lineHeight: 1.4
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.background = '#f0f9ff')}
                            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                        >
                            <span style={{ marginRight: 6, fontSize: 12 }}>📍</span>
                            {s.display_name}
                        </button>
                    ))}
                    {/* Span (not <button>): global button CSS washes this out — solid black bar stays clearly visible. */}
                    <span
                        role="button"
                        tabIndex={0}
                        onClick={() => setShowAddressDropdown(false)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowAddressDropdown(false); } }}
                        style={{
                            display: 'block',
                            width: '100%',
                            boxSizing: 'border-box',
                            textAlign: 'center',
                            padding: '9px 12px',
                            background: '#000',
                            color: '#fff',
                            borderTop: '1px solid #000',
                            cursor: 'pointer',
                            fontSize: '12px',
                            fontWeight: 800
                        }}
                    >
                        ✕&nbsp; Dismiss suggestions
                    </span>
                </div>,
                document.body
            )}

            {showArchiveAllConfirm && (
                <div style={{
                    position: 'fixed',
                    top: 0,
                    left: 0,
                    right: 0,
                    bottom: 0,
                    background: 'rgba(0,0,0,0.5)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    zIndex: 1001,
                    padding: '16px'
                }}>
                    <div style={{
                        background: '#fff',
                        padding: '24px',
                        borderRadius: '12px',
                        maxWidth: '420px',
                        width: '100%',
                        textAlign: 'center',
                        boxShadow: '0 10px 25px rgba(0,0,0,0.2)'
                    }}>
                        <div style={{ marginBottom: '16px' }}>
                            <div style={{ fontSize: '48px', marginBottom: '12px' }}>!</div>
                            <h3 style={{ margin: '0 0 10px 0', color: '#1f2937', fontSize: '20px' }}>Archive all clients?</h3>
                            <p style={{ margin: 0, color: '#6b7280', fontSize: '14px', lineHeight: 1.5 }}>
                                This will archive {activeClients.length} {activeClients.length === 1 ? 'client' : 'clients'}. Are you sure?
                            </p>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => setShowArchiveAllConfirm(false)}
                                disabled={isArchivingAll}
                                style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: isArchivingAll ? 'not-allowed' : 'pointer', color: '#666', fontSize: '14px', opacity: isArchivingAll ? 0.7 : 1 }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleArchiveAllConfirm}
                                disabled={isArchivingAll}
                                title="Archive All"
                                aria-label="Confirm archive all clients"
                                style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: isArchivingAll ? 'not-allowed' : 'pointer', color: '#fff', fontWeight: 'bold', fontSize: '14px', opacity: isArchivingAll ? 0.7 : 1 }}
                            >
                                {isArchivingAll ? 'Archiving...' : 'Archive All'}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Delete/Archive Confirmation Modal */}
            {showDeleteConfirm && clientToDelete && (
                <div style={{
                    position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
                    background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001
                }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '450px', maxWidth: '90%', textAlign: 'center' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>Archive Client?</h3>
                        <p style={{ margin: '0 0 12px 0', color: '#666', fontSize: '14px' }}>
                            Are you sure you want to archive <strong>{clientToDelete.client_name}</strong>?
                        </p>
                        <div style={{
                            background: '#fffbeb',
                            border: '1px solid #fde68a',
                            borderRadius: '8px', padding: '10px 14px', marginBottom: '16px', textAlign: 'left', fontSize: '13px',
                            color: '#92400e'
                        }}>
                            <strong>Warning: Archiving will also:</strong>
                            <ul style={{ margin: '6px 0 0 0', paddingLeft: '18px' }}>
                                <li>Archive all projects for this client</li>
                                <li>Cancel all pending/in-progress tasks</li>
                                <li>Deactivate client service assignments</li>
                            </ul>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
                            <button
                                onClick={() => { setShowDeleteConfirm(false); setClientToDelete(null); }}
                                style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', color: '#666', fontSize: '14px' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDeleteConfirm}
                                title="Archive"
                                aria-label="Archive client"
                                style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 'bold', fontSize: '14px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                <CrudActionIcon action="archive" />
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ══ Create Project for Client ══ */}
            {projectPromptClient && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 1002, background: 'rgba(10,18,40,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
                    <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 520, boxShadow: '0 24px 64px rgba(10,18,40,0.3)', overflow: 'hidden' }}>
                        <div style={{ background: 'linear-gradient(135deg,#0f172a 0%,#1e3a8a 100%)', padding: '16px 22px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div>
                                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', marginBottom: 3 }}>New Project</div>
                                <div style={{ fontSize: 16, fontWeight: 800, color: '#fff' }}>{projectPromptClient.client_name}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => { setProjectPromptClient(null); setProjectPromptErrors({}); }}
                                style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.25)', color: '#fff', borderRadius: 8, width: 32, height: 32, cursor: 'pointer', fontWeight: 700, fontSize: 16, lineHeight: 1 }}
                                title="Close"
                                aria-label="Close project dialog"
                            >
                                ×
                            </button>
                        </div>
                        <div style={{ padding: '18px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
                            {projectPromptClient.contract_note && (
                                <div style={{ background: '#ecfdf5', border: '1px solid #bbf7d0', color: '#15803d', borderRadius: 8, padding: '8px 12px', fontSize: 12, fontWeight: 600 }}>
                                    {projectPromptClient.contract_note}
                                </div>
                            )}
                            <div>
                                <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 13, fontWeight: 600 }}>
                                    Project Name <span style={{ color: '#64748b', fontWeight: 400 }}>(auto-generated, editable)</span>
                                </label>
                                <input
                                    type="text"
                                    value={projectPromptClient.project_name}
                                    onChange={(e) => handleProjectPromptChange('project_name', e.target.value)}
                                    placeholder="e.g. Acme Corp - Tax / Audit"
                                    required
                                    aria-required="true"
                                    aria-invalid={projectPromptErrors.project_name ? true : undefined}
                                    style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: projectPromptErrors.project_name ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: 13 }}
                                />
                                {projectPromptErrors.project_name && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{projectPromptErrors.project_name}</div>}
                                <div style={{ marginTop: 4, color: '#64748b', fontSize: 11 }}>Auto-generated from client + services. You can edit it before creating.</div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                                <div>
                                    <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 13, fontWeight: 600 }}>Manager <span style={{ color: '#dc2626' }}>*</span></label>
                                    <select
                                        value={projectPromptClient.manager_id}
                                        onChange={(e) => handleProjectPromptChange('manager_id', e.target.value)}
                                        required
                                        aria-required="true"
                                        aria-invalid={projectPromptErrors.manager_id ? true : undefined}
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: projectPromptErrors.manager_id ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: 13 }}
                                    >
                                        <option value="">-- Select Manager --</option>
                                        {managers.map((m: any) => (
                                            <option key={String(m.id)} value={String(m.id)}>
                                                {[m.first_name, m.last_name].filter(Boolean).join(' ') || `Manager #${m.id}`}
                                            </option>
                                        ))}
                                    </select>
                                    {projectPromptErrors.manager_id && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{projectPromptErrors.manager_id}</div>}
                                </div>
                                <div>
                                    <label style={{ display: 'block', marginBottom: 5, color: '#374151', fontSize: 13, fontWeight: 600 }}>Due Date <span style={{ color: '#dc2626' }}>*</span></label>
                                    <input
                                        type="datetime-local"
                                        value={projectPromptClient.end_date}
                                        onChange={(e) => handleProjectPromptChange('end_date', e.target.value)}
                                        required
                                        aria-required="true"
                                        aria-invalid={projectPromptErrors.end_date ? true : undefined}
                                        style={{ width: '100%', padding: '9px 12px', borderRadius: 7, border: projectPromptErrors.end_date ? '2px solid #ef4444' : '1px solid #d1d5db', color: '#111827', backgroundColor: '#fff', fontSize: 13 }}
                                    />
                                    {projectPromptErrors.end_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{projectPromptErrors.end_date}</div>}
                                </div>
                            </div>
                        </div>
                        <div style={{ padding: '12px 22px', borderTop: '1px solid #e2e8f0', display: 'flex', justifyContent: 'flex-end', gap: 10, background: '#f8fafc' }}>
                            <button
                                type="button"
                                onClick={handleSkipProjectCreation}
                                disabled={isCreatingProject}
                                style={{ padding: '8px 16px', background: 'transparent', border: '1px solid #cbd5e1', borderRadius: 8, cursor: isCreatingProject ? 'not-allowed' : 'pointer', color: '#475569', fontSize: 13, fontWeight: 600 }}
                            >
                                Skip
                            </button>
                            <button
                                type="button"
                                onClick={handleCreateProjectForClient}
                                disabled={isCreatingProject}
                                style={{ padding: '8px 20px', background: isCreatingProject ? '#94a3b8' : '#1e3a8a', border: 'none', borderRadius: 8, cursor: isCreatingProject ? 'not-allowed' : 'pointer', color: '#fff', fontSize: 13, fontWeight: 700 }}
                            >
                                {isCreatingProject ? 'Creating…' : 'Create Project'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
