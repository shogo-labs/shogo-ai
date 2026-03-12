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
    ...(process.env.WINDOWS_CERT_PATH && process.env.WINDOWS_CERT_PASSWORD ? {
      windowsSign: {
        certificateFile: process.env.WINDOWS_CERT_PATH,
        certificatePassword: process.env.WINDOWS_CERT_PASSWORD,
        timestampServer: 'http://timestamp.digicert.com'
      }
    } : {}),
    extraResource: [
      './resources/bun',
      './resources/web',
      './resources/bundle',
      './resources/node_modules',
      './resources/prisma',
      './resources/package.json',
      './resources/prisma.config.local.ts',
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
