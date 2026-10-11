import Swal, { type SweetAlertIcon, type SweetAlertOptions } from 'sweetalert2';

// Custom CSS for clock loader in SweetAlert2
const injectClockLoaderStyles = () => {
  if (typeof document === 'undefined') return;
  
  const styleId = 'swal-clock-loader-styles';
  const existing = document.getElementById(styleId);
  if (existing) existing.remove();
  
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent = `
    /* Custom clock loader animation for SweetAlert2 */
    .swal2-loading .swal2-loader {
      border-color: #1e3a8a transparent #1e3a8a transparent !important;
      border-width: 4px !important;
      width: 60px !important;
      height: 60px !important;
      animation: swal-rotate 1.2s linear infinite !important;
    }
    
    .swal2-loading .swal2-loader::before {
      content: '';
      position: absolute;
      width: 8px;
      height: 8px;
      background: #1e3a8a;
      border-radius: 50%;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
    }
    
    @keyframes swal-rotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    
    /* Enhanced loading modal styles */
    .swal-loading-modal {
      font-size: 16px !important;
    }
    
    .swal-loading-modal .swal2-title {
      color: #0f172a !important;
      font-size: 22px !important;
      font-weight: 700 !important;
      margin-bottom: 10px !important;
    }
    
    .swal-loading-modal .swal2-html-container {
      color: #475569 !important;
      font-size: 15.5px !important;
      line-height: 1.6 !important;
    }

    /* Large textarea modal for report editing */
    .swal-large-textarea-modal.swal2-popup {
      max-width: min(860px, calc(100vw - 32px)) !important;
      width: min(860px, calc(100vw - 32px)) !important;
      padding: 22px 24px 20px !important;
      max-height: calc(100vh - 48px) !important;
      overflow: hidden !important;
      box-sizing: border-box !important;
    }

    .swal-large-textarea-modal .swal2-icon {
      display: none !important;
    }

    .swal-large-textarea-modal .swal2-title {
      font-size: 17px !important;
      font-weight: 800 !important;
      color: #0f172a !important;
      margin-top: 0 !important;
      margin-bottom: 4px !important;
      padding-top: 0 !important;
    }

    .swal-large-textarea-modal .swal2-html-container {
      font-size: 13px !important;
      color: #64748b !important;
      line-height: 1.5 !important;
      margin: 8px 0 0 !important;
      padding: 0 !important;
    }

    .swal-large-textarea-modal .swal2-input-label {
      display: block !important;
      width: 100% !important;
      box-sizing: border-box !important;
      font-size: 12px !important;
      font-weight: 700 !important;
      color: #1e293b !important;
      margin: 18px 0 8px !important;
      text-align: left !important;
    }

    .swal-large-textarea-modal .swal2-textarea {
      display: block !important;
      width: 100% !important;
      max-width: 100% !important;
      min-width: 0 !important;
      margin: 0 !important;
      box-sizing: border-box !important;
      font-size: 12px !important;
      line-height: 1.6 !important;
      padding: 10px 24px 10px 14px !important;
      border: 1.5px solid #e2e8f0 !important;
      border-radius: 8px !important;
      resize: none !important;
      font-family: 'Consolas', 'Monaco', 'Courier New', monospace !important;
      color: #0f172a !important;
      white-space: pre-wrap !important;
      overflow-wrap: break-word !important;
      overflow-x: hidden !important;
      overflow-y: auto !important;
      scrollbar-gutter: stable !important;
      scrollbar-width: thin !important;
      scrollbar-color: #cbd5e1 transparent !important;
    }

    .swal-large-textarea-modal .swal2-textarea::-webkit-scrollbar {
      width: 6px !important;
    }

    .swal-large-textarea-modal .swal2-textarea::-webkit-scrollbar-track {
      background: transparent !important;
      border-radius: 999px !important;
    }

    .swal-large-textarea-modal .swal2-textarea::-webkit-scrollbar-thumb {
      background: #cbd5e1 !important;
      border-radius: 999px !important;
    }

    .swal-large-textarea-modal .swal2-textarea {
      height: clamp(240px, 48vh, 360px) !important;
      min-height: 220px !important;
      max-height: calc(100vh - 260px) !important;
    }

    .swal-large-textarea-modal .swal2-textarea:focus {
      border-color: #1e3a8a !important;
      box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.10) !important;
      outline: none !important;
    }

    .swal-large-textarea-modal .swal2-actions {
      margin-top: 16px !important;
      gap: 8px !important;
    }

    .swal-large-textarea-modal .swal2-confirm,
    .swal-large-textarea-modal .swal2-cancel {
      font-size: 13px !important;
      font-weight: 700 !important;
      padding: 9px 22px !important;
      border-radius: 8px !important;
    }

    @media (max-width: 640px) {
      .swal-large-textarea-modal.swal2-popup {
        width: calc(100vw - 24px) !important;
        max-width: calc(100vw - 24px) !important;
        padding: 18px 16px 16px !important;
      }

      .swal-large-textarea-modal .swal2-textarea {
        height: clamp(220px, 46vh, 320px) !important;
        max-height: calc(100vh - 240px) !important;
      }
    }

    /* Centered card notification with countdown */
    .swal-centered-card-notification.swal2-container {
      background: rgba(0, 0, 0, 0.4) !important;
    }

    .swal-centered-card-notification {
      position: fixed !important;
      top: 50% !important;
      left: 50% !important;
      transform: translate(-50%, -50%) !important;
      width: auto !important;
      max-width: 680px !important;
      margin: 0 !important;
      padding: 0 !important;
    }

    .swal-centered-card-notification .swal2-popup {
      padding: 28px 34px !important;
      border-radius: 12px !important;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15), 0 2px 4px rgba(0, 0, 0, 0.1) !important;
      border: 1px solid #fca5a5 !important;
      width: 100% !important;
    }

    .swal-centered-card-notification .swal2-icon {
      display: none !important;
    }

    .swal-centered-card-notification .swal2-title {
      font-size: 19px !important;
      font-weight: 700 !important;
      color: #dc2626 !important;
      margin-bottom: 10px !important;
      padding-right: 40px !important;
      text-align: left !important;
    }

    .swal-centered-card-notification .swal2-html-container {
      font-size: 15.5px !important;
      color: #475569 !important;
      line-height: 1.6 !important;
      margin: 0 !important;
      text-align: left !important;
    }

    .swal-centered-card-notification .swal2-close {
      position: absolute !important;
      top: 12px !important;
      right: 12px !important;
      width: 28px !important;
      height: 28px !important;
      font-size: 20px !important;
      color: #64748b !important;
      background: transparent !important;
      border-radius: 4px !important;
      transition: all 0.2s !important;
    }

    .swal-centered-card-notification .swal2-close:hover {
      background: #f1f5f9 !important;
      color: #1e293b !important;
    }

    .swal-countdown-timer {
      display: inline-block;
      margin-top: 10px;
      padding: 4px 10px;
      background: #fef3c7;
      color: #92400e;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
};

type ToastType = 'success' | 'info' | 'warning' | 'error';

interface ConfirmActionOptions {
  title?: string;
  text?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  icon?: SweetAlertIcon;
  danger?: boolean;
}

interface PromptActionOptions {
  title?: string;
  text?: string;
  inputLabel?: string;
  inputPlaceholder?: string;
  inputValue?: string;
  confirmButtonText?: string;
  cancelButtonText?: string;
  icon?: SweetAlertIcon;
  danger?: boolean;
  required?: boolean;
  large?: boolean; // Use large modal for editing long content
}

interface NotifyAPI {
  success: (message: string, duration?: number) => void | Promise<void>;
  info: (message: string, duration?: number) => void | Promise<void>;
  warning: (message: string, duration?: number) => void | Promise<void>;
  error: (message: string, duration?: number) => void | Promise<void>;
  auto: (message: string, duration?: number) => void | Promise<void>;
}

interface ToastAPI {
  show: (message: string, options?: { type?: ToastType; duration?: number }) => void | Promise<void>;
  success: (message: string, duration?: number) => void | Promise<void>;
  info: (message: string, duration?: number) => void | Promise<void>;
  error: (message: string, duration?: number) => void | Promise<void>;
}

declare global {
  interface Window {
    __nativeAlert?: typeof window.alert;
    __nativeFetch?: typeof window.fetch;
    __notifyInstalled?: boolean;
    __lastToastSignature?: string;
    __lastToastAt?: number;
    __lockdownState?: { enabled: boolean; reason?: string; updatedAt?: string };
    confirmAction?: (options?: ConfirmActionOptions) => Promise<boolean>;
    promptAction?: (options?: PromptActionOptions) => Promise<string | null>;
    notify?: NotifyAPI;
    toast?: ToastAPI;
  }
}

const modalDefaults = {
  background: '#ffffff',
  color: '#0f172a',
  width: 'min(600px, 94vw)',
  // Confirmation and prompt dialogs open in the middle of the screen. The
  // top-right corner is reserved for toasts (showLoadingToast / finishLoadingToast).
  position: 'center' as const,
  confirmButtonColor: '#1e3a8a',
  cancelButtonColor: '#64748b',
  buttonsStyling: true,
  customClass: {
    popup: 'swal-modern-popup',
    title: 'swal-modern-title',
    htmlContainer: 'swal-modern-html',
    confirmButton: 'swal-modern-confirm',
    cancelButton: 'swal-modern-cancel',
  },
  showClass: {
    popup: 'swal-modern-in',
  },
  hideClass: {
    popup: 'swal-modern-out',
  },
} satisfies SweetAlertOptions;

const TOAST_ICONS: Record<string, string> = {
  success: `<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7.5" cy="7.5" r="7.5" fill="#22c55e"/><path d="M4.5 7.5L6.5 9.5L10.5 5.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  error:   `<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7.5" cy="7.5" r="7.5" fill="#ef4444"/><path d="M5 5L10 10M10 5L5 10" stroke="white" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  warning: `<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7.5" cy="7.5" r="7.5" fill="#f59e0b"/><path d="M7.5 4.5V8" stroke="white" stroke-width="1.5" stroke-linecap="round"/><circle cx="7.5" cy="10.5" r="0.75" fill="white"/></svg>`,
  info:    `<svg width="22" height="22" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="7.5" cy="7.5" r="7.5" fill="#3b82f6"/><path d="M7.5 7V10.5" stroke="white" stroke-width="1.5" stroke-linecap="round"/><circle cx="7.5" cy="4.75" r="0.75" fill="white"/></svg>`,
};

