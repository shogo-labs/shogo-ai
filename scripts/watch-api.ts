/**
 * Custom file watcher for the API server.
 *
 * Uses chokidar instead of raw fs.watch for reliable file-watching on Windows.
 * chokidar deduplicates events, waits for writes to finish, and avoids the
 * phantom-change storms that plague fs.watch({ recursive: true }) on NTFS.
 *
 * Only watches apps/api/src and packages/ — ignores workspaces/, node_modules/, etc.
 */

import { spawn, type Subprocess } from "bun";
import chokidar from "chokidar";
import { resolve, relative, sep } from "path";
import { createConnection } from "net";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "apps/api/src/entry.ts");
const API_PORT = Number(process.env.API_PORT ?? 8002);

const WATCH_DIRS = [
  resolve(ROOT, "apps/api/src"),
  resolve(ROOT, "packages"),
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

function isPortFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const socket = createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      res(false);
    });
    socket.once("error", () => {
      res(true);
    });
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
      oldChild.kill();

      const killTimeout = setTimeout(() => {
        console.log(`[watch-api] Graceful exit timed out — sending SIGKILL`);
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

    child = spawn({
      cmd: ["bun", "run", ENTRY],
      stdout: "inherit",
      stderr: "inherit",
      stdin: "inherit",
      env: { ...process.env, PREWARM_CLAUDE_CODE: "false" },
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

function cleanup() {
  watcher.close();
  child?.kill();
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
