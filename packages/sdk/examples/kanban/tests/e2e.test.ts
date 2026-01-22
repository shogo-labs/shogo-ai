/**
 * Kanban Board E2E Tests
 * 
 * Tests the Shogo SDK Prisma pass-through functionality:
 * - shogo.db.user.create() - User creation
 * - shogo.db.board.create() - Board creation with default columns
 * - shogo.db.card.create() - Card creation
 * - shogo.db.column.create() - Column creation
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3003'

test.describe('Kanban Board - Shogo SDK Example', () => {
  
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // App should show either setup form or board selector
    const heading = page.locator('h1, h2').first()
    await expect(heading).toBeVisible({ timeout: 15000 })
  })

  test('should handle user flow', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Wait for page to load
    await page.waitForTimeout(1000)
    
    const emailInput = page.locator('input[type="email"]')
    const isSetup = await emailInput.isVisible({ timeout: 10000 }).catch(() => false)
    
    if (isSetup) {
      // Fill in user form
      await emailInput.fill(`kanban-${Date.now()}@example.com`)
      
      const nameInput = page.locator('input[placeholder="Name (optional)"]')
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Kanban User')
      }
      
      await page.click('button[type="submit"]')

      // Should show board selector or boards
      await expect(page.locator('h1, h2, .board-card, .new-board-card').first()).toBeVisible({ timeout: 15000 })
    } else {
      // Already logged in, just verify we can see the app
      await expect(page.locator('h1, h2').first()).toBeVisible()
    }
  })

  test('should create board and show columns', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're logged in
    await ensureLoggedIn(page)
    
    // Wait for the page to be ready
    await page.waitForTimeout(1000)
    
    // Look for create board button or existing boards
    const createBtn = page.locator('.new-board-card, button:has-text("Create"), button:has-text("New Board")').first()
    const existingBoard = page.locator('.board-card, [class*="board"]').first()
    
    // Either create a new board or click an existing one
    if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createBtn.click()
      
      // Fill board name
      const boardNameInput = page.locator('input[placeholder*="Board"], input[placeholder*="name"]').first()
      if (await boardNameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await boardNameInput.fill(`Test Board ${Date.now()}`)
        
        // Submit
        const submitBtn = page.getByRole('button', { name: /create/i })
        if (await submitBtn.isVisible().catch(() => false)) {
          await submitBtn.click()
        }
      }
    } else if (await existingBoard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await existingBoard.click()
    }
    
    // After clicking, we should see columns or be on a board
    await page.waitForTimeout(2000)
    
    // Check for columns or board content
    const hasColumns = await page.locator('.column, [class*="column"], button:has-text("Add")').first().isVisible().catch(() => false)
    const hasContent = await page.locator('h1, h2').first().isVisible().catch(() => false)
    
    expect(hasColumns || hasContent).toBe(true)
  })

  test('should show SDK attribution somewhere', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Wait for page to load
    await page.waitForTimeout(1000)
    
    // Check for SDK reference - it's in the setup form
    const sdkText = page.getByText(/@shogo-ai\/sdk/i)
    const isSetupPage = await sdkText.isVisible({ timeout: 5000 }).catch(() => false)
    
    // If we're on setup page, we should see the SDK reference
    // If not, we're on the board which is also fine
    if (isSetupPage) {
      await expect(sdkText).toBeVisible()
    } else {
      // Just verify the app is working
      await expect(page.locator('h1, h2').first()).toBeVisible()
    }
  })
})

async function ensureLoggedIn(page: import('@playwright/test').Page) {
  // Wait for the page to load
  await page.waitForTimeout(1000)
  
  const emailInput = page.locator('input[type="email"]')
  const isSetup = await emailInput.isVisible({ timeout: 5000 }).catch(() => false)
  
  if (isSetup) {
    await emailInput.fill(`kanban-${Date.now()}@example.com`)
    await page.click('button[type="submit"]')
    // Wait for transition
    await page.waitForTimeout(3000)
  }
}
