import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  DROPDOWN_ANIM_MS,
  DROPDOWN_SEARCH_THRESHOLD,
  filterDropdownOptions,
  getFlipForTrigger,
  shouldShowDropdownSearch,
} from '@/utils/dropdownSystem';

export type AppSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
};

type AppSelectProps = {
  value: string;
  onChange: (value: string) => void;
  options: AppSelectOption[];
  /** Visible label / placeholder when nothing is selected. */
  placeholder?: string;
  ariaLabel: string;
  disabled?: boolean;
  /** Override the 10+ = search threshold (default 10). */
  searchThreshold?: number;
  /** Placeholder inside the menu search field. */
  searchPlaceholder?: string;
  id?: string;
  className?: string;
  triggerStyle?: CSSProperties;
};

/**
 * SYSTEM DROPDOWN STANDARD — universal select (all roles / all pages).
 *
 * Rule 1 — Obvious trigger: 48px min-height, clear caret icon (rotates on
 *   open), hover + focus-visible feedback.
 * Rule 2 — Flip on edge: opens upward when it would hit the viewport bottom.
 * Rule 3 — 10+ items = search (role-agnostic; threshold prop defaults to 10).
 * Rule 4 — Animate 150ms in/out (out-animation stays mounted briefly on close).
 */
export default function AppSelect({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  ariaLabel,
  disabled = false,
  searchThreshold = DROPDOWN_SEARCH_THRESHOLD,
  searchPlaceholder = 'Search options…',
  id,
  className,
  triggerStyle,
}: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(-1);
  const [openUp, setOpenUp] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const closeTimer = useRef<number | null>(null);
  const reactId = useId();
  const menuId = `${id ?? `app-select-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`}-menu`;

  const selected = options.find((o) => o.value === value) ?? null;
  const showSearch = shouldShowDropdownSearch(options.length, searchThreshold);
  const visible = useMemo(
    () => (showSearch ? filterDropdownOptions(options, query, (o) => o.label) : options),
    [options, query, showSearch],
  );

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
  };

  /** Rule 4 — play the 150ms out-animation, then unmount. */
  const requestClose = () => {
    if (!open || closing) return;
    setClosing(true);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
      setQuery('');
      setHighlight(-1);
      closeTimer.current = null;
    }, DROPDOWN_ANIM_MS);
  };

  const toggle = () => {
    if (disabled) return;
    if (open && !closing) {
      requestClose();
      return;
    }
    cancelClose();
    // Rule 2 — measure viewport space before opening.
    setOpenUp(getFlipForTrigger(triggerRef.current));
    setOpen(true);
    setQuery('');
    setHighlight(-1);
  };

  const commit = (next: string) => {
    onChange(next);
    requestClose();
    triggerRef.current?.focus();
  };

  // Outside click / Escape closes (with out-animation).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) requestClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestClose();
    };
    // Rule 2 — re-evaluate flip on scroll/resize while open.
    const onReposition = () => setOpenUp(getFlipForTrigger(triggerRef.current));
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  useEffect(() => {
    if (open && !closing && showSearch) searchRef.current?.focus();
  }, [open, closing, showSearch]);

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  const handleTriggerKey = (e: ReactKeyboardEvent) => {    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) toggle();
      else if (visible.length > 0) setHighlight((h) => (h + 1) % visible.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (open && visible.length > 0) setHighlight((h) => (h <= 0 ? visible.length - 1 : h - 1));
    }
  };

  const handleMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (visible.length === 0 ? -1 : (h + 1) % visible.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (visible.length === 0 ? -1 : h <= 0 ? visible.length - 1 : h - 1));
    } else if (e.key === 'Enter' && highlight >= 0 && visible[highlight] && !visible[highlight].disabled) {
      e.preventDefault();
      commit(visible[highlight].value);
    }
  };

  return (
    <div ref={rootRef} className={`app-dd${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        className="app-dd-trigger"
        style={triggerStyle}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={menuId}
        aria-label={ariaLabel}
        disabled={disabled}
        data-open={open && !closing ? 'true' : 'false'}
        onClick={toggle}
        onKeyDown={handleTriggerKey}
      >
        <span className="app-dd-trigger-label">{selected ? selected.label : placeholder}</span>
        {/* Rule 1 — clear caret icon, rotates 180° when open (see CSS). */}
        <span className="app-dd-caret" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </span>
      </button>

      {open && (
        <div
          id={menuId}
          role="listbox"
          aria-label={ariaLabel}
          onKeyDown={handleMenuKey}
          className={`app-dd-menu${openUp ? ' app-dd-menu--up' : ''}${closing ? ' is-closing' : ''}`}
        >
          {/* Rule 3 — 10+ items = search, for every user type. */}
          {showSearch && (
            <div className="app-dd-search">
              <input
                ref={searchRef}
                type="search"
                value={query}
                aria-label={`Search ${ariaLabel}`}
                placeholder={searchPlaceholder}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setHighlight(-1);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setHighlight(0);
                  }
                }}
              />
            </div>
          )}
          <div className="app-dd-count" aria-live="polite">
            {showSearch ? `${visible.length} of ${options.length}` : `${options.length} options`}
          </div>
          {visible.length === 0 ? (
            <div className="app-dd-empty">No matches for “{query.trim()}”.</div>
          ) : (
            visible.map((opt) => {
              const idx = visible.indexOf(opt);
              const isSelected = opt.value === value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  data-selected={isSelected ? 'true' : 'false'}
                  data-highlighted={idx === highlight ? 'true' : 'false'}
                  className="app-dd-option"
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => {
                    if (!opt.disabled) commit(opt.value);
                  }}
                >
                  <span className="app-dd-option-check" aria-hidden="true">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>{opt.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
