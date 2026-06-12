// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ForgeConfig } from '@electron-forge/cli'
import fs from 'fs'

// `runSyncWeb` lives in a sibling .mjs module (loaded via dynamic
// `import()` inside the `prePackage` hook below) so that:
//
//   - test-forge-config.ts can import + exercise it without triggering
//     this file's top-level REQUIRED_RESOURCES check, which legitimately
//     `process.exit(1)`s a build that hasn't run the download-bun /
//     copy-package.json CI steps yet.
//
//   - We don't pay the cost of static `require('./scripts/run-sync-web.mjs')`
//     from a CJS-compiled file (this tsconfig is `module: commonjs`),
//     which would fail with ERR_REQUIRE_ESM on older Node versions.
//     Dynamic import is ESM-aware on every Node ≥14.

const hasIcon = fs.existsSync('./resources/icon.icns') || fs.existsSync('./resources/icon.ico')
const hasInstallGif = fs.existsSync('./resources/install-splash.gif')

// Two tiers of resources:
//
//  - REQUIRED resources must exist or the build is broken by definition.
//    Until this branch `./resources/web` lived here too, but a missing
//    `vs/loader.js` slipped past the check (the directory exists; only
//    its Monaco subtree was missing). It's now populated *and verified*
//    by `sync-web.mjs`, wired in below as a `prePackage` hook so it
//    fires whether forge is invoked via `npm run package` or via
//    `npx electron-forge package` — the npm `prepackage` lifecycle
//    hook only fires for the former, which is exactly how v1.8.12
//    shipped without the Monaco bundle.
//
//  - OPTIONAL resources are platform-specific or feature-flagged
//    (VM disk images, sherpa onnx blobs, sysaudio bundles, etc.) and
//    silently dropping them is correct.
const REQUIRED_RESOURCES = [
  './resources/bun',
  './resources/package.json',
  './prisma',
  './prisma.config.js',
]

const OPTIONAL_RESOURCES = [
  './resources/bundle',
  './resources/vm-bundle',
  './resources/node_modules',
  './resources/templates',
  './resources/runtime-template',
  './resources/canvas-runtime',
  // agent-runtime static assets (canvas-bridge.js served at /agent/canvas/bridge.js).
  // Without this, the workspace iframe never installs the SSE listener and the
  // "Update available — Refresh" toast never shows on Desktop.
  './resources/static',
  './resources/tree-sitter-wasm',
  './resources/vm',
  './resources/vm-helper',
  './resources/sherpa-onnx',
  './resources/shogo-sysaudio',
  './resources/seed.db',
  // Runtime install scripts (e.g. download-sherpa.mjs) copied by bundle-api.mjs.
  // The install-sherpa route resolves them at process.cwd()/scripts/, where
  // cwd is process.resourcesPath in the packaged app. Without this, the
  // directory is never shipped and install-sherpa 500s with "not found".
  './resources/scripts',
]

// VM disk images are Linux-only and not usable on Windows. Exclude them
// on win32 to keep the Squirrel installer under NuGet's size limits.
const isWin32 = process.platform === 'win32'

const missingRequired = REQUIRED_RESOURCES.filter((p) => !fs.existsSync(p))
if (missingRequired.length > 0) {
  // Fail loud at config-load time. These resources are produced by
  // explicit build steps (downloading bun, generating the prisma client,
  // copying package.json, etc.) — if any of them is missing the upstream
  // pipeline is broken and the package would just ship corrupted.
  // ./resources/web is NOT in this list because it's owned by the
  // prePackage hook below; see runSyncWeb() and the comment on
  // `extraResource`.
  console.error('[forge.config] ERROR: required resources are missing:')
  for (const p of missingRequired) console.error(`  - ${p}`)
  console.error('')
  console.error('  These are produced by explicit build steps (see apps/desktop/BUILD.md).')
  console.error('  Run `bun run package` / `bun run make` to drive the full pipeline.')
  process.exit(1)
}


