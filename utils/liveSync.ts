/**
 * liveSync — real-time polling + mutation-triggered refresh system.
 *
 * Pages call `useLiveSync(fetchFn, options?)` to get background auto-refresh.
 * The fetch interceptor in _app.tsx calls `emitDataMutated()` after every
 * successful mutation (POST/PUT/PATCH/DELETE) so all mounted pages refresh
 * immediately instead of waiting for the next interval tick.
 *
 * Fade behaviour:
 *   Wrap content with the `.live-sync-fade` CSS class.  On every refresh the
 *   class `.live-sync-refreshing` is toggled briefly so the container fades
 *   out then back in over 1 second (defined in globals.css).
 */

import { useCallback, useEffect, useRef } from 'react';

/** Default background poll interval (30 s). */
const DEFAULT_INTERVAL_MS = 30_000;

/** How long the fade-out lasts before we swap data and fade back in (ms). */
const FADE_OUT_MS = 180;

/** Name of the browser custom event that signals a mutation happened. */
export const DATA_MUTATED_EVENT = 'data:mutated' as const;

/** Emit this after every successful API mutation so all pages refresh promptly. */
export function emitDataMutated(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(DATA_MUTATED_EVENT));
}

export interface UseLiveSyncOptions {
    /**
     * How often to silently re-fetch in milliseconds.
     * @default 30000
     */
    intervalMs?: number;

    /**
     * Ref to a DOM element that should receive the fade animation on refresh.
     * If provided the element gets `.live-sync-refreshing` briefly on each
     * background update.
     */
    containerRef?: React.RefObject<HTMLElement | null>;

    /**
     * Set to false to pause polling (e.g. while a modal is open).
     * @default true
     */
    enabled?: boolean;
}

/**
 * Hook that silently re-runs `fetchFn` on an interval and also whenever any
 * page triggers a mutation event.  The initial fetch is NOT done here — the
 * page is responsible for the first load.  This hook only drives background
 * refreshes.
 *
 * @param fetchFn   Async callback that re-fetches and updates state.
 * @param options   Optional configuration.
 */
export function useLiveSync(
    fetchFn: () => Promise<void> | void,
    options?: UseLiveSyncOptions,
): void {
    const {
        intervalMs = DEFAULT_INTERVAL_MS,
        containerRef,
        enabled = true,
    } = options ?? {};

    // Keep a stable ref to fetchFn so the interval/listener closure never
    // captures a stale version.
    const fetchRef = useRef(fetchFn);
    useEffect(() => {
        fetchRef.current = fetchFn;
    });

    const refresh = useCallback(async () => {
        if (containerRef?.current) {
            containerRef.current.classList.add('live-sync-refreshing');
            // Brief pause so the fade-out is visible before data swaps.
            await new Promise<void>((resolve) => setTimeout(resolve, FADE_OUT_MS));
        }

        await fetchRef.current?.();

        if (containerRef?.current) {
            // Removing the class triggers the CSS transition back to opacity 1.
            containerRef.current.classList.remove('live-sync-refreshing');
        }
    }, [containerRef]);

    // ── interval polling ────────────────────────────────────────────────────
    useEffect(() => {
        if (!enabled) return;

        const id = window.setInterval(() => {
            void refresh();
        }, intervalMs);

        return () => {
            window.clearInterval(id);
        };
    }, [enabled, intervalMs, refresh]);

    // ── mutation-triggered refresh ──────────────────────────────────────────
    useEffect(() => {
        if (!enabled) return;

        // Debounce: multiple mutations fired in quick succession (e.g. Promise.all
        // of several POST requests) should only trigger one refresh.
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const handler = () => {
            if (debounceTimer !== null) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void refresh();
            }, 400);
        };

        window.addEventListener(DATA_MUTATED_EVENT, handler);

        return () => {
            window.removeEventListener(DATA_MUTATED_EVENT, handler);
            if (debounceTimer !== null) clearTimeout(debounceTimer);
        };
    }, [enabled, refresh]);
}
