import { useState, useEffect, useRef } from 'react';
import Head from 'next/head';
import { useRouter } from 'next/router';
import { getApiBaseUrl } from '@/utils/network';

type ContractData = {
    id: number;
    title: string;
    body: string;
    status: 'pending' | 'accepted' | 'rejected' | 'expired';
    token_expires_at: string;
    client_name: string;
    contact_person: string;
};

function formatExpiry(value: string) {
    if (!value) return '';
    const d = new Date(value);
    if (isNaN(d.getTime())) return value;
    return d.toLocaleString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit',
    });
}

export default function ContractReview() {
    const router = useRouter();
    const API_BASE = getApiBaseUrl();
    const [contract, setContract] = useState<ContractData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const [decision, setDecision] = useState<'accepted' | 'rejected' | null>(null);
    const [deciding, setDeciding] = useState(false);
    const [decisionDone, setDecisionDone] = useState(false);
    const [decisionMessage, setDecisionMessage] = useState('');
    const [scrolledToBottom, setScrolledToBottom] = useState(false);
    const [confirmingReject, setConfirmingReject] = useState(false);
    const bodyRef = useRef<HTMLDivElement>(null);
    const token = router.isReady ? String(router.query.token ?? '') : '';

    useEffect(() => {
        if (!token) return;
        setLoading(true);
        fetch(`${API_BASE}/contracts.php?action=review&token=${encodeURIComponent(token)}`)
            .then(r => r.json())
            .then(data => {
                if (data.success) setContract(data.data);
                else setError(data.message || 'Contract not found or link is invalid.');
            })
            .catch(() => setError('Unable to load contract. Please try again.'))
            .finally(() => setLoading(false));
    }, [token, API_BASE]);

    // Track scroll to bottom so Accept btn becomes available
    useEffect(() => {
        const el = bodyRef.current;
        if (!el) return;

        const handleScroll = () => {
            const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
            if (atBottom) setScrolledToBottom(true);
        };
        el.addEventListener('scroll', handleScroll);
        handleScroll(); // fire once for short contracts
        return () => el.removeEventListener('scroll', handleScroll);
    }, [contract]);

    const handleDecide = async (d: 'accepted' | 'rejected') => {
        if (!token || deciding) return;
        setDeciding(true);
        try {
            const res = await fetch(
                `${API_BASE}/contracts.php?action=decide&token=${encodeURIComponent(token)}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ decision: d }),
                }
            );
            const data = await res.json();
            if (data.success) {
                setDecision(d);
                setDecisionMessage(data.message || '');
                setDecisionDone(true);
                if (contract) setContract({ ...contract, status: d });
            } else {
                setError(data.message || 'Failed to submit your response.');
            }
        } catch {
            setError('A network error occurred. Please try again.');
        } finally {
            setDeciding(false);
            setConfirmingReject(false);
        }
    };

    // ─── Styled constants ───────────────────────────────────────
    const pageBg = '#f0f4ff';
    const cardShadow = '0 8px 40px rgba(30,58,138,0.10), 0 2px 8px rgba(30,58,138,0.06)';
    const headerGradient = 'linear-gradient(135deg, #0f172a 0%, #1e3a8a 60%, #1d4ed8 100%)';

    // ─── Status badge map ────────────────────────────────────────
    const statusBadge: Record<string, { bg: string; color: string; label: string; icon: string }> = {
        pending:  { bg: '#eff6ff', color: '#1e40af', label: 'Awaiting Your Response', icon: '📋' },
        accepted: { bg: '#d1fae5', color: '#065f46', label: 'Accepted',  icon: '✅' },
        rejected: { bg: '#fee2e2', color: '#991b1b', label: 'Cancelled', icon: '❌' },
        expired:  { bg: '#fef3c7', color: '#92400e', label: 'Expired',   icon: '⏰' },
    };

    if (!router.isReady || (!token && !loading)) {
        return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: pageBg }}>
                <div style={{ fontSize: 14, color: '#64748b' }}>Loading contract…</div>
            </div>
        );
    }

    if (loading) {
        return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: pageBg }}>
                <div style={{ textAlign: 'center' }}>
                    <div style={{ width: 48, height: 48, border: '4px solid #e2e8f0', borderTopColor: '#1e3a8a', borderRadius: '50%', animation: 'spin 0.8s linear infinite', margin: '0 auto 16px' }} />
                    <p style={{ color: '#64748b', fontSize: 14 }}>Loading your contract…</p>
                </div>
                <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
            </div>
        );
    }

    if (error && !contract) {
        return (
            <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: pageBg, padding: 24 }}>
                <div style={{ maxWidth: 480, width: '100%', background: '#fff', borderRadius: 20, boxShadow: cardShadow, padding: '48px 32px', textAlign: 'center' }}>
                    <div style={{ fontSize: 56, marginBottom: 20 }}>🔗</div>
                    <h2 style={{ fontWeight: 800, color: '#0f172a', marginBottom: 12, fontSize: 22 }}>Link Not Found</h2>
                    <p style={{ color: '#64748b', fontSize: 14, lineHeight: 1.7 }}>{error}</p>
                </div>
            </div>
        );
    }

    if (!contract) return null;

    const badge = statusBadge[contract.status] ?? statusBadge.pending;
    const isPending = contract.status === 'pending' && !decisionDone;

    return (
        <>
            <Head>
                <title>Contract Review – {contract.title}</title>
                <meta name="robots" content="noindex,nofollow" />
            </Head>

            <div style={{ minHeight: '100vh', background: pageBg, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 16px 80px' }}>
                {/* Card */}
                <div style={{ maxWidth: 760, width: '100%', background: '#fff', borderRadius: 24, boxShadow: cardShadow, overflow: 'hidden' }}>

                    {/* Header gradient */}
                    <div style={{ background: headerGradient, padding: '36px 40px 28px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
                            <div style={{ width: 44, height: 44, background: 'rgba(255,255,255,0.15)', borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>📄</div>
                            <div>
                                <div style={{ fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>LLB Accountants</div>
                                <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.85)' }}>Service Contract</div>
                            </div>
                        </div>
                        <h1 style={{ fontSize: 26, fontWeight: 800, color: '#fff', margin: '0 0 10px', lineHeight: 1.2 }}>{contract.title}</h1>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                                For: <strong style={{ color: '#fff' }}>{contract.client_name}</strong>
                            </span>
                            {contract.contact_person && (
                                <span style={{ fontSize: 13, color: 'rgba(255,255,255,0.75)' }}>
                                    · {contract.contact_person}
                                </span>
                            )}
                        </div>
                        {contract.token_expires_at && contract.status === 'pending' && !decisionDone && (
                            <div style={{ marginTop: 14, fontSize: 12, color: 'rgba(255,255,255,0.65)' }}>
                                ⏰ Offer expires: {formatExpiry(contract.token_expires_at)}
                            </div>
                        )}
                    </div>

                    {/* Status strip */}
                    <div style={{ background: badge.bg, padding: '10px 40px', display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 16 }}>{badge.icon}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color: badge.color }}>{badge.label}</span>
                    </div>

                    {/* Success / decision done banner */}
                    {decisionDone && (
                        <div style={{
                            margin: '24px 40px 0',
                            padding: '20px 24px',
                            background: decision === 'accepted' ? '#d1fae5' : '#fee2e2',
                            borderRadius: 14,
                            display: 'flex', alignItems: 'flex-start', gap: 14,
                        }}>
                            <span style={{ fontSize: 28 }}>{decision === 'accepted' ? '🎉' : '❌'}</span>
                            <div>
                                <p style={{ margin: '0 0 4px', fontWeight: 700, fontSize: 16, color: decision === 'accepted' ? '#065f46' : '#991b1b' }}>
                                    {decision === 'accepted' ? 'Contract Accepted!' : 'Contract Cancelled'}
                                </p>
                                <p style={{ margin: 0, fontSize: 13, color: decision === 'accepted' ? '#047857' : '#b91c1c', lineHeight: 1.6 }}>
                                    {decisionMessage}
                                </p>
                            </div>
                        </div>
                    )}

                    {/* Instruction */}
                    {isPending && (
                        <div style={{ margin: '24px 40px 0', padding: '14px 18px', background: '#f0f9ff', borderLeft: '3px solid #0369a1', borderRadius: 8 }}>
                            <p style={{ margin: 0, fontSize: 13, color: '#0c4a6e', lineHeight: 1.7 }}>
                                <strong>Please read the entire contract below.</strong> Scroll through the document to review all terms and conditions before making your decision.
                                The <em>Accept</em> button will become available once you have scrolled to the bottom.
                            </p>
                        </div>
                    )}

                    {/* Contract body */}
                    <div
                        ref={bodyRef}
                        style={{
                            margin: '24px 40px',
                            maxHeight: 440,
                            overflowY: 'auto',
                            background: '#f8fafc',
                            borderRadius: 12,
                            padding: '28px 28px',
                            fontSize: 14,
                            lineHeight: 1.85,
                            color: '#1e293b',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontFamily: "'Georgia', serif",
                            scrollbarWidth: 'thin',
                        }}
                    >
                        {contract.body}
                    </div>

                    {/* Action buttons */}
                    {!decisionDone && isPending && (
                        <div style={{ padding: '0 40px 40px' }}>
                            {!scrolledToBottom && (
                                <p style={{ margin: '0 0 14px', fontSize: 12, color: '#94a3b8', textAlign: 'center' }}>
                                    ↓ Scroll down to read the full contract before responding
                                </p>
                            )}

                            {confirmingReject ? (
                                <div style={{ background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 12, padding: '20px 24px', marginBottom: 0 }}>
                                    <p style={{ margin: '0 0 16px', fontWeight: 700, fontSize: 12, color: '#991b1b' }}>
                                        ❌ Are you sure you want toCancel this contract?
                                    </p>
                                    <p style={{ margin: '0 0 20px', fontSize: 13, color: '#7f1d1d', lineHeight: 1.6 }}>
                                        This action cannot be undone. The office will be notified of your decision.
                                    </p>
                                    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                                        <button
                                            onClick={() => handleDecide('rejected')}
                                            disabled={deciding}
                                            style={{ padding: '8px 14px', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 12, cursor: 'pointer' }}
                                        >
                                            {deciding ? 'Submitting...' : 'Cancel Contract'}
                                        </button>
                                        <button
                                            onClick={() => setConfirmingReject(false)}
                                            style={{ padding: '8px 14px', background: '#f1f5f9', color: '#374151', border: 'none', borderRadius: 8, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                                        >
                                            Go Back
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'flex-end', alignItems: 'center' }}>
                                    <button
                                        onClick={() => scrolledToBottom && handleDecide('accepted')}
                                        disabled={!scrolledToBottom || deciding}
                                        style={{                                            padding: '8px 14px',
                                            background: scrolledToBottom ? 'linear-gradient(135deg,#15803d,#16a34a)' : '#d1d5db',
                                            color: '#fff',
                                            border: 'none',
                                            borderRadius: 10,
                                            fontWeight: 800,
                                            fontSize: 12,
                                            cursor: scrolledToBottom ? 'pointer' : 'not-allowed',
                                            transition: 'all 0.2s',
                                            boxShadow: scrolledToBottom ? '0 4px 14px rgba(21,128,61,0.35)' : 'none',                                        }}
                                    >
                                        ✅ Accept Contract
                                    </button>
                                    <button
                                        onClick={() => setConfirmingReject(true)}
                                        disabled={deciding}
                                        style={{                                            padding: '8px 14px',
                                            background: '#fff',
                                            color: '#dc2626',
                                            border: '2px solid #fca5a5',
                                            borderRadius: 10,
                                            fontWeight: 700,
                                            fontSize: 12,
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                        }}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            )}
                        </div>
                    )}

                    {/* Already decided / expired footer */}
                    {!isPending && !decisionDone && (
                        <div style={{ padding: '0 40px 40px', textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
                            {contract.status === 'expired'
                                ? 'This contract invitation has expired. Please contact the office to request a new one.'
                                : `This contract was already ${contract.status}.`}
                        </div>
                    )}

                    {/* Footer branding */}
                    <div style={{ borderTop: '1px solid #f1f5f9', padding: '16px 40px', textAlign: 'center', background: '#fafafa' }}>
                        <p style={{ margin: 0, fontSize: 11, color: '#94a3b8' }}>
                            © {new Date().getFullYear()} LLB Accountants · All rights reserved
                        </p>
                    </div>
                </div>
            </div>
        </>
    );
}
