/**
 * Custom file watcher for the API server.
 *
 * Replaces `bun --watch` to avoid the EBUSY / integer-overflow crash on Windows
 * caused by heavy filesystem activity in the workspaces/ directory.
 *
 * Only watches apps/api/src and packages/ — ignores workspaces/, node_modules/, etc.
 */

import { spawn, type Subprocess } from "bun";
import { watch, type FSWatcher } from "fs";
import { resolve, relative, sep } from "path";

const ROOT = resolve(import.meta.dir, "..");
const ENTRY = resolve(ROOT, "apps/api/src/entry.ts");

const WATCH_DIRS = [
  resolve(ROOT, "apps/api/src"),
  resolve(ROOT, "packages"),
];

const IGNORE = ["node_modules", ".git", "dist", "build", "generated", "workspaces", ".canvas-state.json"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);

let child: Subprocess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let generation = 0;
let waitingForChange = false;
let restarting = false;
let restartQueued = false;
const DEBOUNCE_MS = 300;
const KILL_TIMEOUT_MS = 5_000;

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

function shouldIgnore(filename: string | null): boolean {
  if (!filename) return true;
  if (IGNORE.some((dir) => filename.includes(dir))) return true;
  const ext = filename.slice(filename.lastIndexOf("."));
  return !EXTENSIONS.has(ext);
}

function scheduleRestart(file: string) {
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => {
    const rel = relative(ROOT, file);
    console.log(`[watch-api] Change detected: ${rel} — restarting...`);
    startServer();
  }, DEBOUNCE_MS);
}

const watchers: FSWatcher[] = [];

for (const dir of WATCH_DIRS) {
  try {
    const w = watch(dir, { recursive: true }, (_event, filename) => {
      if (!shouldIgnore(filename)) {
        scheduleRestart(resolve(dir, filename ?? ""));
      }
    });
    watchers.push(w);
    console.log(`[watch-api] Watching ${relative(ROOT, dir)}${sep}`);
  } catch (err: any) {
    console.warn(`[watch-api] Could not watch ${dir}: ${err.message}`);
  }
}

process.on("SIGINT", () => {
  for (const w of watchers) w.close();
  child?.kill();
  process.exit(0);
});

process.on("SIGTERM", () => {
  for (const w of watchers) w.close();
  child?.kill();
  process.exit(0);
});

console.log("[watch-api] Starting API server...");
startServer();
