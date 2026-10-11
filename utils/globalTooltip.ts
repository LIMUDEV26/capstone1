/**
 * Global tooltip controller: every `title` tooltip in the system shows
 * after a 100ms hover delay in a styled bubble that points at its element
 * with an arrow.
 *
 * Zero per-page work required — a single delegated listener picks up any
 * element carrying a `title` attribute (including content rendered later).
 * While our bubble is armed/visible the native title is parked aside so the
 * browser's own tooltip never double-renders; it is always restored.
 *
 * Notes:
 * - Disabled buttons/inputs do not emit hover events, so those keep the
 *   native tooltip (still functional, just unstyled).
 * - Touch devices have no hover; nothing shows (same as before).
 */

const TOOLTIP_DELAY_MS = 100;
const TOOLTIP_GAP_PX = 10;
const VIEWPORT_PAD_PX = 8;

let installed = false;

function findTipTarget(node: EventTarget | null): HTMLElement | null {
  let el = node as HTMLElement | null;
  while (el && el !== document.body) {
    if (
      el instanceof HTMLElement &&
      (el.getAttribute('title') || el.getAttribute('data-llb-tip'))
    ) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function installGlobalTooltips() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => {};
  }
  if (installed) return () => {};
  installed = true;

  let tipEl: HTMLDivElement | null = null;
  let showTimer: number | null = null;
  let currentTarget: HTMLElement | null = null;

  const ensureTip = () => {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'llb-tooltip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    return tipEl;
  };

  const clearTimer = () => {
    if (showTimer !== null) {
      window.clearTimeout(showTimer);
      showTimer = null;
    }
  };

  const hideTip = () => {
    clearTimer();
    if (tipEl) tipEl.classList.remove('llb-tooltip-visible');
    if (currentTarget) {
      const parked = currentTarget.getAttribute('data-llb-tip');
      if (parked !== null) {
        currentTarget.setAttribute('title', parked);
        currentTarget.removeAttribute('data-llb-tip');
      }
      currentTarget = null;
    }
  };

  const placeTip = (target: HTMLElement, el: HTMLDivElement, text: string) => {
    el.textContent = text;
    el.removeAttribute('data-placement');
    // Park off-screen for one synchronous measure, then place. The browser
    // paints once at the final spot with the fade running from 0.
    el.style.left = '-9999px';
    el.style.top = '0px';
    el.classList.add('llb-tooltip-visible');
    const tipWidth = el.offsetWidth;
    const tipHeight = el.offsetHeight;

    const rect = target.getBoundingClientRect();
    const targetCenterX = rect.left + rect.width / 2;
    let left = targetCenterX - tipWidth / 2;
    left = Math.max(
      VIEWPORT_PAD_PX,
      Math.min(left, window.innerWidth - tipWidth - VIEWPORT_PAD_PX)
    );

    const spaceAbove = rect.top - TOOLTIP_GAP_PX;
    const placement = spaceAbove >= tipHeight + VIEWPORT_PAD_PX ? 'top' : 'bottom';
    const top =
      placement === 'top' ? rect.top - tipHeight - TOOLTIP_GAP_PX : rect.bottom + TOOLTIP_GAP_PX;

    let arrowLeft = targetCenterX - left;
    arrowLeft = Math.max(14, Math.min(arrowLeft, tipWidth - 14));

    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.setAttribute('data-placement', placement);
    el.style.setProperty('--arrow-left', `${Math.round(arrowLeft)}px`);
  };

  const showTip = () => {
    showTimer = null;
    if (!currentTarget || !document.contains(currentTarget)) {
      hideTip();
      return;
    }
    // Park the native title aside now (100ms in — before the browser's own
    // ~1s tooltip delay) so only our bubble renders.
    const parked = currentTarget.getAttribute('data-llb-tip');
    const raw = parked !== null ? parked : currentTarget.getAttribute('title') || '';
    if (parked === null) {
      currentTarget.setAttribute('data-llb-tip', raw);
      currentTarget.removeAttribute('title');
    }
    const text = raw.trim();
    if (!text) {
      hideTip();
      return;
    }
    placeTip(currentTarget, ensureTip(), text);
  };

  const armForTarget = (target: HTMLElement | null) => {
    if (target === currentTarget) return;
    hideTip();
    if (!target) return;
    const hasText = (target.getAttribute('title') || target.getAttribute('data-llb-tip') || '').trim();
    if (!hasText) return;
    currentTarget = target;
    clearTimer();
    showTimer = window.setTimeout(showTip, TOOLTIP_DELAY_MS);
  };

  const onMouseOver = (event: MouseEvent) => {
    armForTarget(findTipTarget(event.target));
  };

  const onMouseOut = (event: MouseEvent) => {
    if (!currentTarget) return;
    const next = findTipTarget(event.relatedTarget);
    if (next !== currentTarget) hideTip();
  };

  const onFocusIn = (event: FocusEvent) => {
    armForTarget(findTipTarget(event.target));
  };

  const onFocusOut = () => {
    hideTip();
  };

  const onScroll = () => {
    // Cheap and jump-free: dismiss while scrolling; it re-arms on hover.
    hideTip();
  };

  const onPointerDownOrKey = (event: Event) => {
    if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Escape') return;
    hideTip();
  };

  document.addEventListener('mouseover', onMouseOver);
  document.addEventListener('mouseout', onMouseOut);
  document.addEventListener('focusin', onFocusIn);
  document.addEventListener('focusout', onFocusOut);
  document.addEventListener('scroll', onScroll, true);
  document.addEventListener('pointerdown', onPointerDownOrKey, true);
  document.addEventListener('keydown', onPointerDownOrKey, true);

  return () => {
    document.removeEventListener('mouseover', onMouseOver);
    document.removeEventListener('mouseout', onMouseOut);
    document.removeEventListener('focusin', onFocusIn);
    document.removeEventListener('focusout', onFocusOut);
    document.removeEventListener('scroll', onScroll, true);
    document.removeEventListener('pointerdown', onPointerDownOrKey, true);
    document.removeEventListener('keydown', onPointerDownOrKey, true);
    hideTip();
    if (tipEl && tipEl.parentElement) {
      tipEl.parentElement.removeChild(tipEl);
      tipEl = null;
    }
    installed = false;
  };
}
