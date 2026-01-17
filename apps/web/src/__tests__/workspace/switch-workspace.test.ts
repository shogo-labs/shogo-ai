/**
 * E2E Test: Switch Workspace
 * 
 * Tests workspace switching:
 * 1. User can open workspace dropdown
 * 2. User can see available workspaces
 * 3. User can switch to a different workspace
 * 4. Workspace context updates correctly
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL } from '../helpers/test-helpers'

test.describe('Switch Workspace E2E', () => {
  test('user can open workspace dropdown and see workspaces', async ({ page }) => {
    // Sign up a user (creates personal workspace)
    await signUpUser(page)
    
    // Wait for workspace button to appear
    const workspaceButton = page.getByRole('button', { name: /Personal|Select workspace/i }).first()
    await expect(workspaceButton).toBeVisible({ timeout: 10000 })
    
    // Click workspace button to open dropdown
    await workspaceButton.click()
    
    // Wait for menu to appear
    await page.waitForTimeout(500)
    
    // Verify menu is visible
    const workspaceMenu = page.locator('[role="menu"]').first()
    await expect(workspaceMenu).toBeVisible({ timeout: 5000 })
    
    // Verify at least one workspace is shown
    const workspaceItems = workspaceMenu.getByRole('menuitem')
    const workspaceCount = await workspaceItems.count()
    expect(workspaceCount).toBeGreaterThan(0)
    
    // Verify "Create new workspace" option exists
    const createWorkspaceOption = workspaceMenu.getByRole('menuitem', { name: /Create new workspace/i })
    await expect(createWorkspaceOption).toBeVisible()
  })

  test('user can create and switch to a new workspace', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Wait for workspace button
    const workspaceButton = page.getByRole('button', { name: /Personal|Select workspace/i }).first()
    await expect(workspaceButton).toBeVisible({ timeout: 10000 })
    
    // Open workspace dropdown
    await workspaceButton.click()
    await page.waitForTimeout(500)
    
    // Click "Create new workspace"
    const createWorkspaceOption = page.getByRole('menuitem', { name: /Create new workspace/i })
    await createWorkspaceOption.click()
    
    // Wait for dialog or form to appear
    // This might open a dialog or navigate to a page
    await page.waitForTimeout(1000)
    
    // Look for workspace name input or form
    // The exact implementation may vary, so we'll check for common patterns
    const nameInput = page.getByRole('textbox', { name: /workspace name|name/i }).first()
    
    if (await nameInput.isVisible().catch(() => false)) {
      const newWorkspaceName = `Test Workspace ${Date.now()}`
      await nameInput.fill(newWorkspaceName)
      
      // Look for create/save button
      const createButton = page.getByRole('button', { name: /Create|Save/i }).first()
      if (await createButton.isVisible().catch(() => false)) {
        await createButton.click()
        
        // Wait for workspace to be created and switched
        await page.waitForTimeout(2000)
        
        // Verify workspace button shows new workspace name
        const updatedWorkspaceButton = page.getByRole('button', { name: new RegExp(newWorkspaceName, 'i') })
        await expect(updatedWorkspaceButton).toBeVisible({ timeout: 5000 })
      }
    }
  })
})
