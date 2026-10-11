import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectDir = join(__dirname, "..");
const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const electronBin = require("electron");
const NGROK_PATH = String(
  process.env.NGROK_PATH || "C:\\Users\\spencer\\AppData\\Local\\ngrok\\ngrok.exe"
).trim();
const NGROK_DOMAIN = String(process.env.NGROK_DOMAIN || "").trim();
// --no-tunnel (or NGROK_ENABLED=0) starts the app without the public tunnel,
// e.g. `npm run start:no-tunnel`. Default keeps the previous behavior.
const CLI_ARGS = new Set(process.argv.slice(2).map((a) => String(a).toLowerCase()));
const TUNNEL_DISABLED = CLI_ARGS.has("--no-tunnel")
  || CLI_ARGS.has("--tunnel=false")
  || String(process.env.NGROK_ENABLED || "").trim().toLowerCase() === "0";
const DESKTOP_DISABLED = CLI_ARGS.has("--no-desktop")
  || String(process.env.DESKTOP_ENABLED || "").trim().toLowerCase() === "0";
const NEXT_MODE = String(process.env.NEXT_START_MODE || "start").trim().toLowerCase() === "dev"
  ? "dev"
  : "start";

function parsePort(value, fallback = 3000) {
  const port = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }
  return port;
}

async function detectRunningNextServer(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "HEAD",
      signal: AbortSignal.timeout(2500),
    });
    return String(response.headers.get("x-powered-by") || "").toLowerCase() === "next.js";
  } catch {
    return false;
  }
}

async function waitForHttpServer(port, timeoutMs = 120_000) {
  const startedAt = Date.now();
  const url = `http://127.0.0.1:${port}/`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(2500),
      });
      if (response.status < 500) return;
    } catch {
      // Next is still starting. Retry until the timeout expires.
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Next did not become ready at ${url} within ${timeoutMs / 1000} seconds.`);
}

async function findLocalNgrokUrl(port) {
  for (let inspectorPort = 4040; inspectorPort <= 4049; inspectorPort += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${inspectorPort}/api/tunnels`, {
        signal: AbortSignal.timeout(500),
      });
      if (!response.ok) continue;
      const payload = await response.json();
      const tunnel = (Array.isArray(payload?.tunnels) ? payload.tunnels : []).find((item) => {
        const address = String(item?.config?.addr || "");
        return address.endsWith(`:${port}`);
      });
      if (tunnel?.public_url) return String(tunnel.public_url);
    } catch {
      // Try the next local ngrok inspector port.
    }
  }
  return "";
}

function canListenOnPort(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    const cleanup = (available) => {
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(available));
        return;
      }
      resolve(available);
    };

    server.once("error", () => cleanup(false));
    server.once("listening", () => cleanup(true));
    server.listen(port, host);
  });
}

async function pickAvailablePort(startPort, host, maxAttempts = 20) {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const port = startPort + offset;
    if (port > 65535) break;
    if (await canListenOnPort(port, host)) {
      return port;
    }
  }

  throw new Error(`Unable to find an open port starting from ${startPort}.`);
}

function launch(command, args, label, env = process.env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    cwd: projectDir,
    env,
    windowsHide: false,
    shell: false,
  });

  child.on("error", (error) => {
    console.error(`[start-with-ngrok] Failed to launch ${label}: ${error.message}`);
  });

  return child;
}

function hasProductionBuild() {
  return existsSync(join(projectDir, ".next", "BUILD_ID"));
}

async function runBuildIfNeeded() {
  if (NEXT_MODE !== "start" || hasProductionBuild()) return;

  console.log("[start-with-ngrok] No production build found. Building once before start...");
  const build = launch(process.execPath, [nextBin, "build", "--webpack"], "next build");
  const code = await new Promise((resolve) => {
    build.on("exit", (exitCode) => resolve(exitCode ?? 0));
  });

  if (code !== 0) {
    console.error(`[start-with-ngrok] Build failed with code ${code}.`);
    process.exit(code);
  }
}

if (!existsSync(NGROK_PATH) && !TUNNEL_DISABLED) {
  console.warn(`[start-with-ngrok] Ngrok not found at: ${NGROK_PATH}`);
  console.warn("[start-with-ngrok] Starting the app without the tunnel.");
}

if (TUNNEL_DISABLED) {
  console.log("[start-with-ngrok] Tunnel disabled (--no-tunnel / NGROK_ENABLED=0). Local network only.");
}

function isNgrokProcessRunning() {
  if (process.platform !== "win32") return false;

  try {
    const output = execFileSync(
      "tasklist.exe",
      ["/FI", "IMAGENAME eq ngrok.exe", "/NH"],
      { encoding: "utf8", windowsHide: true }
    );
    return /\bngrok\.exe\b/i.test(output);
  } catch {
    return false;
  }
}

