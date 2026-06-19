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
import { spawnSync } from 'node:child_process';
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
  ensureWorkspaceSymlink({
    namespace: '@shogo-ai',
    packageName: 'worker',
    sourceDir: path.join(REPO_ROOT, 'packages', 'shogo-worker'),
    label: 'worker',
  });
}

/**
 * Same trick for `@shogo/agent-runtime`. Only `src/fs-tree-walker.ts`
 * gets imported from apps/desktop (the rest of agent-runtime — Hono,
 * RAG, voice mode, etc. — is intentionally NOT pulled into the
 * Electron main bundle), so this is a narrow surface that bun resolves
 * + inlines straight from source.
 *
 * Apps/api's Dockerfile uses the same `ln -sf` pattern at deploy time
 * (`ln -sf ../../../packages/agent-runtime node_modules/@shogo/agent-runtime`).
 * We replicate it here so the build works on Windows + macOS GitHub
 * runners where apps/desktop is npm-installed and never sees the
 * workspace symlink that bun install would create.
 */
function ensureAgentRuntimeSymlink() {
  ensureWorkspaceSymlink({
    namespace: '@shogo',
    packageName: 'agent-runtime',
    sourceDir: path.join(REPO_ROOT, 'packages', 'agent-runtime'),
    label: 'agent-runtime',
  });
}

function ensureWorkspaceSymlink({ namespace, packageName, sourceDir, label }) {
  const namespaceDir = path.join(DESKTOP_DIR, 'node_modules', namespace);
  const linkPath = path.join(namespaceDir, packageName);

  if (!existsSync(sourceDir)) {
    console.error(`[bundle-main] ${label} source missing at ${sourceDir}`);
    process.exit(1);
  }
  mkdirSync(namespaceDir, { recursive: true });

  // If a stale symlink/dir exists, replace it so we always point at the
  // current monorepo source (relevant when packages get moved).
  if (existsSync(linkPath) || lstatExists(linkPath)) {
    try { unlinkSync(linkPath); } catch { /* dir, leave alone */ }
  }
  if (!existsSync(linkPath)) {
    // On Windows, `symlinkSync(..., 'dir')` requires
    // SeCreateSymbolicLinkPrivilege — i.e. an elevated terminal OR
    // Developer Mode enabled. Junctions (directory reparse points)
    // don't need that privilege and behave identically for module
    // resolution, so use them on Windows. The 'junction' type is
    // ignored on POSIX and the second arg there is just 'dir'.
    //
    // This change fixes local-dev `npm run build` on Windows without
    // changing CI behavior (the GitHub windows-latest runners would
    // also benefit — they used to need admin context for the existing
    // worker symlink and would silently break if that ever changed).
    //
    // Junctions also require an ABSOLUTE target on Windows; relative
    // targets get resolved against the current working directory at
    // creation time rather than against the link's own directory.
    if (process.platform === 'win32') {
      symlinkSync(sourceDir, linkPath, 'junction');
    } else {
      const relTarget = path.relative(namespaceDir, sourceDir);
      symlinkSync(relTarget, linkPath, 'dir');
    }
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
  '@sentry/electron',
  '@sentry/electron/main',
  'bonjour-service',
  'fflate',
  'multicast-dns',
  'node-ical',
  'node-pty',
  'ps-list',
  'fsevents',
];

ensureWorkerSymlink();
ensureAgentRuntimeSymlink();

// Inject `packages/shogo-worker`'s version as a build-time constant so
// `readWorkerVersion()` in `cloud-login.ts` doesn't have to read its own
// `package.json` at runtime via `import.meta.url` (which Bun inlines, leaking
// the build host's path — see the post-bundle safety check below). The
// matching `declare const __SHOGO_WORKER_VERSION__` lives in cloud-login.ts.
const workerPkg = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'packages', 'shogo-worker', 'package.json'), 'utf8'),
);
if (typeof workerPkg.version !== 'string' || workerPkg.version.length === 0) {
  console.error('[bundle-main] shogo-worker package.json has no version field');
  process.exit(1);
}

