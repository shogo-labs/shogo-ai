// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Manages the lifecycle of the spawned apps/api worker process.
 *
 * Single-instance enforcement via a PID file at ~/.shogo/worker.pid:
 * one worker per machine is intentional — mirrors Cursor's `agent worker`
 * behaviour so the cloud-side instance identity stays 1:1 with a machine
 * rather than multiplexing across forks.
 *
 * Signal hygiene: callers that hold the CLI process in the foreground
 * (`shogo worker start --foreground`) should invoke `installShutdownHooks()`
 * so Ctrl-C / SIGTERM tears down the child and clears the PID file.
 * The detached codepath doesn't need it — once `child.unref()` runs the
 * CLI exits and the child owns its own PID file.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { PID_FILE, WORKER_LOG, WORKER_ERR, ensureHome } from './paths.ts';

export interface SpawnOpts {
  entry: string;
  runner: 'bun' | 'node';
  env: NodeJS.ProcessEnv;
  cwd: string;
  detach?: boolean;
  inheritStdio?: boolean;
}

export function readPid(): number | null {
  if (!existsSync(PID_FILE)) return null;
  const raw = readFileSync(PID_FILE, 'utf-8').trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

export function spawnWorker(opts: SpawnOpts): { pid: number; child: ChildProcess } {
  ensureHome();

  const existingPid = readPid();
  if (existingPid && isRunning(existingPid)) {
    throw new Error(`Worker already running (pid=${existingPid}). Run \`shogo worker stop\` first.`);
  }
  if (existingPid) clearPid();

  const stdio: ("ignore" | "inherit" | number)[] = opts.inheritStdio
    ? ['ignore', 'inherit', 'inherit']
    : ['ignore', openSync(WORKER_LOG, 'a'), openSync(WORKER_ERR, 'a')];

  const child = spawn(opts.runner, [opts.entry], {
    cwd: opts.cwd,
    env: opts.env,
    detached: !!opts.detach,
    stdio: stdio as any,
  });

  if (!child.pid) throw new Error('Failed to spawn worker process.');
  writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });

  if (opts.detach) child.unref();
  return { pid: child.pid, child };
}

/**
 * Install SIGINT / SIGTERM / exit handlers that forward the signal to the
 * foreground child and clear the PID file. Idempotent — safe to call twice.
 *
 * Only meaningful for foreground runs; detached workers own their own
 * lifecycle after `child.unref()`.
 */
export function installShutdownHooks(child: ChildProcess): void {
  let shutdownStarted = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    try { child.kill(signal); } catch { /* already gone */ }
    clearPid();
  };

  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGHUP', () => shutdown('SIGHUP'));
  process.once('exit', () => {
    if (!shutdownStarted) clearPid();
  });

  // Propagate child's exit to this process for foreground runs.
  child.on('exit', (code, signal) => {
    clearPid();
    if (signal) process.exit(128 + (signalToInt(signal) ?? 0));
    process.exit(code ?? 0);
  });
}

function signalToInt(signal: NodeJS.Signals): number | undefined {
  const map: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15 };
  return map[signal];
}

export function stopWorker(signal: NodeJS.Signals = 'SIGTERM'): { killedPid: number | null } {
  const pid = readPid();
  if (!pid) return { killedPid: null };
  if (!isRunning(pid)) {
    clearPid();
    return { killedPid: null };
  }
  try { process.kill(pid, signal); } catch {}
  clearPid();
  return { killedPid: pid };
}
