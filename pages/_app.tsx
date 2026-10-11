import "@/styles/globals.css";
import "@/styles/app-dropdown.css";
import "sweetalert2/dist/sweetalert2.min.css";
import type { AppProps } from "next/app";
import { useEffect, useLayoutEffect, useState } from "react";
import { AuthProvider } from "@/components/AuthProvider";
import { ToastProvider } from "@/components/Toast";
import { installNotificationGlobals } from "@/utils/notify";
import { installGlobalTooltips } from "@/utils/globalTooltip";
import { getApiBaseUrl, normalizeLegacyBackendUrl } from "@/utils/network";
import { emitDataMutated } from "@/utils/liveSync";

const AUTH_CACHE_TTL_MS = 120_000;
const JSON_RESPONSE_CACHE_TTL_MS = 60_000;
const API_GET_TIMEOUT_MS = 20_000;

const CACHEABLE_JSON_API_SUFFIXES = [
  "/api/branches.php",
  "/api/calendar-events.php",
  "/api/cash-advance-requests.php",
  "/api/clients.php",
  "/api/contracts.php",
  "/api/document-management.php",
  "/api/documents.php",
  "/api/edit-requests.php",
  "/api/employees.php",
  "/api/holidays.php",
  "/api/leave-requests.php",
  "/api/leave-types.php",
  "/api/notifications.php",
  "/api/overtime-requests.php",
  "/api/payroll.php",
  "/api/payroll_analytics.php",
  "/api/projects.php",
  "/api/reports.php",
  "/api/roles.php",
  "/api/services.php",
  "/api/task-workflow.php",
  "/api/tasks.php",
  "/api/users.php",
];

type AuthCacheEntry = {
  payload: unknown;
  status: number;
  timestamp: number;
};

type JsonResponseCacheEntry = {
  payload: unknown;
  status: number;
  timestamp: number;
};

let authCache: AuthCacheEntry | null = null;
let authInFlight: Promise<AuthCacheEntry | null> | null = null;
const jsonResponseCache = new Map<string, JsonResponseCacheEntry>();
const jsonResponseInFlight = new Map<string, Promise<JsonResponseCacheEntry | null>>();
let jsonResponseCacheGeneration = 0;

function clearAuthCache() {
  authCache = null;
  authInFlight = null;
}

function clearJsonResponseCache() {
  jsonResponseCache.clear();
  jsonResponseInFlight.clear();
  jsonResponseCacheGeneration += 1;
}

function buildCachedJsonResponse(entry: JsonResponseCacheEntry) {
  return new Response(JSON.stringify(entry.payload ?? null), {
    status: entry.status,
    headers: { "Content-Type": "application/json" },
  });
}