const toast = Swal.mixin({
  ...modalDefaults,
  toast: true,
  position: 'top-end',
  showConfirmButton: false,
  showCloseButton: false,
  timer: 3000,
  timerProgressBar: true,
  width: 'auto',
  padding: 0,
  showClass: {
    popup: 'swal-modern-in',
  },
  hideClass: {
    popup: 'swal-modern-out',
  },
  customClass: {
    popup: 'swal-stick-toast',
    title: 'swal-stick-toast-title',
    timerProgressBar: 'swal-stick-toast-progress',
  },
  didOpen: (el) => {
    // Hide the bulky native SweetAlert2 icon
    const nativeIcon = el.querySelector('.swal2-icon') as HTMLElement | null;
    if (nativeIcon) nativeIcon.style.display = 'none';
    // Detect type from SweetAlert2's own icon class
    let type: string = 'info';
    if (el.classList.contains('swal2-icon-success')) type = 'success';
    else if (el.classList.contains('swal2-icon-error')) type = 'error';
    else if (el.classList.contains('swal2-icon-warning')) type = 'warning';
    else if (el.classList.contains('swal2-icon-info')) type = 'info';
    // Inject a clean SVG icon before the title
    const titleEl = el.querySelector('.swal-stick-toast-title') as HTMLElement | null;
    if (titleEl && !el.querySelector('.swal-toast-svg-icon')) {
      const svgHtml = TOAST_ICONS[type] ?? TOAST_ICONS.info;
      const wrapper = document.createElement('span');
      wrapper.className = 'swal-toast-svg-icon';
      wrapper.innerHTML = svgHtml;
      titleEl.parentElement?.insertBefore(wrapper, titleEl);
    }
  },
});

