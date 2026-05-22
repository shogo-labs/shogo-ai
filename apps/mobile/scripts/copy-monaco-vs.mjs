#!/usr/bin/env node
/**
 * Mirror `node_modules/monaco-editor/min/vs/` into `apps/mobile/public/vs/`
 * so the Expo web build serves Monaco's AMD bundle from the same origin as
 * the app shell — both in `expo start --web` and in `expo export`.
 *
 * Why this exists:
 *   `@monaco-editor/react` (via `@monaco-editor/loader`) lazy-loads Monaco
 *   from `https://cdn.jsdelivr.net/npm/monaco-editor@<ver>/min/vs/loader.js`
 *   the first time `<Editor>` mounts. That's fine for a normal web page,
 *   but the packaged desktop app loads the renderer from `shogo://app/`
 *   with a tight CSP (`script-src 'self' shogo: blob: 'unsafe-inline'
 *   'unsafe-eval'`) — no `https:`, no jsdelivr — so the script load is
 *   blocked and Monaco never initializes. The renderer logs
 *   `Monaco initialization: error: Event` and the IDE editor stays blank.
 *
 *   Self-hosting Monaco at `/vs/` (same origin as `index.html`) bypasses
 *   the CSP entirely (matches `'self'`) and makes the app work offline.
 *   `CodeEditor.tsx` calls `loader.config({ paths: { vs: '/vs' } })` at
 *   module-load time so the loader points here instead of the CDN.
 *
 * Skip-if-up-to-date:
 *   We stamp the destination with `<dest>/.monaco-editor-version` matching
 *   `monaco-editor`'s package.json version. If they agree, we no-op so
 *   repeated `expo start --web` invocations don't keep re-copying ~30 MB.
 *   Bumping the `monaco-editor` dependency invalidates the stamp and the
 *   next build re-syncs.
 *
 * The destination (`apps/mobile/public/vs/`) is gitignored — regenerable
 * from `node_modules`, no value in committing.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');

const SOURCE_VS = path.join(APP_ROOT, 'node_modules', 'monaco-editor', 'min', 'vs');
const SOURCE_PKG = path.join(APP_ROOT, 'node_modules', 'monaco-editor', 'package.json');
const DEST_VS = path.join(APP_ROOT, 'public', 'vs');
const VERSION_STAMP = path.join(DEST_VS, '.monaco-editor-version');

function fail(msg) {
  console.error(`[copy-monaco-vs] ${msg}`);
  process.exit(1);
}

if (!existsSync(SOURCE_VS)) {
  // `monaco-editor` is a direct dep of @shogo/mobile — if it's missing the
  // workspace was never installed. Surface that loud instead of silently
  // shipping an IDE-less build.
  fail(`source not found: ${SOURCE_VS} — run \`bun install\` from the repo root.`);
}
if (!existsSync(SOURCE_PKG)) {
  fail(`source package.json not found: ${SOURCE_PKG}`);
}

const monacoVersion = JSON.parse(readFileSync(SOURCE_PKG, 'utf8')).version;
if (typeof monacoVersion !== 'string' || monacoVersion.length === 0) {
  fail('monaco-editor package.json has no version field');
}

if (existsSync(VERSION_STAMP)) {
  const stamped = readFileSync(VERSION_STAMP, 'utf8').trim();
  if (stamped === monacoVersion) {
    console.log(`[copy-monaco-vs] up to date (monaco-editor@${monacoVersion}) — skipping`);
    process.exit(0);
  }
  // Different version cached — wipe so we don't end up with a mix of old
  // and new bundled chunks (hashed filenames change between releases).
  rmSync(DEST_VS, { recursive: true, force: true });
}

mkdirSync(path.dirname(DEST_VS), { recursive: true });
console.log(`[copy-monaco-vs] copying monaco-editor@${monacoVersion}/min/vs → public/vs ...`);
cpSync(SOURCE_VS, DEST_VS, { recursive: true });
writeFileSync(VERSION_STAMP, monacoVersion);
console.log(`[copy-monaco-vs] ✓ done`);
