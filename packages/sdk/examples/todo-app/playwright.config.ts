import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Run tests sequentially for database consistency
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 2, // Always retry to capture traces on failure
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  timeout: 30000,
  // Output directory for test results (traces, screenshots, etc.)
  outputDir: './test-results',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    // Always capture traces for replay in the UI
    trace: 'on',
    // Always capture screenshots
    screenshot: 'on',
    // Capture video on failure for additional debugging
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Only use webServer in CI or when explicitly requested
  ...(process.env.START_SERVER ? {
    webServer: {
      command: 'bun run dev',
      url: 'http://localhost:3000',
      reuseExistingServer: !process.env.CI,
      timeout: 120000,
    },
  } : {}),
})
