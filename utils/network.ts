const DEFAULT_BACKEND_ORIGIN = "http://localhost";
const DEFAULT_BACKEND_BASE_PATH = "/capstone1";
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);
const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^169\.254\./,
  /^20\.20\./,
];

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeConfiguredOrigin(value: string): string {
  if (!value) return "";

  try {
    const parsed = new URL(value);
    if (WILDCARD_HOSTS.has(parsed.hostname)) return "";
    return trimTrailingSlash(parsed.origin);
  } catch {
    return "";
  }
}

function normalizeBasePath(value: string): string {
  const trimmed = String(value || "").trim();
  if (!trimmed) return DEFAULT_BACKEND_BASE_PATH;
  if (trimmed === "/") return "";

  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash || DEFAULT_BACKEND_BASE_PATH;
}

function isPrivateIpv4(hostname: string): boolean {
  return PRIVATE_IPV4_RANGES.some((re) => re.test(hostname));
}

function getLocalhostBackendOrigin(hostname: string, configured: string): string {
  if (!configured) return `http://${hostname}`;

  try {
    const configuredHost = new URL(configured).hostname;
    if (isPrivateIpv4(configuredHost)) return `http://${hostname}`;
  } catch {
    return configured;
  }

  return configured;
}

export function getBackendOrigin(): string {
  const configured = normalizeConfiguredOrigin(String(process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "").trim());

  if (typeof window !== "undefined") {
    const hostname = window.location.hostname;
    const windowOrigin = `${window.location.protocol}//${hostname}`;
    if (hostname && !WILDCARD_HOSTS.has(hostname)) {
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return getLocalhostBackendOrigin(hostname, configured);
      }

      if (configured) {
        try {
          const configuredHost = new URL(configured).hostname;
          if (configuredHost === hostname) return configured;
          if (isPrivateIpv4(configuredHost)) return windowOrigin;
        } catch {
          // Fall through to configured for safety.
        }
        return configured;
      }

      return windowOrigin;
    }
  }

  if (configured) {
    return configured;
  }

  return DEFAULT_BACKEND_ORIGIN;
}

export function getBackendBaseUrl(): string {
  const configuredBasePath = normalizeBasePath(String(process.env.NEXT_PUBLIC_BACKEND_BASE_PATH || DEFAULT_BACKEND_BASE_PATH));
  if (typeof window !== "undefined") {
    const configured = normalizeConfiguredOrigin(String(process.env.NEXT_PUBLIC_BACKEND_ORIGIN || "").trim());
    if (!configured) return configuredBasePath;

    try {
      const configuredHost = new URL(configured).hostname;
      if (configuredHost === window.location.hostname || isPrivateIpv4(configuredHost)) {
        return configuredBasePath;
      }
    } catch {
      return configuredBasePath;
    }
  }
  return `${getBackendOrigin()}${configuredBasePath}`;
}

export function getApiBaseUrl(): string {
  return `${getBackendBaseUrl()}/api`;
}

/**
 * Build an authenticated URL for a file stored below the backend uploads
 * directory. Database rows historically contain both `uploads/foo.pdf` and
 * `foo.pdf`; serve-file.php expects the latter, so normalise both shapes here.
 */
export function getAuthenticatedFileUrl(value?: string | null): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return normalizeLegacyBackendUrl(raw);

  const normalised = raw
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^capstone1\/uploads\//i, "")
    .replace(/^uploads\//i, "");

  return `${getApiBaseUrl()}/serve-file.php?path=${encodeURIComponent(normalised)}`;
}

export function normalizeLegacyBackendUrl(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  const match = rawUrl.match(/^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(\/capstone1\/.*)$/i);
  if (!match) return rawUrl;

  return `${getBackendOrigin()}${match[1]}`;
}

export function resolveBackendAssetUrl(value?: string | null): string {
  if (!value) return "";
  if (/^https?:\/\//i.test(value) || value.startsWith("data:image/")) {
    return normalizeLegacyBackendUrl(value);
  }

  const backendBase = getBackendBaseUrl();

  if (value.startsWith("/capstone1/")) {
    return `${getBackendOrigin()}${value}`;
  }

  if (value.startsWith("/uploads/")) {
    return `${backendBase}${value}`;
  }

  return `${backendBase}/${value.replace(/^\/+/, "")}`;
}
