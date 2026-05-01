/**
 * Custom file watcher for the API server.
 *
 * Uses chokidar instead of raw fs.watch for reliable file-watching on Windows.
 * chokidar deduplicates events, waits for writes to finish, and avoids the
 * phantom-change storms that plague fs.watch({ recursive: true }) on NTFS.
 *
 * Only watches apps/api/src and packages/ — ignores workspaces/, node_modules/, etc.
 */

import { spawn, spawnSync, type Subprocess } from "bun";
import chokidar from "chokidar";
import { resolve, relative, sep } from "path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "apps/api/src/entry.ts");
const API_PORT = Number(process.env.API_PORT ?? 8002);
const IS_WIN = process.platform === "win32";

const WATCH_DIRS = [
  resolve(ROOT, "apps/api/src"),
  resolve(ROOT, "packages/agent-runtime/src"),
  resolve(ROOT, "packages/model-catalog/src"),
  resolve(ROOT, "packages/sdk/src"),
  resolve(ROOT, "packages/shared-runtime/src"),
];

const DEBOUNCE_MS = 800;
const KILL_TIMEOUT_MS = 5_000;
const PORT_WAIT_MS = 10_000;
const PORT_POLL_INTERVAL_MS = 300;

let child: Subprocess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let waitingForChange = false;
let restarting = false;
let restartQueued = false;

/**
 * Returns true when the port is free for binding.
 *
 * We use a bind probe rather than a TCP connect probe — a zombie listener
 * owned by a dead process refuses connections but still blocks bind(), and
 * a connect-based test would falsely report "free" and then the spawned
 * server would crash with EADDRINUSE.
 */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    try {
      const probe = Bun.serve({
        port,
        hostname: "0.0.0.0",
        fetch: () => new Response("probe"),
      });
      probe.stop(true);
      res(true);
    } catch {
      res(false);
    }
  });
}

async function waitForPortRelease(port: number): Promise<boolean> {
  const deadline = Date.now() + PORT_WAIT_MS;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true;
    await new Promise((r) => setTimeout(r, PORT_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * Cross-platform tree-kill for a child process.
 *
 * On Windows, `Subprocess.kill()` translates to `TerminateProcess`, which
 * does NOT cascade to descendants — any grandchildren become orphans and
 * can leak listening sockets. `taskkill /F /T` walks the process tree.
 */
function treeKill(proc: Subprocess): void {
  if (IS_WIN && typeof proc.pid === "number") {
    try {
      spawnSync({
        cmd: ["taskkill", "/F", "/T", "/PID", String(proc.pid)],
        stdout: "ignore",
        stderr: "ignore",
      });
      return;
    } catch {
      // fall through
    }
  }
  try {
    proc.kill();
  } catch {
    // already dead
  }
}

async function startServer() {
  if (restarting) {
    restartQueued = true;
    return;
  }
  restarting = true;
  restartQueued = false;

  try {
    if (child) {
      const oldChild = child;
      child = null;
      treeKill(oldChild);

      const killTimeout = setTimeout(() => {
        console.log(`[watch-api] Graceful exit timed out — forcing kill`);
        try { oldChild.kill(9); } catch {}
      }, KILL_TIMEOUT_MS);

      await oldChild.exited;
      clearTimeout(killTimeout);
    }

    const portFree = await waitForPortRelease(API_PORT);
    if (!portFree) {
      console.log(`[watch-api] Port ${API_PORT} still in use after ${PORT_WAIT_MS / 1000}s — waiting for file change to retry...`);
      waitingForChange = true;
      return;
    }

    waitingForChange = false;
    const gen = ++generation;

    const envFile = resolve(ROOT, ".env.local");
    child = spawn({
      cmd: ["bun", `--env-file=${envFile}`, "run", ENTRY],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: { ...process.env },
    });

    child.exited.then((code) => {
      if (gen !== generation) return;
      if (code !== 0) {
        console.log(`[watch-api] Server exited with code ${code} — waiting for file change to restart...`);
        waitingForChange = true;
      }
    });
  } finally {
    restarting = false;
    if (restartQueued) {
      restartQueued = false;
      startServer();
    }
  }
}

function scheduleRestart(filePath: string) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const rel = relative(ROOT, filePath);
    console.log(`[watch-api] Change detected: ${rel} — restarting...`);
    startServer();
  }, DEBOUNCE_MS);
}

const watcher = chokidar.watch(WATCH_DIRS, {
  ignored: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/generated/**",
    "**/workspaces/**",
    "**/eval-outputs/**",
    "**/.canvas-state.json",
  ],
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 300,
    pollInterval: 100,
  },
});

watcher.on("change", (filePath) => scheduleRestart(filePath));
watcher.on("add", (filePath) => scheduleRestart(filePath));
watcher.on("unlink", (filePath) => scheduleRestart(filePath));

watcher.on("ready", () => {
  for (const dir of WATCH_DIRS) {
    console.log(`[watch-api] Watching ${relative(ROOT, dir)}${sep}`);
  }
  console.log("[watch-api] Starting API server...");
  startServer();
});

watcher.on("error", (err) => {
  console.warn(`[watch-api] Watcher error: ${err.message}`);
});

let cleaningUp = false;

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  try { await watcher.close(); } catch {}
  if (child) {
    const c = child;
    child = null;
    treeKill(c);
    // Wait for the child to actually exit so its listening sockets are
    // released by the kernel before this process exits. Without this,
    // grandchild handles can leak past our exit and pin the port.
    const killTimeout = setTimeout(() => {
      try { c.kill(9); } catch {}
    }, KILL_TIMEOUT_MS);
    try { await c.exited; } catch {}
    clearTimeout(killTimeout);
  }
  process.exit(0);
}

process.on("SIGINT", () => { void cleanup(); });
process.on("SIGTERM", () => { void cleanup(); });