// `./resources/web` is materialised + verified by the `prePackage`
// hook below (sync-web.mjs). We list it unconditionally — `existsSync`
// runs at config-load time, which is BEFORE prePackage gets a chance
// to populate the directory. If it's still missing when electron-
// packager actually runs, packager will fail loudly, which is exactly
// what we want.
//
// The other REQUIRED_RESOURCES entries are populated by separate CI
// steps (or by the developer ahead of `bun run package`); their
// existence IS verified at config-load time by the check above.
//
// OPTIONAL_RESOURCES legitimately may be absent on some platforms
// (vm/ is Linux-only inside the bundle, sherpa-onnx/ is opt-in, etc.)
// so they're still filtered with `existsSync`.
const extraResource = [
  './resources/web',
  ...REQUIRED_RESOURCES,
  ...OPTIONAL_RESOURCES.filter((p) => fs.existsSync(p)),
].filter((p) => !(isWin32 && p === './resources/vm'))

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shogo',
    ...(hasIcon ? { icon: './resources/icon' } : {}),
    asar: { unpack: '{**/node_modules/node-pty/**/*,**/node_modules/xterm-headless/**/*}' },
    // macOS privacy strings. Without NSMicrophoneUsageDescription, the
    // packaged .app silently fails getUserMedia({ audio: true }) instead
    // of triggering the system microphone prompt.
    extendInfo: {
      NSMicrophoneUsageDescription: 'Shogo needs microphone access to record audio for note-taking and transcription.',
    },
    // Signing and notarization are handled by explicit workflow steps
    // rather than @electron/osx-sign (which has integration bugs with @electron/packager 18.x).
    ...(process.env.WINDOWS_CERT_PATH && process.env.WINDOWS_CERT_PASSWORD ? {
      windowsSign: {
        certificateFile: process.env.WINDOWS_CERT_PATH,
        certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
      }
    } : {}),
    extraResource,
    ignore: [
      /^\/src/,
      /^\/scripts/,
      /^\/resources/,
      /^\/native/,
      /^\/prisma\/migrations/,
      /tsconfig\.json$/,
      /forge\.config\.ts$/,
      // Workspace packages are linked into node_modules via `file:` deps
      // (e.g. `@shogo/pty-core`), which npm/bun materialize as symlinks that
      // point OUT of apps/desktop (../../packages/*). @electron/asar refuses
      // to pack a symlink that escapes the package and throws "links out of
      // the package", which electron-forge swallows into a silent no-op (no
      // Shogo.app, exit 0) — this bricked the v1.8.17–v1.8.20 macOS releases.
      // These packages exist only so the build-time bundlers can resolve and
      // INLINE them (bundle-main.mjs → dist/main.js, bundle-pty-host.mjs →
      // dist/pty-host.js); nothing in the shipped app require()s them at
      // runtime (pty-core ships only src/*.ts, and preload imports it as a
      // type-only import). So exclude the whole @shogo namespace from packaging.
      /^\/node_modules\/@shogo(\/|$)/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Shogo',
        setupExe: 'Shogo-Setup.exe',
        ...(hasIcon ? { setupIcon: './resources/icon.ico', iconUrl: 'https://raw.githubusercontent.com/shogo-labs/shogo-ai/main/apps/desktop/resources/icon.ico' } : {}),
        ...(hasInstallGif ? { loadingGif: './resources/install-splash.gif' } : {}),
        ...(process.env.WINDOWS_CERT_PATH && process.env.WINDOWS_CERT_PASSWORD ? {
          certificateFile: process.env.WINDOWS_CERT_PATH,
          certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
        } : {}),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
      },
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'shogo-labs',
          name: 'shogo-ai',
        },
        prerelease: false,
        draft: true,
      },
    },
  ],
  hooks: {
    // Populate + verify resources/web BEFORE electron-packager copies
    // extraResource into the .app. This is the single point of control
    // for "the renderer bundle is correct on disk": it runs whether
    // forge is invoked via `npm run package` or `npx electron-forge
    // package`. The previous design lived in npm's `prepackage`
    // lifecycle hook, which only fires for `npm run` — `npx electron-
    // forge package` bypassed it and silently shipped a Monaco-less
    // bundle (v1.8.12 / v1.8.13 desktop release).
    prePackage: async () => {
      // Dynamic import (not top-level) so the ESM .mjs module is
      // loaded by Node's ESM resolver, not via CJS `require()` which
      // hits ERR_REQUIRE_ESM on Node < 22.
      const { runSyncWeb } = await import('./scripts/run-sync-web.mjs')
      runSyncWeb()
    },
  },
}

export default config