const SWEET_ALERT_DURATION_MS = 3000;
const SAVE_NOTIFICATION_DURATION_MS = SWEET_ALERT_DURATION_MS;
const TOAST_DEDUPE_WINDOW_MS = 700;
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOCKDOWN_EVENT_NAME = 'lockdown:active';
const LOCKDOWN_STATE_EVENT_NAME = 'lockdown:state';
const LOCKDOWN_STORAGE_KEY = 'lockdown_state';

function resolveAlertDuration(duration?: number): number {
  if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return SWEET_ALERT_DURATION_MS;
}


function isLockdownMessage(message: string): boolean {
  const text = message.toLowerCase();
  return text.includes('system lockdown mode is active');
}

function extractLockdownReason(message: string): string {
  const idx = message.toLowerCase().indexOf('reason:');
  if (idx === -1) return '';
  return message.slice(idx + 7).trim();
}

function broadcastLockdownState(state: { enabled: boolean; reason?: string; updatedAt?: string }) {
  if (typeof window === 'undefined') return;
  window.__lockdownState = { enabled: state.enabled, reason: state.reason, updatedAt: state.updatedAt };
  try {
    window.localStorage.setItem(LOCKDOWN_STORAGE_KEY, JSON.stringify(window.__lockdownState));
  } catch {
    // Ignore storage failures.
  }
  try {
    window.dispatchEvent(new CustomEvent(LOCKDOWN_STATE_EVENT_NAME, { detail: window.__lockdownState }));
  } catch {
    // Ignore event dispatch failures.
  }
}

