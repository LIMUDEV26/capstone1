type ZeroResultsProps = {
    /** The query that produced no results. */
    query: string;
    /** What was being searched, e.g. "clients", "documents". */
    itemLabel?: string;
    /** Alternative searches to try (clickable). */
    alternatives?: string[];
    onPickAlternative?: (term: string) => void;
    /** Clears the search (and ideally sibling filters). */
    onClear?: () => void;
    clearLabel?: string;
};

/**
 * Zero-result state: never a dead end. Shows what was searched, clickable
 * alternative searches, and a way back out.
 */
export default function ZeroResults({
    query,
    itemLabel = 'results',
    alternatives = [],
    onPickAlternative,
    onClear,
    clearLabel = 'Clear search',
}: ZeroResultsProps) {
    const clean = String(query ?? '').trim();
    return (
        <div style={{ padding: '28px 16px', textAlign: 'center' }}>
            <div
                aria-hidden="true"
                style={{
                    width: 44,
                    height: 44,
                    borderRadius: '50%',
                    background: '#f1f5f9',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 10,
                    color: '#94a3b8',
                }}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="8" y1="11" x2="14" y2="11" /></svg>
            </div>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>
                No {itemLabel} found{clean ? <> for <span style={{ color: '#1d4ed8' }}>“{clean}”</span></> : ''}
            </div>
            {alternatives.length > 0 && (
                <div style={{ marginTop: 10 }}>
                    <div style={{ fontSize: 12, color: '#64748b', marginBottom: 6 }}>Try one of these instead:</div>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'center', flexWrap: 'wrap' }}>
                        {alternatives.map((alt) => (
                            <button
                                key={alt}
                                type="button"
                                onClick={() => onPickAlternative?.(alt)}
                                title={`Search for "${alt}"`}
                                style={{
                                    padding: '5px 12px',
                                    borderRadius: 99,
                                    border: '1px solid #bfdbfe',
                                    background: '#eff6ff',
                                    color: '#1d4ed8',
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                }}
                            >
                                {alt}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {onClear && (
                <button
                    type="button"
                    onClick={onClear}
                    style={{ marginTop: 12, background: 'transparent', border: 'none', color: '#64748b', fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                >
                    {clearLabel}
                </button>
            )}
        </div>
    );
}