if (DESKTOP_DISABLED) {
  console.log("[start-with-ngrok] Desktop launch disabled (--no-desktop / DESKTOP_ENABLED=0).");
}

const bindHost = String(process.env.NEXT_BIND_HOST || "").trim() || "0.0.0.0";
const requestedPort = parsePort(process.env.PORT || process.env.NEXT_PORT, 3000);

const nextAlreadyRunning = await detectRunningNextServer(requestedPort);
if (!nextAlreadyRunning) {
  await runBuildIfNeeded();
}

const selectedPort = nextAlreadyRunning
  ? requestedPort
  : await pickAvailablePort(requestedPort, bindHost);
const childEnv = {
  ...process.env,
  PORT: String(selectedPort),
  NEXT_PORT: String(selectedPort),
};

const ngrokArgs = NGROK_DOMAIN
  ? ["http", String(selectedPort), "--url=" + NGROK_DOMAIN]
  : ["http", String(selectedPort)];
const existingTunnelUrl = !TUNNEL_DISABLED
  ? await findLocalNgrokUrl(selectedPort)
  : "";
const ngrokAlreadyRunning = !TUNNEL_DISABLED && !existingTunnelUrl && isNgrokProcessRunning();
const ngrok = (!TUNNEL_DISABLED && !existingTunnelUrl && !ngrokAlreadyRunning && existsSync(NGROK_PATH))
  ? launch(NGROK_PATH, ngrokArgs, "ngrok", childEnv)
  : null;

const nextScript = join(__dirname, "run-next-network.mjs");
const next = nextAlreadyRunning
  ? null
  : launch(process.execPath, [nextScript, NEXT_MODE], `next ${NEXT_MODE}`, childEnv);

if (nextAlreadyRunning) {
  console.log(`[start-with-ngrok] App is already running on http://localhost:${selectedPort}.`);
}
if (existingTunnelUrl) {
  console.log(`[start-with-ngrok] Existing tunnel: ${existingTunnelUrl}`);
}
if (ngrokAlreadyRunning) {
  console.log("[start-with-ngrok] Ngrok is already running; keeping the existing process instead of starting a conflicting duplicate.");
}

let shuttingDown = false;
let desktop = null;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (desktop && !desktop.killed) desktop.kill(signal);
  if (ngrok && !ngrok.killed) ngrok.kill(signal);
  if (next && !next.killed) next.kill(signal);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

ngrok?.on("exit", (code) => {
  if (shuttingDown) return;
  console.error(`[start-with-ngrok] Ngrok exited with code ${code}. The app will continue locally.`);
});

next?.on("exit", (code, signal) => {
  if (shuttingDown) return;
  if (desktop && !desktop.killed) desktop.kill();
  if (ngrok && !ngrok.killed) ngrok.kill();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

if (TUNNEL_DISABLED || (!ngrok && !existingTunnelUrl && !ngrokAlreadyRunning)) {
  if (!existingTunnelUrl && !ngrokAlreadyRunning) {
    console.log(`[start-with-ngrok] Serving locally on port ${selectedPort} (no public tunnel).`);
  }
} else {
  if (ngrok) {
    console.log(`[start-with-ngrok] Tunneling port ${selectedPort} via ngrok${NGROK_DOMAIN ? ` (${NGROK_DOMAIN})` : "."}`);
  } else if (ngrokAlreadyRunning) {
    console.log(`[start-with-ngrok] Existing ngrok process retained; verify that it targets port ${selectedPort} if public access is required.`);
  }
}
console.log(`[start-with-ngrok] Next mode: ${NEXT_MODE}`);

try {
  await waitForHttpServer(selectedPort);
  console.log(`[start-with-ngrok] App ready: http://localhost:${selectedPort}`);

  if (!DESKTOP_DISABLED) {
    const desktopEnv = {
      ...childEnv,
      CAPSTONE_DESKTOP_START_URL: `http://localhost:${selectedPort}`,
    };
    // Some automation hosts set this to make Electron behave like plain Node.
    // The desktop child must always run in normal Electron mode.
    delete desktopEnv.ELECTRON_RUN_AS_NODE;
    desktop = launch(electronBin, [projectDir], "Electron desktop", desktopEnv);
    desktop.on("exit", (code) => {
      if (!shuttingDown) {
        console.log(`[start-with-ngrok] Desktop exited with code ${code ?? 0}. Web app and tunnel remain active.`);
      }
    });
    console.log("[start-with-ngrok] Desktop app launched.");
  }
} catch (error) {
  console.error(`[start-with-ngrok] ${error.message}`);
  shutdown("SIGTERM");
}
