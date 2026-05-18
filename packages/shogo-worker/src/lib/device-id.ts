// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Stable per-machine UUID stored at ~/.shogo/device-id.
 *
 * The cloud uses (workspaceId, deviceId) as a dedupe key — when the
 * same machine re-runs `shogo login`, the previous device-tagged API
 * key is auto-revoked so we don't accumulate "ghost" device rows in
 * the dashboard. Stability across re-logins is what makes this work,
 * so we persist the id at first generation rather than rolling a new
 * one each time.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DEVICE_ID_FILE, ensureHome } from './paths.ts';

export function getOrCreateDeviceId(): string {
  if (existsSync(DEVICE_ID_FILE)) {
    const value = readFileSync(DEVICE_ID_FILE, 'utf-8').trim();
    if (value) return value;
  }
  ensureHome();
  const id = randomUUID();
  writeFileSync(DEVICE_ID_FILE, id, { mode: 0o600 });
  chmodSync(DEVICE_ID_FILE, 0o600);
  return id;
}
