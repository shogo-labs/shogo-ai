import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run tests sequentially to avoid DB conflicts
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // Single worker for E2E tests
  reporter: 'html',
  timeout: 30000,

  use: {
    baseURL: 'http://localhost:5174',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Start backend and frontend before running tests
  webServer: [
    {
      command: 'cd examples/todo-app/backend && bun run start',
      url: 'http://localhost:3002',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: 'cd examples/todo-app/frontend && bun run dev',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
  ],
})
