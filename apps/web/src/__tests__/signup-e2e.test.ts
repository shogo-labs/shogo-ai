/**
 * E2E Test: Signup Flow
 * 
 * Tests the complete signup flow:
 * 1. User can sign up with name, email, and password
 * 2. Personal workspace is created for the user
 * 3. Personal workspace is automatically selected after signup
 * 4. User is redirected to workspace view
 * 
 * This test uses Playwright to interact with the browser.
 */

import { test, expect } from '@playwright/test'

const WEB_URL = process.env.WEB_URL || 'http://localhost:5173'

test.describe('Signup Flow E2E', () => {
  test('user can sign up and personal workspace is created and selected', async ({ page }) => {
    // Generate unique test email to avoid conflicts
    const testEmail = `test-signup-e2e-${Date.now()}@example.com`
    const testName = 'Test User E2E'
    const testPassword = 'TestPassword123!'

    // Navigate to app (should show login page)
    await page.goto(WEB_URL)
    
    // Wait for login page to load
    await expect(page.getByText('Sign in to your account or create a new one')).toBeVisible()
    
    // Click on Sign Up tab
    await page.getByRole('tab', { name: 'Sign Up' }).click()
    
    // Fill in signup form
    await page.getByRole('textbox', { name: 'Name' }).fill(testName)
    await page.getByRole('textbox', { name: 'Email' }).fill(testEmail)
    await page.getByRole('textbox', { name: 'Password' }).fill(testPassword)
    
    // Submit the form
    await page.getByRole('button', { name: 'Sign Up' }).click()
    
    // Wait for signup to complete and user to be authenticated
    // After signup, AuthGate should render the workspace view
    await expect(page.getByRole('heading', { name: /What's on your mind/i })).toBeVisible({ timeout: 10000 })
    
    // Verify we're on the workspace view (not login page)
    await expect(page.getByText('Sign in to your account')).not.toBeVisible()
    
    // Wait for workspace data to load - check console for any errors
    const consoleErrors: string[] = []
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text()
        consoleErrors.push(text)
        // Log MCP-related errors specifically
        if (text.includes('workspace') || text.includes('member') || text.includes('useWorkspaceData')) {
          console.log(`Browser console error: ${text}`)
        }
      }
    })
    
    // Wait for workspace to be created and loaded
    // The workspace is created via database hook, then frontend needs to query it
    // Try waiting for the workspace selector to show a workspace name (not "Select workspace")
    try {
      await page.waitForFunction(
        () => {
          const button = document.querySelector('button[aria-haspopup="menu"]')
          if (!button) return false
          const text = button.textContent || ''
          // Check if button shows a workspace name (not "Select workspace" or "W Select workspace")
          return text && !text.toLowerCase().includes('select workspace') && text.length > 5
        },
        { timeout: 15000 }
      )
    } catch (e) {
      console.log('Workspace did not auto-select within timeout')
    }
    
    // Additional wait for data to sync
    await page.waitForTimeout(2000)
    
    // Verify workspace selector shows a workspace name (not "Select workspace")
    // After successful signup, workspace should auto-select and show the workspace name
    const workspaceButton = page.locator('button').filter({ hasText: /Personal/i }).first()
    await expect(workspaceButton).toBeVisible({ timeout: 10000 })
    
    // Click workspace selector to see available workspaces
    await workspaceButton.click()
    
    // Wait for menu to appear
    await page.waitForTimeout(500)
    
    // Verify personal workspace exists in the dropdown
    // The workspace should contain "Personal" in its name
    // Try multiple selectors for the menu
    const workspaceMenu = page.locator('[role="menu"]').or(page.locator('menu')).first()
    await expect(workspaceMenu).toBeVisible({ timeout: 5000 })
    
    // Check that there's at least one workspace option (not just "Create new workspace")
    const workspaceItems = workspaceMenu.getByRole('menuitem')
    const workspaceCount = await workspaceItems.count()
    expect(workspaceCount).toBeGreaterThan(0)
    
    // Debug: Log all workspace items to see what's available
    const workspaceTexts: string[] = []
    for (let i = 0; i < workspaceCount; i++) {
      const itemText = await workspaceItems.nth(i).textContent()
      if (itemText) {
        workspaceTexts.push(itemText)
        console.log(`Workspace ${i}: ${itemText}`)
      }
    }
    
    // Verify at least one workspace contains "Personal" in its name
    let foundPersonalWorkspace = false
    for (const text of workspaceTexts) {
      if (text.toLowerCase().includes('personal')) {
        foundPersonalWorkspace = true
        break
      }
    }
    
    // If no personal workspace found, fail with helpful message
    if (!foundPersonalWorkspace) {
      console.error(`No personal workspace found. Available workspaces: ${workspaceTexts.join(', ')}`)
    }
    expect(foundPersonalWorkspace).toBe(true)
    
    // Verify workspace button text contains "Personal" (after auto-selection)
    // Note: Workspace selection is stored in state, not necessarily in the URL
    const workspaceText = await workspaceButton.textContent()
    expect(workspaceText).toMatch(/personal/i)
  })
})
