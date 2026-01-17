import { defineConfig, devices } from '@playwright/test';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Load .env.local from monorepo root
 */
function loadEnvLocal() {
  // Get directory name in ES module context
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const monorepoRoot = join(__dirname, '../..');
  const envLocalPath = join(monorepoRoot, '.env.local');
  
  try {
    const envFile = readFileSync(envLocalPath, 'utf-8');
    const envVars: Record<string, string> = {};
    
    // Parse .env.local file (simple parser for KEY=VALUE format)
    envFile.split('\n').forEach((line) => {
      // Skip comments and empty lines
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      
      // Parse KEY=VALUE
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (match) {
        const [, key, value] = match;
        // Remove quotes if present
        const unquotedValue = value.replace(/^["']|["']$/g, '');
        envVars[key.trim()] = unquotedValue;
      }
    });
    
    // Set environment variables (only if not already set)
    Object.entries(envVars).forEach(([key, value]) => {
      if (!process.env[key]) {
        process.env[key] = value;
      }
    });
  } catch (error) {
    // .env.local doesn't exist or can't be read - that's okay
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`Warning: Could not load .env.local: ${error}`);
    }
  }
}

// Load .env.local before configuring Playwright
loadEnvLocal();

/**
 * See https://playwright.dev/docs/test-configuration.
 */
export default defineConfig({
  testDir: './src/__tests__',
  /* Run tests in files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Base URL to use in actions like `await page.goto('/')`. */
    baseURL: process.env.WEB_URL || 'http://localhost:5173',
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: 'on-first-retry',
  },

  /* Configure projects for major browsers */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /* Run your local dev server, API server, and MCP server before starting the tests */
  webServer: [
    {
      command: 'cd ../../ && DATABASE_URL="${DATABASE_URL:-postgres://shogo:shogo_dev@localhost:5432/shogo}" bun run mcp:http',
      url: 'http://localhost:3100/mcp',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://shogo:shogo_dev@localhost:5432/shogo',
        ...process.env,
      },
    },
    {
      command: 'cd ../../ && DATABASE_URL="${DATABASE_URL:-postgres://shogo:shogo_dev@localhost:5432/shogo}" bun run api:start',
      url: 'http://localhost:8002/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        DATABASE_URL: process.env.DATABASE_URL || 'postgres://shogo:shogo_dev@localhost:5432/shogo',
        ...process.env,
      },
    },
    {
      command: 'bun run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 120 * 1000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
