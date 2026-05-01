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

import { spawn, spawnSync, type Subprocess } from "bun";
import { resolve } from "path";

const ROOT = resolve(import.meta.dir, "..");
const API_PORT = Number(process.env.API_PORT ?? 8002);
const WEB_PORT = 8081;
const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// 1. Kill whatever is bound to API_PORT
// ---------------------------------------------------------------------------

/**
 * Returns true when the port is currently bound (bind would fail).
 *
 * We deliberately use a real bind probe rather than a TCP connect probe —
 * a zombie listener owned by a dead process refuses connections but still
 * blocks bind(), and a connect-based test would falsely report "free".
 */
async function isPortBound(port: number): Promise<boolean> {
  try {
    const probe = Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch: () => new Response("probe"),
    });
    probe.stop(true);
    return false;
  } catch {
    return true;
  }
}

/**
 * Best-effort sweep of stale shogo-ai bun.exe processes left behind from
 * previous dev:all runs. We tree-kill anything whose CommandLine references
 * one of our dev scripts, except this process and the bundled desktop bun.
 */
async function sweepStaleShogoBunProcesses(): Promise<void> {
  if (!IS_WIN) return;
  const ps = spawn({
    cmd: [
      "powershell",
      "-NoProfile",
      "-Command",
      "Get-CimInstance Win32_Process -Filter \"Name='bun.exe'\" | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress",
    ],
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(ps.stdout).text();
  await ps.exited;

  let procs: Array<{ ProcessId: number; CommandLine?: string; ExecutablePath?: string }> = [];
  try {
    const parsed = JSON.parse(out.trim() || "[]");
    procs = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return;
  }

  const ourPid = process.pid;
  const trigger = /shogo-ai|watch-api\.ts|dev-all\.ts|apps[\\/]+api[\\/]+src[\\/]+entry\.ts/i;
  const desktopBundled = /apps[\\/]+desktop[\\/]+resources[\\/]+bun/i;

  for (const p of procs) {
    if (!p?.ProcessId || p.ProcessId === ourPid) continue;
    if (p.ExecutablePath && desktopBundled.test(p.ExecutablePath)) continue;
    if (!p.CommandLine || !trigger.test(p.CommandLine)) continue;
    spawnSync({
      cmd: ["taskkill", "/F", "/T", "/PID", String(p.ProcessId)],
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

async function killProcessOnPort(port: number) {
  if (!(await isPortBound(port))) return;

  console.log(`[dev:all] Port ${port} is occupied — clearing…`);
  try {
    if (IS_WIN) {
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
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", pid],
          stdout: "ignore",
          stderr: "ignore",
        });
      }

      // Belt-and-suspenders: kill orphaned shogo-ai bun.exe trees that may
      // still hold inherited socket handles to this port.
      await sweepStaleShogoBunProcesses();

      // Wait briefly for sockets to drain before reporting status.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (!(await isPortBound(port))) return;
        await Bun.sleep(250);
      }

      if (await isPortBound(port)) {
        console.warn(
          `[dev:all] Port ${port} is still bound by a leaked socket from a previously-killed process.\n` +
            `[dev:all] Windows will not release the bind until the kernel reaps the dead-PID's sockets.\n` +
            `[dev:all] Workarounds: 1) close any browser tab pointing at the dev URL (it keeps connections alive), 2) reboot, or 3) override API_PORT=<other> in .env.local for this session.`
        );
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
      "bun",
      "x",
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
      "bun",
      "x",
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

  // On Windows, .kill() does TerminateProcess on the immediate child only —
  // its grandchildren (the actual API/web servers) become orphans and leak
  // listening sockets. Tree-kill instead so the whole subtree dies together.
  const cleanup = () => {
    if (IS_WIN && typeof proc.pid === "number") {
      try {
        spawnSync({
          cmd: ["taskkill", "/F", "/T", "/PID", String(proc.pid)],
          stdout: "ignore",
          stderr: "ignore",
        });
      } catch {
        proc.kill();
      }
    } else {
      proc.kill();
    }
  };
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
