import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { DROPDOWN_ANIM_MS, getFlipForTrigger } from '@/utils/dropdownSystem';
import {
    clearRecentSearches,
    getAutocompleteSuggestions,
    getRecentSearches,
    removeRecentSearch,
    saveRecentSearch,
} from '@/utils/search';

type SearchBarProps = {
    value: string;
    onChange: (value: string) => void;
    /** Fired on explicit search commits (Enter / suggestion pick). */
    onSearch?: (term: string) => void;
    /** Namespace for this bar's recent searches, e.g. "clients:list". */
    storageKey: string;
    placeholder?: string;
    /** Candidate strings the autocomplete matches against. */
    suggestions?: string[];
    disabled?: boolean;
    inputStyle?: CSSProperties;
    /** Optional class applied to the inner <input> (e.g. CSS-module styles). */
    inputClassName?: string;
    ariaLabel?: string;
};

const AUTOSAVE_IDLE_MS = 1000;

// Minimum space reserved inside the input for the clear (X) button so it
// always sits *inside* the field — even when callers pass an `inputStyle` /
// `inputClassName` that overrides padding (e.g. `padding: 10` would
// otherwise let text slide under the X).
const CLEAR_RESERVE_RIGHT = 30;
const ICON_RESERVE_LEFT = 12;

function toPx(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const m = value.trim().match(/^(-?\d+(?:\.\d+)?)px$/);
        if (m) return Number(m[1]);
        if (/^-?\d+(?:\.\d+)?$/.test(value.trim())) return Number(value.trim());
    }
    return null;
}

/** Parse the right component out of a CSS `padding` shorthand. */
function shorthandSide(padding: unknown, side: 'left' | 'right' | 'top' | 'bottom'): number | null {
    if (typeof padding === 'number' && Number.isFinite(padding)) return padding;
    if (typeof padding !== 'string') return null;
    const parts = padding.trim().split(/\s+/).map(toPx);
    if (parts.some((p) => p === null)) return null;
    const nums = parts as number[];
    if (nums.length === 1) return nums[0];
    if (nums.length === 2) return side === 'top' || side === 'bottom' ? nums[0] : nums[1];
    if (nums.length === 3) {
        if (side === 'top') return nums[0];
        if (side === 'bottom') return nums[2];
        return nums[1];
    }
    if (nums.length >= 4) {
        if (side === 'top') return nums[0];
        if (side === 'right') return nums[1];
        if (side === 'bottom') return nums[2];
        return nums[3];
    }
    return null;
}

function reserveHorizontal(style: CSSProperties | undefined, side: 'left' | 'right', min: number): number {
    const explicit = side === 'right' ? style?.paddingRight : style?.paddingLeft;
    const fromExplicit = toPx(explicit);
    if (fromExplicit !== null) return Math.max(min, fromExplicit);
    const fromShorthand = shorthandSide(style?.padding, side);
    if (fromShorthand !== null) return Math.max(min, fromShorthand);
    return min;
}

function reserveVertical(style: CSSProperties | undefined, side: 'top' | 'bottom', fallback: number): number {
    const explicit = side === 'top' ? style?.paddingTop : style?.paddingBottom;
    const fromExplicit = toPx(explicit);
    if (fromExplicit !== null) return fromExplicit;
    const fromShorthand = shorthandSide(style?.padding, side);
    if (fromShorthand !== null) return fromShorthand;
    return fallback;
}

/**
 * System search bar: live-filter input with recent searches, autocomplete
 * suggestions, and keyboard navigation. Clicking a recent/suggestion fills
 * the bar and commits the search.
 */
