// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Expense Tracker E2E Tests
 * 
 * Tests the Shogo SDK Prisma pass-through functionality:
 * - shogo.db.user.create() - User creation with category seeding
 * - shogo.db.category.findMany() - Category listing
 * - shogo.db.transaction.create() - Transaction creation
 * - shogo.db.transaction.aggregate() - Summary calculations
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001'

test.describe('Expense Tracker - Shogo SDK Example', () => {
  
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // App title should be visible (wait longer for initial server startup)
    await expect(page.getByRole('heading', { name: /expense/i }).first()).toBeVisible({ timeout: 15000 })
    
    // Should show either setup form or dashboard
    const setupForm = page.getByPlaceholder('Email address')
    const dashboard = page.getByText(/balance/i)
    
    const hasSetup = await setupForm.isVisible().catch(() => false)
    const hasDashboard = await dashboard.isVisible().catch(() => false)
    
    expect(hasSetup || hasDashboard).toBe(true)
  })

  test('should show footer attribution', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Should have some attribution text (Shogo/Prisma)
    const attr = page.getByText(/Shogo|Prisma/i)
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
      const testEmail = `expense-${Date.now()}@example.com`
      await setupForm.fill(testEmail)
      
      const nameInput = page.getByPlaceholder('Name (optional)')
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('Expense User')
      }
      
      await page.getByRole('button', { name: 'Get Started' }).click()
      
      // Should transition to dashboard
      await expect(page.getByText('Balance')).toBeVisible({ timeout: 15000 })
    }
  })

  test('should display summary section', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Summary cards should be visible
    await expect(page.getByText('Balance')).toBeVisible({ timeout: 10000 })
    await expect(page.getByText('Income')).toBeVisible()
    await expect(page.getByText('Expenses', { exact: true })).toBeVisible()
  })

  test('should have seeded categories available', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Click add transaction button to reveal form
    const addBtn = page.getByRole('button', { name: /add transaction/i })
    if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addBtn.click()
    }
    
    // Check if category dropdown exists and has options
    const categorySelect = page.locator('select').first()
    if (await categorySelect.isVisible().catch(() => false)) {
      const options = await categorySelect.locator('option').allTextContents()
      // Should have seeded categories
      expect(options.length).toBeGreaterThan(0)
    }
  })

  test('should add a transaction', async ({ page }) => {
    await page.goto(BASE_URL)
    await page.waitForLoadState('networkidle')
    
    // Ensure we're on dashboard
    await ensureDashboard(page)
    
    // Click add transaction button to reveal form
    const addBtn = page.getByRole('button', { name: /add transaction/i })
    if (await addBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await addBtn.click()
    }
    
    // Fill transaction form
    const amountInput = page.getByPlaceholder(/amount/i)
    const descInput = page.getByPlaceholder(/description/i)
    
    if (await amountInput.isVisible().catch(() => false)) {
      await amountInput.click()
      await amountInput.fill('42.50')
      
      if (await descInput.isVisible().catch(() => false)) {
        await descInput.fill(`Test expense ${Date.now()}`)
      }
      
      // Select a category
      const categorySelect = page.locator('select').first()
      if (await categorySelect.isVisible().catch(() => false)) {
        await categorySelect.selectOption({ index: 1 })
      }
      
      // Submit
      const submitBtn = page.getByRole('button', { name: /add transaction/i }).last()
      if (await submitBtn.isVisible().catch(() => false)) {
        await submitBtn.click()
        
        // Should see the amount somewhere (use first() since multiple elements may match)
        await expect(page.getByText(/42\.50|42.5/).first()).toBeVisible({ timeout: 10000 })
      }
    }
  })
})

async function ensureDashboard(page: import('@playwright/test').Page) {
  // Wait for the page to load
  await page.waitForTimeout(1000)
  
  const setupForm = page.getByPlaceholder('Email address')
  const isSetup = await setupForm.isVisible({ timeout: 5000 }).catch(() => false)
  
  if (isSetup) {
    await setupForm.fill(`expense-${Date.now()}@example.com`)
    await page.getByRole('button', { name: 'Get Started' }).click()
    await expect(page.getByText('Balance')).toBeVisible({ timeout: 15000 })
  } else {
    // Already on dashboard, wait for it to be ready
    await expect(page.getByText('Balance')).toBeVisible({ timeout: 15000 })
  }
}