function broadcastLockdown(message: string) {
  if (typeof window === 'undefined') return;
  const reason = extractLockdownReason(message);
  broadcastLockdownState({ enabled: true, reason });
  try {
    window.dispatchEvent(new CustomEvent(LOCKDOWN_EVENT_NAME, { detail: { reason } }));
  } catch {
    // Ignore event dispatch failures.
  }
}

function toMessage(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function detectTypeFromMessage(message: string): ToastType {
  const text = message.toLowerCase();
  if (
    /(error|fail|failed|invalid|denied|cannot|unable|forbidden|network|timeout|problem|wrong)/.test(text)
  ) {
    return 'error';
  }
  if (/(warn|warning|careful|attention|caution)/.test(text)) {
    return 'warning';
  }
  if (/(success|saved|created|updated|deleted|restored|completed|done|sent)/.test(text)) {
    return 'success';
  }
  return 'info';
}

function notifyToastDeduped(type: ToastType, message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  const text = toMessage(message).trim();
  if (!text || typeof window === 'undefined') return;
  if (isLockdownMessage(text)) {
    broadcastLockdown(text);
    return;
  }

  const signature = `${type}:${text.toLowerCase()}`;
  const now = Date.now();
  if (
    window.__lastToastSignature === signature &&
    typeof window.__lastToastAt === 'number' &&
    now - window.__lastToastAt < TOAST_DEDUPE_WINDOW_MS
  ) {
    return;
  }

  window.__lastToastSignature = signature;
  window.__lastToastAt = now;
  void notifyToast(type, text, duration);
}

function getRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.method.toUpperCase();
  return 'GET';
}

function getRequestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return '';
}

export async function notifyToast(type: ToastType, message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  if (!message) return;
  if (isLockdownMessage(message)) {
    broadcastLockdown(message);
    return;
  }
  await toast.fire({
    icon: type,
    title: message,
    timer: resolveAlertDuration(duration),
  });
}

export async function notifySuccess(message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  await notifyToast('success', message, duration);
}

export async function notifyInfo(message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  await notifyToast('info', message, duration);
}

export async function notifyWarning(message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  await notifyToast('warning', message, duration);
}

export async function notifyError(message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  if (isLockdownMessage(message)) {
    broadcastLockdown(message);
    return;
  }
  await notifyToast('error', message, duration);
}

export async function notifyAuto(message: string, duration = SAVE_NOTIFICATION_DURATION_MS) {
  await notifyToast(detectTypeFromMessage(message), message, duration);
}


export async function confirmAction(options: ConfirmActionOptions = {}): Promise<boolean> {
  const {
    title = 'Please confirm',
    text = 'Are you sure you want to continue?',
    confirmButtonText = 'Yes, continue',
    cancelButtonText = 'Cancel',
    icon = 'question',
    danger = false,
  } = options;

  const result = await Swal.fire({
    ...modalDefaults,
    icon,
    title,
    text,
    showCancelButton: true,
    reverseButtons: true,
    focusCancel: true,
    confirmButtonText,
    cancelButtonText,
    confirmButtonColor: danger ? '#dc2626' : '#1e3a8a',
    // Deliberately NO `timer` / `timerProgressBar`: a confirmation must never
    // dismiss itself, or the operator can lose the prompt while reading it and
    // the action silently does not run. It closes only when dismissed by the
    // operator — Cancel, the × button, a click outside, or Escape.
    showCloseButton: true,
    allowOutsideClick: true,
  });

  return result.isConfirmed;
}

