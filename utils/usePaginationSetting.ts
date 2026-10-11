import { useEffect, useState } from 'react';
import { useAuth } from '@/components/AuthProvider';
import { getApiBaseUrl } from '@/utils/network';

const DEFAULT_PAGE_SIZE = 10;
const clamp = (v: number) =>
    Number.isFinite(v) ? Math.max(1, Math.min(100, Math.trunc(v))) : DEFAULT_PAGE_SIZE;

// NOTE: the API base is resolved lazily inside fetchPageSize (never captured
// at module load) because it depends on window.location. A module-time
// constant can bake in a server-side absolute URL, sending this request
// cross-host where cookies/CORS fail and every table falls back wrongly.
const PAGINATION_SETTING_KEY = 'pagination_items_per_page';

// Module-level cache so all mounted components share one fetch result.
let _cached: number | null = null;
let _inflight: Promise<number> | null = null;

async function fetchPageSize(): Promise<number> {
    try {
        const res = await fetch(
            `${getApiBaseUrl()}/settings_api.php?keys=${PAGINATION_SETTING_KEY}`,
            { credentials: 'include', cache: 'no-store' }
        );
        const data = await res.json();
        const raw = data?.data?.pagination_items_per_page;
        return clamp(Number(raw ?? DEFAULT_PAGE_SIZE));
    } catch {
        return DEFAULT_PAGE_SIZE;
    }
}

function getOrFetch(): Promise<number> {
    if (_cached !== null) return Promise.resolve(_cached);
    if (_inflight) return _inflight;
    _inflight = fetchPageSize().then((v) => {
        _cached = v;
        _inflight = null;
        return v;
    });
    return _inflight;
}

/** Invalidate the cache (call after admin saves the setting). */
export function invalidatePaginationCache() {
    _cached = null;
    _inflight = null;
}

/**
 * Returns the admin-configured items-per-page value.
 * Falls back to 10 while loading.
 */
export function usePaginationSetting(): number {
    const { status } = useAuth();
    const [pageSize, setPageSize] = useState<number>(_cached ?? DEFAULT_PAGE_SIZE);

    useEffect(() => {
        if (status !== 'authenticated') return;

        let active = true;
        void getOrFetch().then((v) => {
            if (active) setPageSize(v);
        });
        return () => { active = false; };
    }, [status]);

    return pageSize;
}
