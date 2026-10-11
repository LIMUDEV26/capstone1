import { useState, useEffect, useRef, useCallback } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import CrudActionIcon from '../../components/CrudActionIcon';
import PhoneInput from '@/components/PhoneInput';
import { confirmAction, notifyError, notifySuccess } from '@/utils/notify';
import { getApiBaseUrl } from '@/utils/network';
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

type ContactNumberType = 'mobile' | 'telephone';

type ContactInfoParsed = {
    primary: { first_name: string; last_name: string; contact_number: string; contact_number_type: ContactNumberType };
    additional: Array<{ first_name: string; last_name: string; contact_number: string; contact_number_type: ContactNumberType }>;
};

const EMPTY_CONTACT_INFO: ContactInfoParsed = {
    primary: { first_name: '', last_name: '', contact_number: '', contact_number_type: 'mobile' },
    additional: []
};

const normalizeContactName = (value: string) => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeContactNumberType = (value: string): ContactNumberType => (value === 'telephone' ? 'telephone' : 'mobile');
const normalizeContactNumberDraft = (value: string, includeDefault = false) => {
    const normalized = normalizeInternationalPhoneNumber(value, DEFAULT_PHONE_COUNTRY_CODE);
    if (normalized) return normalized;

    const draft = sanitizeInternationalPhoneDraft(value).trim();
    if (!draft) {
        return includeDefault ? DEFAULT_PHONE_COUNTRY_CODE : '';
    }

    if (draft.startsWith('+')) {
        return draft;
    }

    const digits = draft.replace(/\D+/g, '');
    if (!digits) {
        return includeDefault ? DEFAULT_PHONE_COUNTRY_CODE : '';
    }

    const localDigits = digits.replace(/^0+/, '') || digits;
    return `${DEFAULT_PHONE_COUNTRY_CODE}${localDigits}`;
};

const decodeHtmlEntities = (value: string) => {
    const text = String(value || '');
    if (!text.includes('&')) return text;
    return text
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#34;/g, '"')
        .replace(/&#x22;/gi, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/gi, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
};

const parseLegacyContactInfo = (text: string): ContactInfoParsed => {
    const trimmed = String(text || '').trim();
    if (!trimmed) return { ...EMPTY_CONTACT_INFO };

    const numberMatch = trimmed.match(/(\+?\d[\d\s()\-]{5,}\d)/);
    const rawNumber = numberMatch ? numberMatch[1] : '';
    const contact_number = rawNumber ? normalizeContactNumberDraft(rawNumber) : '';
    const contact_number_type = rawNumber.startsWith('+') ? 'mobile' : 'telephone';
    let namePart = trimmed;
    if (numberMatch) {
        namePart = trimmed.replace(numberMatch[1], ' ').replace(/[|(),-]/g, ' ');
    }
    const parts = namePart.trim().split(/\s+/).filter(Boolean);
    const first_name = parts.shift() || '';
    const last_name = parts.join(' ');

    return {
        primary: {
            first_name,
            last_name,
            contact_number,
            contact_number_type
        },
        additional: []
    };
};

const parseContactInfo = (raw: string): ContactInfoParsed => {
    const decoded = decodeHtmlEntities(raw);
    const trimmed = String(decoded || '').trim();
    if (!trimmed) return { ...EMPTY_CONTACT_INFO };

    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                const primarySource = parsed.primary || parsed.contact || parsed;
                const rawNumber = String(primarySource?.contact_number ?? primarySource?.contactNumber ?? '').trim();
                const explicitTypeRaw = String(primarySource?.contact_number_type ?? primarySource?.contactNumberType ?? '').trim();
                const explicitType = explicitTypeRaw === 'telephone' || explicitTypeRaw === 'mobile' ? explicitTypeRaw : '';
                const inferredType =
                    explicitType ||
                    (rawNumber.startsWith('+') ? 'mobile' : 'telephone');
                const contact_number_type: ContactNumberType = inferredType === 'mobile' ? 'mobile' : 'telephone';
                const primary: ContactInfoParsed['primary'] = {
                    first_name: normalizeContactName(primarySource?.first_name ?? primarySource?.firstName ?? ''),
                    last_name: normalizeContactName(primarySource?.last_name ?? primarySource?.lastName ?? ''),
                    contact_number: normalizeContactNumberDraft(rawNumber),
                    contact_number_type
                };
                const additional: ContactInfoParsed['additional'] = Array.isArray(parsed.additional)
                    ? parsed.additional.map((entry: any) => {
                        const rawAdditionalNumber = String(entry?.contact_number ?? entry?.contactNumber ?? '').trim();
                        const explicitAdditionalTypeRaw = String(entry?.contact_number_type ?? entry?.contactNumberType ?? '').trim();
                        const explicitAdditionalType =
                            explicitAdditionalTypeRaw === 'telephone' || explicitAdditionalTypeRaw === 'mobile'
                                ? explicitAdditionalTypeRaw
                                : '';
                        const inferredAdditionalType =
                            explicitAdditionalType ||
                            (rawAdditionalNumber.startsWith('+') ? 'mobile' : 'telephone');
                        const contactNumberType: ContactNumberType = inferredAdditionalType === 'mobile' ? 'mobile' : 'telephone';

                        return {
                            first_name: normalizeContactName(entry?.first_name ?? entry?.firstName ?? ''),
                            last_name: normalizeContactName(entry?.last_name ?? entry?.lastName ?? ''),
                            contact_number: normalizeContactNumberDraft(rawAdditionalNumber),
                            contact_number_type: contactNumberType
                        };
                    })
                    : [];
                return { primary, additional };
            }
        } catch (err) {
            return { ...EMPTY_CONTACT_INFO };
        }
    }

    return parseLegacyContactInfo(trimmed);
};

