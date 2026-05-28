#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Repairs the executable bit on node-pty's `spawn-helper` binaries.
 *
 * Why this exists:
 *   node-pty ships per-platform prebuilds under `node_modules/node-pty/prebuilds/`.
 *   On macOS and Linux it bundles a small `spawn-helper` ELF/Mach-O that the
 *   native `pty.node` shells out to during `posix_spawnp(2)`. The helper MUST be
 *   `+x` or the kernel returns EACCES and the entire spawn fails with the
 *   famously unhelpful error "spawn:failed: posix_spawnp failed".
 *
 *   Some package managers (bun, npm with offline cache, yarn pnp, electron-builder
 *   asar unpack) silently drop the exec bit when materialising the file from a
 *   non-tar source. This script puts it back. It is idempotent and cheap, so it
 *   is safe to wire into `postinstall`.
 *
 * Cross-platform note:
 *   On Windows the helper does not exist (node-pty uses winpty/conpty), so the
 *   script no-ops there.
 */
import { chmodSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';

if (platform() === 'win32') process.exit(0);

const root = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', 'node_modules', 'node-pty', 'prebuilds');

let st;
try {
  st = statSync(root);
} catch {
  // node-pty not installed (e.g. fresh clone before `npm install`). Nothing to do.
  process.exit(0);
}
if (!st.isDirectory()) process.exit(0);

let fixed = 0;
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const helper = join(root, entry.name, 'spawn-helper');
  try {
    const s = statSync(helper);
    if (!s.isFile()) continue;
    // 0o755 — owner rwx, group/other rx. Matches what npm SHOULD have done.
    chmodSync(helper, 0o755);
    fixed++;
  } catch {
    // Helper missing for that prebuild — skip silently.
  }
}

if (fixed > 0) {
  // eslint-disable-next-line no-console
  console.log(`[fix-node-pty-perms] chmod +x ${fixed} spawn-helper binar${fixed === 1 ? 'y' : 'ies'}`);
}
