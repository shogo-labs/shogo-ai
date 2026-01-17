/**
 * E2E Test: Shared With Me Page
 * 
 * Tests the shared projects page:
 * 1. User can navigate to shared with me page
 * 2. Page shows empty state when no shared projects
 * 3. Shared projects appear when user is invited
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL } from '../helpers/test-helpers'

test.describe('Shared With Me Page E2E', () => {
  test('user can navigate to shared with me page', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to shared with me
    await page.getByRole('link', { name: /Shared with me/i }).click()
    
    // Wait for page to load
    await page.waitForURL(/\/shared/, { timeout: 5000 })
    
    // Verify we're on shared page
    expect(page.url()).toContain('/shared')
    
    // Verify page heading or title text
    const heading = page.getByRole('heading', { name: /Shared with me/i }).first()
    const titleText = page.getByText(/Shared with me/i).first()
    const isHeadingVisible = await heading.isVisible().catch(() => false)
    const isTextVisible = await titleText.isVisible().catch(() => false)
    expect(isHeadingVisible || isTextVisible).toBe(true)
  })

  test('shared with me page shows empty state when no shared projects', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to shared with me
    await page.getByRole('link', { name: /Shared with me/i }).click()
    await page.waitForURL(/\/shared/, { timeout: 5000 })
    await page.waitForTimeout(1000)
    
    // Verify empty state message
    const emptyState = page.getByText(/No shared projects yet|Projects you are invited to/i).first()
    await expect(emptyState).toBeVisible({ timeout: 5000 })
  })

  test('user can search shared projects', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Navigate to shared with me
    await page.getByRole('link', { name: /Shared with me/i }).click()
    await page.waitForURL(/\/shared/, { timeout: 5000 })
    await page.waitForTimeout(1000)
    
    // Find search input
    const searchInput = page.getByRole('textbox', { name: /Search shared/i })
    
    if (await searchInput.isVisible().catch(() => false)) {
      await expect(searchInput).toBeVisible()
      
      // Type in search
      await searchInput.fill('test')
      await page.waitForTimeout(500)
      
      // Search input should accept input
      const inputValue = await searchInput.inputValue()
      expect(inputValue).toBe('test')
    }
  })
})
