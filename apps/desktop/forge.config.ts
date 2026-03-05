import type { ForgeConfig } from '@electron-forge/cli'

const config: ForgeConfig = {
  packagerConfig: {
    name: 'Shogo',
    icon: './resources/icon',
    asar: true,
    extraResource: [
      './resources/bun',
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
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'Shogo',
      },
    },
  ],
}

export default config
