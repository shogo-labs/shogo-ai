/**
 * Test: RuntimeManager Template Copy Integration
 * 
 * Verifies that RuntimeManager correctly copies the bundled Vite template
 * when creating a new project directory.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { existsSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { RuntimeManager } from '../manager'

const TEST_WORKSPACES_DIR = join(import.meta.dir, '.test-workspaces')
const TEST_PROJECT_ID = 'test-template-copy-' + Date.now()

describe('RuntimeManager Template Copy', () => {
  let manager: RuntimeManager

  beforeAll(() => {
    // Clean up any previous test artifacts
    if (existsSync(TEST_WORKSPACES_DIR)) {
      rmSync(TEST_WORKSPACES_DIR, { recursive: true, force: true })
    }

    manager = new RuntimeManager({
      workspacesDir: TEST_WORKSPACES_DIR,
      basePort: 15200, // Use a different port range for tests
    })
  })

  afterAll(async () => {
    // Stop any running runtimes
    await manager.stopAll()

    // Clean up test directory
    if (existsSync(TEST_WORKSPACES_DIR)) {
      rmSync(TEST_WORKSPACES_DIR, { recursive: true, force: true })
    }
  })

  test('should copy bundled template when starting a project', async () => {
    // Start a project (this will create the directory and copy template)
    const runtime = await manager.start(TEST_PROJECT_ID)

    // Verify runtime started
    expect(runtime.status).toBe('running')
    expect(runtime.port).toBeGreaterThanOrEqual(15200)
    expect(runtime.url).toContain('localhost')

    // Verify project directory was created
    const projectDir = join(TEST_WORKSPACES_DIR, TEST_PROJECT_ID)
    expect(existsSync(projectDir)).toBe(true)

    // Verify key files from template were copied
    expect(existsSync(join(projectDir, 'package.json'))).toBe(true)
    expect(existsSync(join(projectDir, 'vite.config.ts'))).toBe(true)
    expect(existsSync(join(projectDir, 'index.html'))).toBe(true)
    expect(existsSync(join(projectDir, 'tsconfig.json'))).toBe(true)
    expect(existsSync(join(projectDir, 'src', 'App.tsx'))).toBe(true)
    expect(existsSync(join(projectDir, 'src', 'main.tsx'))).toBe(true)

    // Verify package.json content is from template
    const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf-8'))
    expect(packageJson.name).toBe('project')
    expect(packageJson.dependencies.react).toBeDefined()
    expect(packageJson.devDependencies.vite).toBeDefined()

    // Verify vite.config.ts has host: '0.0.0.0' configuration
    const viteConfig = readFileSync(join(projectDir, 'vite.config.ts'), 'utf-8')
    expect(viteConfig).toContain("host: '0.0.0.0'")
    expect(viteConfig).toContain('port: 5173')

    // Verify node_modules was installed
    expect(existsSync(join(projectDir, 'node_modules'))).toBe(true)

    // Stop the runtime
    await manager.stop(TEST_PROJECT_ID)
    expect(manager.status(TEST_PROJECT_ID)).toBe(null)
  }, 120000) // 2 minute timeout for install + startup
})
