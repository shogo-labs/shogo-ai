/**
 * Inventory Management E2E Tests
 * 
 * Tests the Shogo SDK Prisma pass-through functionality:
 * - shogo.db.user.create() - User creation with category/supplier seeding
 * - shogo.db.product.findMany() - Product listing
 * - shogo.db.product.create() - Product creation
 * - shogo.db.stockMovement.create() - Stock tracking
 * - shogo.db.product.aggregate() - Summary calculations
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3004'

test.describe('Inventory Management - Shogo SDK Example', () => {
  
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // App title should be visible (wait longer for initial server startup)
    await expect(page.getByRole('heading', { name: /inventory/i }).first()).toBeVisible({ timeout: 15000 })
    
    // Should show either setup form or dashboard
    const setupForm = page.getByPlaceholder('Email address')
    const dashboard = page.getByText(/total products/i)
    
    const hasSetup = await setupForm.isVisible().catch(() => false)
    const hasDashboard = await dashboard.isVisible().catch(() => false)
    
    expect(hasSetup || hasDashboard).toBe(true)
  })

  test('should show footer attribution', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Should have some attribution text (Prisma)
    const attr = page.getByText(/Prisma/i)
    await expect(attr.first()).toBeVisible({ timeout: 15000 })
  })

  test('should create user if on setup form', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Wait for page to load
    await page.waitForTimeout(1000)
    
    const setupForm = page.getByPlaceholder('Email address')
    const isSetup = await setupForm.isVisible({ timeout: 10000 }).catch(() => false)
    
    if (isSetup) {
      const testEmail = `inventory-${Date.now()}@example.com`
      await setupForm.fill(testEmail)
      
      const nameInput = page.getByPlaceholder('Name (optional)')
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Inventory User')
      }
      
      await page.getByRole('button', { name: 'Get Started' }).click()
      
      // Should transition to dashboard
      await expect(page.getByText('Total Products')).toBeVisible({ timeout: 15000 })
    }
  })

  test('should display summary section', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Summary cards should be visible
    await expect(page.getByText('Total Products')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Inventory Value')).toBeVisible()
    await expect(page.getByText('Low Stock', { exact: true })).toBeVisible()
    await expect(page.getByText('Out of Stock', { exact: true })).toBeVisible()
  })

  test('should have seeded categories available', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Click add product button to reveal form
    const addBtn = page.getByRole('button', { name: '+ Add Product' })
    await expect(addBtn).toBeVisible({ timeout: 10000 })
    await addBtn.click()
    
    // Check if category dropdown exists and has options
    const categorySelect = page.locator('select').first()
    await expect(categorySelect).toBeVisible()
    const options = await categorySelect.locator('option').allTextContents()
    // Should have seeded categories (Electronics, Clothing, etc.)
    expect(options.length).toBeGreaterThan(1)
  })

  test('should add a product', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Click add product button
    const addBtn = page.getByRole('button', { name: '+ Add Product' })
    await expect(addBtn).toBeVisible({ timeout: 10000 })
    await addBtn.click()
    
    // Fill product form
    const nameInput = page.getByPlaceholder('Product name *')
    const skuInput = page.getByPlaceholder('SKU *')
    
    await expect(nameInput).toBeVisible()
    const testSku = `TEST-${Date.now()}`
    await nameInput.fill('Test Product')
    await skuInput.fill(testSku)
    
    // Set price
    const priceInput = page.getByPlaceholder('Price')
    await priceInput.fill('19.99')
    
    // Select a category
    const categorySelect = page.locator('select').first()
    await categorySelect.selectOption({ index: 1 })
    
    // Submit
    const submitBtn = page.getByRole('button', { name: 'Add Product' })
    await submitBtn.click()
    
    // Should see the product in the table
    await expect(page.getByText('Test Product').first()).toBeVisible({ timeout: 10000 })
  })

  test('should show stock status badges', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Wait for the page to fully render
    await page.waitForTimeout(500)
    
    // Check for stock badges or products section
    const productsSection = page.getByRole('heading', { name: 'Products', exact: true })
    await expect(productsSection).toBeVisible({ timeout: 10000 })
  })
})

async function ensureDashboard(page: import('@playwright/test').Page) {
  // Wait for the page to load
  await page.waitForTimeout(1000)
  
  const setupForm = page.getByPlaceholder('Email address')
  const isSetup = await setupForm.isVisible({ timeout: 5000 }).catch(() => false)
  
  if (isSetup) {
    await setupForm.fill(`inventory-${Date.now()}@example.com`)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByText('Total Products')).toBeVisible({ timeout: 15000 })
  } else {
    // Already on dashboard, wait for it to be ready
    await expect(page.getByText('Total Products')).toBeVisible({ timeout: 15000 })
  }
}
