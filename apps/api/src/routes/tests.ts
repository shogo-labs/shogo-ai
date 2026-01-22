/**
 * Tests API Routes
 *
 * Endpoints for E2E test management and execution.
 * Provides structured test discovery and JSON reporter output.
 *
 * Endpoints:
 * - GET /projects/:projectId/tests/list - List test files and cases
 * - POST /projects/:projectId/tests/run - Run tests with JSON reporter (streaming)
 */

import { Hono } from "hono"
import { spawn, execSync } from "child_process"
import { existsSync, readdirSync, statSync, readFileSync } from "fs"
import { join, relative } from "path"

/**
 * Test file with its test cases
 */
export interface TestFile {
  /** Relative path to test file */
  path: string
  /** File name */
  name: string
  /** Test cases discovered in file */
  tests: TestCase[]
}

/**
 * Individual test case
 */
export interface TestCase {
  /** Test title */
  title: string
  /** Line number where test is defined */
  line?: number
  /** Full test path (describe > test) */
  fullTitle: string
}

/**
 * Test run result from JSON reporter
 */
export interface TestResult {
  status: 'passed' | 'failed' | 'skipped' | 'timedOut'
  title: string
  file: string
  line?: number
  duration?: number
  error?: string
  retries?: number
}

/**
 * Configuration for tests routes
 */
export interface TestsRoutesConfig {
  /**
   * Workspaces directory where projects are stored
   */
  workspacesDir: string
}

/**
 * Parse test file to extract test cases
 * Looks for test('...') and it('...') patterns
 */