const buildContactInfoPayload = (data: {
    contact_first_name: string;
    contact_last_name: string;
    contact_number: string;
    contact_number_type: ContactNumberType;
    additional_contacts: Array<{ first_name: string; last_name: string; contact_number: string; contact_number_type: ContactNumberType }>;
}) => {
    const contactNumberType = normalizeContactNumberType(data.contact_number_type);
    const primary = {
        first_name: normalizeContactName(data.contact_first_name),
        last_name: normalizeContactName(data.contact_last_name),
        contact_number: normalizeInternationalPhoneNumber(data.contact_number, DEFAULT_PHONE_COUNTRY_CODE) || '',
        contact_number_type: contactNumberType
    };
    const additional = (data.additional_contacts || [])
        .map((contact) => {
            const additionalNumberType = normalizeContactNumberType(contact.contact_number_type);
            return {
                first_name: normalizeContactName(contact.first_name),
                last_name: normalizeContactName(contact.last_name),
                contact_number: normalizeInternationalPhoneNumber(contact.contact_number, DEFAULT_PHONE_COUNTRY_CODE) || '',
                contact_number_type: additionalNumberType
            };
        })
        .filter((contact) => contact.first_name || contact.last_name || contact.contact_number);

    if (!primary.first_name && !primary.last_name && !primary.contact_number && additional.length === 0) {
        return '';
    }

    return JSON.stringify({ primary, additional });
};

const formatContactInfo = (raw: string) => {
    const decoded = decodeHtmlEntities(raw);
    const trimmed = String(decoded || '').trim();
    if (!trimmed) return '-';

    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
        return trimmed;
    }

    const parsed = parseContactInfo(trimmed);
    const fullName = [parsed.primary.first_name, parsed.primary.last_name].filter(Boolean).join(' ').trim();
    const contactNumber = formatPhoneDisplay(parsed.primary.contact_number) || '';
    if (!fullName && !contactNumber) return '-';

    const additionalCount = parsed.additional.length;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span>{fullName || 'Contact'}</span>
            {contactNumber && (
                <span style={{ color: '#64748b', fontSize: '12px' }}>
                    Contact #: {contactNumber}
                </span>
            )}
            {additionalCount > 0 && (
                <span style={{ color: '#94a3b8', fontSize: '11px' }}>
                    +{additionalCount} more
                </span>
            )}
        </div>
    );
};

