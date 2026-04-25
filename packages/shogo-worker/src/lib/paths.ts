// SPDX-License-Identifier: Apache-2.0
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
export const PID_FILE = join(HOME_DIR, 'worker.pid');
export const LOGS_DIR = join(HOME_DIR, 'logs');
export const WORKER_LOG = join(LOGS_DIR, 'worker.log');
export const WORKER_ERR = join(LOGS_DIR, 'worker.err.log');

export function ensureHome(): void {
  mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  mkdirSync(LOGS_DIR, { recursive: true, mode: 0o700 });
}
