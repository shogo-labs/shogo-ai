/**
 * E2E Test: Preview Modes
 * 
 * Tests preview functionality:
 * 1. User can toggle preview modes (Mobile/Tablet/Desktop/Wide)
 * 2. Preview iframe width updates when mode changes
 * 3. Active viewport button is highlighted
 */

import { test, expect } from '@playwright/test'
import { signUpUser, WEB_URL, waitForProjectCreation } from '../helpers/test-helpers'

test.describe('Preview Modes E2E', () => {
  test('viewport switcher changes iframe width', async ({ page }) => {
    // Sign up a user
    await signUpUser(page)
    
    // Create a project
    const chatInput = page.getByRole('textbox', { name: /Ask Shogo to create/i })
    await chatInput.fill(`Viewport Test ${Date.now()}`)
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
    
    // Find the preview iframe
    const iframe = page.locator('iframe').first()
    
    // Wait for iframe to be visible
    await expect(iframe).toBeVisible({ timeout: 30000 })
    
    // Get the direct parent div that has the inline width style (the viewport container)
    // This is the div with style="width: XXXpx" that wraps the iframe
    const viewportContainer = iframe.locator('xpath=parent::div')
    
    // Find preview mode buttons by title attribute (more reliable than name)
    const mobileButton = page.locator('button[title="Mobile"]').first()
    const tabletButton = page.locator('button[title="Tablet"]').first()
    const desktopButton = page.locator('button[title="Desktop"]').first()
    const wideButton = page.locator('button[title="Wide"]').first()
    
    // Verify at least one viewport button is visible
    const hasMobile = await mobileButton.isVisible().catch(() => false)
    const hasTablet = await tabletButton.isVisible().catch(() => false)
    const hasDesktop = await desktopButton.isVisible().catch(() => false)
    const hasWide = await wideButton.isVisible().catch(() => false)
    
    expect(hasMobile || hasTablet || hasDesktop || hasWide).toBe(true)
    
    // Test Mobile viewport (375px)
    if (hasMobile) {
      await mobileButton.click()
      await page.waitForTimeout(500) // Wait for animation
      
      const mobileWidth = await viewportContainer.evaluate((el) => {
        return el.getBoundingClientRect().width
      })
      
      // Mobile should be ~375px (allow some tolerance)
      expect(mobileWidth).toBeGreaterThanOrEqual(370)
      expect(mobileWidth).toBeLessThanOrEqual(380)
      
      // Verify mobile button is highlighted (has bg-background class)
      await expect(mobileButton).toHaveClass(/bg-background/)
    }
    
    // Test Tablet viewport (768px)
    if (hasTablet) {
      await tabletButton.click()
      await page.waitForTimeout(500) // Wait for animation
      
      const tabletWidth = await viewportContainer.evaluate((el) => {
        return el.getBoundingClientRect().width
      })
      
      // Tablet should be ~768px
      expect(tabletWidth).toBeGreaterThanOrEqual(760)
      expect(tabletWidth).toBeLessThanOrEqual(775)
      
      // Verify tablet button is highlighted
      await expect(tabletButton).toHaveClass(/bg-background/)
    }
    
    // Test Desktop viewport (1024px)
    if (hasDesktop) {
      await desktopButton.click()
      await page.waitForTimeout(500) // Wait for animation
      
      const desktopWidth = await viewportContainer.evaluate((el) => {
        return el.getBoundingClientRect().width
      })
      
      // Desktop should be ~1024px
      expect(desktopWidth).toBeGreaterThanOrEqual(1015)
      expect(desktopWidth).toBeLessThanOrEqual(1030)
      
      // Verify desktop button is highlighted
      await expect(desktopButton).toHaveClass(/bg-background/)
    }
    
    // Test Wide viewport (1440px)
    if (hasWide) {
      await wideButton.click()
      await page.waitForTimeout(500) // Wait for animation
      
      const wideWidth = await viewportContainer.evaluate((el) => {
        return el.getBoundingClientRect().width
      })
      
      // Wide should be ~1440px (or maxWidth: 100% if viewport is smaller)
      expect(wideWidth).toBeGreaterThanOrEqual(1400)
      
      // Verify wide button is highlighted
      await expect(wideButton).toHaveClass(/bg-background/)
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
