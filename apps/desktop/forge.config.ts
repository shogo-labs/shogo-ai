// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ForgeConfig } from '@electron-forge/cli'
import fs from 'fs'

const hasIcon = fs.existsSync('./resources/icon.icns') || fs.existsSync('./resources/icon.ico')

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
  './resources/whisper',
  './resources/shogo-audio',
  './resources/seed.db',
  './resources/package.json',
  './prisma',
  './prisma.config.js',
]

const extraResource = extraResourceCandidates.filter((p) => fs.existsSync(p))

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shogo',
    ...(hasIcon ? { icon: './resources/icon' } : {}),
    asar: true,
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
      name: '@electron-forge/maker-zip',
      platforms: ['darwin', 'win32'],
    },
    {
      name: '@electron-forge/maker-dmg',
      config: {
        format: 'ULFO',
      },
    },
  ],
}

export default config
