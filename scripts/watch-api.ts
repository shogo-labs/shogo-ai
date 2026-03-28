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

const IGNORE = ["node_modules", ".git", "dist", "build"];
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);

let child: Subprocess | null = null;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 300;

function startServer() {
  if (child) {
    child.kill();
    child = null;
  }

  child = spawn({
    cmd: ["bun", "run", ENTRY],
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
    env: { ...process.env, PREWARM_CLAUDE_CODE: "false" },
  });

  child.exited.then((code) => {
    if (child?.killed) return;
    if (code !== 0) {
      console.log(`[watch-api] Server exited with code ${code}, restarting in 1s...`);
      setTimeout(startServer, 1000);
    }
  });
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
