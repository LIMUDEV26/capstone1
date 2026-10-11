import { useEffect, useId, useState, type CSSProperties } from 'react';

interface PaginationProps {
    currentPage: number;
    totalItems: number;
    itemsPerPage: number;
    onPageChange: (page: number) => void;
    label?: string;
    variant?: 'light' | 'dark';
}

type PageItem = number | 'ellipsis';

// Step used for the quick page-jump shortcuts: 1 .. 50 .. 100 .. 150 .. last.
const PAGE_JUMP_STEP = 50;
// Numbered buttons already cover up to 7 slots; show jump shortcuts beyond that.
const JUMP_STRIP_THRESHOLD = 7;

const buildPageItems = (currentPage: number, totalPages: number): PageItem[] => {
    if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
    }

    const items: PageItem[] = [1];
    const start = Math.max(2, currentPage - 1);
    const end = Math.min(totalPages - 1, currentPage + 1);

    if (start > 2) items.push('ellipsis');
    for (let page = start; page <= end; page += 1) {
        items.push(page);
    }
    if (end < totalPages - 1) items.push('ellipsis');

    items.push(totalPages);
    return items;
};

// Quick-jump targets derived from the settings-based page count, e.g.
// totalPages=253 -> [1, 50, 100, 150, 200, 250, 253(last)].
const buildJumpTargets = (totalPages: number): number[] => {
    if (totalPages <= 1) return [];
    const targets = new Set<number>([1]);
    for (let page = PAGE_JUMP_STEP; page < totalPages; page += PAGE_JUMP_STEP) {
        targets.add(page);
    }
    targets.add(totalPages);
    return Array.from(targets).sort((a, b) => a - b);
};

