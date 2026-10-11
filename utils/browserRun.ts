/**
 * Browser-run tracking for "close browser = logout, close tab = stay logged in".
 *
 * The PHP session cookie already has lifetime 0 (api/config.php), so a normal
 * browser close discards it. This module covers browsers that restore sessions
 * ("continue where you left off"): every open tab heartbeats a timestamp into
 * localStorage, so a tab booting with no recent heartbeat knows the browser
 * was fully closed (a fresh run) and any live session must be a restored one.
 *
 * - Close one tab, others still open: heartbeats continue -> reopening still
 *   sees a live run -> stays logged in.
 * - Close the browser: heartbeats stop -> next launch sees a stale timestamp
 *   -> restored session is destroyed -> logged out everywhere.
 */

const BROWSER_ALIVE_KEY = 'llb_browser_alive';
const BROWSER_UNLOAD_KEY = 'llb_browser_unload';

/** How often each open tab refreshes the alive timestamp. */
export const BROWSER_ALIVE_BEAT_MS = 5000;

/**
 * Maximum age of the last sign of life (heartbeat OR clean page unload)
 * that still counts as the same browser run.
 *
 * 30s was too aggressive: in `npm run dev` the first visit to a page
 * routinely compiles for 30-90s with no tab alive to heartbeat, so hopping
 * between pages destroyed the session and every page rendered logged-out
 * (empty sidebar, empty tables, bounce to login). 5 minutes still enforces
 * "close browser = logout" for realistic attacker timelines while covering
 * dev rebuild gaps and short tab-close/reopen gaps. It remains stricter
 * than the app's own idle session timeout (30 min default).
 */
export const BROWSER_FRESH_RUN_STALE_MS = 300000;

export function readLastBrowserAliveTimestamp(): number {
    try {
        const raw = window.localStorage.getItem(BROWSER_ALIVE_KEY);
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}

/** Record that this browser run is alive right now. Safe to call often. */
export function markBrowserAlive(now: number = Date.now()): void {
    try {
        window.localStorage.setItem(BROWSER_ALIVE_KEY, String(now));
    } catch {
        /* storage unavailable (private mode) — session cookie still applies */
    }
}

function readLastBrowserUnloadTimestamp(): number {
    try {
        const raw = window.localStorage.getItem(BROWSER_UNLOAD_KEY);
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : 0;
    } catch {
        return 0;
    }
}

/**
 * Record a clean page unload (tab navigation/close). Lets the next mount
 * tell "same tab continuing after a slow load" apart from "browser was
 * gone": without this, the heartbeat alone goes stale during long dev
 * compiles and the fresh-run check fires on ordinary navigation.
 *
 * Trade-off (documented): a real browser close also writes this mark, so a
 * relaunch inside the stale window keeps a restored session. The window
 * above bounds that risk; the idle session timeout bounds it further.
 */
export function markBrowserUnloading(now: number = Date.now()): void {
    try {
        window.localStorage.setItem(BROWSER_UNLOAD_KEY, String(now));
    } catch {
        /* storage unavailable (private mode) — session cookie still applies */
    }
}

/**
 * True when no tab of this browser has heartbeated recently: this tab is
 * booting into a fresh browser run (browser was closed, or first visit ever).
 */
export function isFreshBrowserRun(now: number = Date.now()): boolean {
    // A reload can outlive the heartbeat window while the dev/production
    // server is rebuilding. It is still the same browser run and must never
    // invalidate an otherwise valid session.
    try {
        const navigation = window.performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
        if (navigation?.type === 'reload') return false;
    } catch {
        // Fall back to the heartbeat when navigation timing is unavailable.
    }

    // Same-tab continuity: a clean unload followed by a mount inside the
    // window is a navigation (possibly a slow dev compile), not a restart.
    const lastSignOfLife = Math.max(
        readLastBrowserAliveTimestamp(),
        readLastBrowserUnloadTimestamp(),
    );
    return now - lastSignOfLife > BROWSER_FRESH_RUN_STALE_MS;
}
