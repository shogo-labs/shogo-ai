/**
 * Cross-platform dev:all script.
 *
 * Replaces the bash-only one-liner so it works on Windows (PowerShell)
 * as well as macOS / Linux.
 *
 *  1. Kill any process occupying the API port (best-effort).
 *  2. Run Prisma migrate deploy against the local SQLite DB.
 *  3. Start the API and web dev servers via concurrently.
 */

import { spawn, type Subprocess } from "bun";
import { resolve } from "path";
import { createConnection } from "net";

const ROOT = resolve(import.meta.dir, "..");
const API_PORT = Number(process.env.API_PORT ?? 8002);
const WEB_PORT = 8081;

// ---------------------------------------------------------------------------
// 1. Kill whatever is listening on API_PORT
// ---------------------------------------------------------------------------

async function isPortInUse(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      res(true);
    });
    socket.once("error", () => res(false));
  });
}

async function killProcessOnPort(port: number) {
  if (!(await isPortInUse(port))) return;

  console.log(`[dev:all] Killing process on port ${port}…`);
  try {
    if (process.platform === "win32") {
      const netstat = spawn({
        cmd: ["netstat", "-ano"],
        stdout: "pipe",
        stderr: "ignore",
      });
      const output = await new Response(netstat.stdout).text();
      await netstat.exited;

      const pids = new Set<string>();
      for (const line of output.split("\n")) {
        if (line.includes(`:${port}`) && /LISTENING/i.test(line)) {
          const pid = line.trim().split(/\s+/).pop();
          if (pid && /^\d+$/.test(pid)) pids.add(pid);
        }
      }
      for (const pid of pids) {
        const kill = spawn({
          cmd: ["taskkill", "/F", "/PID", pid],
          stdout: "ignore",
          stderr: "ignore",
        });
        await kill.exited;
      }
    } else {
      const proc = spawn({
        cmd: ["sh", "-c", `lsof -ti:${port} | xargs kill -9 2>/dev/null`],
        stdout: "ignore",
        stderr: "ignore",
      });
      await proc.exited;
    }
  } catch {
    // Best-effort — if it fails the watcher will handle the conflict.
  }
}

// ---------------------------------------------------------------------------
// 2. Run Prisma migrations for the local SQLite database
// ---------------------------------------------------------------------------

async function migrate() {
  console.log("[dev:all] Running SQLite migrations…");
  const proc = spawn({
    cmd: [
      "bunx",
      "prisma",
      "migrate",
      "deploy",
      "--config",
      "prisma.config.local.ts",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env },
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.error("[dev:all] Migration failed — aborting.");
    process.exit(code);
  }
  console.log("[dev:all] Migrations applied.");
}

// ---------------------------------------------------------------------------
// 3. Start API + web dev servers
// ---------------------------------------------------------------------------

async function startDevServers() {
  console.log("[dev:all] Starting API and web dev servers…");
  const proc = spawn({
    cmd: [
      "bunx",
      "concurrently",
      "--kill-others",
      "-n",
      "api,web",
      "-c",
      "green,magenta",
      "bun run api:dev",
      "bun run web:dev",
    ],
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });

  const cleanup = () => proc.kill();
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  const code = await proc.exited;
  process.exit(code ?? 0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

await Promise.all([killProcessOnPort(API_PORT), killProcessOnPort(WEB_PORT)]);
await migrate();
await startDevServers();