function shouldCacheJsonApiResponse(parsedUrl: URL | null, method: string, cacheMode?: string) {
  if (!parsedUrl || method !== "GET" || cacheMode === "no-store") return false;

  const pathname = parsedUrl.pathname.toLowerCase();
  if (!/\/api\/[^?#]+\.php$/i.test(pathname)) return false;
  if (pathname.endsWith("/api/auth.php") || pathname.endsWith("/api/security-control.php")) {
    return false;
  }

  if (pathname.endsWith("/api/settings_api.php")) {
    const keys = String(parsedUrl.searchParams.get("keys") || "");
    return keys
      .split(",")
      .map((key) => key.trim())
      .includes("pagination_items_per_page");
  }

  return CACHEABLE_JSON_API_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

const useClientLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export default function App({ Component, pageProps }: AppProps) {
  useClientLayoutEffect(() => {
    if (typeof window === "undefined") return;

    try {
      // Remove stale browser lockout artifacts from previous builds.
      window.localStorage.removeItem("intruder_browser_block_state");
      window.localStorage.removeItem("intruder_browser_id");
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useClientLayoutEffect(() => {
    if (typeof window !== "undefined") {
      // Self-heal stale wrapper chains left by dev hot-reload cycles.
      if (typeof window.__nativeFetch === "function") {
        window.fetch = window.__nativeFetch.bind(window);
      }
      if (typeof window.__nativeAlert === "function") {
        window.alert = window.__nativeAlert.bind(window);
      }
      window.__notifyInstalled = false;
    }

    const cleanup = installNotificationGlobals();
    return cleanup;
  }, []);

  useClientLayoutEffect(() => {
    // System-wide tooltips: 300ms delay + pointing arrow for every title.
    return installGlobalTooltips();
  }, []);

  useClientLayoutEffect(() => {
    if (typeof window === "undefined" || typeof window.fetch !== "function") return;

    const originalFetch = window.fetch.bind(window);

    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = typeof input === "string"
        ? input
        : (input instanceof URL ? input.toString() : input.url);
      // Rewrite legacy localhost API calls so LAN/public clients hit the actual server host.
      const normalizedUrl = normalizeLegacyBackendUrl(rawUrl);
      const normalizedInput: RequestInfo = input instanceof Request
        ? (normalizedUrl !== rawUrl ? new Request(normalizedUrl, input) : input)
        : normalizedUrl;

      const method = (normalizedInput instanceof Request ? normalizedInput.method : init?.method || "GET").toUpperCase();
      const cacheMode = normalizedInput instanceof Request ? normalizedInput.cache : init?.cache;
      let parsedUrl: URL | null = null;
      try {
        parsedUrl = new URL(normalizedUrl, window.location.origin);
      } catch {
        parsedUrl = null;
      }

      const isAuthEndpoint = parsedUrl ? /\/api\/auth\.php$/i.test(parsedUrl.pathname) : false;
      const isAuthSessionRequest = Boolean(
        parsedUrl
        && isAuthEndpoint
        && method === "GET"
        && !parsedUrl.searchParams.has("action")
      );
      const isLogoutRequest = Boolean(
        parsedUrl
        && isAuthEndpoint
        && method === "POST"
        && parsedUrl.searchParams.get("action") === "logout"
      );
      const shouldUseJsonResponseCache = shouldCacheJsonApiResponse(parsedUrl, method, cacheMode);
      const jsonResponseCacheKey = shouldUseJsonResponseCache && parsedUrl ? parsedUrl.toString() : "";
      // Match both legacy `/capstone1/api/*.php` URLs and the production
      // same-origin `/api/*.php` proxy. Restricting this to the legacy prefix
      // meant successful production mutations never invalidated the JSON GET
      // cache and never emitted the live-sync event.
      const isApiPhp = Boolean(
        parsedUrl && /\/api\/[^/]+\.php$/i.test(parsedUrl.pathname),
      );

      if (parsedUrl && isAuthEndpoint && parsedUrl.searchParams.has("action")) {
        clearAuthCache();
        clearJsonResponseCache();
      }

      if (parsedUrl && isApiPhp && method !== "GET") {
        clearJsonResponseCache();
      }

      const mergedHeaders = new Headers();

      if (normalizedInput instanceof Request) {
        normalizedInput.headers.forEach((value, key) => mergedHeaders.set(key, value));
      }

      const initHeaders = new Headers(init?.headers || undefined);
      initHeaders.forEach((value, key) => mergedHeaders.set(key, value));

      const hasMergedHeaders = Array.from(mergedHeaders.keys()).length > 0;
      const nextInit: RequestInit = hasMergedHeaders
        ? { ...(init || {}), headers: mergedHeaders }
        : (init || {});

      const performFetch = () => {
        const callerSignal = normalizedInput instanceof Request
          ? normalizedInput.signal
          : nextInit.signal;
        const signal = isApiPhp && method === "GET"
          ? (callerSignal
              ? AbortSignal.any([callerSignal, AbortSignal.timeout(API_GET_TIMEOUT_MS)])
              : AbortSignal.timeout(API_GET_TIMEOUT_MS))
          : callerSignal;
        const requestInit = signal ? { ...nextInit, signal } : nextInit;

        if (normalizedInput instanceof Request) {
          return originalFetch(new Request(normalizedInput, requestInit));
        }
        return originalFetch(normalizedInput, requestInit);
      };

      if (isLogoutRequest) {
        void performFetch();
        return new Response(JSON.stringify({ success: true, message: 'Logout successful' }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (isAuthSessionRequest) {
        // Forced refreshes (AuthProvider / useProtectedPage pass
        // cache: 'no-store') must always hit the network. Serving the cached
        // session here left every page rendering with a stale user (wrong or
        // empty sidebar, empty tables, redirect bounces) after login,
        // logout, role edits, or session expiry.
        if (cacheMode === 'no-store' || cacheMode === 'reload') {
          return performFetch();
        }
        const now = Date.now();
        if (authCache && now - authCache.timestamp < AUTH_CACHE_TTL_MS) {
          return new Response(JSON.stringify(authCache.payload ?? null), {
            status: authCache.status,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (!authInFlight) {
          authInFlight = (async () => {
            const res = await performFetch();
            let payload: unknown = null;
            try {
              payload = await res.clone().json();
            } catch {
              payload = null;
            }

            const entry: AuthCacheEntry = {
              payload,
              status: res.status,
              timestamp: Date.now(),
            };
            authCache = entry;
            return entry;
          })().catch(() => null).finally(() => {
            authInFlight = null;
          });
        }

        const entry = await authInFlight;
        if (entry) {
          return new Response(JSON.stringify(entry.payload ?? null), {
            status: entry.status,
            headers: { "Content-Type": "application/json" },
          });
        }
      }

      if (shouldUseJsonResponseCache && jsonResponseCacheKey) {
        const now = Date.now();
        const cachedEntry = jsonResponseCache.get(jsonResponseCacheKey);
        if (cachedEntry && now - cachedEntry.timestamp < JSON_RESPONSE_CACHE_TTL_MS) {
          return buildCachedJsonResponse(cachedEntry);
        }

        const pendingEntry = jsonResponseInFlight.get(jsonResponseCacheKey);
        if (pendingEntry) {
          const entry = await pendingEntry;
          if (entry) return buildCachedJsonResponse(entry);
        }

        const requestGeneration = jsonResponseCacheGeneration;
        const request = (async (): Promise<JsonResponseCacheEntry | null> => {
          const response = await performFetch();
          let payload: unknown;
          try {
            payload = await response.clone().json();
          } catch {
            return null;
          }

          const entry: JsonResponseCacheEntry = {
            payload,
            status: response.status,
            timestamp: Date.now(),
          };
          if (requestGeneration === jsonResponseCacheGeneration) {
            jsonResponseCache.set(jsonResponseCacheKey, entry);
          }
          return entry;
        })();
        jsonResponseInFlight.set(jsonResponseCacheKey, request);

        try {
          const entry = await request;
          if (entry) return buildCachedJsonResponse(entry);
        } finally {
          if (jsonResponseInFlight.get(jsonResponseCacheKey) === request) {
            jsonResponseInFlight.delete(jsonResponseCacheKey);
          }
        }
      }

      const res = await performFetch();

      // Emit live-sync mutation event so all mounted pages can refresh.
      const isMutationMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
      if (isApiPhp && isMutationMethod && res.status >= 200 && res.status < 300) {
        emitDataMutated();
      }

      return res;
    };

    return () => {
      window.fetch = originalFetch;
    };
  }, []);

  return (
    <ToastProvider>
      <AuthProvider>
        <Component {...pageProps} />
      </AuthProvider>
    </ToastProvider>
  );
}