export async function promptAction(options: PromptActionOptions = {}): Promise<string | null> {
  const {
    title = 'Enter details',
    text = '',
    inputLabel = '',
    inputPlaceholder = '',
    inputValue = '',
    confirmButtonText = 'Continue',
    cancelButtonText = 'Cancel',
    icon = 'question',
    danger = false,
    required = false,
    large = false,
  } = options;

  // Inject styles if using large modal
  if (large) {
    injectClockLoaderStyles();
  }

  const result = await Swal.fire({
    ...modalDefaults,
    icon,
    title,
    text,
    input: 'textarea',
    inputLabel,
    inputPlaceholder,
    inputValue,
    inputAutoTrim: false,
    inputAttributes: {
      'aria-label': inputLabel || title,
      rows: large ? '10' : '8',
      wrap: 'soft',
    },
    showCancelButton: true,
    reverseButtons: true,
    focusConfirm: false,
    confirmButtonText,
    cancelButtonText,
    confirmButtonColor: danger ? '#dc2626' : '#1e3a8a',
    timer: 3000,
    timerProgressBar: true,
    customClass: {
      ...modalDefaults.customClass,
      popup: large ? 'swal-modern-popup swal-large-textarea-modal' : 'swal-modern-popup',
    },
    preConfirm: (value) => {
      const normalized = typeof value === 'string' ? value : '';
      if (required && normalized.trim() === '') {
        Swal.showValidationMessage('This field is required.');
        return false;
      }
      return normalized;
    },
  });

  if (!result.isConfirmed) {
    return null;
  }

  return typeof result.value === 'string' ? result.value : '';
}

/**
 * Show a loading modal with clock loader animation
 * Use this for long-running operations like sending reports/certificates
 */
export function showLoadingModal(title: string, html: string = '') {
  injectClockLoaderStyles();
  
  let secondsElapsed = 0;
  const buildHtml = () => {
    const secondsText = `<div style="margin-top: 6px; font-size: 10px; color: #64748b; line-height: 1;">${secondsElapsed}s</div>`;
    return html ? html + secondsText : secondsText;
  };
  
  const swal = Swal.fire({
    title,
    html: buildHtml(),
    icon: 'info',
    allowOutsideClick: false,
    showConfirmButton: false,
    willOpen: () => {
      Swal.showLoading();
      const interval = window.setInterval(() => {
        secondsElapsed++;
        if (Swal.isVisible()) {
          Swal.update({ html: buildHtml() });
        } else {
          window.clearInterval(interval);
        }
      }, 1000);
      (swal as any).__interval = interval;
    },
    willClose: () => {
      const interval = (swal as any).__interval;
      if (interval) window.clearInterval(interval);
    },
    customClass: {
      popup: 'swal-loading-modal',
    },
  });
}

/** Show one upper-right toast that remains until the bulk request finishes. */
export function showLoadingToast(title: string) {
  void Swal.fire({
    toast: true,
    position: 'top-end',
    icon: 'info',
    title,
    showConfirmButton: false,
    showCloseButton: false,
    timer: undefined,
    timerProgressBar: false,
    customClass: {
      popup: 'swal-stick-toast',
      title: 'swal-stick-toast-title',
    },
    didOpen: (el) => {
      const nativeIcon = el.querySelector('.swal2-icon') as HTMLElement | null;
      if (nativeIcon) nativeIcon.style.display = 'none';

      const titleEl = el.querySelector('.swal-stick-toast-title') as HTMLElement | null;
      if (!titleEl || el.querySelector('.swal-toast-svg-icon')) return;

      const wrapper = document.createElement('span');
      wrapper.className = 'swal-toast-svg-icon';
      wrapper.setAttribute('aria-hidden', 'true');
      wrapper.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="#dbeafe" stroke-width="3"/><path d="M12 3a9 9 0 0 1 9 9" stroke="#2563eb" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 12 12" to="360 12 12" dur="0.8s" repeatCount="indefinite"/></path></svg>`;
      titleEl.parentElement?.insertBefore(wrapper, titleEl);
    },
  });
}

