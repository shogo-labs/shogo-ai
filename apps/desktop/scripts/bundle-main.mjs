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
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

// ─────────────────────────────────────────────────────────────────────────────
// Post-bundle safety check: refuse to ship a bundle that leaks the build host's
// absolute path into the output.
//
// `bun build --target node --format cjs` rewrites `__dirname`, `__filename`,
// and `import.meta.url` in each bundled module as string literals captured at
// build time, NOT as the runtime CJS / ESM builtins Electron's loader sets when
// it actually requires the file. On a CI runner that means the bundle ships
// with paths like `/Users/runner/work/<org>/<repo>/apps/desktop/src` hard-coded
// inside `app.asar` — every consumer's Electron then resolves them against a
// non-existent directory.
//
// v1.7.8 shipped exactly that regression: `preload: path.join(__dirname, ...)`
// in `main.ts` ended up pointing at the CI runner's source tree, so the
// preload script never loaded, `window.shogoDesktop` was undefined, and the
// renderer fell back to a hard-coded `localhost:8002` API URL that doesn't
// match the packaged app's dynamic API port. The user-visible symptoms were
// "can't get past onboarding" and "Shogo Cloud signin doesn't complete".
//
// Refuse the bundle if it contains the repo root anywhere. The only correct
// fix at the source level is to derive paths from Electron's `app.getAppPath()`
// or `process.resourcesPath`, both of which are set at runtime and cannot be
// inlined by Bun.
// ─────────────────────────────────────────────────────────────────────────────

const bundleSource = readFileSync(OUT_FILE, 'utf8');
const forbidden = [
  // Plain absolute paths to anywhere inside the build checkout. Catches `__dirname`
  // inlines, `__filename` inlines, and any other path that snuck through.
  { needle: REPO_ROOT, label: 'REPO_ROOT' },
  // Same path, encoded as a `file://` URL. Catches `import.meta.url` inlines —
  // e.g. `new URL('../package.json', import.meta.url)` patterns.
  { needle: pathToFileURL(REPO_ROOT).href, label: 'REPO_ROOT file:// URL' },
];

const leaks = forbidden.filter(({ needle }) => bundleSource.includes(needle));
if (leaks.length > 0) {
  // Print up to a few examples of each leak so the next maintainer can grep
  // their way to the offending source file fast.
  for (const { needle, label } of leaks) {
    console.error(`[bundle-main] ✗ bundle leaks ${label} (${needle})`);
    let idx = bundleSource.indexOf(needle);
    let count = 0;
    while (idx !== -1 && count < 3) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(bundleSource.length, idx + needle.length + 40);
      const snippet = bundleSource.slice(start, end).replace(/\n/g, '\\n');
      console.error(`    …${snippet}…`);
      idx = bundleSource.indexOf(needle, idx + needle.length);
      count++;
    }
  }
  console.error('');
  console.error('[bundle-main] Refusing to ship a bundle with build-host paths baked in.');
  console.error('  Cause: `bun build` inlines `__dirname` / `__filename` / `import.meta.url`');
  console.error('  as string literals at build time. The packaged app then resolves them on');
  console.error('  the end-user\'s machine, where those paths do not exist.');
  console.error('');
  console.error('  Fix: in any module that gets bundled into dist/main.js, replace');
  console.error('       `path.join(__dirname, …)` etc. with Electron-supplied runtime APIs:');
  console.error('         • `app.getAppPath()` for paths inside the app/asar bundle');
  console.error('         • `process.resourcesPath` for unpacked resources');
  console.error('         • `app.getPath("userData")` for per-user state');
  console.error('');
  process.exit(1);
}

console.log('[bundle-main] ✓ no build-host paths leaked into bundle');
