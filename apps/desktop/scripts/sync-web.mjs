#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Build the mobile web bundle and sync it into the desktop's resources/web.
 *
 * Why this exists:
 *   The packaged Electron renderer is served from `shogo://app/`, whose
 *   protocol handler resolves URL paths against `resources/web/`. That
 *   directory is the entire React-Native-for-web app — index.html plus
 *   every static asset, including the self-hosted Monaco AMD loader at
 *   `vs/loader.js` that the IDE editor depends on.
 *
 *   Until this script existed the contract between mobile and desktop was
 *   "follow the steps in BUILD.md by hand" — `cd apps/mobile && bun run
 *   build`, then `rm -rf apps/desktop/resources/web`, then a manual `cp
 *   -R`. Any of those skipped, mis-typed, or run in the wrong order
 *   produced a `resources/web/` that was either stale or missing critical
 *   assets, and the packaged app *built successfully* anyway. The user-
 *   visible symptom (Monaco editor permanently stuck on "Loading…") was a
 *   second-order consequence of the renderer 404ing on
 *   `shogo://app/vs/loader.js`.
 *
 *   This script makes the bad state unrepresentable:
 *
 *     1. Always rebuilds the mobile web bundle (`bun run build` in
 *        `apps/mobile`), which itself chains `copy-monaco-vs.mjs` before
 *        `expo export --platform web`. No way to skip the Monaco mirror.
 *     2. Wipes `apps/desktop/resources/web/` so leftover files from a
 *        previous build can never mask a regression.
 *     3. Copies the fresh `apps/mobile/dist/` over verbatim.
 *     4. Asserts a list of REQUIRED_FILES exists at the destination, with
 *        a non-zero size, and bails with a clear error if anything is
 *        missing. This is the line that would have caught the original
 *        bug at build time instead of at runtime.
 *
 *   It is invoked automatically as the `prepackage` / `premake` lifecycle
 *   hook in `apps/desktop/package.json`, so `electron-forge package` and
 *   `electron-forge make` cannot run against a broken bundle.
 *
 * Override:
 *   Pass `--skip-mobile-build` (or set `SKIP_MOBILE_BUILD=1`) to reuse an
 *   existing `apps/mobile/dist/` — handy for iterating on desktop-only
 *   changes. The post-sync assertions still run, so a missing
 *   `vs/loader.js` is still surfaced.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DESKTOP_DIR, '..', '..');
const MOBILE_DIR = path.join(REPO_ROOT, 'apps', 'mobile');
const MOBILE_DIST = path.join(MOBILE_DIR, 'dist');
const DEST_WEB = path.join(DESKTOP_DIR, 'resources', 'web');

const SKIP_MOBILE_BUILD =
  process.argv.includes('--skip-mobile-build') || process.env.SKIP_MOBILE_BUILD === '1';

/**
 * Files we contract to ship inside resources/web/. If any of these are
 * missing after the sync, the packaged app is known-broken — fail the
 * build instead of letting the user discover it at runtime.
 *
 *  - index.html              the SPA shell loaded by `shogo://app/`
 *  - vs/loader.js            Monaco's AMD loader (IDE editor entry point)
 *  - vs/editor/editor.main.js Monaco core (referenced by loader)
 *  - _expo/                  Expo's static JS bundle directory
 *  - assets/                 React Native asset registry output
 *
 * `_expo` and `assets` are checked as directories — they must exist and
 * be non-empty.
 */
// Min-byte thresholds are calibrated against monaco-editor's `min/vs/` —
// loader.js is ~40 KB, editor.main.js is ~80 KB, editor.main.css is
// ~300 KB. We floor at roughly half of each so a future Monaco upgrade
// that shrinks the bundle slightly doesn't trip the alarm, while still
// catching a truncated/HTML-as-JS copy.
const REQUIRED_FILES = [
  { rel: 'index.html', kind: 'file', minBytes: 100 },
  { rel: 'vs/loader.js', kind: 'file', minBytes: 20_000 },
  { rel: 'vs/editor/editor.main.js', kind: 'file', minBytes: 40_000 },
  { rel: 'vs/editor/editor.main.css', kind: 'file', minBytes: 100_000 },
];
const REQUIRED_DIRS_NONEMPTY = ['_expo', 'assets'];