export default function SearchBar({
    value,
    onChange,
    onSearch,
    storageKey,
    placeholder = 'Search...',
    suggestions = [],
    disabled = false,
    inputStyle,
    inputClassName,
    ariaLabel,
}: SearchBarProps) {
    const [open, setOpen] = useState(false);
    const [recents, setRecents] = useState<string[]>([]);
    const [highlight, setHighlight] = useState(-1);
    // Rule 2 (flip on edge) + Rule 4 (150ms in/out) for the suggestions menu.
    const [openUp, setOpenUp] = useState(false);
    const [menuClosing, setMenuClosing] = useState(false);
    const [renderMenu, setRenderMenu] = useState(false);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const menuRef = useRef<HTMLDivElement | null>(null);
    // Fixed-position portal coords so the menu overlays in front of every
    // card (no ancestor overflow or stacking context can block it).
    const [menuPos, setMenuPos] = useState({ top: 0, bottom: 0, left: 0, width: 0 });
    const valueRef = useRef(value);
    valueRef.current = value;

    const trimmed = value.trim();
    const matches = useMemo(
        () => getAutocompleteSuggestions(trimmed, suggestions, 6),
        [trimmed, suggestions]
    );

    const refreshRecents = () => setRecents(getRecentSearches(storageKey));

    // Outside-click closes the dropdown (menu lives in a body portal, so
    // both the bar and the menu count as "inside").
    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            const t = e.target as Node | null;
            if (t && containerRef.current?.contains(t)) return;
            if (t && menuRef.current?.contains(t)) return;
            setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [open ]);

    // Debounced autosave: live-filter lists rarely get an Enter press, so a
    // settled query still lands in recents.
    useEffect(() => {
        const current = valueRef.current.trim();
        if (current.length < 2) return;
        const timer = window.setTimeout(() => {
            if (valueRef.current.trim() === current) {
                saveRecentSearch(storageKey, current);
                setRecents(getRecentSearches(storageKey));
            }
        }, AUTOSAVE_IDLE_MS);
        return () => window.clearTimeout(timer);
    }, [value, storageKey]);

    const commit = (term: string) => {
        const clean = String(term ?? '').trim();
        onChange(clean);
        if (clean.length >= 2) {
            saveRecentSearch(storageKey, clean);
            setRecents(getRecentSearches(storageKey));
        }
        onSearch?.(clean);
        setOpen(false);
        setHighlight(-1);
    };

    const showingRecents = trimmed === '' && recents.length > 0;
    const items = trimmed === '' ? recents : matches;
    const showDropdown = open && !disabled && (showingRecents || items.length > 0);

    // Rule 2 — measure viewport space on open; Rule 4 — keep the menu mounted
    // for the 150ms out-animation before unmounting.
    // NOTE: measure the input (trigger), not the container — the container
    // includes the open menu and would inflate the rect.
    // The menu renders in a fixed-position body portal, so coords come from
    // the input's viewport rect and no card can clip it.
    const refreshMenuPos = () => {
        const el = inputRef.current;
        if (!el || typeof window === 'undefined') return;
        const r = el.getBoundingClientRect();
        const estH = Math.min(260, 40 + Math.max(items.length, 1) * 38);
        const up = getFlipForTrigger(el, estH);
        setOpenUp(up);
        setMenuPos({
            top: r.bottom + 4,
            bottom: window.innerHeight - r.top + 4,
            left: Math.max(8, r.left),
            width: Math.max(120, Math.min(r.width, window.innerWidth - 16)),
        });
    };
    useEffect(() => {
        if (showDropdown) {
            setRenderMenu(true);
            setMenuClosing(false);
            refreshMenuPos();
            return;
        }
        if (!renderMenu || menuClosing) return;
        setMenuClosing(true);
        const timer = window.setTimeout(() => {
            setRenderMenu(false);
            setMenuClosing(false);
        }, DROPDOWN_ANIM_MS);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showDropdown ]);

    // Rule 2 — re-evaluate flip + portal coords while open (type / scroll / resize).
    useEffect(() => {
        if (!renderMenu || menuClosing) return;
        const onReposition = () => refreshMenuPos();
        window.addEventListener('resize', onReposition);
        window.addEventListener('scroll', onReposition, true);
        return () => {
            window.removeEventListener('resize', onReposition);
            window.removeEventListener('scroll', onReposition, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [renderMenu, menuClosing, items.length]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown' && showDropdown && items.length > 0) {
            e.preventDefault();
            setHighlight((h) => (h + 1) % items.length);
        } else if (e.key === 'ArrowUp' && showDropdown && items.length > 0) {
            e.preventDefault();
            setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1));
        } else if (e.key === 'Enter') {
            if (showDropdown && highlight >= 0 && items[highlight]) {
                e.preventDefault();
                commit(items[highlight]);
            } else {
                commit(value);
                (e.target as HTMLInputElement)?.blur?.();
            }
        } else if (e.key === 'Escape') {
            if (value) {
                onChange('');
                onSearch?.('');
                setHighlight(-1);
            }
            setOpen(false);
        }
    };

    // Strip caller padding so the enforced reserves below can't be clobbered
    // by the spread (TS also forbids duplicate keys in one literal).
    const { padding: _pad, paddingLeft: _pl, paddingRight: _pr, paddingTop: _pt, paddingBottom: _pb, boxSizing: _bs, ...restInputStyle } = inputStyle ?? {};
    void _pad; void _pl; void _pr; void _pt; void _pb; void _bs;
    const enforcedPaddingLeft = reserveHorizontal(inputStyle, 'left', ICON_RESERVE_LEFT);
    const enforcedPaddingRight = reserveHorizontal(inputStyle, 'right', CLEAR_RESERVE_RIGHT);
    const enforcedPaddingTop = reserveVertical(inputStyle, 'top', 9);
    const enforcedPaddingBottom = reserveVertical(inputStyle, 'bottom', 9);

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
                <input
                    ref={inputRef}
                    type="text"
                    role="combobox"
                    aria-expanded={renderMenu && !menuClosing}
                    aria-label={ariaLabel ?? placeholder}
                    aria-autocomplete="list"
                    placeholder={placeholder}
                    value={value}
                    disabled={disabled}
                    autoComplete="off"
                    className={inputClassName}
                    onChange={(e) => {
                        onChange(e.target.value);
                        setOpen(true);
                        setHighlight(-1);
                    }}
                    onFocus={() => {
                        refreshRecents();
                        setOpen(true);
                    }}
                    onKeyDown={handleKeyDown}
                    style={{
                        width: '100%',
                        borderRadius: 8,
                        border: '1px solid #e2e8f0',
                        background: '#fff',
                        color: '#0f172a',
                        fontSize: 13,
                        outline: 'none',
                        ...restInputStyle,
                        // Re-assert after the spread: callers may pass their own
                        // `padding` / `paddingLeft` / `paddingRight`, but the X
                        // must stay inside the field and text must never slide
                        // underneath it.
                        paddingTop: enforcedPaddingTop,
                        paddingBottom: enforcedPaddingBottom,
                        paddingLeft: enforcedPaddingLeft,
                        paddingRight: enforcedPaddingRight,
                        boxSizing: 'border-box',
                    }}
                />
                {value && !disabled && (
                    <button
                        type="button"
                        data-search-clear="true"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                            onChange('');
                            onSearch?.('');
                            setOpen(false);
                            setHighlight(-1);
                            inputRef.current?.focus();
                        }}
                        title="Clear search"
                        aria-label="Clear search"
                        className="llb-search-clear"
                        style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', alignItems: 'center', justifyContent: 'center', width: 20, height: 20, minWidth: 20, minHeight: 20, maxWidth: 20, maxHeight: 20, flexShrink: 0, border: 'none', background: 'transparent', color: '#94a3b8', cursor: 'pointer', fontSize: 12, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}
                    >
                        ✕
                    </button>
                )}
            </div>

            {renderMenu && typeof document !== 'undefined' && createPortal(
                <div
                    ref={menuRef}
                    role="listbox"
                    aria-label={showingRecents ? 'Recent searches' : 'Search suggestions'}
                    className={`app-anim-menu${openUp ? ' app-flip-up' : ''}${menuClosing ? ' is-closing' : ''}`}
                    style={{
                        position: 'fixed',
                        top: openUp ? undefined : menuPos.top,
                        bottom: openUp ? menuPos.bottom : undefined,
                        left: menuPos.left,
                        width: menuPos.width,
                        zIndex: 250000,
                        background: '#fff',
                        border: '1px solid #e2e8f0',
                        borderRadius: 10,
                        boxShadow: '0 10px 28px rgba(15, 23, 42, 0.14)',
                        overflow: 'hidden',
                        maxHeight: 260,
                        overflowY: 'auto',
                    }}
                >
                    <div style={{ padding: '6px 10px 2px', fontSize: 10, fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>{showingRecents ? 'Recent searches' : 'Suggestions'}</span>
                        {showingRecents && (
                            <button
                                type="button"
                                onClick={() => {
                                    clearRecentSearches(storageKey);
                                    setRecents([]);
                                }}
                                style={{ border: 'none', background: 'transparent', color: '#64748b', fontSize: 10, fontWeight: 700, cursor: 'pointer', padding: 0 }}
                            >
                                Clear all
                            </button>
                        )}
                    </div>
                    {items.map((item, i) => (
                        <div
                            key={`${showingRecents ? 'recent' : 'suggest'}-${item}`}
                            role="option"
                            aria-selected={i === highlight}
                            onMouseDown={(e) => {
                                // Fire before the input blurs/closes.
                                e.preventDefault();
                                commit(item);
                            }}
                            onMouseEnter={() => setHighlight(i)}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '8px 10px',
                                cursor: 'pointer',
                                background: i === highlight ? '#eff6ff' : 'transparent',
                                fontSize: 13,
                                color: '#0f172a',
                            }}
                        >
                            {showingRecents && (
                                <span aria-hidden="true" style={{ color: '#94a3b8', flexShrink: 0, display: 'inline-flex' }}>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" /></svg>
                                </span>
                            )}
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item}</span>
                            {showingRecents && (
                                <button
                                    type="button"
                                    title={`Remove "${item}"`}
                                    aria-label={`Remove "${item}" from recent searches`}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        removeRecentSearch(storageKey, item);
                                        setRecents(getRecentSearches(storageKey));
                                    }}
                                    style={{ border: 'none', background: 'transparent', color: '#cbd5e1', cursor: 'pointer', fontSize: 12, padding: '0 2px', lineHeight: 1 }}
                                >
                                    ✕
                                </button>
                            )}
                        </div>
                    ))}
                </div>,
                document.body
            )}
        </div>
    );
}
