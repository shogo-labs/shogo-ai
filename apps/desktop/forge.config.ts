// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Shogo Technologies, Inc.
import type { ForgeConfig } from '@electron-forge/cli'
import fs from 'fs'

const hasIcon = fs.existsSync('./resources/icon.icns') || fs.existsSync('./resources/icon.ico')

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shogo',
    ...(hasIcon ? { icon: './resources/icon' } : {}),
    asar: true,
    ...(process.platform === 'darwin' && process.env.APPLE_ID ? {
      osxSign: {
        optionsForFile: () => ({
          hardenedRuntime: true,
          entitlements: './entitlements.plist',
          'entitlements-inherit': './entitlements.plist',
        }),
      },
      osxNotarize: {
        tool: 'notarytool' as const,
        appleId: process.env.APPLE_ID!,
        appleIdPassword: process.env.APPLE_ID_PASSWORD!,
        teamId: process.env.APPLE_TEAM_ID!,
      },
    } : {}),
    ...(process.env.WINDOWS_CERT_PATH && process.env.WINDOWS_CERT_PASSWORD ? {
      windowsSign: {
        certificateFile: process.env.WINDOWS_CERT_PATH,
        certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
      }
    } : {}),
    extraResource: [
      './resources/bun',
      './resources/web',
      './resources/bundle',
      './resources/node_modules',
      './resources/templates',
      './resources/runtime-template',
      './resources/canvas-runtime',
      './resources/seed.db',
      './resources/package.json',
      './prisma',
      './prisma.config.js',
    ],
    ignore: [
      /^\/src/,
      /^\/scripts/,
      /tsconfig\.json$/,
      /forge\.config\.ts$/,
    ],
  },
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
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