export default function Branches() {
    const router = useRouter();
    const API_BASE = getApiBaseUrl();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [user, setUser] = useState<any>(null);
    const [branches, setBranches] = useState<any[]>([]);
    const [loading, setLoading] = useState(true);
    const [showArchiveView, setShowArchiveView] = useState(false);
    const [currentPage, setCurrentPage] = useState(1);

    // Modals & Action States
    const [showModal, setShowModal] = useState(false);
    const [editingBranch, setEditingBranch] = useState<any>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [branchToDelete, setBranchToDelete] = useState<any>(null);
    const [activeDropdown, setActiveDropdown] = useState<number | null>(null);

    // Form Data
    const [formData, setFormData] = useState({
        branch_name: '',
        location: '',
        latitude: null as number | null,
        longitude: null as number | null,
        contact_first_name: '',
        contact_last_name: '',
        contact_number: DEFAULT_PHONE_COUNTRY_CODE,
        contact_number_type: 'mobile' as ContactNumberType,
        additional_contacts: [] as Array<{ first_name: string; last_name: string; contact_number: string; contact_number_type: ContactNumberType }>,
        status: 'active'
    });
    const [error, setError] = useState('');
    const [success, setSuccess] = useState('');
    // Inline "Required" message under the branch name field.
    const [branchNameError, setBranchNameError] = useState('');

    // Location autocomplete state
    type LocationSuggestion = { display_name: string; lat: string; lon: string };
    const [locationSuggestions, setLocationSuggestions] = useState<LocationSuggestion[]>([]);
    const [locationSearching, setLocationSearching] = useState(false);
    const [showLocationDropdown, setShowLocationDropdown] = useState(false);
    const locationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const locationInputRef = useRef<HTMLInputElement | null>(null);
    const locationDropdownRef = useRef<HTMLDivElement | null>(null);

    // Live-sync: silently refresh branches in background.
    useLiveSync(async () => {
        if (!user) return;
        await fetchBranches();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    useEffect(() => {
        checkSession();
    }, []);

    useEffect(() => {
        const handleClickOutside = () => setActiveDropdown(null);
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
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

    const checkSession = async () => {
        try {
            const [authRes] = await Promise.all([
                fetch(`${API_BASE}/auth.php`, { credentials: 'include' }),
                fetchBranches(),
            ]);
            const data = await authRes.json();
            if (data.success) {
                setUser(data.data);
            } else {
                router.push('/');
            }
        } catch (err) {
            router.push('/');
        } finally {
            setLoading(false);
        }
    };

    const fetchBranches = async () => {
        try {
            const res = await fetch(`${API_BASE}/branches.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setBranches(data.data);
        } catch (err) { console.error('Failed to fetch branches'); }
    };

    const handleLogout = async () => {
        await fetch(`${API_BASE}/auth.php?action=logout`, { method: 'POST', credentials: 'include' });
        router.push('/');
    };

    const handleInputChange = (e: any) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
        // Inline per-field "Required" message for the branch name.
        if (e.target.name === 'branch_name' && branchNameError) setBranchNameError('');
    };

    const setContactNumberType = (type: ContactNumberType) => {
        if (type === formData.contact_number_type) return;
        setFormData({ ...formData, contact_number_type: type });
    };

    const addAdditionalContact = () => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: [
                ...prev.additional_contacts,
                { first_name: '', last_name: '', contact_number: DEFAULT_PHONE_COUNTRY_CODE, contact_number_type: 'mobile' }
            ]
        }));
    };

    const updateAdditionalContact = (
        index: number,
        field: 'first_name' | 'last_name' | 'contact_number' | 'contact_number_type',
        value: string
    ) => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: prev.additional_contacts.map((contact, i) =>
                i === index ? { ...contact, [field]: value } : contact
            )
        }));
    };

    const setAdditionalContactNumberType = (index: number, type: ContactNumberType) => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: prev.additional_contacts.map((contact, i) => {
                if (i !== index) return contact;
                return { ...contact, contact_number_type: type };
            })
        }));
    };

    const removeAdditionalContact = (index: number) => {
        setFormData((prev) => ({
            ...prev,
            additional_contacts: prev.additional_contacts.filter((_, i) => i !== index)
        }));
    };

    const resetForm = () => {
        setFormData({
            branch_name: '',
            location: '',
            latitude: null,
            longitude: null,
            contact_first_name: '',
            contact_last_name: '',
            contact_number: DEFAULT_PHONE_COUNTRY_CODE,
            contact_number_type: 'mobile',
            additional_contacts: [],
            status: 'active'
        });
        setLocationSuggestions([]);
        setShowLocationDropdown(false);
        setEditingBranch(null);
        setError('');
        setSuccess('');
    };

    // Debounced Nominatim search
    const searchLocation = useCallback((query: string) => {
        if (locationDebounceRef.current) clearTimeout(locationDebounceRef.current);
        if (!query.trim() || query.trim().length < 3) {
            setLocationSuggestions([]);
            setShowLocationDropdown(false);
            return;
        }
        locationDebounceRef.current = setTimeout(async () => {
            setLocationSearching(true);
            try {
                const res = await fetch(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&addressdetails=0`,
                    { headers: { 'Accept-Language': 'en' } }
                );
                const results: LocationSuggestion[] = await res.json();
                setLocationSuggestions(results);
                setShowLocationDropdown(results.length > 0);
            } catch {
                setLocationSuggestions([]);
            } finally {
                setLocationSearching(false);
            }
        }, 500);
    }, []);

    const handleLocationInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setFormData((prev) => ({ ...prev, location: value, latitude: null, longitude: null }));
        searchLocation(value);
    };

    const acceptLocationSuggestion = (suggestion: LocationSuggestion) => {
        setFormData((prev) => ({
            ...prev,
            location: suggestion.display_name,
            latitude: parseFloat(suggestion.lat),
            longitude: parseFloat(suggestion.lon)
        }));
        setShowLocationDropdown(false);
        setLocationSuggestions([]);
    };

    const openAddModal = () => { resetForm(); setShowModal(true); };

    const openEditModal = (b: any) => {
        const contactInfo = parseContactInfo(b.contact_info || '');
        setEditingBranch(b);
        setLocationSuggestions([]);
        setShowLocationDropdown(false);
        setFormData({
            branch_name: b.branch_name || '',
            location: b.location || '',
            latitude: b.latitude ? parseFloat(b.latitude) : null,
            longitude: b.longitude ? parseFloat(b.longitude) : null,
            contact_first_name: contactInfo.primary.first_name,
            contact_last_name: contactInfo.primary.last_name,
            contact_number: getPhoneInputDefault(contactInfo.primary.contact_number),
            contact_number_type: contactInfo.primary.contact_number_type || 'mobile',
            additional_contacts: contactInfo.additional.map((contact) => ({
                first_name: contact.first_name,
                last_name: contact.last_name,
                contact_number: getPhoneInputDefault(contact.contact_number),
                contact_number_type: contact.contact_number_type || 'mobile'
            })),
            status: b.status || 'active'
        });
        setError(''); setSuccess('');
        setShowModal(true);
        setActiveDropdown(null);
    };

    const handleSubmit = async (e: any) => {
        e.preventDefault();
        setError(''); setSuccess('');

        // Required-field check with an inline message under the field.
        if (!String(formData.branch_name || '').trim()) {
            setBranchNameError('Required.');
            return;
        }
        setBranchNameError('');

        if (!isPhoneDraftEmpty(formData.contact_number, DEFAULT_PHONE_COUNTRY_CODE) && !normalizeInternationalPhoneNumber(formData.contact_number, DEFAULT_PHONE_COUNTRY_CODE)) {
            setError('Primary contact number must be a valid international number with a country code, like +63985 323 4710.');
            return;
        }

        for (const contact of formData.additional_contacts) {
            if (!isPhoneDraftEmpty(contact.contact_number, DEFAULT_PHONE_COUNTRY_CODE) && !normalizeInternationalPhoneNumber(contact.contact_number, DEFAULT_PHONE_COUNTRY_CODE)) {
                setError('Additional contact numbers must be valid international numbers with a country code, like +63985 323 4710.');
                return;
            }
        }

        try {
            const isEdit = !!editingBranch;
            const url = `${API_BASE}/branches.php`;
            const method = isEdit ? 'PUT' : 'POST';
            const payloadBase = {
                branch_name: formData.branch_name,
                location: formData.location,
                latitude: formData.latitude,
                longitude: formData.longitude,
                contact_info: buildContactInfoPayload(formData),
                status: formData.status
            };
            const payload = isEdit ? { ...payloadBase, branch_id: editingBranch.branch_id } : payloadBase;

            const res = await fetch(url, {
                method,
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify(payload)
            });
            const data = await res.json();

            if (data.success) {
                setSuccess(isEdit ? 'Branch updated!' : 'Branch created!');
                setShowModal(false);
                resetForm();

                if (isEdit && editingBranch) {
                    // Optimistic update for PUT
                    setBranches((prev) =>
                        (prev || []).map((b) =>
                            b.branch_id === editingBranch.branch_id ? { ...b, ...payload } : b
                        )
                    );
                } else {
                    // Re-fetch so the new branch shows with server truth
                    // (correct sort order, status, and generated fields).
                    setCurrentPage(1);
                    await fetchBranches();
                }
            } else {
                setError(data.message || 'Failed');
            }
        } catch (err) {
            setError('An error occurred');
        }
    };

    // Archive (soft delete)
    const handleArchiveClick = (b: any) => {
        setBranchToDelete(b);
        setShowDeleteConfirm(true);
        setActiveDropdown(null);
    };

    const handleDeleteConfirm = async () => {
        if (!branchToDelete) return;

        try {
            const res = await fetch(`${API_BASE}/branches.php?id=${branchToDelete.branch_id}`, {
                method: 'DELETE',
                credentials: 'include'
            });
            const data = await res.json();
            if (data.success) {
                setBranches((prev) =>
                    (prev || []).map((b) =>
                        b.branch_id === branchToDelete.branch_id ? { ...b, status: 'inactive' } : b
                    )
                );
            } else {
                alert(data.message || 'Failed to archive');
            }
            setShowDeleteConfirm(false);
            setBranchToDelete(null);
        } catch (err) {
            alert('An error occurred');
        }
    };

    // Restore from archive (silent core — callers confirm first)
    const doRestoreBranch = async (branchId: number) => {
        try {
            const res = await fetch(`${API_BASE}/branches.php`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ branch_id: branchId, status: 'active' })
            });
            const data = await res.json();
            if (data.success) {
                setBranches((prev) =>
                    (prev || []).map((b) =>
                        b.branch_id === branchId ? { ...b, status: 'active' } : b
                    )
                );
            } else {
                alert(data.message || 'Failed to restore');
            }
        } catch (err) {
            alert('An error occurred');
        }
    };

    const handleRestore = async (branchId: number) => {
        const target = branches.find(b => b.branch_id === branchId);
        const label = target?.branch_name || 'this branch';
        const confirmed = await confirmAction({
            title: `Restore ${label}?`,
            text: 'This branch will be returned to active branches.',
            confirmButtonText: 'Yes, restore',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        await doRestoreBranch(branchId);
    };

    // Archive All
    const handleArchiveAll = async () => {
        const active = branches.filter(b => b.status === 'active');
        
        if (active.length === 0) {
            alert('No active branches available to archive.');
            return;
        }
        
        const confirmed = await confirmAction({
            title: 'Archive all branches?',
            text: `This will archive ${active.length} ${active.length === 1 ? 'branch' : 'branches'}. Are you sure?`,
            confirmButtonText: 'Archive All',
            icon: 'warning',
            danger: true,
        });
        if (!confirmed) return;

        for (const b of active) { 
            try {
                const res = await fetch(`${API_BASE}/branches.php?id=${b.branch_id}`, { 
                    method: 'DELETE', 
                    credentials: 'include' 
                });
                const data = await res.json();
                if (data.success) {
                    // Continue with next branch
                }
            } catch (err) { 
                console.error('Failed to archive branch', b.branch_id, err); 
            }
        }
        setBranches((prev) =>
            (prev || []).map((b) =>
                active.some((a) => a.branch_id === b.branch_id) ? { ...b, status: 'inactive' } : b
            )
        );
    };

    // Restore All
    const handleRestoreAll = async () => {
        const archivedBranches = branches.filter(b => b.status === 'inactive');
        if (archivedBranches.length === 0) {
            alert('No archived branches to restore.');
            return;
        }
        const confirmed = await confirmAction({
            title: 'Restore all archived branches?',
            text: `This will restore ${archivedBranches.length} archived ${archivedBranches.length === 1 ? 'branch' : 'branches'} to active.`,
            confirmButtonText: 'Yes, restore all',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        for (const b of archivedBranches) {
            await doRestoreBranch(b.branch_id);
        }
        setBranches((prev) =>
            (prev || []).map((b) =>
                archivedBranches.some((a) => a.branch_id === b.branch_id) ? { ...b, status: 'active' } : b
            )
        );
    };

    const toggleDropdown = (e: React.MouseEvent, branchId: number) => {
        e.stopPropagation();
        setActiveDropdown(activeDropdown === branchId ? null : branchId);
    };

    // Filter branches based on view
    const activeBranches = branches.filter(b => b.status === 'active');
    const archivedBranches = branches.filter(b => b.status === 'inactive');
    const displayedBranches = showArchiveView ? archivedBranches : activeBranches;
    const paginatedBranches = displayedBranches.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);

    useEffect(() => {
        setCurrentPage(1);
    }, [showArchiveView]);

    useEffect(() => {
        const totalPages = Math.max(1, Math.ceil(displayedBranches.length / ITEMS_PER_PAGE));
        if (currentPage > totalPages) setCurrentPage(totalPages);
    }, [displayedBranches.length, currentPage]);

    const tableHeaderStyle = { padding: '12px 15px', textAlign: 'left', borderBottom: '2px solid #e2e8f0', color: '#4a5568', fontWeight: 'bold' } as const;
    const tableCellStyle = { padding: '12px 15px', borderBottom: '1px solid #e2e8f0', color: '#2d3748' };

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
                <title>{showArchiveView ? 'Archived Branches' : 'Branch Management'}</title>
            </Head>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <h1 style={{ fontSize: '14px', fontWeight: 'bold', color: '#1a202c', margin: 0 }}>
                        {showArchiveView ? 'Archived Branches' : 'Branch Management'}
                    </h1>
                    {!showArchiveView && (
                        <button
                            onClick={openAddModal}
                            title="Add Branch"
                            aria-label="Add Branch"
                            style={{
                                height: '40px',
                                padding: '0 18px',
                                background: '#1e3a8a',
                                color: 'white',
                                border: 'none',
                                borderRadius: '6px',
                                cursor: 'pointer',
                                fontWeight: 'bold',
                                fontSize: 13,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center'
                            }}
                        >
                            Add Branch
                        </button>
                    )}
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <button
                        onClick={() => setShowArchiveView(!showArchiveView)}
                        title={showArchiveView ? 'Back to Active Branches' : 'View Archived Branches'}
                        style={{
                            background: showArchiveView ? '#1e3a8a' : '#f1f5f9',
                            color: showArchiveView ? 'white' : '#64748b',
                            border: 'none',
                            borderRadius: '6px',
                            height: '36px',
                            padding: '0 12px',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            fontSize: '13px',
                            whiteSpace: 'nowrap'
                        }}
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="21 8 21 21 3 21 3 8"></polyline>
                            <rect x="1" y="3" width="22" height="5"></rect>
                            <line x1="10" y1="12" x2="14" y2="12"></line>
                        </svg>
                        {showArchiveView ? 'Back to Active' : `Archive (${archivedBranches.length})`}
                    </button>
                    {!showArchiveView ? (
                        <>
                            {activeBranches.length > 0 && (
                                <button
                                    onClick={handleArchiveAll}
                                    title="Archive All"
                                    aria-label="Archive All branches"
                                    style={{
                                        height: '36px',
                                        padding: '0 16px',
                                        background: '#dc2626',
                                        color: 'white',
                                        border: 'none',
                                        borderRadius: '6px',
                                        cursor: 'pointer',
                                        fontWeight: 'bold',
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: '6px',
                                        whiteSpace: 'nowrap'
                                    }}
                                >
                                    <CrudActionIcon action="archive" />
                                    Archive All
                                </button>
                            )}
                        </>
                    ) : archivedBranches.length > 0 && (
                        <button
                            onClick={handleRestoreAll}
                            title="Restore All"
                            aria-label="Restore All branches"
                            style={{ height: '36px', padding: '0 16px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                        >
                            <CrudActionIcon action="restore" />
                        </button>
                    )}
                </div>
            </div>

            {/* Branches Table */}
            <div style={{ background: 'white', borderRadius: '12px', boxShadow: '0 1px 3px rgba(0,0,0,0.1)', overflow: 'visible' }}>
                <table className="llb-table llb-pin-first" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead style={{ background: '#f8fafc' }}>
                        <tr>
                            <th style={tableHeaderStyle}>Branch Name</th>
                            <th style={tableHeaderStyle}>Location</th>
                            <th style={tableHeaderStyle}>Contact Person</th>
                            {!showArchiveView && <th style={tableHeaderStyle}>Status</th>}
                            <th style={tableHeaderStyle}>Issued At</th>
                            <th style={{ ...tableHeaderStyle, textAlign: 'center', width: showArchiveView ? '150px' : '60px' }}>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {displayedBranches.length === 0 ? (
                            <tr>
                                <td colSpan={showArchiveView ? 5 : 6} style={{ padding: '20px', textAlign: 'center', color: '#666' }}>
                                    {showArchiveView ? 'No archived branches.' : 'No branches found.'}
                                </td>
                            </tr>
                        ) : paginatedBranches.map((b: any) => (
                            <tr key={b.branch_id} style={{ transition: 'background-color 0.2s' }}>
                                <td style={tableCellStyle} className="llb-trunc" title={b.branch_name}><strong>{b.branch_name}</strong></td>
                                <td style={tableCellStyle} className="llb-trunc" title={b.location || ''}>{b.location || '-'}</td>
                                <td style={tableCellStyle}>{formatContactInfo(b.contact_info)}</td>
                                {!showArchiveView && (
                                    <td style={tableCellStyle}>
                                        <span style={{
                                            color: 'green', fontWeight: 'bold', textTransform: 'capitalize',
                                            padding: '4px 8px', borderRadius: '12px', background: '#dcfce7'
                                        }}>
                                            {b.status}
                                        </span>
                                    </td>
                                )}
                                <td style={tableCellStyle}>{b.created_at ? new Date(b.created_at).toLocaleDateString() : '-'}</td>
                                <td style={{ ...tableCellStyle, textAlign: 'center', position: 'relative' }} className="llb-actions">
                                    {showArchiveView ? (
                                        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center' }}>
                                            <button
                                                onClick={() => handleRestore(b.branch_id)}
                                                title="Restore"
                                                aria-label={`Restore ${b.branch_name}`}
                                                style={{ padding: '6px 12px', background: '#16a34a', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                                            >
                                                <CrudActionIcon action="restore" />
                                            </button>
                                        </div>
                                    ) : (
                                        <>
                                            <button
                                                onClick={(e) => toggleDropdown(e, b.branch_id)}
                                                style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: '5px' }}
                                            >
                                                <svg width="20" height="20" viewBox="0 0 24 24" fill="#666">
                                                    <circle cx="12" cy="5" r="2"></circle>
                                                    <circle cx="12" cy="12" r="2"></circle>
                                                    <circle cx="12" cy="19" r="2"></circle>
                                                </svg>
                                            </button>
                                            {activeDropdown === b.branch_id && (
                                                <div style={{
                                                    position: 'absolute', right: '10px', top: '100%', background: 'white',
                                                    border: '1px solid #e2e8f0', borderRadius: '8px',
                                                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)', zIndex: 100, minWidth: '120px'
                                                }}>
                                                    <button onClick={() => openEditModal(b)} title="Edit" aria-label={`Edit ${b.branch_name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer' }}>
                                                        <CrudActionIcon action="edit" /> Edit
                                                    </button>
                                                    <button onClick={() => handleArchiveClick(b)} title="Archive" aria-label={`Archive ${b.branch_name}`} style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', padding: '10px', textAlign: 'left', background: 'none', border: 'none', cursor: 'pointer', color: 'red' }}>
                                                        <CrudActionIcon action="archive" /> Archive
                                                    </button>
                                                </div>
                                            )}
                                        </>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Pagination
                currentPage={currentPage}
                totalItems={displayedBranches.length}
                itemsPerPage={ITEMS_PER_PAGE}
                onPageChange={setCurrentPage}
                label={showArchiveView ? 'archived branches' : 'branches'}
            />

            {/* Add/Edit Modal */}
            {showModal && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '560px', maxWidth: '95%', maxHeight: '90vh', overflowY: 'auto' }}>
                        <h2 style={{ marginTop: 0, marginBottom: '20px', color: '#333' }}>
                            {editingBranch ? 'Edit Branch' : 'Add New Branch'}
                        </h2>

                        <form onSubmit={handleSubmit} noValidate>
                            <div style={{ marginBottom: '15px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Branch Name *</label>
                                <input type="text" name="branch_name" value={formData.branch_name} onChange={handleInputChange} required aria-required="true" aria-invalid={branchNameError ? true : undefined}
                                    style={{ width: '100%', padding: '10px', borderRadius: '6px', border: branchNameError ? '2px solid #ef4444' : '1px solid #ccc', color: '#000', backgroundColor: '#fff' }} />
                                {branchNameError && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{branchNameError}</div>}
                            </div>

                            {/* Location field with autocomplete */}
                            <div style={{ marginBottom: '15px', position: 'relative' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>
                                    Location
                                    {locationSearching && (
                                        <span style={{ marginLeft: 8, color: '#94a3b8', fontSize: '12px' }}>Searching…</span>
                                    )}
                                </label>
                                <div style={{ position: 'relative' }}>
                                    <input
                                        ref={locationInputRef}
                                        type="text"
                                        name="location"
                                        value={formData.location}
                                        onChange={handleLocationInputChange}
                                        onFocus={() => { if (locationSuggestions.length > 0) setShowLocationDropdown(true); }}
                                        autoComplete="off"
                                        placeholder="Type to search a location…"
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff', boxSizing: 'border-box' }}
                                    />
                                    {formData.latitude && (
                                        <span title="Location pinned" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: '#16a34a', fontSize: 16 }}>📍</span>
                                    )}
                                </div>

                                {/* Suggestions dropdown */}
                                {showLocationDropdown && locationSuggestions.length > 0 && (
                                    <div
                                        ref={locationDropdownRef}
                                        style={{
                                            position: 'absolute',
                                            top: '100%',
                                            left: 0,
                                            right: 0,
                                            background: 'white',
                                            border: '1px solid #e2e8f0',
                                            borderRadius: '8px',
                                            boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
                                            zIndex: 2000,
                                            maxHeight: '220px',
                                            overflowY: 'auto',
                                            marginTop: '2px'
                                        }}
                                    >
                                        <div style={{ padding: '6px 10px 4px', fontSize: '11px', color: '#94a3b8', borderBottom: '1px solid #f1f5f9' }}>
                                            Suggested locations — click to accept
                                        </div>
                                        {locationSuggestions.map((s, i) => (
                                            <button
                                                key={i}
                                                type="button"
                                                onClick={() => acceptLocationSuggestion(s)}
                                                style={{
                                                    display: 'block',
                                                    width: '100%',
                                                    textAlign: 'left',
                                                    padding: '9px 12px',
                                                    background: 'none',
                                                    border: 'none',
                                                    borderBottom: i < locationSuggestions.length - 1 ? '1px solid #f1f5f9' : 'none',
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
                                            onClick={() => setShowLocationDropdown(false)}
                                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setShowLocationDropdown(false); } }}
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
                                    </div>
                                )}

                                {/* Map preview */}
                                {formData.latitude && formData.longitude && (
                                    <div style={{ marginTop: '10px', borderRadius: '8px', overflow: 'hidden', border: '1px solid #e2e8f0' }}>
                                        <iframe
                                            title="Location map preview"
                                            width="100%"
                                            height="180"
                                            style={{ display: 'block', border: 'none' }}
                                            src={`https://www.openstreetmap.org/export/embed.html?bbox=${formData.longitude - 0.01},${formData.latitude - 0.01},${formData.longitude + 0.01},${formData.latitude + 0.01}&layer=mapnik&marker=${formData.latitude},${formData.longitude}`}
                                        />
                                        <div style={{ padding: '6px 10px', background: '#f8fafc', fontSize: '11px', color: '#64748b', borderTop: '1px solid #e2e8f0' }}>
                                            📍 Pinned: {formData.latitude.toFixed(5)}, {formData.longitude.toFixed(5)} — You can still edit the address text above.
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div style={{ marginBottom: '15px', display: 'flex', gap: '12px' }}>
                                <div style={{ flex: 1 }}>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Contact First Name</label>
                                    <input
                                        type="text"
                                        name="contact_first_name"
                                        value={formData.contact_first_name}
                                        onChange={handleInputChange}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                                    />
                                </div>
                                <div style={{ flex: 1 }}>
                                    <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Contact Last Name</label>
                                    <input
                                        type="text"
                                        name="contact_last_name"
                                        value={formData.contact_last_name}
                                        onChange={handleInputChange}
                                        style={{ width: '100%', padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                                    />
                                </div>
                            </div>

                            <div style={{ marginBottom: '10px' }}>
                                <label style={{ display: 'block', marginBottom: '5px', color: '#555', fontSize: '14px' }}>Contact Number</label>
                                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                                    <button
                                        type="button"
                                        onClick={() => setContactNumberType('mobile')}
                                        style={{
                                            padding: '6px 10px',
                                            borderRadius: '6px',
                                            border: '1px solid #cbd5f5',
                                            background: formData.contact_number_type === 'mobile' ? '#1e3a8a' : '#f8fafc',
                                            color: formData.contact_number_type === 'mobile' ? '#fff' : '#1f2937',
                                            cursor: 'pointer',
                                            fontWeight: 600,
                                            fontSize: '12px'
                                        }}
                                    >
                                        Mobile
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setContactNumberType('telephone')}
                                        style={{
                                            padding: '6px 10px',
                                            borderRadius: '6px',
                                            border: '1px solid #cbd5f5',
                                            background: formData.contact_number_type === 'telephone' ? '#1e3a8a' : '#f8fafc',
                                            color: formData.contact_number_type === 'telephone' ? '#fff' : '#1f2937',
                                            cursor: 'pointer',
                                            fontWeight: 600,
                                            fontSize: '12px'
                                        }}
                                    >
                                        Telephone
                                    </button>
                                </div>
                                <PhoneInput
                                    name="contact_number"
                                    value={formData.contact_number}
                                    onChange={(contact_number) => setFormData((prev) => ({ ...prev, contact_number }))}
                                    ariaLabel="Primary contact number"
                                    countryAriaLabel="Primary contact country calling code"
                                    placeholder="Phone number"
                                    inputStyle={{ padding: '10px', borderColor: '#ccc', color: '#000' }}
                                    selectStyle={{ padding: '10px 8px', borderColor: '#ccc', color: '#000' }}
                                />
                                <div style={{ marginTop: '6px', color: '#64748b', fontSize: '12px' }}>
                                    Choose a country code, then enter the local number. Philippines (+63) is the default.
                                </div>
                            </div>

                            <div style={{ marginBottom: '15px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                    <span style={{ color: '#555', fontSize: '14px', fontWeight: 600 }}>Additional Contacts</span>
                                    <button
                                        type="button"
                                        onClick={addAdditionalContact}
                                        style={{ padding: '4px 10px', background: '#e2e8f0', border: 'none', borderRadius: '6px', cursor: 'pointer', color: '#1f2937', fontWeight: 600 }}
                                    >
                                        +
                                    </button>
                                </div>
                                {formData.additional_contacts.length === 0 && (
                                    <div style={{ color: '#94a3b8', fontSize: '12px' }}>No additional contacts added.</div>
                                )}
                                {formData.additional_contacts.map((contact, index) => (
                                    <div key={`additional-contact-${index}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginBottom: '12px' }}>
                                        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                                            <input
                                                type="text"
                                                placeholder="First name"
                                                value={contact.first_name}
                                                onChange={(e) => updateAdditionalContact(index, 'first_name', e.target.value)}
                                                style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                                            />
                                            <input
                                                type="text"
                                                placeholder="Last name"
                                                value={contact.last_name}
                                                onChange={(e) => updateAdditionalContact(index, 'last_name', e.target.value)}
                                                style={{ flex: 1, padding: '10px', borderRadius: '6px', border: '1px solid #ccc', color: '#000', backgroundColor: '#fff' }}
                                            />
                                            <button
                                                type="button"
                                                onClick={() => removeAdditionalContact(index)}
                                                aria-label={`Remove additional contact ${index + 1}`}
                                                style={{ padding: '6px 10px', background: '#fee2e2', border: 'none', borderRadius: '6px', cursor: 'pointer', color: '#b91c1c', fontWeight: 600 }}
                                            >
                                                -
                                            </button>
                                        </div>
                                        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                                            <button
                                                type="button"
                                                onClick={() => setAdditionalContactNumberType(index, 'mobile')}
                                                style={{
                                                    padding: '6px 10px',
                                                    borderRadius: '6px',
                                                    border: '1px solid #cbd5f5',
                                                    background: contact.contact_number_type === 'mobile' ? '#1e3a8a' : '#f8fafc',
                                                    color: contact.contact_number_type === 'mobile' ? '#fff' : '#1f2937',
                                                    cursor: 'pointer',
                                                    fontWeight: 600,
                                                    fontSize: '12px'
                                                }}
                                            >
                                                Mobile
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setAdditionalContactNumberType(index, 'telephone')}
                                                style={{
                                                    padding: '6px 10px',
                                                    borderRadius: '6px',
                                                    border: '1px solid #cbd5f5',
                                                    background: contact.contact_number_type === 'telephone' ? '#1e3a8a' : '#f8fafc',
                                                    color: contact.contact_number_type === 'telephone' ? '#fff' : '#1f2937',
                                                    cursor: 'pointer',
                                                    fontWeight: 600,
                                                    fontSize: '12px'
                                                }}
                                            >
                                                Telephone
                                            </button>
                                            <PhoneInput
                                                value={contact.contact_number}
                                                onChange={(value) => updateAdditionalContact(index, 'contact_number', value)}
                                                ariaLabel={`Additional contact ${index + 1} number`}
                                                countryAriaLabel={`Additional contact ${index + 1} country calling code`}
                                                placeholder="Phone number"
                                                style={{ flex: 1 }}
                                                inputStyle={{ padding: '10px', borderColor: '#ccc', color: '#000' }}
                                                selectStyle={{ padding: '10px 8px', borderColor: '#ccc', color: '#000' }}
                                            />
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '16px', alignItems: 'center' }}>
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
                                <button 
                                    type="submit"
                                    title={editingBranch ? 'Update Branch' : 'Create Branch'}
                                    aria-label={editingBranch ? 'Update Branch' : 'Create Branch'}
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
                                    {editingBranch ? 'Update' : 'Save'}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && branchToDelete && (
                <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1001 }}>
                    <div style={{ background: 'white', padding: '30px', borderRadius: '12px', width: '400px', maxWidth: '90%', textAlign: 'center' }}>
                        <h3 style={{ margin: '0 0 10px 0', color: '#333' }}>
                            Archive Branch?
                        </h3>
                        <p style={{ margin: '0 0 20px 0', color: '#666' }}>
                            Are you sure you want to archive <strong>{branchToDelete.branch_name}</strong>?
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '10px' }}>
                            <button
                                onClick={() => { setShowDeleteConfirm(false); setBranchToDelete(null); }}
                                style={{ padding: '10px 20px', background: 'transparent', border: '1px solid #ccc', borderRadius: '6px', cursor: 'pointer', color: '#666' }}
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDeleteConfirm}
                                title="Archive"
                                aria-label="Archive branch"
                                style={{ padding: '10px 20px', background: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', color: 'white', fontWeight: 'bold', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                            >
                                <CrudActionIcon action="archive" />
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
