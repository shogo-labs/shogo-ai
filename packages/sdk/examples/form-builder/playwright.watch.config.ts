/**
 * Playwright Watch Config
 *
 * Extends the base playwright.config.ts with video recording and slowMo
 * for the "Watch" mode in the Tests panel. This config is used when
 * running tests with `--config playwright.watch.config.ts`.
 *
 * - video: 'on' - always record video (base config uses 'retain-on-failure')
 * - slowMo: 500 - add 500ms delay between actions so the video looks natural
 */
import { defineConfig, devices } from '@playwright/test'
import baseConfig from './playwright.config'

export default defineConfig({
  ...baseConfig,
  use: {
    ...baseConfig.use,
    video: 'on',
    launchOptions: {
      ...baseConfig.use?.launchOptions,
      slowMo: 500,
    },
  },
})
