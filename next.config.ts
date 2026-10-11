import type { NextConfig } from "next";
import { networkInterfaces } from "node:os";

const devWatchIgnored = [
  "**/.git/**",
  "**/.next/**",
  "**/node_modules/**",
  "**/vendor/**",
  "**/mcp-servers/**",
  "**/backups/**",
  "**/uploads/**",
  "**/out/**",
  "**/HTML/**",
  "**/temp_capstone1.5/**",
];

function normalizeBackendOrigin(value: string | undefined) {
  const raw = String(value || "").trim();
  if (!raw) return "http://127.0.0.1";

  try {
    const parsed = new URL(raw);
    return parsed.origin;
  } catch {
    return "http://127.0.0.1";
  }
}

/**
 * Origins the browser may talk to when Node serves the app (`next dev` /
 * `next start`). Phase 1.3 replaced `connect-src *` / `frame-src *` with a real
 * list; these must be computed because the backend host varies per machine.
 *
 * In dev the frontend runs on :3000 while Apache serves the PHP API on :80, so
 * asset URLs resolved by utils/network.ts can legitimately be cross-origin.
 */
function getBackendCspOrigins(): string[] {
  const candidates = [
    process.env.BACKEND_ORIGIN,
    process.env.NEXT_PUBLIC_BACKEND_ORIGIN,
    // Browser access to the local PHP server is needed during development,
    // but must never be advertised by the production policy.
    ...(process.env.NODE_ENV === "production"
      ? []
      : ["http://localhost", "http://127.0.0.1"]),
  ];

  const origins = new Set<string>();
  for (const candidate of candidates) {
    const raw = String(candidate || "").trim();
    if (!raw) continue;
    try {
      origins.add(new URL(raw).origin);
    } catch {
      // Ignore malformed values rather than emitting a broken CSP.
    }
  }

  return [...origins];
}

const backendCspOrigins = getBackendCspOrigins();
const backendBasePath = (() => {
  const raw = String(process.env.NEXT_PUBLIC_BACKEND_BASE_PATH || "/capstone1").trim();
  if (!raw || raw === "/") return "/capstone1";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
})();

// Dev origins that may serve the Next.js dev UI (localhost + LAN IPs).
// The old list hardcoded a single stale LAN IP, so after a network change the
// dev server replied "Blocked request" and `npm run dev` looked broken.
function getAllowedDevOrigins(): string[] {
  const origins = new Set<string>(["localhost", "127.0.0.1", "::1", "20.20.18.119"]);

  for (const extra of String(process.env.ALLOWED_DEV_ORIGINS || "").split(",")) {
    const host = extra.trim();
    if (host) origins.add(host);
  }

  const manualHost = String(process.env.NEXT_HOST || "").trim();
  if (manualHost) origins.add(manualHost);

  try {
    for (const entries of Object.values(networkInterfaces())) {
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.internal) continue;
        if (entry.family === "IPv4" && entry.address && !entry.address.startsWith("169.254.")) {
          origins.add(entry.address);
        }
      }
    }
  } catch {
    // Fall back to the static list above.
  }

  return [...origins];
}

const allowedDevOrigins = getAllowedDevOrigins();

const baseSecurityHeaders = [
  // Prevent clickjacking by disallowing this site from being embedded in iframes.
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  // Prevent MIME-type sniffing.
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Restrict referrer information sent to third parties.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Restrict browser feature access.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Content Security Policy — kept in sync with the Apache-served policy in
  // .htaccess (Phase 1.3). Differences are deliberate: this variant also allows
  // the cross-origin PHP backend, because in dev the frontend is on :3000 while
  // Apache serves the API on :80.
  //
  // Next.js emits inline hydration data, so static builds still require
  // 'unsafe-inline'. `eval` is only required by the development toolchain and
  // is deliberately excluded from the production policy.
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"} https://js.hcaptcha.com https://*.hcaptcha.com`,
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' data: https://fonts.gstatic.com",
      // blob: covers <iframe src={URL.createObjectURL(...)} /> PDF previews.
      `img-src 'self' data: blob: ${backendCspOrigins.join(" ")}`,
      "media-src 'self'",
      `connect-src 'self' ${backendCspOrigins.join(" ")} https://api.hcaptcha.com https://*.hcaptcha.com https://nominatim.openstreetmap.org`,
      `frame-src 'self' blob: ${backendCspOrigins.join(" ")} https://hcaptcha.com https://*.hcaptcha.com https://www.openstreetmap.org`,
      "worker-src 'self' blob:",
      // 'self' rather than 'none' so the browser's built-in PDF viewer keeps
      // working in the document preview modal.
      "object-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join("; "),
  },
];

// HSTS must only go out over real HTTPS in production. Sending it from
// `next dev` on plain http://localhost teaches the browser to force-https
// localhost afterwards, which then looks like localhost:3000 is "blocked".
const securityHeaders = [
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
  ...baseSecurityHeaders,
];

const nextConfig: NextConfig = {
  // Keep static exports portable, but let Next resize/compress oversized source
  // images for the normal server and Vercel deployments.
  images: { unoptimized: process.env.DEPLOY_STATIC === "1" },
  reactCompiler: true,
  reactStrictMode: true,
  turbopack: {},
  experimental: {
    // lucide-react ships as a giant barrel: without this, webpack evaluates
    // the whole icon library while compiling each page that imports it, so
    // the first dev visit to icon-heavy pages (leave-requests, cash-advance)
    // took ~60s and looked like "data not loading".
    optimizePackageImports: ['lucide-react'],
  },
  ...(process.env.DEPLOY_STATIC === "1"
    ? { output: "export", trailingSlash: true }
    : {}),
  allowedDevOrigins,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
  async rewrites() {
    // Vercel routes these paths to the bundled PHP function in vercel.json.
    // Static Apache deployments serve the PHP API on the same origin and use
    // Apache's .htaccess routing, so Next.js rewrites are unnecessary there.
    if (process.env.VERCEL === "1" || process.env.DEPLOY_STATIC === "1") return [];

    const backendOrigin = normalizeBackendOrigin(process.env.BACKEND_ORIGIN);

    return [
      {
        source: "/api/:path*",
        destination: `${backendOrigin}/capstone1/api/:path*`,
      },
      {
        source: `${backendBasePath}/api/:path*`,
        destination: `${backendOrigin}${backendBasePath}/api/:path*`,
      },
      // Upload files are served through the authenticated PHP proxy.
      // Direct access to /capstone1/uploads/ is blocked by uploads/.htaccess.
      {
        source: `${backendBasePath}/uploads/:path*`,
        destination: `${backendOrigin}${backendBasePath}/api/serve-file.php?path=:path*`,
      },
    ];
  },
  onDemandEntries: {
    // Keep pages warm in memory longer to avoid re-compilation on navigation.
    maxInactiveAge: 25 * 60_000,
    pagesBufferLength: 10,
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...(config.watchOptions || {}),
        ignored: devWatchIgnored,
      };
      // Reduce in-memory cache size during dev to prevent memory exhaustion
      if (config.cache && typeof config.cache === 'object' && config.cache.type === 'filesystem') {
        config.cache.maxMemoryGenerations = 2;
      }
    }
    return config;
  },
};

export default nextConfig;