function parseTestCases(filePath: string): TestCase[] {
  const tests: TestCase[] = []
  
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')
    
    // Stack to track describe blocks
    const describeStack: string[] = []
    
    lines.forEach((line, index) => {
      // Match describe blocks
      const describeMatch = line.match(/(?:describe|test\.describe)\s*\(\s*['"`]([^'"`]+)['"`]/)
      if (describeMatch) {
        describeStack.push(describeMatch[1])
      }
      
      // Match end of describe blocks (rough heuristic)
      if (line.match(/^\s*\}\s*\)\s*;?\s*$/)) {
        describeStack.pop()
      }
      
      // Match test/it blocks
      const testMatch = line.match(/(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/)
      if (testMatch) {
        const title = testMatch[1]
        const fullTitle = describeStack.length > 0 
          ? `${describeStack.join(' › ')} › ${title}`
          : title
        
        tests.push({
          title,
          line: index + 1,
          fullTitle,
        })
      }
    })
  } catch {
    // File can't be read, return empty
  }
  
  return tests
}

/**
 * Recursively find test files in a directory
 */
function findTestFiles(dir: string, baseDir: string): TestFile[] {
  const files: TestFile[] = []
  
  if (!existsSync(dir)) {
    return files
  }
  
  const entries = readdirSync(dir, { withFileTypes: true })
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    
    if (entry.isDirectory()) {
      // Skip node_modules
      if (entry.name === 'node_modules') continue
      files.push(...findTestFiles(fullPath, baseDir))
    } else if (entry.isFile()) {
      // Match test files
      if (entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
        const relativePath = relative(baseDir, fullPath)
        const tests = parseTestCases(fullPath)
        
        files.push({
          path: relativePath,
          name: entry.name,
          tests,
        })
      }
    }
  }
  
  return files
}

/**
 * Create tests routes
 */
export function testsRoutes(config: TestsRoutesConfig) {
  const { workspacesDir } = config
  const router = new Hono()

  /**
   * GET /projects/:projectId/tests/list - List test files and cases
   * 
   * Response:
   * - files: TestFile[] - Array of test files with their test cases
   * - hasTests: boolean - Whether any test files were found
   */
  router.get("/projects/:projectId/tests/list", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Look for test files in common locations
    const testLocations = ['tests', 'test', '__tests__', 'e2e', 'spec']
    let allFiles: TestFile[] = []
    
    for (const loc of testLocations) {
      const testDir = join(projectDir, loc)
      if (existsSync(testDir)) {
        allFiles.push(...findTestFiles(testDir, projectDir))
      }
    }
    
    // Also check root for test files
    try {
      const rootEntries = readdirSync(projectDir, { withFileTypes: true })
      for (const entry of rootEntries) {
        if (entry.isFile() && entry.name.match(/\.(test|spec)\.(ts|tsx|js|jsx)$/)) {
          const tests = parseTestCases(join(projectDir, entry.name))
          allFiles.push({
            path: entry.name,
            name: entry.name,
            tests,
          })
        }
      }
    } catch {
      // Ignore errors reading root
    }

    // Deduplicate by path
    const seen = new Set<string>()
    const files = allFiles.filter(f => {
      if (seen.has(f.path)) return false
      seen.add(f.path)
      return true
    })

    return c.json({
      files,
      hasTests: files.length > 0,
      totalTests: files.reduce((sum, f) => sum + f.tests.length, 0),
    }, 200)
  })

  /**
   * POST /projects/:projectId/tests/run - Run tests with options
   *
   * Request body:
   * - file?: string - Specific test file to run (relative path)
   * - testName?: string - Specific test name pattern (grep)
   * - headed?: boolean - Run in headed mode
   * - reporter?: 'list' | 'json' | 'line' - Reporter to use
   *
   * Response: Streaming text output of the command
   */
  router.post("/projects/:projectId/tests/run", async (c) => {
    const projectId = c.req.param("projectId")
    const projectDir = join(workspacesDir, projectId)

    // Verify project exists
    if (!existsSync(projectDir)) {
      return c.json(
        { error: { code: "project_not_found", message: "Project not found" } },
        404
      )
    }

    // Parse request body
    let body: { 
      file?: string
      testName?: string
      headed?: boolean
      reporter?: 'list' | 'json' | 'line'
    } = {}
    
    try {
      body = await c.req.json()
    } catch {
      // Empty body is fine, use defaults
    }

    const { file, testName, headed, reporter = 'list' } = body

    // Build command
    let command = 'bunx playwright test'
    
    // Add specific file
    if (file) {
      command += ` "${file}"`
    }
    
    // Add test name filter (grep)
    if (testName) {
      command += ` --grep "${testName}"`
    }
    
    // Add headed mode
    if (headed) {
      command += ' --headed'
    }
    
    // Add reporter
    command += ` --reporter=${reporter}`

    const timeout = 180000 // 3 minutes

    console.log(`[Tests] Running: ${command} in ${projectDir}`)

    // Create a streaming response
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()

    // Execute command asynchronously
    ;(async () => {
      try {
        // Write header
        await writer.write(encoder.encode(`$ ${command}\n\n`))

        // Spawn the command
        const child = spawn('sh', ['-c', command], {
          cwd: projectDir,
          env: {
            ...process.env,
            FORCE_COLOR: '1',
            CI: 'true',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        })

        // Set up timeout
        const timeoutId = setTimeout(() => {
          child.kill('SIGTERM')
          writer.write(encoder.encode('\n\n[ERROR] Tests timed out\n'))
        }, timeout)

        // Stream stdout
        child.stdout?.on('data', async (data: Buffer) => {
          try {
            await writer.write(data)
          } catch {
            // Writer closed, ignore
          }
        })

        // Stream stderr
        child.stderr?.on('data', async (data: Buffer) => {
          try {
            await writer.write(data)
          } catch {
            // Writer closed, ignore
          }
        })

        // Handle completion
        child.on('close', async (code) => {
          clearTimeout(timeoutId)
          try {
            await writer.write(encoder.encode(`\n\n[Process exited with code ${code}]\n`))
            await writer.close()
          } catch {
            // Writer already closed, ignore
          }
        })

        // Handle errors
        child.on('error', async (err) => {
          clearTimeout(timeoutId)
          try {
            await writer.write(encoder.encode(`\n\n[ERROR] ${err.message}\n`))
            await writer.close()
          } catch {
            // Writer already closed, ignore
          }
        })

      } catch (err: any) {
        try {
          await writer.write(encoder.encode(`[ERROR] ${err.message}\n`))
          await writer.close()
        } catch {
          // Writer already closed, ignore
        }
      }
    })()

    // Return streaming response
    return new Response(readable, {
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  })

  return router
}

export default testsRoutes