/** Replace the active upper-right loading toast with one timed result toast. */
export function finishLoadingToast(
  message: string,
  icon: ToastType = 'success',
  duration: number = SAVE_NOTIFICATION_DURATION_MS,
) {
  void toast.fire({
    position: 'top-end',
    icon,
    title: message,
    timer: resolveAlertDuration(duration),
    timerProgressBar: true,
  });
}

/**
 * Update loading modal content
 */
export function updateLoadingModal(html: string) {
  Swal.update({ html });
}

/**
 * Close loading modal
 */
export function closeLoadingModal() {
  Swal.close();
}

/**
 * Show a centered card notification with countdown timer and close button
 * Perfect for warnings and important messages
 */
export function showCenteredCardNotification(
  message: string,
  options: {
    title?: string;
    icon?: SweetAlertIcon;
    duration?: number;
    onClose?: () => void;
    showActionButton?: boolean;
    actionButtonText?: string;
    onActionClick?: () => void;
  } = {}
) {
  const {
    title = 'Warning',
    icon = 'warning',
    duration = 3000,
    onClose,
    showActionButton = false,
    actionButtonText = 'Take Action',
    onActionClick,
  } = options;

  injectClockLoaderStyles();

  let countdown = Math.floor(duration / 1000);
  let countdownInterval: NodeJS.Timeout | null = null;

  const updateCountdown = () => {
    const timerElement = document.querySelector('.swal-countdown-timer');
    if (timerElement) {
      timerElement.textContent = `Auto-closing in ${countdown}s`;
    }
  };

  Swal.fire({
    icon,
    title,
    html: `
      <div style="margin-bottom: 6px;">${message}</div>
      <div style="display: flex; align-items: center; gap: 10px; margin-top: 12px; flex-wrap: wrap;">
        ${showActionButton ? `
          <button 
            id="swal-action-button" 
            style="
              padding: 8px 16px;
              background: #1e3a8a;
              color: white;
              border: none;
              border-radius: 6px;
              font-size: 13px;
              font-weight: 600;
              cursor: pointer;
              transition: background 0.2s;
            "
            onmouseover="this.style.background='#1e40af'"
            onmouseout="this.style.background='#1e3a8a'"
          >
            ${actionButtonText}
          </button>
        ` : ''}
        <div class="swal-countdown-timer">Auto-closing in ${countdown}s</div>
      </div>
    `,
    timer: duration,
    timerProgressBar: true,
    showConfirmButton: false,
    showCloseButton: true,
    allowOutsideClick: true,
    customClass: {
      container: 'swal-centered-card-notification',
      popup: 'swal-centered-card-notification',
    },
    width: 'auto',
    didOpen: () => {
      // Attach click handler to action button
      if (showActionButton && onActionClick) {
        const actionButton = document.getElementById('swal-action-button');
        if (actionButton) {
          actionButton.addEventListener('click', () => {
            Swal.close();
            onActionClick();
          });
        }
      }

      countdownInterval = setInterval(() => {
        countdown--;
        if (countdown > 0) {
          updateCountdown();
        } else if (countdownInterval) {
          clearInterval(countdownInterval);
        }
      }, 1000);
    },
    willClose: () => {
      if (countdownInterval) {
        clearInterval(countdownInterval);
      }
      if (onClose) {
        onClose();
      }
    },
  });
}

