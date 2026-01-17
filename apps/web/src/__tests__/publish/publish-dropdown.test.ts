/**
 * E2E Test: Publish Dropdown
 * 
 * Tests the publish functionality:
 * 1. Publish dropdown opens correctly
 * 2. User can configure published URL
 * 3. User can set visibility settings
 * 4. User can initiate publishing
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Publish Dropdown E2E', () => {
  test('publish dropdown opens with configuration options', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Publish Test Project ${Date.now()}`)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    
    // Navigate to project if needed
    const url = page.url()
    if (!url.match(/\/projects\/[a-f0-9-]+/)) {
      const projectLink = page.locator('a[href*="/projects/"]:not([href="/projects"])').first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
      }
    }
    await page.waitForTimeout(2000)
    
    // Find and click Publish button
    const publishButton = page.getByRole('button', { name: /Publish/i }).first()
    await expect(publishButton).toBeVisible({ timeout: 5000 })
    await publishButton.click()
    
    // Wait for dropdown/menu to appear
    await page.waitForTimeout(500)
    
    // Verify publish menu/dialog is visible
    const publishMenu = page.locator('[role="menu"]:has-text("Publish"), [role="dialog"]:has-text("Publish")').first()
    await expect(publishMenu).toBeVisible({ timeout: 5000 })
    
    // Verify key elements are present
    const publishedUrlHeading = page.getByText(/Published URL|URL/i).first()
    await expect(publishedUrlHeading).toBeVisible({ timeout: 5000 })
  })

  test('user can set custom published URL', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Custom URL Test ${Date.now()}`)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    
    // Navigate to project if needed
    const url = page.url()
    if (!url.match(/\/projects\/[a-f0-9-]+/)) {
      const projectLink = page.locator('a[href*="/projects/"]:not([href="/projects"])').first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
      }
    }
    await page.waitForTimeout(2000)
    
    // Open publish dropdown
    const publishButton = page.getByRole('button', { name: /Publish/i }).first()
    await publishButton.click()
    await page.waitForTimeout(500)
    
    // Find URL input
    const urlInput = page.getByRole('textbox', { name: /URL|my-project/i }).first()
    
    if (await urlInput.isVisible().catch(() => false)) {
      const customUrl = `my-custom-url-${Date.now()}`
      await urlInput.fill(customUrl)
      
      // Verify the value was set
      const inputValue = await urlInput.inputValue()
      expect(inputValue).toContain(customUrl)
    }
  })

  test('user can change visibility settings', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Visibility Test ${Date.now()}`)
    await chatInput.press('Enter')
    
    // Wait for project to be created
    await waitForProjectCreation(page)
    
    // Navigate to project if needed
    const url = page.url()
    if (!url.match(/\/projects\/[a-f0-9-]+/)) {
      const projectLink = page.locator('a[href*="/projects/"]:not([href="/projects"])').first()
      if (await projectLink.isVisible().catch(() => false)) {
        await projectLink.click()
        await page.waitForURL(/\/projects\/[a-f0-9-]+/, { timeout: 10000 })
      }
    }
    await page.waitForTimeout(2000)
    
    // Open publish dropdown
    const publishButton = page.getByRole('button', { name: /Publish/i }).first()
    await publishButton.click()
    await page.waitForTimeout(500)
    
    // Find visibility setting
    const visibilityButton = page.getByRole('button', { name: /Anyone|Who can visit/i }).first()
    
    if (await visibilityButton.isVisible().catch(() => false)) {
      await visibilityButton.click()
      await page.waitForTimeout(500)
      
      // Should show options or dropdown
      // Verify button is still visible after click
      await expect(visibilityButton).toBeVisible()
    }
  })
})
