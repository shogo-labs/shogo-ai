// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ForgeConfig } from '@electron-forge/cli'
import fs from 'fs'

const hasIcon = fs.existsSync('./resources/icon.icns') || fs.existsSync('./resources/icon.ico')
const hasInstallGif = fs.existsSync('./resources/install-splash.gif')

// Two tiers of resources:
//
//  - REQUIRED resources must exist or the build is broken by definition.
//    `./resources/web` is the killer example — without it the packaged
//    renderer has no HTML/JS/Monaco bundle and you ship an app that
//    opens to a permanent "Loading…" spinner. Until this branch the
//    config silently `.filter()`-dropped missing entries from the
//    candidates list, which is exactly how the IDE-editor-not-loading
//    bug shipped invisibly.
//
//  - OPTIONAL resources are platform-specific or feature-flagged
//    (VM disk images, sherpa onnx blobs, sysaudio bundles, etc.) and
//    silently dropping them is correct.
const REQUIRED_RESOURCES = [
  './resources/web',
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
]

// VM disk images are Linux-only and not usable on Windows. Exclude them
// on win32 to keep the Squirrel installer under NuGet's size limits.
const isWin32 = process.platform === 'win32'

const missingRequired = REQUIRED_RESOURCES.filter((p) => !fs.existsSync(p))
if (missingRequired.length > 0) {
  // Fail loud at config-load time. Bypassing `bun run package` /
  // `bun run make` (which run `scripts/sync-web.mjs` via lifecycle hooks)
  // and calling electron-forge directly used to silently produce a
  // broken package. Now it can't.
  console.error('[forge.config] ERROR: required resources are missing:')
  for (const p of missingRequired) console.error(`  - ${p}`)
  console.error('')
  console.error('  Run `bun run sync:web` from apps/desktop/ to populate resources/web/,')
  console.error('  or `bun run package` / `bun run make` which invoke it automatically.')
  process.exit(1)
}

const extraResource = [...REQUIRED_RESOURCES, ...OPTIONAL_RESOURCES]
  .filter((p) => !(isWin32 && p === './resources/vm'))
  .filter((p) => fs.existsSync(p))

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shogo',
    ...(hasIcon ? { icon: './resources/icon' } : {}),
    asar: true,
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
}

export default config