export function installNotificationGlobals() {
  if (typeof window === 'undefined') return () => {};
  const win = window;

  if (win.__notifyInstalled) return () => {};
  win.__notifyInstalled = true;
  const previousAlert = win.alert.bind(win);
  const currentFetch = win.fetch.bind(win);

  // Preserve first-seen raw functions for callers that intentionally bypass wrappers.
  if (!win.__nativeAlert) {
    win.__nativeAlert = previousAlert;
  }
  if (!win.__nativeFetch) {
    win.__nativeFetch = currentFetch;
  }

  // Always execute against the preserved raw fetch to avoid wrapper recursion.
  const previousFetch = win.__nativeFetch.bind(win);

  const wrappedAlert: typeof window.alert = (message?: unknown) => {
    const text = toMessage(message);
    if (!text) return;
    notifyToastDeduped(detectTypeFromMessage(text), text, SAVE_NOTIFICATION_DURATION_MS);
  };
  win.alert = wrappedAlert;

  const wrappedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = getRequestMethod(input, init);
    const requestUrl = getRequestUrl(input);
    // Logout already toasts from the UI (Layout handleLogoutClick) — the
    // server's "Logout successful" reply would be a second duplicate popup.
    const isLogoutRequest = /action=logout/i.test(requestUrl);
    const shouldNotifyMutation =
      MUTATION_METHODS.has(method) && /\/api\//i.test(requestUrl) && !isLogoutRequest;
    // Opt-out for callers that render inline form messages instead of popups.
    const silentHeaders = init?.headers;
    const silentToast =
      (typeof silentHeaders === 'object' && silentHeaders !== null &&
        (('X-No-Toast' in silentHeaders && String((silentHeaders as Record<string, unknown>)['X-No-Toast']) === '1') ||
         (typeof (silentHeaders as Headers).get === 'function' && (silentHeaders as Headers).get('X-No-Toast') === '1') ||
         (Array.isArray(silentHeaders) && (silentHeaders as [string, string][]).some(([k, v]) => String(k).toLowerCase() === 'x-no-toast' && String(v) === '1')))) as boolean;

    try {
      const response = await previousFetch(input, init);
      if (!shouldNotifyMutation || silentToast) return response;

      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        let payload: unknown = null;
        try {
          payload = await response.clone().json();
        } catch {
          payload = null;
        }

        if (payload && typeof payload === 'object' && 'success' in payload) {
          const apiResponse = payload as { success?: unknown; message?: unknown; error?: unknown };
          const ok = Boolean(apiResponse.success);
          const rawMessage =
            apiResponse.message ??
            apiResponse.error;
          const message =
            toMessage(rawMessage) || (ok ? 'Saved successfully.' : 'Operation failed.');
          if (isLockdownMessage(message)) {
            broadcastLockdown(message);
            return response;
          }
          notifyToastDeduped(
            ok ? 'success' : 'error',
            message,
            SAVE_NOTIFICATION_DURATION_MS
          );
        } else if (!response.ok) {
          notifyToastDeduped(
            'error',
            `Request failed (${response.status})`,
            SAVE_NOTIFICATION_DURATION_MS
          );
        }
      } else if (!response.ok) {
        notifyToastDeduped(
          'error',
          `Request failed (${response.status})`,
          SAVE_NOTIFICATION_DURATION_MS
        );
      }

      return response;
    } catch (error) {
      if (shouldNotifyMutation && !silentToast) {
        notifyToastDeduped('error', 'Network error. Please try again.', SAVE_NOTIFICATION_DURATION_MS);
      }
      throw error;
    }
  }) as typeof window.fetch;
  win.fetch = wrappedFetch;

  window.confirmAction = confirmAction;
  window.promptAction = promptAction;
  window.notify = {
    success: (message: string, duration?: number) => notifySuccess(message, duration),
    info: (message: string, duration?: number) => notifyInfo(message, duration),
    warning: (message: string, duration?: number) => notifyWarning(message, duration),
    error: (message: string, duration?: number) => notifyError(message, duration),
    auto: (message: string, duration?: number) => notifyAuto(message, duration),
  };
  window.toast = {
    show: (message: string, options?: { type?: ToastType; duration?: number }) =>
      notifyToast(options?.type ?? 'success', message, options?.duration ?? SAVE_NOTIFICATION_DURATION_MS),
    success: (message: string, duration?: number) => notifySuccess(message, duration),
    info: (message: string, duration?: number) => notifyInfo(message, duration),
    error: (message: string, duration?: number) => notifyError(message, duration),
  };

  return () => {
    if (win.alert === wrappedAlert) {
      win.alert = previousAlert;
    }
    if (win.fetch === wrappedFetch) {
      win.fetch = previousFetch;
    }
    delete win.confirmAction;
    delete win.promptAction;
    delete win.notify;
    delete win.toast;
    win.__notifyInstalled = false;
  };
}
