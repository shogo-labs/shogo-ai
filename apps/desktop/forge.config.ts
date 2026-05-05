// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ForgeConfig } from '@electron-forge/cli'
import fs from 'fs'

const hasIcon = fs.existsSync('./resources/icon.icns') || fs.existsSync('./resources/icon.ico')
const hasInstallGif = fs.existsSync('./resources/install-splash.gif')

const extraResourceCandidates = [
  './resources/bun',
  './resources/web',
  './resources/bundle',
  './resources/vm-bundle',
  './resources/node_modules',
  './resources/templates',
  './resources/runtime-template',
  './resources/canvas-runtime',
  './resources/tree-sitter-wasm',
  './resources/vm',
  './resources/vm-helper',
  './resources/sherpa-onnx',
  './resources/shogo-sysaudio',
  './resources/ffmpeg',
  './resources/seed.db',
  './resources/package.json',
  './prisma',
  './prisma.config.js',
]

// VM disk images (./resources/vm) are Linux-only and not usable on Windows.
// Exclude them on win32 to keep the Squirrel installer under NuGet's size limits.
const isWin32 = process.platform === 'win32'
const extraResource = extraResourceCandidates
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
