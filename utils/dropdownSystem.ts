/**
 * SYSTEM DROPDOWN STANDARD — shared constants + helpers (all roles / all pages).
 *
 * Rule 1 — Obvious trigger: 48px touch target, clear caret icon, hover feedback.
 * Rule 2 — Flip on edge: menu opens upward when it would hit the viewport bottom.
 * Rule 3 — 10+ items = search (role-agnostic, applies to every user type).
 * Rule 4 — Animate 150ms in/out.
 */

export const DROPDOWN_TOUCH_TARGET_PX = 48;
export const DROPDOWN_ANIM_MS = 150;
export const DROPDOWN_SEARCH_THRESHOLD = 10;
export const DROPDOWN_MENU_GAP_PX = 8;

/** Rule 3 — any dropdown with 10+ items shows a search field. No role gating. */
export function shouldShowDropdownSearch(itemCount: number, threshold = DROPDOWN_SEARCH_THRESHOLD): boolean {
  return itemCount >= threshold;
}

/** Case-insensitive filter used by every searchable dropdown menu. */
export function filterDropdownOptions<T>(
  options: T[],
  query: string,
  getLabel: (option: T) => string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return options;
  return options.filter((o) => getLabel(o).toLowerCase().includes(q));
}

export type DropdownFlip = {
  /** True when the menu should open upward (not enough room below). */
  openUp: boolean;
  /** Max menu height that fits in the chosen direction. */
  maxHeight: number;
};

/**
 * Rule 2 — decide open direction from viewport space.
 * Pure function so it is unit-testable and reusable by every custom menu
 * (AppSelect, SearchBar suggestions, Layout profile/notification dropdowns,
 * row action menus).
 */
export function computeDropdownFlip(args: {
  triggerRect: { top: number; bottom: number; height: number };
  viewportHeight: number;
  menuHeight: number;
  gap?: number;
}): DropdownFlip {
  const gap = args.gap ?? DROPDOWN_MENU_GAP_PX;
  const spaceBelow = args.viewportHeight - args.triggerRect.bottom - gap;
  const spaceAbove = args.triggerRect.top - gap;
  if (args.menuHeight <= spaceBelow) return { openUp: false, maxHeight: args.menuHeight };
  if (spaceAbove > spaceBelow) {
    return { openUp: true, maxHeight: Math.max(120, Math.min(args.menuHeight, spaceAbove)) };
  }
  return { openUp: false, maxHeight: Math.max(120, Math.min(args.menuHeight, spaceBelow)) };
}

/**
 * Rule 2 — DOM helper: measure the trigger and decide whether the menu
 * (of estimated height) must flip upward. Safe to call on open + on resize.
 */
export function getFlipForTrigger(
  triggerEl: HTMLElement | null,
  estimatedMenuHeight = 320,
  gap = DROPDOWN_MENU_GAP_PX,
): boolean {
  if (!triggerEl || typeof window === 'undefined') return false;
  const rect = triggerEl.getBoundingClientRect();
  const { openUp } = computeDropdownFlip({
    triggerRect: { top: rect.top, bottom: rect.bottom, height: rect.height },
    viewportHeight: window.innerHeight,
    menuHeight: estimatedMenuHeight,
    gap,
  });
  return openUp;
}

/** Rule 4 — keep the menu mounted for the out-animation before unmounting. */
export function closeWithAnimation(setClosing: (v: boolean) => void, onClosed: () => void): number {
  setClosing(true);
  return window.setTimeout(() => {
    setClosing(false);
    onClosed();
  }, DROPDOWN_ANIM_MS);
}
