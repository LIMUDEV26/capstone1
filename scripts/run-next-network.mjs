import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { createRequire } from "node:module";
import nextEnv from "@next/env";

const require = createRequire(import.meta.url);
const { loadEnvConfig } = nextEnv;
const nextBin = require.resolve("next/dist/bin/next");
const modeArg = String(process.argv[2] || "dev").toLowerCase();
const mode = modeArg === "start" ? "start" : "dev";
const projectDir = process.cwd();

const PRIVATE_IPV4_RANGES = [
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^20\.20\./,
];
const LINK_LOCAL_IPV4_RANGE = /^169\.254\./;

loadEnvConfig(projectDir, mode === "dev");

function listExternalIPv4() {
  const nets = networkInterfaces();
  const ips = [];

  for (const entries of Object.values(nets)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      ips.push(entry.address);
    }
  }

  return ips;
}

function pickNetworkHost() {
  const manual = String(process.env.NEXT_HOST || "").trim();
  if (manual) return manual;

  const ips = listExternalIPv4().filter((ip) => !LINK_LOCAL_IPV4_RANGE.test(ip));
  const privateIp = ips.find((ip) => PRIVATE_IPV4_RANGES.some((re) => re.test(ip)));
  return privateIp || ips[0] || "127.0.0.1";
}

function isWildcardOrigin(value) {
  return /^https?:\/\/(?:0\.0\.0\.0|::|\[::\])(?::\d+)?(?:\/|$)/i.test(value);
}

function parsePort(value, fallback = 3000) {
  const port = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return fallback;
  }
  return port;
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

    server.once("error", (error) => {
      if (error && (error.code === "EADDRINUSE" || error.code === "EACCES")) {
        cleanup(false);
        return;
      }
      cleanup(false);
    });

    server.once("listening", () => {
      cleanup(true);
    });

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

const publicHost = pickNetworkHost();
const bindHost = String(process.env.NEXT_BIND_HOST || "").trim() || "0.0.0.0";
const env = { ...process.env };
const devBundler = String(env.NEXT_DEV_BUNDLER || "webpack").trim().toLowerCase();
const requestedPort = parsePort(env.PORT || env.NEXT_PORT, 3000);
const currentBackendOrigin = String(env.NEXT_PUBLIC_BACKEND_ORIGIN || "").trim();
const currentRewriteBackendOrigin = String(env.BACKEND_ORIGIN || "").trim();

if (!currentBackendOrigin || isWildcardOrigin(currentBackendOrigin)) {
  env.NEXT_PUBLIC_BACKEND_ORIGIN = `http://${publicHost}`;
}

// Keep browser clients pointed at the visible host, but make the dev rewrite
// target the local XAMPP/Apache instance by default so tunnels stay reliable.
if (!currentRewriteBackendOrigin || isWildcardOrigin(currentRewriteBackendOrigin)) {
  env.BACKEND_ORIGIN = "http://127.0.0.1";
}

const selectedPort = await pickAvailablePort(requestedPort, bindHost);
env.PORT = String(selectedPort);

console.log(`[next-network] Host: ${publicHost}`);
console.log(`[next-network] Bind host: ${bindHost}`);
console.log(`[next-network] Port: ${selectedPort}`);
if (mode === "dev") {
  console.log(`[next-network] Dev bundler: ${devBundler === "webpack" ? "webpack" : "turbopack"}`);
}
if (selectedPort !== requestedPort) {
  console.log(
    `[next-network] Port ${requestedPort} is busy, using ${selectedPort} instead.`
  );
}
console.log(`[next-network] Public backend origin: ${env.NEXT_PUBLIC_BACKEND_ORIGIN}`);
console.log(`[next-network] Rewrite backend origin: ${env.BACKEND_ORIGIN}`);

const args = [nextBin, mode, "-H", bindHost, "-p", String(selectedPort)];
if (mode === "dev" && devBundler === "webpack") {
  args.push("--webpack");
}
const child = spawn(process.execPath, args, {
  env,
  stdio: ["inherit", "pipe", "pipe"],
});

function replaceBindHostLine(value) {
  return value.replace(
    /https?:\/\/(?:0\.0\.0\.0|\[::\]|::)(:\d+)?/gi,
    (_match, port = "") => `http://${publicHost}${port}`
  );
}

function pipeWithReplacement(stream, target) {
  let buffer = "";
  stream.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      target.write(`${replaceBindHostLine(line)}\n`);
    }
  });
  stream.on("end", () => {
    if (buffer) target.write(replaceBindHostLine(buffer));
  });
}

pipeWithReplacement(child.stdout, process.stdout);
pipeWithReplacement(child.stderr, process.stderr);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
