import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import Layout from '../../components/Layout';
import Pagination from '../../components/Pagination';
import { notifyError, notifySuccess, notifyWarning, confirmAction } from '@/utils/notify';
import { getApiBaseUrl, resolveBackendAssetUrl } from '@/utils/network';
import { useLiveSync } from '@/utils/liveSync';
import { usePaginationSetting } from '@/utils/usePaginationSetting';
import DocumentPreviewModal, { type PreviewDocument } from '../../components/DocumentPreviewModal';
import { FieldMessage, FormAlert } from '../../components/FormAlert';
import SearchBar from '../../components/SearchBar';
import ZeroResults from '../../components/ZeroResults';
import { collectSearchTerms, getAlternativeSuggestions } from '@/utils/search';

type Contract = {
    id: number;
    client_id: number;
    title: string;
    body: string;
    status: 'pending' | 'accepted' | 'rejected' | 'expired';
    is_signed: number;
    is_archived: number;
    signed_contract_file?: string | null;
    token: string;
    token_expires_at: string;
    sent_at: string | null;
    responded_at: string | null;
    admin_notified_at: string | null;
    created_at: string;
    client_name: string;
    client_email: string;
    project_count?: number | string;
    project_deadline?: string | null;
};

type ClientOption = {
    client_id: number;
    client_name: string;
    email: string;
    company_email?: string;
    services?: any[];
};

type ManagerOption = {
    id: number;
    first_name?: string;
    last_name?: string;
};

function getContractTemplateTitle(clientName: string) {
    return `Service Engagement - ${clientName || 'Client'}`;
}

function getContractTemplateBody(client: ClientOption | null) {
    const clientName = String(client?.client_name || 'Client');
    const serviceNames = Array.isArray(client?.services)
        ? client.services.map((s: any) => String(s?.service_name || '').trim()).filter(Boolean)
        : [];
    const serviceList = serviceNames.length > 0
        ? serviceNames.map((name, i) => `${i + 1}. ${name}`).join('\n')
        : '- Services as agreed upon during consultation';
    return [
        'SERVICE ENGAGEMENT AGREEMENT',
        `Client: ${clientName}`,
        '',
        '1. SCOPE OF SERVICES',
        serviceList,
        '',
        '2. TERMS AND CONDITIONS',
        'a) The Service Provider shall perform the services with due care and professional diligence.',
        'b) The Client agrees to provide all necessary documentation and information required for the completion of services in a timely manner.',
        'c) Both parties agree to maintain confidentiality of all proprietary and sensitive information exchanged during the engagement.',
        'd) Payment terms shall be in accordance with the fee schedule provided separately or as mutually agreed upon.',
        'e) Either party may terminate this agreement with 30 days written notice.',
        '',
        '3. DELIVERABLES AND TIMELINE',
        'Deliverables and timelines will be established upon project initiation and communicated through the project management system.',
        '',
        '4. ACCEPTANCE',
        'By accepting this contract, the Client acknowledges that they have read, understood, and agree to the terms set forth in this Agreement.',
        'This Agreement shall be effective as of the date of acceptance.',
    ].join('\n');
}

function formatDate(value: string | null) {
    if (!value) return '—';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function getStatusConfig(status: string, contract?: Contract) {
    // If a signed contract file has been uploaded, override display to Valid/Expired
    // based on whether the project deadline has passed.
    if (contract?.signed_contract_file) {
        const deadline = contract.project_deadline;
        const isExpired = deadline ? new Date(deadline) < new Date() : false;
        if (isExpired) {
            return { bg: '#fef3c7', color: '#92400e', label: 'Expired', icon: '⏰' };
        }
        return { bg: '#d1fae5', color: '#065f46', label: 'Valid', icon: '✅' };
    }
    switch (status) {
        case 'accepted': return { bg: '#d1fae5', color: '#065f46', label: 'Valid',    icon: '✅' };
        case 'rejected': return { bg: '#fee2e2', color: '#991b1b', label: 'Rejected', icon: '❌' };
        case 'expired':  return { bg: '#fef3c7', color: '#92400e', label: 'Expired',  icon: '⏰' };
        default:         return { bg: '#eff6ff', color: '#1e40af', label: 'Pending',  icon: '📋' };
    }
}

function canCreateProjectFromContract(contract: Contract) {
    return contract.status === 'accepted' && Number(contract.project_count || 0) <= 0;
}

function buildContractPrintHtml(title: string, body: string, clientName: string, contractId: number): string {
    const rows = body.split('\n').map(line => {
        const t = line.trim();
        if (t === '') return '<div style="height:8px"></div>';
        // skip signature block lines — the sig-block div is appended separately
        if (/^_{5,}/.test(t) || /^(Client Signature|Authorized Representative|Date:\s*_{3,})/.test(t)) return '';
        if (/^\d+\.\s+[A-Z]/.test(t)) return `<h3 style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.04em;border-bottom:1px solid #e2e8f0;padding-bottom:2px;margin:10px 0 4px">${t}</h3>`;
        if (/^[a-z]\)/.test(t)) return `<p style="padding-left:16px;margin:1px 0;color:#334155;font-size:10px">${t}</p>`;
        if (/^\d+\.\s/.test(t) && !/[A-Z]{3,}/.test(t)) return `<p style="padding-left:16px;margin:1px 0;color:#334155;font-size:10px">${t}</p>`;
        return `<p style="margin:1px 0;font-size:10.5px">${t}</p>`;
    }).join('');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:210mm;height:297mm}
