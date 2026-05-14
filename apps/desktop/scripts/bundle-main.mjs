#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Re-bundle the Electron main process so workspace TS imports get inlined.
 *
 * Why this exists:
 *   apps/desktop is installed via `npm install` (not the bun workspace)
 *   and its node_modules has no @shogo-ai/* entries. `tsc` happily emits
 *   `dist/main.js` with `require('@shogo-ai/worker/cloud-login')` calls,
 *   but at runtime Electron's Node can't resolve them — and even if it
 *   could, the worker's `exports` map points at `.ts` source which Node
 *   can't load.
 *
 *   This script runs AFTER tsc and overwrites `dist/main.js` with a
 *   self-contained bundle that has every workspace TS import inlined.
 *   Bun is invoked from the REPO ROOT where workspace symlinks DO exist,
 *   so it resolves `@shogo-ai/worker/cloud-login` straight to the source
 *   `.ts` file and inlines it.
 *
 *   This is the same trick `scripts/bundle-api.mjs` already uses for the
 *   API server bundle — see that script for the full external-package
 *   list. main.ts only pulls in workspace TS deps (no native modules
 *   beyond electron itself), so the externals list here is small.
 *
 * Other tsc outputs in `dist/` (preload.js, local-server.js, …) are
 * left alone because they don't import workspace packages.
 */
import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const ENTRY = path.join(DESKTOP_DIR, 'src', 'main.ts');
const OUT_FILE = path.join(DESKTOP_DIR, 'dist', 'main.js');

/**
 * Bun walks upward from the input file looking for
 * `node_modules/@shogo-ai/worker` to resolve the import. apps/desktop
 * is npm-installed (no @shogo-ai entries) and the repo root's
 * node_modules doesn't have them either — only the bun-managed
 * per-workspace dirs (e.g. apps/api/node_modules) carry the symlink.
 *
 * Rather than depend on `bun install` having run for a sibling app,
 * we ensure the symlink exists right before bundling. npm install
 * leaves unknown entries in node_modules alone, so this is stable
 * across `npm install` cycles for apps/desktop's own deps.
 */
function ensureWorkerSymlink() {
  const namespaceDir = path.join(DESKTOP_DIR, 'node_modules', '@shogo-ai');
  const linkPath = path.join(namespaceDir, 'worker');
  const targetAbs = path.join(REPO_ROOT, 'packages', 'shogo-worker');

  if (!existsSync(targetAbs)) {
    console.error(`[bundle-main] worker source missing at ${targetAbs}`);
    process.exit(1);
  }
  mkdirSync(namespaceDir, { recursive: true });

  // If a stale symlink/dir exists, replace it so we always point at the
  // current monorepo source (relevant when packages get moved).
  if (existsSync(linkPath) || lstatExists(linkPath)) {
    try { unlinkSync(linkPath); } catch { /* dir, leave alone */ }
  }
  if (!existsSync(linkPath)) {
    const relTarget = path.relative(namespaceDir, targetAbs);
    symlinkSync(relTarget, linkPath, 'dir');
  }
}

function lstatExists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

if (!existsSync(ENTRY)) {
  console.error(`bundle-main: entry not found: ${ENTRY}`);
  process.exit(1);
}
if (!existsSync(OUT_FILE)) {
  console.error(`bundle-main: dist/main.js not found — did tsc run first?`);
  process.exit(1);
}

// Externals: anything that's a real native module Electron ships, plus
// the desktop's own runtime npm dependencies (node_modules-resolved at
// runtime by Electron, not bundled). Keeping these external avoids
// pulling node-gyp artifacts into the JS bundle.
const EXTERNALS = [
  'electron',
  'bonjour-service',
  'fflate',
  'multicast-dns',
  'node-ical',
  'ps-list',
];

const externalArgs = EXTERNALS.flatMap((p) => ['--external', p]).join(' ');

ensureWorkerSymlink();

const cmd = `bun build "${ENTRY}" --target node --format cjs --outfile "${OUT_FILE}" ${externalArgs}`;

console.log('[bundle-main] running:');
console.log(`  ${cmd}`);
try {
  execSync(cmd, { cwd: DESKTOP_DIR, stdio: 'inherit' });
} catch (err) {
  console.error('[bundle-main] bun build failed');
  process.exit(1);
}

const sizeKb = (statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`[bundle-main] ✓ wrote dist/main.js (${sizeKb} KB)`);
