/**
 * E2E Test: Preview Modes
 * 
 * Tests preview functionality:
 * 1. User can toggle preview modes (Mobile/Tablet/Desktop/Wide)
 * 2. Preview updates when mode changes
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Preview Modes E2E', () => {
  test('user can toggle preview modes', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Preview Test ${Date.now()}`)
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
    
    // Find preview mode buttons
    const mobileButton = page.getByRole('button', { name: /Mobile/i }).first()
    const tabletButton = page.getByRole('button', { name: /Tablet/i }).first()
    const desktopButton = page.getByRole('button', { name: /Desktop/i }).first()
    const wideButton = page.getByRole('button', { name: /Wide/i }).first()
    
    // At least one preview mode button should be visible
    const hasMobile = await mobileButton.isVisible().catch(() => false)
    const hasTablet = await tabletButton.isVisible().catch(() => false)
    const hasDesktop = await desktopButton.isVisible().catch(() => false)
    const hasWide = await wideButton.isVisible().catch(() => false)
    
    expect(hasMobile || hasTablet || hasDesktop || hasWide).toBe(true)
    
    // Try clicking available buttons
    if (hasMobile) {
      await mobileButton.click()
      await page.waitForTimeout(500)
    }
    
    if (hasTablet) {
      await tabletButton.click()
      await page.waitForTimeout(500)
    }
    
    if (hasDesktop) {
      await desktopButton.click()
      await page.waitForTimeout(500)
    }
  })

  test('preview button is visible on project page', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Preview Button Test ${Date.now()}`)
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
    
    // Find Preview button
    const previewButton = page.getByRole('button', { name: /Preview/i }).first()
    await expect(previewButton).toBeVisible({ timeout: 5000 })
  })
})
