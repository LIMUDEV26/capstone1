export type NotificationReadItem = {
    id?: string | number | null;
    read_key?: string | null;
    occurred_at?: string | null;
};

type NotificationReadState = Record<string, number>;

const NOTIFICATION_READ_STATE_EVENT = 'notifications:read-state-changed';
const MAX_TRACKED_NOTIFICATION_READ_ENTRIES = 500;

export function parseNotificationTimestamp(value: string | null | undefined) {
    const raw = String(value || '').trim();
    if (!raw) return 0;
    const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
    const ms = Date.parse(normalized);
    return Number.isNaN(ms) ? 0 : ms;
}

export function getNotificationReadKey(item: NotificationReadItem) {
    const readKey = String(item?.read_key || '').trim();
    if (readKey) return readKey;
    return String(item?.id || '').trim();
}

function normalizeNotificationReadState(raw: unknown): NotificationReadState {
    if (Array.isArray(raw)) {
        return raw.reduce<NotificationReadState>((nextState, value) => {
            const key = String(value || '').trim();
            if (key) {
                nextState[key] = Date.now();
            }
            return nextState;
        }, {});
    }

    if (!raw || typeof raw !== 'object') return {};

    return Object.entries(raw as Record<string, unknown>).reduce<NotificationReadState>((nextState, [key, value]) => {
        const normalizedKey = String(key || '').trim();
        const normalizedValue = Number(value);
        if (normalizedKey && Number.isFinite(normalizedValue) && normalizedValue >= 0) {
            nextState[normalizedKey] = normalizedValue;
        }
        return nextState;
    }, {});
}

function trimNotificationReadState(state: NotificationReadState) {
    const entries = Object.entries(state);
    if (entries.length <= MAX_TRACKED_NOTIFICATION_READ_ENTRIES) return state;

    return Object.fromEntries(
        entries
            .sort((left, right) => left[1] - right[1])
            .slice(entries.length - MAX_TRACKED_NOTIFICATION_READ_ENTRIES)
    );
}

function dispatchNotificationReadStateChanged(storageKey: string) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(NOTIFICATION_READ_STATE_EVENT, {
        detail: { storageKey },
    }));
}

function persistNotificationReadState(storageKey: string, nextState: NotificationReadState) {
    if (typeof window === 'undefined') return nextState;

    const trimmedState = trimNotificationReadState(nextState);

    try {
        window.localStorage.setItem(storageKey, JSON.stringify(trimmedState));
    } catch {
        return trimmedState;
    }

    dispatchNotificationReadStateChanged(storageKey);
    return trimmedState;
}

export function getNotificationReadState(storageKey: string): NotificationReadState {
    if (typeof window === 'undefined' || !storageKey) return {};

    try {
        const raw = window.localStorage.getItem(storageKey);
        if (!raw) return {};
        return normalizeNotificationReadState(JSON.parse(raw));
    } catch {
        return {};
    }
}

export function isNotificationRead(item: NotificationReadItem, readState: NotificationReadState) {
    const readKey = getNotificationReadKey(item);
    if (!readKey) return false;

    const lastReadAt = Number(readState[readKey] || 0);
    if (!Number.isFinite(lastReadAt) || lastReadAt <= 0) return false;

    return parseNotificationTimestamp(item?.occurred_at) <= lastReadAt;
}

export function countUnreadNotifications(items: NotificationReadItem[], readState: NotificationReadState) {
    return items.reduce((count, item) => (isNotificationRead(item, readState) ? count : count + 1), 0);
}

export function markNotificationsReadInStorage(storageKey: string, items: NotificationReadItem[]) {
    const nextState = {
        ...getNotificationReadState(storageKey),
    };

    items.forEach((item) => {
        const readKey = getNotificationReadKey(item);
        if (!readKey) return;

        const occurredAt = parseNotificationTimestamp(item?.occurred_at);
        const fallbackReadAt = occurredAt > 0 ? occurredAt : Date.now();
        nextState[readKey] = Math.max(Number(nextState[readKey] || 0), fallbackReadAt);
    });

    return persistNotificationReadState(storageKey, nextState);
}

export function markNotificationsUnreadInStorage(storageKey: string, items: NotificationReadItem[]) {
    const nextState = {
        ...getNotificationReadState(storageKey),
    };

    items.forEach((item) => {
        const readKey = getNotificationReadKey(item);
        if (!readKey) return;
        delete nextState[readKey];
    });

    return persistNotificationReadState(storageKey, nextState);
}

export function subscribeToNotificationReadState(storageKey: string, callback: () => void) {
    if (typeof window === 'undefined') return () => {};

    const handleStorage = (event: StorageEvent) => {
        if (event.key === storageKey) {
            callback();
        }
    };

    const handleCustomEvent = (event: Event) => {
        const detail = (event as CustomEvent<{ storageKey?: string }>).detail;
        if (detail?.storageKey === storageKey) {
            callback();
        }
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(NOTIFICATION_READ_STATE_EVENT, handleCustomEvent as EventListener);

    return () => {
        window.removeEventListener('storage', handleStorage);
        window.removeEventListener(NOTIFICATION_READ_STATE_EVENT, handleCustomEvent as EventListener);
    };
}