function log(msg) {
  console.log(`[sync-web] ${msg}`);
}
function fail(msg) {
  console.error(`[sync-web] ERROR: ${msg}`);
  process.exit(1);
}

function run(cmd, args, opts) {
  const pretty = `${cmd} ${args.join(' ')}`;
  log(`$ ${pretty}  (cwd=${opts?.cwd ?? process.cwd()})`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) fail(`failed to spawn \`${pretty}\`: ${r.error.message}`);
  if (typeof r.status === 'number' && r.status !== 0) {
    fail(`\`${pretty}\` exited with code ${r.status}`);
  }
}

// 1. Build the mobile web bundle (unless caller opted out).
if (SKIP_MOBILE_BUILD) {
  log('SKIP_MOBILE_BUILD set — reusing existing apps/mobile/dist/');
  if (!existsSync(MOBILE_DIST)) {
    fail(`no existing build at ${MOBILE_DIST} — rerun without --skip-mobile-build`);
  }
} else {
  if (!existsSync(path.join(MOBILE_DIR, 'package.json'))) {
    fail(`apps/mobile not found at ${MOBILE_DIR}`);
  }
  log('building mobile web bundle (bun run build) ...');
  run('bun', ['run', 'build'], { cwd: MOBILE_DIR });
  if (!existsSync(MOBILE_DIST)) {
    fail(`bun run build completed but ${MOBILE_DIST} does not exist`);
  }
}

// 2. Wipe the previous resources/web so stale files can't mask regressions.
if (existsSync(DEST_WEB)) {
  log(`wiping ${path.relative(REPO_ROOT, DEST_WEB)} ...`);
  rmSync(DEST_WEB, { recursive: true, force: true });
}
mkdirSync(path.dirname(DEST_WEB), { recursive: true });

// 3. Copy the fresh dist over.
log(`copying ${path.relative(REPO_ROOT, MOBILE_DIST)} → ${path.relative(REPO_ROOT, DEST_WEB)} ...`);
cpSync(MOBILE_DIST, DEST_WEB, { recursive: true });

// 4. Assert the contract. Every entry in REQUIRED_FILES / REQUIRED_DIRS_NONEMPTY
//    MUST exist at the destination with the expected shape. Anything missing
//    is a packaging bug — better to fail here than to ship a broken IDE.
const failures = [];

for (const { rel, kind, minBytes } of REQUIRED_FILES) {
  const p = path.join(DEST_WEB, rel);
  if (!existsSync(p)) {
    failures.push(`missing required file: resources/web/${rel}`);
    continue;
  }
  const st = statSync(p);
  if (kind === 'file' && !st.isFile()) {
    failures.push(`expected file but got ${st.isDirectory() ? 'directory' : 'other'}: resources/web/${rel}`);
    continue;
  }
  if (typeof minBytes === 'number' && st.size < minBytes) {
    failures.push(`resources/web/${rel} is suspiciously small (${st.size} bytes, expected >= ${minBytes})`);
  }
}

for (const rel of REQUIRED_DIRS_NONEMPTY) {
  const p = path.join(DEST_WEB, rel);
  if (!existsSync(p) || !statSync(p).isDirectory()) {
    failures.push(`missing required directory: resources/web/${rel}/`);
    continue;
  }
  // Cheap non-empty check
  const { readdirSync } = await import('node:fs');
  if (readdirSync(p).length === 0) {
    failures.push(`required directory is empty: resources/web/${rel}/`);
  }
}

if (failures.length > 0) {
  console.error('[sync-web] ERROR: post-sync integrity check failed:');
  for (const f of failures) console.error(`  - ${f}`);
  console.error('');
  console.error('  The desktop bundle is incomplete. The mobile web export probably');
  console.error('  did not include public/ assets. Things to check:');
  console.error('    1. `bun install` was run from the repo root recently');
  console.error('    2. `apps/mobile/node_modules/monaco-editor/` exists');
  console.error('    3. `apps/mobile/scripts/copy-monaco-vs.mjs` runs cleanly');
  console.error('    4. `apps/mobile/app.json` still has `"web": { "output": "single" }`');
  process.exit(1);
}

log(`✓ resources/web is complete (${REQUIRED_FILES.length} files + ${REQUIRED_DIRS_NONEMPTY.length} dirs verified)`);
