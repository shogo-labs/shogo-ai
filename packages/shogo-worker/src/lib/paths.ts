// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Path helpers for the Shogo Worker CLI.
 * Config, PID, and logs live under ~/.shogo/ on all platforms.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export const HOME_DIR = join(homedir(), '.shogo');
export const CONFIG_FILE = join(HOME_DIR, 'config.json');
export const CREDENTIALS_FILE = join(HOME_DIR, 'credentials.json');
/** Stable per-machine UUID. Generated on first `shogo login`, persisted
 * verbatim, sent up as `deviceId` so cloud dedupes across re-logins. */
export const DEVICE_ID_FILE = join(HOME_DIR, 'device-id');
export const PID_FILE = join(HOME_DIR, 'worker.pid');
export const LOGS_DIR = join(HOME_DIR, 'logs');
export const WORKER_LOG = join(LOGS_DIR, 'worker.log');
export const WORKER_ERR = join(LOGS_DIR, 'worker.err.log');

/** Default install location for the AGPL agent-runtime binary. */
export const RUNTIME_DIR = join(HOME_DIR, 'runtime');
export const RUNTIME_BIN = join(RUNTIME_DIR, process.platform === 'win32' ? 'agent-runtime.exe' : 'agent-runtime');
export const RUNTIME_VERSION_FILE = join(RUNTIME_DIR, 'version.json');

/**
 * Default root for cloned project workspaces. The worker stores
 * each pulled project under `<PROJECTS_DIR>/<projectId>/`.
 *
 * Persistent (NOT in tmpdir) so a pinned project doesn't have to
 * re-pull from cloud after a reboot.
 */
export const PROJECTS_DIR = join(HOME_DIR, 'projects');

export function projectDirFor(projectId: string, baseDir: string = PROJECTS_DIR): string {
  return join(baseDir, projectId);
}

export function ensureHome(): void {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
}

export function ensureRuntimeDir(): void {
  ensureHome();
  mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
}

export function ensureProjectsDir(baseDir: string = PROJECTS_DIR): void {
  ensureHome();
  mkdirSync(baseDir, { recursive: true, mode: 0o700 });
}
