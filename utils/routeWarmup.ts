import type { NextRouter } from 'next/router';
import { getApiBaseUrl } from '@/utils/network';

const WARMED_ROUTES = new Set<string>();
const WARMED_DATA_ROUTES = new Map<string, number>();
let lastWarmAt = 0;

const ROUTE_WARMUP_COOLDOWN_MS = 120;
const ROUTE_DATA_WARM_TTL_MS = 45_000;
const MAX_BATCH_PREFETCHES = 32;
const IS_STATIC_EXPORT = process.env.NEXT_PUBLIC_STATIC_EXPORT === '1';

function canWarmRoute(routePath: string) {
    if (!routePath || WARMED_ROUTES.has(routePath)) return false;

    WARMED_ROUTES.add(routePath);
    return true;
}

export function warmRoute(router: Pick<NextRouter, 'prefetch'>, routePath: string) {
    // Apache serves the Railway static export. Pages without getStaticProps do
    // not have /_next/data JSON files in that export, so Next's route prefetch
    // returns 404 and may try to hard-navigate to the page we're already on.
    if (IS_STATIC_EXPORT) return;
    if (!canWarmRoute(routePath)) return;

    router.prefetch(routePath).catch(() => {});
}

function getRouteDataUrls(routePath: string): string[] {
    const api = getApiBaseUrl();
    const year = new Date().getFullYear();
    const routes: Record<string, string[]> = {
        '/my-tasks': [
            `${api}/task-workflow.php?action=my_tasks`,
            `${api}/tasks.php?include_collaborations=1`,
        ],
        '/leave-requests': [
            `${api}/leave-requests.php`,
            `${api}/leave-types.php`,
            `${api}/employees.php?status=active`,
            `${api}/leave-requests.php?balances=1&year=${year}`,
        ],
        '/my-payslips': [
            `${api}/payroll.php?released_only=1&include_archived=1&my_payslip_scope=active`,
        ],
        '/clients': [
            `${api}/clients.php`,
            `${api}/services.php?checklists=1`,
            `${api}/users.php?role=manager&status=active`,
        ],
        '/services': [
            `${api}/services.php?checklists=1&with_archived_checklists=1`,
        ],
        '/contracts': [
            `${api}/contracts.php`,
            `${api}/contracts.php?archived=1`,
            `${api}/clients.php`,
            `${api}/users.php?role=manager&status=active`,
        ],
        '/documents': [
            `${api}/documents.php?action=list_received&search=`,
            `${api}/clients.php`,
            `${api}/employees.php`,
            `${api}/document-management.php?`,
            `${api}/contracts.php`,
        ],
        '/users': [`${api}/users.php`, `${api}/branches.php`],
        '/branches': [`${api}/branches.php`],
        '/projects': [
            `${api}/projects.php`,
            `${api}/clients.php`,
            `${api}/services.php?checklists=1`,
            `${api}/users.php?role=manager`,
        ],
        '/payroll-management': [
            `${api}/payroll.php?include_archived=1&`,
            `${api}/employees.php`,
            `${api}/branches.php?status=active`,
            `${api}/payroll_analytics.php`,
        ],
        '/overtime-requests': [
            `${api}/overtime-requests.php?archived=0`,
            `${api}/employees.php?status=active`,
        ],
        '/cash-advance': [
            `${api}/cash-advance-requests.php?archived=0`,
            `${api}/employees.php`,
        ],
        '/edit-requests': [`${api}/edit-requests.php`],
        '/reports': [`${api}/reports.php?action=list`],
    };

    return routes[routePath] || [];
}

/**
 * Begin loading the destination's initial API data before navigation. The
 * app-level fetch cache shares these in-flight requests with the page, so a
 * quick click does not start a duplicate request or wait on a blank loader.
 */
export function warmRouteData(routePath: string) {
    if (typeof window === 'undefined' || !routePath) return;

    const now = Date.now();
    const lastWarmedAt = WARMED_DATA_ROUTES.get(routePath) || 0;
    if (now - lastWarmedAt < ROUTE_DATA_WARM_TTL_MS) return;

    const urls = getRouteDataUrls(routePath);
    if (urls.length === 0) return;
    WARMED_DATA_ROUTES.set(routePath, now);

    for (const url of urls) {
        void fetch(url, { credentials: 'include' }).catch(() => undefined);
    }
}

export function warmRoutes(router: Pick<NextRouter, 'prefetch'>, routePaths: string[]) {
    if (IS_STATIC_EXPORT) return;
    const now = Date.now();
    if (now - lastWarmAt < ROUTE_WARMUP_COOLDOWN_MS) return;
    lastWarmAt = now;

    let warmedCount = 0;
    for (const path of routePaths) {
        if (!canWarmRoute(path)) continue;

        router.prefetch(path).catch(() => {});
        warmedCount += 1;

        if (warmedCount >= MAX_BATCH_PREFETCHES) break;
    }
}
