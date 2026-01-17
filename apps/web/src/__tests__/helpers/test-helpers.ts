/**
 * Test helper utilities for E2E tests
 */

export const WEB_URL = process.env.WEB_URL || 'http://localhost:5173'

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
 */
export async function waitForProjectCreation(page: any, timeout = 20000) {
  try {
    // Try waiting for redirect to project page
    await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
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
  
  // Additional wait for UI to stabilize
  await page.waitForTimeout(1000)
}