export default function Pagination({
    currentPage,
    totalItems,
    itemsPerPage,
    onPageChange,
    label = 'items',
    variant = 'light',
}: PaginationProps) {
    const totalPages = Math.max(1, Math.ceil(totalItems / Math.max(1, itemsPerPage)));
    const safeCurrentPage = Math.min(Math.max(currentPage, 1), totalPages);

    const [goToDraft, setGoToDraft] = useState<string>(String(safeCurrentPage));
    const goToInputId = useId();

    useEffect(() => {
        setGoToDraft(String(safeCurrentPage));
    }, [safeCurrentPage]);

    if (totalItems === 0) return null;

    const start = (safeCurrentPage - 1) * itemsPerPage + 1;
    const end = Math.min(safeCurrentPage * itemsPerPage, totalItems);
    const pageItems = buildPageItems(safeCurrentPage, totalPages);
    const jumpTargets = buildJumpTargets(totalPages);
    const showJumpStrip = totalPages > JUMP_STRIP_THRESHOLD && jumpTargets.length > 2;
    const isDark = variant === 'dark';

    const goToPage = (page: number) => {
        if (!Number.isFinite(page)) return;
        onPageChange(Math.min(Math.max(1, Math.trunc(page)), totalPages));
    };

    const submitGoTo = () => {
        const parsed = Number.parseInt(goToDraft, 10);
        if (Number.isNaN(parsed)) {
            setGoToDraft(String(safeCurrentPage));
            return;
        }
        goToPage(parsed);
    };

    const colors = isDark
        ? {
            metaText: '#9fb3e0',
            buttonBorder: 'rgba(148, 163, 184, 0.35)',
            buttonBg: 'rgba(15, 23, 42, 0.8)',
            buttonText: '#dbe7ff',
            buttonDisabledBg: 'rgba(15, 23, 42, 0.45)',
            buttonDisabledText: '#6b7ea8',
            ellipsis: '#6b7ea8',
            activeBorder: '#3b82f6',
            activeBg: '#1d4ed8',
            activeText: '#ffffff',
            jumpSeparator: '#475569',
            inputBg: 'rgba(15, 23, 42, 0.8)',
            inputText: '#dbe7ff',
        }
        : {
            metaText: '#64748b',
            buttonBorder: '#e2e8f0',
            buttonBg: '#ffffff',
            buttonText: '#334155',
            buttonDisabledBg: '#f8fafc',
            buttonDisabledText: '#94a3b8',
            ellipsis: '#94a3b8',
            activeBorder: '#1e3a8a',
            activeBg: '#1e3a8a',
            activeText: '#ffffff',
            jumpSeparator: '#b6c2d2',
            inputBg: '#ffffff',
            inputText: '#0f172a',
        };

    const navButtonStyle = (disabled: boolean): CSSProperties => ({
        padding: '6px 10px',
        borderRadius: '6px',
        border: `1px solid ${colors.buttonBorder}`,
        background: disabled ? colors.buttonDisabledBg : colors.buttonBg,
        color: disabled ? colors.buttonDisabledText : colors.buttonText,
        cursor: disabled ? 'not-allowed' : 'pointer',
        fontSize: '12px',
        fontWeight: 600,
    });

    const pageButtonStyle = (isActive: boolean): CSSProperties => ({
        minWidth: '32px',
        padding: '6px 9px',
        borderRadius: '6px',
        border: `1px solid ${isActive ? colors.activeBorder : colors.buttonBorder}`,
        background: isActive ? colors.activeBg : colors.buttonBg,
        color: isActive ? colors.activeText : colors.buttonText,
        cursor: 'pointer',
        fontSize: '12px',
        fontWeight: 600,
    });

    return (
        <div
            style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '8px',
                marginTop: '14px',
            }}
        >
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                flexWrap: 'wrap',
            }}
        >
            <span style={{ fontSize: '13px', color: colors.metaText }}>
                Showing {start}-{end} of {totalItems} {label}
            </span>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                <button
                    type="button"
                    title="First page"
                    aria-label="First page"
                    onClick={() => goToPage(1)}
                    disabled={safeCurrentPage <= 1}
                    style={navButtonStyle(safeCurrentPage <= 1)}
                >
                    «
                </button>
                <button
                    type="button"
                    onClick={() => onPageChange(safeCurrentPage - 1)}
                    disabled={safeCurrentPage <= 1}
                    style={navButtonStyle(safeCurrentPage <= 1)}
                >
                    Prev
                </button>

                {pageItems.map((item, index) => {
                    if (item === 'ellipsis') {
                        return (
                            <span key={`ellipsis-${index}`} style={{ padding: '0 6px', color: colors.ellipsis }}>
                                ...
                            </span>
                        );
                    }

                    const isActive = item === safeCurrentPage;
                    return (
                        <button
                            key={`page-${item}`}
                            type="button"
                            onClick={() => onPageChange(item)}
                            style={pageButtonStyle(isActive)}
                        >
                            {item}
                        </button>
                    );
                })}

                <button
                    type="button"
                    onClick={() => onPageChange(safeCurrentPage + 1)}
                    disabled={safeCurrentPage >= totalPages}
                    style={navButtonStyle(safeCurrentPage >= totalPages)}
                >
                    Next
                </button>
                <button
                    type="button"
                    title="Last page"
                    aria-label="Last page"
                    onClick={() => goToPage(totalPages)}
                    disabled={safeCurrentPage >= totalPages}
                    style={navButtonStyle(safeCurrentPage >= totalPages)}
                >
                    »
                </button>
            </div>
        </div>

        {totalPages > 1 && (
        <div
            style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: '12px',
                flexWrap: 'wrap',
            }}
        >
            {showJumpStrip ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '12px', color: colors.metaText, marginRight: 2 }}>Jump:</span>
                    {jumpTargets.map((target, index) => (
                        <span key={`jump-${target}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            {index > 0 && (
                                <span style={{ color: colors.jumpSeparator, fontSize: 11, fontWeight: 700 }}>..</span>
                            )}
                            <button
                                type="button"
                                title={target === totalPages ? `Last page (${totalPages})` : `Go to page ${target}`}
                                aria-label={target === totalPages ? `Jump to last page, page ${totalPages}` : `Jump to page ${target}`}
                                onClick={() => goToPage(target)}
                                style={pageButtonStyle(target === safeCurrentPage)}
                            >
                                {target}
                            </button>
                        </span>
                    ))}
                </div>
            ) : (
                <span />
            )}

            <form
                className="system-form-compact"
                onSubmit={(e) => {
                    e.preventDefault();
                    submitGoTo();
                }}
                style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
            >
                <label htmlFor={goToInputId} style={{ fontSize: '12px', color: colors.metaText }}>
                    Go to page
                </label>
                <input
                    id={goToInputId}
                    type="number"
                    min={1}
                    max={totalPages}
                    value={goToDraft}
                    onChange={(e) => setGoToDraft(e.target.value)}
                    onFocus={(e) => {
                        try {
                            e.target.select();
                        } catch {
                            /* noop */
                        }
                    }}
                    style={{
                        width: '64px',
                        padding: '5px 8px',
                        borderRadius: '6px',
                        border: `1px solid ${colors.buttonBorder}`,
                        background: colors.inputBg,
                        color: colors.inputText,
                        fontSize: '12px',
                        fontWeight: 600,
                    }}
                />
                <span style={{ fontSize: '12px', color: colors.metaText }}>of {totalPages}</span>
                <button type="submit" className="pagination-go-button" style={pageButtonStyle(false)}>
                    Go
                </button>
            </form>
        </div>
        )}
        </div>
    );
}