body{font-family:"Segoe UI",system-ui,sans-serif;font-size:11px;line-height:1.6;color:#1e293b;background:#fff}
.page{width:210mm;min-height:297mm;padding:14mm 16mm;display:flex;flex-direction:column}
.letterhead{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0f172a;padding-bottom:10px;margin-bottom:14px}
.firm-name{font-size:17px;font-weight:900;color:#0f172a;letter-spacing:-.02em}
.firm-sub{font-size:9px;color:#64748b;margin-top:2px}
.meta{text-align:right;font-size:9px;color:#64748b;line-height:1.5}
.meta strong{color:#0f172a;font-size:10px}
.title-block{text-align:center;margin-bottom:14px}
.title-pill{display:inline-block;background:#0f172a;color:#fff;padding:4px 20px;border-radius:4px;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase}
.body-content{flex:1}
.sig-block{margin-top:20px;padding-top:10px;border-top:1px solid #e2e8f0;font-size:9px;color:#475569;display:flex;gap:40px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}@page{size:A4 portrait;margin:0}.page{page-break-after:avoid;page-break-inside:avoid}}
</style></head><body>
<div class="page">
<div class="letterhead">
  <div><div class="firm-name">LLB Accountants</div><div class="firm-sub">Professional Accounting Services</div></div>
  <div class="meta"><strong>CONTRACT #${contractId}</strong><br>${new Date().toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})}<br>Client: ${clientName}</div>
</div>
<div class="title-block"><span class="title-pill">${title}</span></div>
<div class="body-content">${rows}</div>
<div class="sig-block">
  <div><div>___________________________</div><div>Client Signature</div><div style="margin-top:4px">Date: ___________________</div></div>
  <div><div>___________________________</div><div>Authorized Representative</div></div>
</div>
</div></body></html>`;
}

// ── 3-dot dropdown — fixed-position so it overlays everything ─────
function ActionMenu({ items }: { items: { label: string; icon: string; danger?: boolean; onClick: () => void }[] }) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState({ top: 0, left: 0 });
    const btnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const handler = (e: MouseEvent) => {
            if (
                btnRef.current && !btnRef.current.contains(e.target as Node) &&
                menuRef.current && !menuRef.current.contains(e.target as Node)
            ) setOpen(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open]);

    const handleOpen = () => {
        if (btnRef.current) {
            const r = btnRef.current.getBoundingClientRect();
            // position below-right, then shift left if off-screen
            const menuW = 176;
            let left = r.right - menuW;
            if (left < 8) left = r.left;
            setPos({ top: r.bottom + 6, left });
        }
        setOpen(o => !o);
    };

    return (
        <>
            <button
                ref={btnRef}
                onClick={handleOpen}
                style={{ width: 32, height: 32, background: open ? '#e2e8f0' : '#f1f5f9', border: 'none', borderRadius: 8, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 3 }}
            >
                {[0,1,2].map(i => (
                    <span key={i} style={{ display: 'block', width: 4, height: 4, borderRadius: '50%', background: '#475569' }} />
                ))}
            </button>
            {open && (
                <div
                    ref={menuRef}
                    style={{ position: 'fixed', top: pos.top, left: pos.left, background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: '1px solid #e2e8f0', zIndex: 99999, minWidth: 176, overflow: 'hidden' }}
                >
                    {items.map((item, i) => (
                        <button
                            key={i}
                            onClick={() => { setOpen(false); item.onClick(); }}
                            style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: item.danger ? '#dc2626' : '#1e293b', textAlign: 'left', borderBottom: i < items.length - 1 ? '1px solid #f1f5f9' : 'none' }}
                        >
                            <span style={{ fontSize: 15 }}>{item.icon}</span> {item.label}
                        </button>
                    ))}
                </div>
            )}
        </>
    );
}

export default function Contracts() {
    const router = useRouter();
    const API_BASE = getApiBaseUrl();
    const ITEMS_PER_PAGE = usePaginationSetting();
    const [user, setUser] = useState<any>(null);
    const [contracts, setContracts] = useState<Contract[]>([]);
    const [archivedContracts, setArchivedContracts] = useState<Contract[]>([]);
    // Upload signed contract modal (client first, then file)
    const [showUploadModal, setShowUploadModal] = useState(false);
    const [uploadClientId, setUploadClientId] = useState('');
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [uploading, setUploading] = useState(false);
    const uploadFileRef = useRef<HTMLInputElement>(null);
    // Inline form messages (no popups): field errors sit under their inputs.
    const [uploadClientError, setUploadClientError] = useState('');
    const [uploadFileError, setUploadFileError] = useState('');
    const [uploadFormError, setUploadFormError] = useState('');
    const [pageNotice, setPageNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);

    // Auto-dismiss the page-level inline notice after a few seconds.
    useEffect(() => {
        if (!pageNotice) return;
        const t = window.setTimeout(() => setPageNotice(null), 5000);
        return () => window.clearTimeout(t);
    }, [pageNotice]);
    // Archive page flip
    const [showArchivePage, setShowArchivePage] = useState(false);
    const [clients, setClients] = useState<ClientOption[]>([]);
    const [managers, setManagers] = useState<ManagerOption[]>([]);
    const [loading, setLoading] = useState(true);
    const [currentPage, setCurrentPage] = useState(1);
    const [archivePage, setArchivePage] = useState(1);
    const [searchTerm, setSearchTerm] = useState('');
    const [statusFilter, setStatusFilter] = useState('all');
    const [loadingArchive, setLoadingArchive] = useState(false);
    const [restoringAll, setRestoringAll] = useState(false);

    // View detail modal (row click — full-page expand)
    const [viewContract, setViewContract] = useState<Contract | null>(null);
    const [viewEditMode, setViewEditMode] = useState(false);
    const [viewDraftTitle, setViewDraftTitle] = useState('');
    const [viewDraftBody, setViewDraftBody] = useState('');
    const [savingView, setSavingView] = useState(false);

    // Document preview modal
    const [previewDoc, setPreviewDoc] = useState<PreviewDocument | null>(null);
    const [uploadingDoc, setUploadingDoc] = useState(false);
    const docUploadRef = useRef<HTMLInputElement>(null);

    // Create modal
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [creating, setCreating] = useState(false);
    const [formClientId, setFormClientId] = useState('');
    const [formTitle, setFormTitle] = useState('');
    const [formBody, setFormBody] = useState('');
    const [formExpiresDays, setFormExpiresDays] = useState('7');
    const [formClientDuplicateContractId, setFormClientDuplicateContractId] = useState<number | null>(null);
    const [formEditingTemplate, setFormEditingTemplate] = useState(false);

    // Project modal
    const [showProjectModal, setShowProjectModal] = useState(false);
    const [projectContract, setProjectContract] = useState<Contract | null>(null);
    const [projectManagerId, setProjectManagerId] = useState('');
    const [projectEndDate, setProjectEndDate] = useState('');
    // Inline per-field "Required" messages for the Create Project dialog.
    const [projectFormErrors, setProjectFormErrors] = useState<Record<string, string>>({});
    const [creatingProject, setCreatingProject] = useState(false);

    const normalizedRole = String(user?.role || '').toLowerCase();
    const canManageContracts = normalizedRole === 'admin';
    const canRequestContractEdit = normalizedRole === 'manager';

    // Live-sync: silently refresh contracts in background.
    useLiveSync(async () => {
        if (!user) return;
        const role = String(user?.role || '').toLowerCase();
        if (role === 'admin') {
            await Promise.all([fetchContracts(), fetchClients(), fetchManagers()]);
        } else {
            await fetchContracts();
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    });

    useEffect(() => { checkSession(); }, []);

    useEffect(() => {
        if (!router.isReady) return;
        const accepted = router.query.accepted;
        if (accepted && contracts.length > 0) {
            const c = contracts.find(ct => String(ct.id) === String(accepted));
            if (canManageContracts && c && c.status === 'accepted') {
                openProjectModal(c);
                router.replace('/contracts', undefined, { shallow: true });
            }
        }
        const highlight = router.query.highlight;
        if (highlight && contracts.length > 0) {
            const c = contracts.find(ct => String(ct.id) === String(highlight));
            if (c) { setViewContract(c); router.replace('/contracts', undefined, { shallow: true }); }
        }
    }, [canManageContracts, router.isReady, router.query, contracts]);

    const checkSession = async () => {
        try {
            // Start data fetches optimistically in parallel with auth (auth is
            // served from the in-memory cache after the first page load).
            const [authRes] = await Promise.all([
                fetch(`${API_BASE}/auth.php`, { credentials: 'include' }),
                fetchContracts(),
                fetchClients(),
                fetchManagers(),
            ]);
            const data = await authRes.json();
            if (data.success) {
                setUser(data.data);
            } else { router.push('/'); }
        } catch { router.push('/'); }
        finally { setLoading(false); }
    };

    const fetchContracts = async () => {
        try {
            const res = await fetch(`${API_BASE}/contracts.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setContracts(data.data || []);
        } catch { console.error('Failed to fetch contracts'); }
    };

    const fetchArchivedContracts = async () => {
        setLoadingArchive(true);
        try {
            const res = await fetch(`${API_BASE}/contracts.php?archived=1`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setArchivedContracts(data.data || []);
        } catch { console.error('Failed to fetch archived contracts'); }
        finally { setLoadingArchive(false); }
    };

    const fetchClients = async () => {
        try {
            const res = await fetch(`${API_BASE}/clients.php`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setClients(data.data || []);
        } catch {}
    };

    const fetchManagers = async () => {
        try {
            const res = await fetch(`${API_BASE}/users.php?role=manager&status=active`, { credentials: 'include' });
            const data = await res.json();
            if (data.success) setManagers(data.data || []);
        } catch {}
    };

    const handleToggleSigned = async (c: Contract) => {
        try {
            const res = await fetch(`${API_BASE}/contracts.php?action=toggle_signed`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ id: c.id }),
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess(data.message);
                setContracts(prev => prev.map(x => x.id === c.id ? { ...x, is_signed: data.data.is_signed } : x));
                if (viewContract?.id === c.id) setViewContract(v => v ? { ...v, is_signed: data.data.is_signed } : v);
            } else notifyError(data.message || 'Failed.');
        } catch { notifyError('Network error.'); }
    };

    const handleToggleArchive = async (c: Contract, fromArchiveList = false) => {
        if (fromArchiveList) {
            const confirmed = await confirmAction({
                title: `Restore "${c.title || 'this contract'}"?`,
                text: 'This contract will be returned to active contracts.',
                confirmButtonText: 'Yes, restore',
                cancelButtonText: 'Cancel',
                icon: 'question',
            });
            if (!confirmed) return;
        }
        try {
            const res = await fetch(`${API_BASE}/contracts.php?action=toggle_archive`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ id: c.id }),
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess(data.message);
                if (fromArchiveList) {
                    // Moving from archived → active: remove from archived list, add to active list
                    const restored = { ...c, archived: 0 };
                    setArchivedContracts(prev => prev.filter(x => x.id !== c.id));
                    setContracts(prev => [restored, ...prev]);
                } else {
                    // Moving from active → archived: remove from active list, add to archived list
                    const archived = { ...c, archived: 1 };
                    setContracts(prev => prev.filter(x => x.id !== c.id));
                    setArchivedContracts(prev => [archived, ...prev]);
                }
                if (viewContract?.id === c.id) setViewContract(null);
            } else notifyError(data.message || 'Failed.');
        } catch { notifyError('Network error.'); }
    };

    const handleRestoreAll = async () => {
        if (archivedContracts.length === 0) {
            notifyWarning('No archived contracts to restore.');
            return;
        }
        const confirmed = await confirmAction({
            title: 'Restore all archived contracts?',
            text: `This will restore ${archivedContracts.length} archived contract(s) to active.`,
            confirmButtonText: 'Yes, restore all',
            cancelButtonText: 'Cancel',
            icon: 'question',
        });
        if (!confirmed) return;
        setRestoringAll(true);
        try {
            const res = await fetch(`${API_BASE}/contracts.php?action=restore_all_archived`, {
                method: 'POST', credentials: 'include',
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess('All archived contracts restored.');
                // Move all archived contracts to the active list locally
                setContracts(prev => [...archivedContracts.map(x => ({ ...x, archived: 0 })), ...prev]);
                setArchivedContracts([]);
            } else notifyError(data.message || 'Failed.');
        } catch { notifyError('Network error.'); }
        finally { setRestoringAll(false); }
    };

    const fillContractTemplate = (clientId: string) => {
        const client = clients.find(c => String(c.client_id) === String(clientId)) || null;
        const duplicate = contracts.find(c => String(c.client_id) === String(clientId) && ['pending', 'accepted'].includes(String(c.status || '').toLowerCase()));
        setFormClientId(clientId);
        setFormTitle(getContractTemplateTitle(String(client?.client_name || 'Client')));
        setFormBody(getContractTemplateBody(client));
        setFormClientDuplicateContractId(duplicate ? Number(duplicate.id) : null);
        setFormEditingTemplate(false);
    };

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!formClientId || !formTitle || !formBody) { notifyError('Please fill all required fields.'); return; }
        setCreating(true);
        try {
            const res = await fetch(`${API_BASE}/contracts.php`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ client_id: Number(formClientId), title: formTitle, body: formBody, expires_days: Number(formExpiresDays) || 7 }),
            });
            const data = await res.json();
            if (data.success) {
                data.data?.duplicate_resend ? notifyWarning(data.message) : notifySuccess(data.message || 'Contract sent!');
                setShowCreateModal(false);
                resetForm();
                // Fetch only the contracts list — faster than full page refetch
                await fetchContracts();
            } else notifyError(data.message || 'Failed to create contract.');
        } catch { notifyError('Network error.'); }
        finally { setCreating(false); }
    };

    const resetForm = () => {
        setFormClientId(''); setFormTitle(''); setFormBody('');
        setFormExpiresDays('7'); setFormClientDuplicateContractId(null); setFormEditingTemplate(false);
    };

    const handleSaveEdit = async () => {
        if (!viewContract || !viewDraftTitle.trim() || !viewDraftBody.trim()) return;
        setSavingView(true);
        try {
            const res = await fetch(`${API_BASE}/contracts.php`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ id: viewContract.id, title: viewDraftTitle.trim(), body: viewDraftBody.trim() }),
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess('Contract saved.');
                const updated = { ...viewContract, title: viewDraftTitle.trim(), body: viewDraftBody.trim() };
                setViewContract(updated);
                setContracts(prev => prev.map(x => x.id === viewContract.id ? updated : x));
                setViewEditMode(false);
            } else notifyError(data.message || 'Failed to save.');
        } catch { notifyError('Network error.'); }
        finally { setSavingView(false); }
    };

    const openView = (c: Contract) => {
        setViewContract(c);
        setViewEditMode(false);
        setViewDraftTitle(c.title);
        setViewDraftBody(c.body);
    };

    const openDocViewer = (c: Contract, e: React.MouseEvent) => {
        e.stopPropagation();
        if (c.signed_contract_file) {
            setPreviewDoc({ name: `Signed Contract — ${c.client_name}`, url: resolveBackendAssetUrl(c.signed_contract_file), mime: 'application/pdf' });
        }
    };

    const openUploadModal = () => {
        setUploadClientId('');
        setUploadFile(null);
        setUploadClientError('');
        setUploadFileError('');
        setUploadFormError('');
        setShowUploadModal(true);
    };

    const handleUploadNewSignedContract = async () => {
        // Inline field labels instead of popup toasts.
        let hasError = false;
        if (!uploadClientId) { setUploadClientError('Please choose which client this contract belongs to.'); hasError = true; }
        else setUploadClientError('');
        if (!uploadFile) { setUploadFileError('Please attach the signed contract PDF.'); hasError = true; }
        else setUploadFileError('');
        if (hasError) return;
        setUploadFormError('');
        setUploading(true);
        try {
            const fd = new FormData();
            fd.append('client_id', uploadClientId);
            fd.append('signed_contract', uploadFile as File);
            const res = await fetch(`${API_BASE}/contracts.php?action=upload_new_signed_contract`, {
                method: 'POST', credentials: 'include', body: fd,
                headers: { 'X-No-Toast': '1' },
            });
            const data = await res.json();
            if (data.success) {
                setShowUploadModal(false);
                setUploadClientId('');
                setUploadFile(null);
                await fetchContracts();
                setPageNotice({ tone: 'success', message: data.message || 'Signed contract uploaded!' });
            } else setUploadFormError(data.message || 'Upload failed. Please try again.');
        } catch { setUploadFormError('Network error. Please check your connection and try again.'); }
        finally { setUploading(false); }
    };

    const handleUploadSignedContract = async (contractId: number, file: File) => {
        setUploadingDoc(true);
        try {
            const formData = new FormData();
            formData.append('contract_id', String(contractId));
            formData.append('signed_contract', file);
            const res = await fetch(`${API_BASE}/contracts.php?action=upload_signed_contract`, {
                method: 'POST', credentials: 'include', body: formData,
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess('Signed contract uploaded!');
                const patch = { signed_contract_file: data.data.signed_contract_file as string, is_signed: 1 };
                // Update all relevant state
                setContracts(prev => prev.map(x => x.id === contractId ? { ...x, ...patch } : x));
                setViewContract(v => v && v.id === contractId ? { ...v, ...patch } : v);
            } else notifyError(data.message || 'Upload failed.');
        } catch { notifyError('Network error.'); }
        finally { setUploadingDoc(false); }
    };

    const openProjectModal = (c: Contract) => {
        setProjectContract(c);
        setProjectManagerId('');
        const d = new Date(); d.setDate(d.getDate() + 7); d.setHours(17, 0, 0, 0);
        setProjectEndDate(new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16));
        setShowProjectModal(true);
    };

    const handleCreateProject = async () => {
        if (!projectContract) return;
        const projMissing: Record<string, string> = {};
        if (!projectManagerId) projMissing.manager = 'Required.';
        if (!projectEndDate) projMissing.due_date = 'Required.';
        setProjectFormErrors(projMissing);
        if (Object.keys(projMissing).length > 0) return;
        setCreatingProject(true);
        try {
            const res = await fetch(`${API_BASE}/projects.php`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
                body: JSON.stringify({ client_id: projectContract.client_id, manager_id: Number(projectManagerId), end_date: projectEndDate }),
            });
            const data = await res.json();
            if (data.success) {
                notifySuccess('Project created!');
                setShowProjectModal(false);
                if (data.data?.project_id) router.push(`/projects/detail?id=${data.data.project_id}`);
            } else notifyError(data.message || 'Failed.');
        } catch { notifyError('Network error.'); }
        finally { setCreatingProject(false); }
    };

    const handleDownloadPDF = useCallback(async (c: Contract) => {
        const { jsPDF } = await import('jspdf');
        const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const margin = 18;
        const contentW = pageW - margin * 2;
        let y = margin;

        doc.setFontSize(16); doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
        doc.text('LLB Accountants', margin, y);
        doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(100, 116, 139);
        doc.text('Professional Accounting Services', margin, y + 5);
        const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        doc.text(`CONTRACT #${c.id}`, pageW - margin, y, { align: 'right' });
        doc.text(dateStr, pageW - margin, y + 5, { align: 'right' });
        doc.text(`Client: ${c.client_name}`, pageW - margin, y + 10, { align: 'right' });
        y += 16;
        doc.setDrawColor(15, 23, 42); doc.setLineWidth(0.5); doc.line(margin, y, pageW - margin, y); y += 7;

        const titleText = c.title.toUpperCase();
        doc.setFontSize(10); doc.setFont('helvetica', 'bold'); doc.setTextColor(255, 255, 255);
        const titleW = Math.min(doc.getTextWidth(titleText) + 14, contentW);
        doc.setFillColor(15, 23, 42);
        doc.roundedRect((pageW - titleW) / 2, y, titleW, 8, 2, 2, 'F');
        doc.text(titleText, pageW / 2, y + 5.5, { align: 'center' });
        y += 14;

        doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
        for (const line of c.body.split('\n')) {
            const t = line.trim();
            if (t === '') { y += 3; continue; }
            // skip signature block lines — drawn explicitly below
            if (/^_{5,}/.test(t) || /^(Client Signature|Authorized Representative|Date:\s*_{3,})/.test(t) || /^_{5,}.*_{5,}$/.test(t)) continue;
            if (/^\d+\.\s+[A-Z]/.test(t)) {
                doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.setTextColor(15, 23, 42);
                doc.text(t.toUpperCase(), margin, y); y += 2;
                doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.2); doc.line(margin, y, pageW - margin, y); y += 5;
            } else {
                const indent = /^[a-z]\)|^\d+\.\s/.test(t) ? margin + 5 : margin;
                doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(30, 41, 59);
                const wrapped = doc.splitTextToSize(t, contentW - (indent - margin));
                doc.text(wrapped, indent, y); y += wrapped.length * 4;
            }
            if (y > pageH - 44) { doc.addPage(); y = margin; }
        }

        // Ensure signature block fits — add new page if needed
        if (y + 28 > pageH - margin) { doc.addPage(); y = margin + 10; }
        y += 10;
        doc.setDrawColor(226, 232, 240); doc.setLineWidth(0.3); doc.line(margin, y, pageW - margin, y); y += 8;
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal'); doc.setTextColor(71, 85, 105);
        const colW = contentW / 2 - 5;
        doc.text('_________________________', margin, y);
        doc.text('_________________________', margin + colW + 10, y); y += 4;
        doc.text('Client Signature', margin, y);
        doc.text('Authorized Representative', margin + colW + 10, y); y += 4;
        doc.text('Date: ___________________', margin, y);
        doc.save(`Contract-${c.client_name.replace(/\s+/g, '_')}.pdf`);
    }, []);

    // Filtering
    const filtered = useMemo(() => {
        const term = searchTerm.trim().toLowerCase();
        return contracts.filter(c => {
            if (statusFilter !== 'all' && c.status !== statusFilter) return false;
            if (!term) return true;
            return [c.title, c.client_name, c.client_email, c.status].join(' ').toLowerCase().includes(term);
        });
    }, [contracts, searchTerm, statusFilter]);

    const paginated = filtered.slice((currentPage - 1) * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE);
    const paginatedArchived = archivedContracts.slice((archivePage - 1) * ITEMS_PER_PAGE, archivePage * ITEMS_PER_PAGE);

    useEffect(() => { setCurrentPage(1); }, [searchTerm, statusFilter]);

    const stats = useMemo(() => ({
        total: contracts.length,
        valid: contracts.filter(c => c.status === 'accepted').length,
        expired: contracts.filter(c => c.status === 'expired').length,
    }), [contracts]);

    if (loading) {
        return (
            <Layout role={user?.role} user={user} onLogout={() => {}}>
                <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>Loading…</div>
            </Layout>
        );
    }

    return (
        <Layout role={user?.role} user={user} onLogout={async () => {
            await fetch(`${API_BASE}/auth.php?action=logout`, { credentials: 'include' });
            router.push('/');
        }}>
            <Head><title>Contract Management</title></Head>

            {pageNotice && (
                <div style={{ marginBottom: 12 }}>
                    <FormAlert tone={pageNotice.tone} message={pageNotice.message} onDismiss={() => setPageNotice(null)} />
                </div>
            )}

            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 240, flex: '1 1 300px' }}>
                    <div style={{ width: 42, height: 42, background: 'linear-gradient(135deg,#0f172a,#1e3a8a)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                            <line x1="16" y1="13" x2="8" y2="13" />
                            <line x1="16" y1="17" x2="8" y2="17" />
                            <polyline points="10 9 9 9 8 9" />
                        </svg>
                    </div>
                    <div>
                        <h1 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: 0 }}>Contract Management</h1>
                        <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>View, edit, sign, and archive client service contracts</p>
                    </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end', flex: '1 1 360px', minWidth: 0 }}>
                    <div style={{ width: 200, minWidth: 160, flex: '1 1 180px' }}>
                        <SearchBar
                            storageKey="contracts:list"
                            placeholder="Search contracts…"
                            ariaLabel="Search contracts"
                            value={searchTerm}
                            onChange={setSearchTerm}
                            suggestions={collectSearchTerms(contracts, [
                                (c: any) => c.title,
                                (c: any) => c.client_name,
                                (c: any) => c.client_email,
                                (c: any) => c.status,
                            ])}
                            inputStyle={{ padding: '9px 30px 9px 32px', borderRadius: 10, fontSize: 13 }}
                        />
                    </div>
                    <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
                        style={{ height: 42, padding: '0 14px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13, minWidth: 130, flex: '0 1 160px' }}>
                        <option value="all">All Statuses</option>
                        <option value="accepted">Accepted</option>
                        <option value="rejected">Rejected</option>
                        <option value="expired">Expired</option>
                    </select>
                    {canManageContracts && (
                        <>
                            {/* Archive Storage btn */}
                            <button
                                onClick={async () => { setShowArchivePage(true); await fetchArchivedContracts(); }}
                                style={{ minHeight: 38, padding: '8px 14px', background: '#fff', color: '#475569', border: '1.5px solid #e2e8f0', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap', flex: '0 0 auto' }}
                            >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                                Archive Storage
                            </button>
                            {/* Upload Contract btn — card blue */}
                            <button
                                aria-label="Upload Contract"
                                title="Upload Contract"
                                onClick={openUploadModal}
                                style={{ minHeight: 38, padding: '8px 16px', background: '#2563eb', color: '#ffffff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7, boxShadow: '0 4px 14px rgba(37,99,235,0.35)', whiteSpace: 'nowrap', flex: '0 0 auto', letterSpacing: '0.01em' }}
                            >
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                Upload Contract
                            </button>
                        </>
                    )}
                </div>
            </div>

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
                {[
                    { label: 'Total Contracts', value: stats.total,   color: '#475569', bg: '#f8fafc' },
                    { label: 'Valid',            value: stats.valid,   color: '#065f46', bg: '#ecfdf5' },
                    { label: 'Expired',          value: stats.expired, color: '#92400e', bg: '#fef3c7' },
                ].map(s => (
                    <div key={s.label} style={{ background: s.bg, border: '1px solid rgba(148,163,184,0.18)', borderRadius: 14, padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 4px 12px rgba(15,23,42,0.08)' }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: s.color, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{s.label}</span>
                        <span style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</span>
                    </div>
                ))}
            </div>

            {/* Table */}
            <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.06)', overflow: 'hidden' }}>
                <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                        <tr style={{ background: '#f8fafc' }}>
                            <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Client Name</th>
                            <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Status</th>
                            <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Expiry</th>
                            <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Document</th>
                            <th style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {paginated.length === 0 ? (
                            <tr><td colSpan={5} style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                                <ZeroResults
                                    query={searchTerm}
                                    itemLabel="contracts"
                                    alternatives={getAlternativeSuggestions(searchTerm, collectSearchTerms(contracts, [
                                        (c: any) => c.title,
                                        (c: any) => c.client_name,
                                        (c: any) => c.client_email,
                                    ]))}
                                    onPickAlternative={(term) => setSearchTerm(term)}
                                    onClear={() => setSearchTerm('')}
                                />
                            </td></tr>
                        ) : paginated.map(c => {
                            const sc = getStatusConfig(c.status, c);
                            const hasDoc = !!c.signed_contract_file;
                            return (
                                <tr
                                    key={c.id}
                                    onClick={() => openView(c)}
                                    style={{ borderTop: '1px solid #f1f5f9', cursor: 'pointer', transition: 'background 0.12s' }}
                                    onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                                    onMouseLeave={e => (e.currentTarget.style.background = '')}
                                >
                                    {/* Client Name */}
                                    <td style={{ padding: '14px 16px' }}>
                                        <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{c.client_name}</div>
                                        <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.client_email}</div>
                                        <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>{c.title} &nbsp;<span style={{ color: '#cbd5e1' }}>#{c.id}</span></div>
                                    </td>
                                    {/* Status: Valid / Expired / Pending / Rejected */}
                                    <td style={{ padding: '14px 16px' }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: sc.bg, color: sc.color, padding: '4px 11px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                                            {sc.icon} {sc.label}
                                        </span>
                                    </td>
                                    {/* Deadline — project end_date */}
                                    <td style={{ padding: '14px 16px' }}>
                                        {c.project_deadline ? (
                                            (() => {
                                                const d = new Date(c.project_deadline);
                                                const isPast = d < new Date();
                                                return (
                                                    <span style={{ fontSize: 12, fontWeight: 600, color: isPast ? '#dc2626' : '#0f172a' }}>
                                                        {d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                                                        {isPast && <span style={{ marginLeft: 5, fontSize: 10, color: '#dc2626', fontWeight: 700 }}>EXPIRED</span>}
                                                    </span>
                                                );
                                            })()
                                        ) : (
                                            <span style={{ fontSize: 12, color: '#94a3b8' }}>—</span>
                                        )}
                                    </td>
                                    {/* Document — clickable, opens float viewer */}
                                    <td style={{ padding: '14px 16px' }} onClick={e => e.stopPropagation()}>
                                        <button
                                            onClick={e => openDocViewer(c, e)}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '6px 12px', background: hasDoc ? '#eff6ff' : '#f8fafc', color: hasDoc ? '#1e40af' : '#94a3b8', border: `1px solid ${hasDoc ? '#bfdbfe' : '#e2e8f0'}`, borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700, whiteSpace: 'nowrap' }}>
                                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                            {hasDoc ? 'View Doc' : 'No Document'}
                                        </button>
                                    </td>
                                    {/* Action: Archive only */}
                                    <td style={{ padding: '14px 16px' }} onClick={e => e.stopPropagation()} className="llb-actions">
                                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                            {canManageContracts && canCreateProjectFromContract(c) && (
                                                <button onClick={() => openProjectModal(c)}
                                                    style={{ padding: '5px 10px', background: 'linear-gradient(135deg,#15803d,#16a34a)', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 700, color: '#fff' }}>
                                                    Create Project
                                                </button>
                                            )}
                                            {canManageContracts && (
                                                <button
                                                    onClick={() => handleToggleArchive(c)}
                                                    title="Archive contract"
                                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '6px 12px', background: '#fff5f5', color: '#dc2626', border: '1px solid #fecaca', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/></svg>
                                                    Archive
                                                </button>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {filtered.length > ITEMS_PER_PAGE && (
                <div style={{ marginTop: 16 }}>
                    <Pagination currentPage={currentPage} totalItems={filtered.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setCurrentPage} />
                </div>
            )}

            {/* ═══ ARCHIVE PAGE (page-flip view) ═══ */}
            {showArchivePage && canManageContracts && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9000, background: '#f0f4ff', overflowY: 'auto' }}>
                    <div style={{ maxWidth: 960, margin: '0 auto', padding: '32px 24px 60px' }}>

                        {/* Archive page header */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                                <button
                                    onClick={() => setShowArchivePage(false)}
                                    style={{ width: 36, height: 36, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 9, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                                >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                                </button>
                                <div>
                                    <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: 0 }}>Archive Storage</h2>
                                    <p style={{ fontSize: 12, color: '#64748b', margin: 0 }}>Archived contracts — restore individually or all at once</p>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                                {archivedContracts.length > 0 && (
                                    <button onClick={handleRestoreAll} disabled={restoringAll}
                                        style={{ padding: '8px 16px', background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', borderRadius: 8, cursor: restoringAll ? 'default' : 'pointer', fontSize: 13, fontWeight: 700, opacity: restoringAll ? 0.65 : 1 }}>
                                        {restoringAll ? 'Restoring…' : '↺ Restore All'}
                                    </button>
                                )}
                                <button onClick={fetchArchivedContracts} disabled={loadingArchive}
                                    style={{ padding: '8px 14px', background: '#fff', color: '#475569', border: '1.5px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>
                                    ↻ Refresh
                                </button>
                            </div>
                        </div>

                        {/* Count badge */}
                        <div style={{ marginBottom: 16 }}>
                            <span style={{ fontSize: 12, color: '#64748b', fontWeight: 600 }}>
                                {archivedContracts.length} archived contract{archivedContracts.length !== 1 ? 's' : ''}
                            </span>
                        </div>

                        {/* Archive table */}
                        <div style={{ background: '#fff', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.07)', overflow: 'hidden' }}>
                            {loadingArchive ? (
                                <div style={{ padding: 48, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Loading…</div>
                            ) : archivedContracts.length === 0 ? (
                                <div style={{ padding: 48, textAlign: 'center' }}>
                                    <div style={{ fontSize: 40, marginBottom: 12 }}>🗄️</div>
                                    <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>No archived contracts yet.</p>
                                </div>
                            ) : (
                                <>
                                    <table className="llb-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
                                        <thead>
                                            <tr style={{ background: '#f8fafc' }}>
                                                {['Contract', 'Client', 'Status', 'Created', 'Actions'].map(h => (
                                                    <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{h}</th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {paginatedArchived.map(c => {
                                                const sc = getStatusConfig(c.status);
                                                return (
                                                    <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                                                        <td style={{ padding: '14px 16px' }}>
                                                            <div style={{ fontWeight: 700, fontSize: 13, color: '#0f172a' }}>{c.title}</div>
                                                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 2 }}>
                                                                <span style={{ fontSize: 11, color: '#94a3b8' }}>#{c.id}</span>
                                                            </div>
                                                        </td>
                                                        <td style={{ padding: '14px 16px' }}>
                                                            <div style={{ fontWeight: 600, fontSize: 13, color: '#1e293b' }}>{c.client_name}</div>
                                                            <div style={{ fontSize: 11, color: '#94a3b8' }}>{c.client_email}</div>
                                                        </td>
                                                        <td style={{ padding: '14px 16px' }}>
                                                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: sc.bg, color: sc.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>
                                                                {sc.icon} {sc.label}
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '14px 16px', fontSize: 12, color: '#64748b' }}>{formatDate(c.created_at)}</td>
                                                        <td style={{ padding: '14px 16px' }} className="llb-actions">
                                                            <button onClick={() => handleToggleArchive(c, true)}
                                                                style={{ padding: '6px 14px', background: '#ecfdf5', color: '#065f46', border: '1px solid #a7f3d0', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                                                ↩ Restore
                                                            </button>
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                    {archivedContracts.length > ITEMS_PER_PAGE && (
                                        <div style={{ padding: '12px 16px' }}>
                                            <Pagination currentPage={archivePage} totalItems={archivedContracts.length} itemsPerPage={ITEMS_PER_PAGE} onPageChange={setArchivePage} />
                                        </div>
                                    )}
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

                        {/* ═══ UPLOAD SIGNED CONTRACT MODAL ═══ */}
            {showUploadModal && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.55)', padding: 16 }}>
                    <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.22)', width: '100%', maxWidth: 520 }}>
                        {/* Header */}
                        <div style={{ background: 'linear-gradient(135deg,#1d4ed8,#2563eb)', borderRadius: '20px 20px 0 0', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                <span style={{ fontSize: 15, fontWeight: 800, color: '#fff' }}>Upload Signed Contract</span>
                            </div>
                            <button onClick={() => setShowUploadModal(false)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: 22, cursor: 'pointer', lineHeight: 1 }}>×</button>
                        </div>

                        {/* Body */}
                        <div style={{ padding: '20px 24px' }}>
                            <FormAlert tone="error" message={uploadFormError} onDismiss={() => setUploadFormError('')} style={{ marginBottom: 14 }} />
                            <div style={{ marginBottom: 16 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#1e3a8a', marginBottom: 6 }}>1. Choose client *</label>
                                <select value={uploadClientId} onChange={e => { setUploadClientId(e.target.value); if (e.target.value) setUploadClientError(''); }}
                                    required aria-required="true" aria-invalid={uploadClientError ? true : undefined}
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: uploadClientError ? '2px solid #dc2626' : (uploadClientId ? '1px solid #e2e8f0' : '2px solid #2563eb'), fontSize: 13, color: '#0f172a', background: '#fff' }}>
                                    <option value="">Select a client…</option>
                                    {clients.map(c => (
                                        <option key={c.client_id} value={c.client_id}>{c.client_name}{c.email || c.company_email ? ` (${c.email || c.company_email})` : ''}</option>
                                    ))}
                                </select>
                                <FieldMessage message={uploadClientError} />
                            </div>
                            <div style={{ marginBottom: 8 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 800, color: '#1e3a8a', marginBottom: 6 }}>2. Attach signed PDF *</label>
                                <input
                                    ref={uploadFileRef}
                                    type="file"
                                    accept=".pdf,application/pdf"
                                    required
                                    aria-required="true"
                                    aria-label="Signed contract PDF (required)"
                                    style={{ display: 'none' }}
                                    onChange={e => {
                                        const f = e.target.files?.[0] || null;
                                        if (f && !/\.pdf$/i.test(f.name)) { setUploadFileError('Only PDF files are allowed.'); e.target.value = ''; return; }
                                        setUploadFile(f);
                                        if (f) setUploadFileError('');
                                        e.target.value = '';
                                    }}
                                />
                                <button type="button" onClick={() => { setUploadFileError(''); uploadFileRef.current?.click(); }}
                                    style={{ width: '100%', padding: '16px', borderRadius: 10, border: uploadFileError ? '1.5px dashed #dc2626' : `1.5px dashed ${uploadFile ? '#16a34a' : '#93c5fd'}`, background: uploadFileError ? '#fef2f2' : (uploadFile ? '#f0fdf4' : '#eff6ff'), cursor: 'pointer', fontSize: 13, fontWeight: 700, color: uploadFileError ? '#b91c1c' : (uploadFile ? '#15803d' : '#1d4ed8') }}>
                                    {uploadFile ? `📄 ${uploadFile.name} (${(uploadFile.size / 1024).toFixed(0)} KB) — click to replace` : '📎 Click to choose the signed contract PDF'}
                                </button>
                                <FieldMessage message={uploadFileError} />
                            </div>
                            <p style={{ fontSize: 12, color: '#64748b', margin: '10px 0 0', lineHeight: 1.5 }}>
                                Saving creates the contract as <strong>Accepted + Signed</strong> for the chosen client. You can then create a project from inside the contract.
                            </p>
                        </div>

                        {/* Footer */}
                        <div style={{ padding: '14px 24px 20px', display: 'flex', gap: 10, justifyContent: 'flex-end', borderTop: '1px solid #f1f5f9' }}>
                            <button
                                disabled={uploading}
                                onClick={handleUploadNewSignedContract}
                                title="Save"
                                style={{ padding: '9px 22px', background: uploading ? '#94a3b8' : '#2563eb', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: uploading ? 'not-allowed' : 'pointer', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                            >
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                                {uploading ? 'Saving…' : 'Save'}
                            </button>
                            <button onClick={() => setShowUploadModal(false)}
                                style={{ padding: '9px 18px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

{/* ═══ CREATE CONTRACT MODAL ═══ */}
            {showCreateModal && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.55)', padding: 16 }}>
                    <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', width: '100%', maxWidth: 600, maxHeight: '90vh', overflow: 'auto' }}>
                        <div style={{ padding: '28px 32px 0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
                                <h2 style={{ fontSize: 20, fontWeight: 800, color: '#0f172a', margin: 0 }}>Send New Contract</h2>
                                <button onClick={() => setShowCreateModal(false)} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8' }}>×</button>
                            </div>
                        </div>
                        <form onSubmit={handleCreate} style={{ padding: '0 32px 32px' }}>
                            <div style={{ marginBottom: 18 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Client *</label>
                                <select value={formClientId} onChange={e => { if (e.target.value) fillContractTemplate(e.target.value); else resetForm(); }} required
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }}>
                                    <option value="">Select a client…</option>
                                    {clients.filter(c => c.email || c.company_email).map(c => (
                                        <option key={c.client_id} value={c.client_id}>{c.client_name} ({c.email || c.company_email})</option>
                                    ))}
                                </select>
                                {formClientDuplicateContractId && (
                                    <div style={{ marginTop: 8, padding: '9px 11px', borderRadius: 8, background: '#fffbeb', border: '1px solid #fde68a', color: '#92400e', fontSize: 12, lineHeight: 1.5 }}>
                                        This client already has a sent contract. Sending will resend the existing contract.
                                    </div>
                                )}
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                                    <label style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Contract Title *</label>
                                    <button type="button" onClick={() => setFormEditingTemplate(true)} disabled={!formClientId || formEditingTemplate}
                                        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #cbd5e1', background: formEditingTemplate ? '#f1f5f9' : '#fff', color: formEditingTemplate ? '#94a3b8' : '#1e3a8a', fontSize: 11, fontWeight: 700, cursor: !formClientId || formEditingTemplate ? 'default' : 'pointer' }}>
                                        ✏ Edit
                                    </button>
                                </div>
                                <input value={formTitle} onChange={e => setFormTitle(e.target.value)} readOnly={!formEditingTemplate} required
                                    placeholder="e.g. Annual Bookkeeping Service Agreement"
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13, background: formEditingTemplate ? '#fff' : '#f8fafc', color: '#0f172a' }} />
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Contract Body / Terms *</label>
                                <textarea value={formBody} onChange={e => setFormBody(e.target.value)} readOnly={!formEditingTemplate} required rows={10}
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.7, background: formEditingTemplate ? '#fff' : '#f8fafc', color: '#0f172a' }} />
                            </div>
                            <div style={{ marginBottom: 24 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Expires In (days)</label>
                                <input type="number" min="1" max="90" value={formExpiresDays} onChange={e => setFormExpiresDays(e.target.value)}
                                    style={{ width: 100, padding: '11px 14px', borderRadius: 10, border: '1px solid #e2e8f0', fontSize: 13 }} />
                            </div>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button type="submit" disabled={creating}
                                    style={{ padding: '9px 20px', background: 'linear-gradient(135deg,#1e3a8a,#1d4ed8)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                                    {creating ? 'Sending…' : 'Send Contract'}
                                </button>
                                <button type="button" onClick={() => setShowCreateModal(false)}
                                    style={{ padding: '9px 18px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                                    Cancel
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}

            {/* ═══ VIEW CONTRACT — MAXIMIZED ROW DETAIL PAGE ═══ */}
            {viewContract && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#f0f4ff', overflowY: 'auto' }}>
                    <div style={{ maxWidth: 900, margin: '0 auto', padding: '28px 20px 60px' }}>

                        {/* Toolbar */}
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, gap: 12, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                                <button onClick={() => { setViewContract(null); setViewEditMode(false); }}
                                    style={{ width: 36, height: 36, background: '#fff', border: '1.5px solid #e2e8f0', borderRadius: 9, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#475569" strokeWidth="2.5" strokeLinecap="round"><polyline points="15 18 9 12 15 6"/></svg>
                                </button>
                                <div>
                                    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94a3b8' }}>Contract #{viewContract.id}</div>
                                    <div style={{ fontSize: 17, fontWeight: 800, color: '#0f172a' }}>{viewContract.client_name}</div>
                                </div>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                {!viewEditMode && canManageContracts && (
                                    <button onClick={() => setViewEditMode(true)}
                                        style={{ padding: '7px 14px', background: '#fff', color: '#1e3a8a', border: '1.5px solid #bfdbfe', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                        ✏ Edit
                                    </button>
                                )}
                                <button
                                    onClick={() => {
                                        const win = window.open('', '_blank', 'width=820,height=1000');
                                        if (!win) return;
                                        win.document.write(buildContractPrintHtml(viewContract.title, viewContract.body, viewContract.client_name, viewContract.id));
                                        win.document.close(); win.focus(); win.print();
                                    }}
                                    style={{ padding: '7px 14px', background: '#fff', color: '#475569', border: '1.5px solid #e2e8f0', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                    🖨 Print
                                </button>
                                <button onClick={() => handleDownloadPDF(viewContract)}
                                    style={{ padding: '7px 14px', background: '#fff', color: '#065f46', border: '1.5px solid #a7f3d0', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                    ⬇ Download PDF
                                </button>
                            </div>
                        </div>

                        {/* Meta strip */}
                        <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', padding: '14px 20px', marginBottom: 16, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                            {(() => { const sc = getStatusConfig(viewContract.status); return (
                                <span style={{ background: sc.bg, color: sc.color, padding: '4px 12px', borderRadius: 20, fontSize: 12, fontWeight: 700 }}>{sc.icon} {sc.label}</span>
                            ); })()}
                            <span style={{ fontSize: 12, color: '#64748b' }}>Sent: <strong>{formatDate(viewContract.sent_at)}</strong></span>
                            <span style={{ fontSize: 12, color: '#64748b' }}>Responded: <strong>{formatDate(viewContract.responded_at)}</strong></span>
                            {canManageContracts && canCreateProjectFromContract(viewContract) && (
                                <button onClick={() => { setViewContract(null); openProjectModal(viewContract); }}
                                    style={{ padding: '5px 13px', background: 'linear-gradient(135deg,#15803d,#16a34a)', color: '#fff', border: 'none', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                                    Create Project
                                </button>
                            )}
                        </div>

                        {/* Two-column layout: contract body + signed document */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr)', gap: 16, alignItems: 'start' }}>

                            {/* Contract body card */}
                            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                                <div style={{ background: 'linear-gradient(135deg,#0f172a,#1e3a8a)', padding: '14px 20px' }}>
                                    <div style={{ fontSize: 13, fontWeight: 800, color: '#fff', letterSpacing: '0.02em' }}>{viewContract.title}</div>
                                </div>
                                <div style={{ padding: '24px 24px' }}>
                                    {viewEditMode ? (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                                            <div>
                                                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Contract Title</label>
                                                <input value={viewDraftTitle} onChange={e => setViewDraftTitle(e.target.value)}
                                                    required aria-required="true" aria-label="Contract title (required)"
                                                    style={{ width: '100%', padding: '10px 13px', borderRadius: 9, border: '1px solid #d1d5db', fontSize: 13, color: '#111827' }} />
                                            </div>
                                            <div>
                                                <label style={{ display: 'block', fontSize: 11, fontWeight: 700, color: '#374151', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 }}>Contract Body</label>
                                                <textarea value={viewDraftBody} onChange={e => setViewDraftBody(e.target.value)} rows={20}
                                                    required aria-required="true" aria-label="Contract body (required)"
                                                    style={{ width: '100%', padding: '10px 13px', borderRadius: 9, border: '1px solid #d1d5db', fontSize: 12, fontFamily: 'monospace', lineHeight: 1.75, color: '#111827', resize: 'vertical' }} />
                                            </div>
                                            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                                                <button onClick={() => setViewEditMode(false)}
                                                    style={{ padding: '8px 16px', background: '#f1f5f9', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, color: '#374151', fontWeight: 600 }}>Cancel</button>
                                                <button onClick={handleSaveEdit} disabled={savingView}
                                                    style={{ padding: '8px 20px', background: '#1e3a8a', color: '#fff', border: 'none', borderRadius: 8, cursor: savingView ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, opacity: savingView ? 0.7 : 1 }}>
                                                    {savingView ? 'Saving…' : 'Save Changes'}
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div>
                                            {/* Letterhead */}
                                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20, paddingBottom: 14, borderBottom: '2px solid #0f172a' }}>
                                                <div>
                                                    <div style={{ fontSize: 18, fontWeight: 900, color: '#0f172a', letterSpacing: '-0.02em' }}>LLB Accountants</div>
                                                    <div style={{ fontSize: 11, color: '#475569', marginTop: 3 }}>Professional Accounting Services</div>
                                                </div>
                                                <div style={{ textAlign: 'right', fontSize: 11, color: '#64748b', lineHeight: 1.7 }}>
                                                    <div style={{ fontWeight: 700, color: '#0f172a', fontSize: 12 }}>CONTRACT #{viewContract.id}</div>
                                                    <div>{new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}</div>
                                                </div>
                                            </div>
                                            <div style={{ fontSize: 13, lineHeight: 1.9, color: '#1e293b' }}>
                                                {viewContract.body.split('\n').map((line, i) => {
                                                    const trimmed = line.trim();
                                                    if (trimmed === '') return <div key={i} style={{ height: 8 }} />;
                                                    if (/^\d+\.\s+[A-Z]/.test(trimmed)) return <div key={i} style={{ fontWeight: 800, color: '#0f172a', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 16, marginBottom: 5, borderBottom: '1px solid #e2e8f0', paddingBottom: 3 }}>{trimmed}</div>;
                                                    if (/^[a-z]\)/.test(trimmed)) return <div key={i} style={{ paddingLeft: 18, color: '#334155' }}>{trimmed}</div>;
                                                    if (/^\d+\.\s/.test(trimmed) && !/[A-Z]{3,}/.test(trimmed)) return <div key={i} style={{ paddingLeft: 18, color: '#334155' }}>{trimmed}</div>;
                                                    if (/^_{5,}/.test(trimmed)) return <div key={i} style={{ marginTop: 6, fontFamily: 'monospace', color: '#475569', fontSize: 12 }}>{trimmed}</div>;
                                                    return <div key={i} style={{ marginBottom: 1 }}>{trimmed}</div>;
                                                })}
                                            </div>
                                            <div style={{ marginTop: 28, paddingTop: 14, borderTop: '1px solid #e2e8f0', display: 'flex', gap: 48 }}>
                                                <div>
                                                    <div style={{ fontFamily: 'monospace', color: '#475569', fontSize: 12 }}>___________________________</div>
                                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>Client Signature</div>
                                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>Date: ___________________</div>
                                                </div>
                                                <div>
                                                    <div style={{ fontFamily: 'monospace', color: '#475569', fontSize: 12 }}>___________________________</div>
                                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>Authorized Representative</div>
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Signed document panel */}
                            <div style={{ background: '#fff', borderRadius: 14, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
                                <div style={{ padding: '14px 20px', borderBottom: '1px solid #f1f5f9' }}>
                                    <div style={{ fontSize: 13, fontWeight: 800, color: '#0f172a' }}>Signed Contract Document</div>
                                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Upload the physical signed copy returned by the client</div>
                                </div>
                                <div style={{ padding: 20 }}>
                                    {viewContract.signed_contract_file ? (
                                        <div>
                                            <div style={{ display: 'flex', gap: 8 }}>
                                                <button
                                                    onClick={() => setPreviewDoc({ name: `Signed Contract — ${viewContract.client_name}`, url: resolveBackendAssetUrl(viewContract.signed_contract_file!), mime: 'application/pdf' })}
                                                    style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 14px', background: '#eff6ff', color: '#1e40af', border: '1px solid #bfdbfe', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                                                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                                                    View Document
                                                </button>
                                                {canManageContracts && (
                                                    <button onClick={() => docUploadRef.current?.click()} disabled={uploadingDoc}
                                                        style={{ flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '8px 14px', background: '#f8fafc', color: '#475569', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                                                        ↑ Replace
                                                    </button>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div style={{ textAlign: 'center', padding: '40px 20px' }}>
                                            <div style={{ width: 56, height: 56, background: '#f1f5f9', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 14px' }}>
                                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                            </div>
                                            <p style={{ fontSize: 13, color: '#64748b', margin: '0 0 16px' }}>No signed contract uploaded yet.</p>
                                            {canManageContracts && (
                                                <button onClick={() => docUploadRef.current?.click()} disabled={uploadingDoc}
                                                    style={{ padding: '9px 22px', background: 'linear-gradient(135deg,#1e3a8a,#1d4ed8)', color: '#fff', border: 'none', borderRadius: 9, cursor: 'pointer', fontSize: 13, fontWeight: 700, opacity: uploadingDoc ? 0.7 : 1 }}>
                                                    {uploadingDoc ? 'Uploading…' : '↑ Upload Signed Contract'}
                                                </button>
                                            )}
                                        </div>
                                    )}
                                    <input
                                        ref={docUploadRef}
                                        type="file"
                                        accept=".pdf"
                                        style={{ display: 'none' }}
                                        onChange={e => {
                                            const file = e.target.files?.[0];
                                            if (file) handleUploadSignedContract(viewContract.id, file);
                                            e.target.value = '';
                                        }}
                                    />
                                </div>
                            </div>

                        </div>
                    </div>
                </div>
            )}

            <DocumentPreviewModal document={previewDoc} onClose={() => setPreviewDoc(null)} />

            {/* ═══ CREATE PROJECT MODAL ═══ */}
            {showProjectModal && projectContract && (
                <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(15,23,42,0.5)', padding: 16 }}>
                    <div style={{ background: '#fff', borderRadius: 20, boxShadow: '0 20px 60px rgba(0,0,0,0.2)', width: '100%', maxWidth: 480 }}>
                        <div style={{ padding: '28px 32px' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
                                <h2 style={{ fontSize: 18, fontWeight: 800, color: '#0f172a', margin: 0 }}>Ready to Create Project</h2>
                                <button onClick={() => { setShowProjectModal(false); setProjectContract(null); setProjectFormErrors({}); }} style={{ background: 'none', border: 'none', fontSize: 22, cursor: 'pointer', color: '#94a3b8' }}>×</button>
                            </div>
                            <div style={{ background: '#ecfdf5', borderRadius: 12, padding: '14px 18px', marginBottom: 20 }}>
                                <p style={{ margin: '0 0 4px', fontSize: 13, color: '#065f46', fontWeight: 700 }}>Contract Accepted</p>
                                <p style={{ margin: 0, fontSize: 12, color: '#047857' }}>
                                    Client <strong>{projectContract.client_name}</strong> accepted &quot;<em>{projectContract.title}</em>&quot;. Create a project now.
                                </p>
                            </div>
                            <div style={{ marginBottom: 18 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Assign Manager *</label>
                                <select value={projectManagerId} onChange={e => { setProjectManagerId(e.target.value); if (projectFormErrors.manager) setProjectFormErrors(prev => { const next = { ...prev }; delete next.manager; return next; }); }}
                                    required aria-required="true" aria-invalid={projectFormErrors.manager ? true : undefined}
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: projectFormErrors.manager ? '2px solid #ef4444' : '1px solid #e2e8f0', fontSize: 13 }}>
                                    <option value="">Select manager…</option>
                                    {managers.map(m => <option key={m.id} value={m.id}>{m.first_name} {m.last_name}</option>)}
                                </select>
                                {projectFormErrors.manager && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{projectFormErrors.manager}</div>}
                            </div>
                            <div style={{ marginBottom: 24 }}>
                                <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: '#374151', marginBottom: 6 }}>Due Date *</label>
                                <input type="datetime-local" value={projectEndDate} onChange={e => { setProjectEndDate(e.target.value); if (projectFormErrors.due_date) setProjectFormErrors(prev => { const next = { ...prev }; delete next.due_date; return next; }); }}
                                    required aria-required="true" aria-invalid={projectFormErrors.due_date ? true : undefined}
                                    style={{ width: '100%', padding: '11px 14px', borderRadius: 10, border: projectFormErrors.due_date ? '2px solid #ef4444' : '1px solid #e2e8f0', fontSize: 13 }} />
                                {projectFormErrors.due_date && <div style={{ marginTop: 4, fontSize: 12, color: '#b91c1c' }}>{projectFormErrors.due_date}</div>}
                            </div>
                            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                                <button onClick={handleCreateProject} disabled={creatingProject}
                                    style={{ padding: '9px 20px', background: 'linear-gradient(135deg,#15803d,#16a34a)', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 13, cursor: 'pointer' }}>
                                    {creatingProject ? 'Creating…' : 'Create Project'}
                                </button>
                                <button onClick={() => { setShowProjectModal(false); setProjectContract(null); setProjectFormErrors({}); }}
                                    style={{ padding: '9px 18px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </Layout>
    );
}