// Bake the desktop Sentry DSN into the bundle when CI provides it. Same
// `--define` pattern as the worker version above — keeps the runtime
// import-free and means the packaged app doesn't need a config file to
// know where to phone home. The matching declaration lives in
// `apps/desktop/src/sentry.ts`. Empty string is treated as "no DSN" by
// `resolveDsn()` so contributor / fork builds without the secret stay
// telemetry-free. We REJECT a DSN containing a double quote so a
// malformed secret can't break out of the JSON-string `--define` value
// and corrupt other defines (defense-in-depth — the value comes from a
// trusted GitHub secret, but the bundler is too easy to corrupt to
// trust without a sanity check).
const desktopSentryDsn = process.env.SHOGO_DESKTOP_SENTRY_DSN || '';
if (desktopSentryDsn.includes('"')) {
  console.error('[bundle-main] SHOGO_DESKTOP_SENTRY_DSN contains a double quote — refusing to bake into bundle');
  process.exit(1);
}
if (desktopSentryDsn) {
  console.log('[bundle-main] baking SHOGO_DESKTOP_SENTRY_DSN into bundle');
} else {
  console.log('[bundle-main] SHOGO_DESKTOP_SENTRY_DSN not set — Sentry will be a no-op in this build');
}

// Build the bun invocation as an argv array and run via `spawnSync` with
// `shell: false`. We deliberately do NOT shell-interpolate the command.
//
// Why: `--define KEY="value"` requires the literal double quotes around the
// value to survive into bun's argv so bun parses the value as a JSON string.
// In a Unix shell those quotes are normally protected by wrapping the whole
// arg in single quotes: `'KEY="value"'`. On Windows `cmd.exe` (which Node's
// `execSync` invokes for the inner shell regardless of how Node was started)
// single quotes are NOT metacharacters — they're passed through literally to
// the child. Bun then sees the key as `'KEY` (with leading apostrophe) and
// fails with `define key "'KEY" must be a valid identifier`. v1.7.9's
// Windows build (run #26030373327) died exactly there.
//
// Passing an argv array sidesteps every shell entirely: Node hands the args
// directly to CreateProcess on Windows / execvp on Unix. Bun receives one
// argv entry `__SHOGO_WORKER_VERSION__="0.0.0"` with the inner quotes intact,
// regardless of platform.
const args = [
  'build',
  ENTRY,
  '--target', 'node',
  '--format', 'cjs',
  '--outfile', OUT_FILE,
  // Emit `dist/main.js.map` next to the bundle so the desktop release
  // workflows can `sentry-cli sourcemaps inject` + `upload` it to the
  // `shogo-desktop` project (and then delete it before packaging, so the
  // map never ships inside app.asar). Without this the main-process bundle
  // has no map and every captured crash stays minified. `external` writes a
  // standalone map without a `sourceMappingURL` comment; sentry-cli adds the
  // comment + Debug ID during inject.
  '--sourcemap=external',
  '--define', `__SHOGO_WORKER_VERSION__="${workerPkg.version}"`,
  '--define', `__SHOGO_DESKTOP_SENTRY_DSN__="${desktopSentryDsn}"`,
  ...EXTERNALS.flatMap((p) => ['--external', p]),
];

console.log('[bundle-main] running:');
console.log(`  bun ${args.map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
const result = spawnSync('bun', args, { cwd: DESKTOP_DIR, stdio: 'inherit', shell: false });
if (result.error) {
  console.error('[bundle-main] failed to invoke bun:', result.error.message);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`[bundle-main] bun build failed (exit ${result.status ?? 'signal:' + result.signal})`);
  process.exit(result.status ?? 1);
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

// On Windows, REPO_ROOT contains `\` separators (e.g.
// `D:\a\shogo-ai\shogo-ai`). When Bun emits an inlined path as a JS string
// literal, those backslashes get JS-escaped to `\\`, so a plain
// `bundleSource.includes(REPO_ROOT)` against the source would miss the leak.
// Add the doubly-backslashed form so the safety net actually fires on Windows
// CI, not just macOS/Linux.
if (path.sep === '\\') {
  forbidden.push({
    needle: REPO_ROOT.replace(/\\/g, '\\\\'),
    label: 'REPO_ROOT (JS-escaped backslashes)',
  });
}

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
