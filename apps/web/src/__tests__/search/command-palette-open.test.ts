/**
 * E2E Test: Command Palette (Search)
 * 
 * Tests the command palette functionality:
 * 1. ⌘K opens the search dialog
 * 2. User can search for pages and projects
 * 3. User can navigate using keyboard
 * 4. User can close the dialog
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Command Palette E2E', () => {
  test('⌘K opens the search dialog', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Press ⌘K (Meta+K on Mac, Ctrl+K on Windows/Linux)
    await page.keyboard.press('Meta+k')
    
    // Wait for search dialog to appear
    const searchDialog = page.getByRole('dialog', { name: /Search/i })
    await expect(searchDialog).toBeVisible({ timeout: 5000 })
    
    // Verify search input is focused
    const searchInput = page.getByRole('textbox', { name: /Search for pages/i })
    await expect(searchInput).toBeVisible()
    
    // Verify input is focused (should be active)
    await expect(searchInput).toBeFocused()
  })

  test('user can search for pages in command palette', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Open command palette
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)
    
    // Type to search
    const searchInput = page.getByRole('textbox', { name: /Search for pages/i })
    await searchInput.fill('projects')
    
    // Wait for results
    await page.waitForTimeout(500)
    
    // Verify results appear (should show "All Projects" or similar)
    const results = page.locator('[role="dialog"] button, [role="dialog"] a')
    const resultsCount = await results.count()
    expect(resultsCount).toBeGreaterThan(0)
  })

  test('user can navigate command palette with keyboard', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Open command palette
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)
    
    // Press down arrow to navigate
    await page.keyboard.press('ArrowDown')
    await page.waitForTimeout(200)
    
    // Press Enter to select
    await page.keyboard.press('Enter')
    
    // Should navigate to selected page
    await page.waitForTimeout(1000)
    
    // Dialog should be closed
    const searchDialog = page.getByRole('dialog', { name: /Search/i })
    await expect(searchDialog).not.toBeVisible()
  })

  test('user can close command palette with Escape', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Open command palette
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)
    
    // Verify dialog is open
    const searchDialog = page.getByRole('dialog', { name: /Search/i })
    await expect(searchDialog).toBeVisible()
    
    // Press Escape
    await page.keyboard.press('Escape')
    await page.waitForTimeout(500)
    
    // Dialog should be closed
    await expect(searchDialog).not.toBeVisible()
  })

  test('user can search for projects in command palette', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project with unique name
    const uniqueName = `Searchable Project ${Date.now()}`
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(uniqueName)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    await page.waitForTimeout(2000)
    
    // Open command palette
    await page.keyboard.press('Meta+k')
    await page.waitForTimeout(500)
    
    // Search for the project
    const searchInput = page.getByRole('textbox', { name: /Search for pages/i })
    await searchInput.fill('Searchable')
    
    // Wait for results
    await page.waitForTimeout(1000)
    
    // Verify project appears in results
    const projectResult = page.getByText(uniqueName).first()
    await expect(projectResult).toBeVisible({ timeout: 5000 })
  })
})
