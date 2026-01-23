/**
 * Test helper utilities for E2E tests
 */

export const WEB_URL = process.env.WEB_URL || 'http://localhost:5173'
export const API_URL = process.env.API_URL || 'http://localhost:8002'

/**
 * Generate a unique test email
 */
export function generateTestEmail(prefix = 'test'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`
}

/**
 * Generate a unique test name
 */
export function generateTestName(prefix = 'Test User'): string {
  return `${prefix} ${Date.now()}`
}

/**
 * Default test password
 */
export const TEST_PASSWORD = 'TestPassword123!'

/**
 * Wait for workspace to be loaded
 */
export async function waitForWorkspaceLoad(page: any, timeout = 10000) {
  // Wait for the workspace view to appear
  await page.waitForSelector('h1:has-text("What\'s on your mind")', { timeout })
  
  // Wait a bit more for workspace data to sync
  await page.waitForTimeout(1000)
}

/**
 * Sign up a new user and return credentials
 */
export async function signUpUser(page: any) {
  const testEmail = generateTestEmail('test-signup')
  const testName = generateTestName('Test User')
  
  await page.goto(WEB_URL)
  await page.getByText('Sign in to your account or create a new one').waitFor()
  await page.getByRole('tab', { name: 'Sign Up' }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(testName)
  await page.getByRole('textbox', { name: 'Email' }).fill(testEmail)
  await page.getByRole('textbox', { name: 'Password' }).fill(TEST_PASSWORD)
  await page.getByRole('button', { name: 'Sign Up' }).click()
  
  // Wait for signup to complete
  await waitForWorkspaceLoad(page)
  
  return { email: testEmail, name: testName, password: TEST_PASSWORD }
}

/**
 * Sign in an existing user
 */
export async function signInUser(page: any, email: string, password: string = TEST_PASSWORD) {
  await page.goto(WEB_URL)
  await page.getByText('Sign in to your account or create a new one').waitFor()
  
  // Make sure we're on Sign In tab
  await page.getByRole('tab', { name: 'Sign In' }).click()
  
  await page.getByRole('textbox', { name: 'Email' }).fill(email)
  await page.getByRole('textbox', { name: 'Password' }).fill(password)
  await page.getByRole('button', { name: 'Sign In' }).click()
  
  // Wait for signin to complete
  await waitForWorkspaceLoad(page)
}

/**
 * Wait for project to be created - handles both redirect and non-redirect cases
 * Also waits for the project runtime to be ready to accept chat messages.
 */
export async function waitForProjectCreation(page: any, timeout = 30000) {
  const startTime = Date.now()
  
  try {
    // Try waiting for redirect to project page
    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 15000 })
  } catch (e) {
    // If no redirect, wait for project to appear in sidebar or for chat to load
    await page.waitForTimeout(3000)
    
    // Check if we're on a project page by looking for project-specific elements
    const projectIndicators = [
      page.locator('button:has-text("Preview")'),
      page.locator('text=/Chat Sessions|Start Discovery/i'),
      page.locator('a[href*="/projects/"]:not([href="/projects"])')
    ]
    
    // Wait for at least one indicator
    await Promise.race(
      projectIndicators.map(locator => locator.first().waitFor({ timeout: 5000 }).catch(() => {}))
    )
  }
  
  // Extract project ID from URL if available
  const url = page.url()
  const projectIdMatch = url.match(/\/projects\/([a-f0-9-]+)/)
  
  if (projectIdMatch) {
    const projectId = projectIdMatch[1]
    const remainingTimeout = Math.max(5000, timeout - (Date.now() - startTime))
    
    // Wait for the project runtime to be ready by calling the wake endpoint
    // This ensures the chat endpoint will work when we send messages
    await waitForProjectRuntime(page, projectId, remainingTimeout)
  }
  
  // Additional wait for UI to stabilize
  await page.waitForTimeout(1000)
}

/**
 * Wait for project runtime to be ready to accept chat messages.
 * Calls the wake endpoint to ensure the pod is started and healthy.
 * Uses constant 500ms delay with max 50 retries (up to 25 seconds total).
 */
export async function waitForProjectRuntime(page: any, projectId: string, _timeout = 30000) {
  const MAX_RETRIES = 50
  const RETRY_DELAY_MS = 500
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      // Use the wake endpoint to ensure the runtime is ready
      // This will start the pod if needed and wait for it to be healthy
      const response = await page.request.post(`${API_URL}/api/projects/${projectId}/chat/wake`)
      
      if (response.ok()) {
        const body = await response.json()
        if (body.success) {
          console.log(`[test-helpers] Project runtime ready for ${projectId} (attempt ${attempt})`)
          return
        }
      }
      
      // If wake fails, check status
      const statusResponse = await page.request.get(`${API_URL}/api/projects/${projectId}/chat/status`)
      if (statusResponse.ok()) {
        const status = await statusResponse.json()
        if (status.ready) {
          console.log(`[test-helpers] Project runtime already ready for ${projectId}`)
          return
        }
      }
    } catch (error) {
      // Ignore errors and retry
      if (attempt % 10 === 0) {
        console.log(`[test-helpers] Waiting for project runtime ${projectId}... (attempt ${attempt}/${MAX_RETRIES})`)
      }
    }
    
    if (attempt < MAX_RETRIES) {
      await page.waitForTimeout(RETRY_DELAY_MS)
    }
  }
  
  console.warn(`[test-helpers] Timeout waiting for project runtime ${projectId} after ${MAX_RETRIES} attempts, continuing anyway...`)
}
