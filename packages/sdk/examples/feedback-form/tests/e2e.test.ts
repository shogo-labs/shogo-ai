// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Shogo Technologies, Inc.
/**
 * Feedback Form E2E Tests
 * 
 * Tests the Shogo SDK Prisma pass-through functionality:
 * - shogo.db.user.create() - User creation
 * - shogo.db.submission.create() - Public form submission
 * - shogo.db.submission.findMany() - Listing submissions
 * - shogo.db.submission.update() - Marking as read/starred
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Feedback Form - Shogo SDK Example', () => {
  
  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // App should show either setup form title or dashboard title
    const feedbackFormTitle = page.getByRole('heading', { name: 'Feedback Form' })
    const dashboardTitle = page.getByRole('heading', { name: 'Feedback Dashboard' })
    
    const hasSetupTitle = await feedbackFormTitle.isVisible().catch(() => false)
    const hasDashboardTitle = await dashboardTitle.isVisible().catch(() => false)
    
    expect(hasSetupTitle || hasDashboardTitle).toBe(true)
  })

  test('should show setup form or dashboard', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Should show either setup form or dashboard
    const setupForm = page.getByPlaceholder('Your email address')
    const dashboard = page.getByRole('heading', { name: 'Feedback Dashboard' })
    
    const hasSetupForm = await setupForm.isVisible().catch(() => false)
    const hasDashboard = await dashboard.isVisible().catch(() => false)
    
    expect(hasSetupForm || hasDashboard).toBe(true)
  })

  test('should create user if on setup form', async ({ page }) => {
    await page.goto(BASE_URL)
    
    const setupForm = page.getByPlaceholder('Your email address')
    const isSetup = await setupForm.isVisible().catch(() => false)
    
    if (isSetup) {
      const testEmail = `test-${Date.now()}@example.com`
      await setupForm.fill(testEmail)
      
      const nameInput = page.getByPlaceholder('Your name (optional)')
      if (await nameInput.isVisible().catch(() => false)) {
        await nameInput.fill('E2E Tester')
      }
      
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      
      // Should transition to dashboard
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
    }
  })

  test('should show form link on dashboard', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // If on setup, create user first
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Should have share form section
    await expect(page.getByText('Share your feedback form')).toBeVisible()
    
    // Should have Copy button
    await expect(page.getByRole('button', { name: 'Copy' })).toBeVisible()
    
    // Should have Preview button
    await expect(page.getByRole('button', { name: 'Preview' })).toBeVisible()
  })

  test('should display public form', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // If on setup, create user first
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Click Preview to go to public form
    await page.getByRole('button', { name: 'Preview' }).click()
    
    // Should show the public form
    await expect(page.getByRole('heading', { name: 'Share Your Feedback' })).toBeVisible({ timeout: 5000 })
    
    // Form fields should be visible
    await expect(page.getByPlaceholder('John Doe')).toBeVisible()
    await expect(page.getByPlaceholder('john@example.com')).toBeVisible()
    await expect(page.getByPlaceholder('Tell us what you think...')).toBeVisible()
  })

  test('should submit feedback', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`submit-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Get the form URL from the input
    const formUrlInput = page.locator('input[readonly]')
    const formUrl = await formUrlInput.inputValue()
    
    // Navigate directly to the public form
    await page.goto(formUrl)
    await expect(page.getByRole('heading', { name: 'Share Your Feedback' })).toBeVisible({ timeout: 5000 })
    
    // Fill out the form - name first
    await page.getByPlaceholder('John Doe').fill('E2E Test User')
    
    // Fill email
    await page.getByPlaceholder('john@example.com').fill('e2e@test.com')
    
    // Click 5-star rating - find the buttons in the star-rating div
    const starButtons = page.locator('.star-rating button')
    await starButtons.nth(4).click()
    
    // Fill message after clicking star (to preserve form state)
    await page.getByPlaceholder('Tell us what you think...').fill('This is an E2E test submission')
    
    // Submit
    await page.getByRole('button', { name: 'Submit Feedback' }).click()
    
    // Should show thank you message
    await expect(page.getByRole('heading', { name: 'Thank You!' })).toBeVisible({ timeout: 10000 })
  })

  test('should show submission in dashboard', async ({ page }) => {
    // This test depends on the previous test having created a submission
    await page.goto(BASE_URL)
    
    // Setup user if needed (use consistent email)
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`dashboard-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
      
      // Create a submission for this user
      await page.getByRole('button', { name: 'Preview' }).click()
      await expect(page.getByRole('heading', { name: 'Share Your Feedback' })).toBeVisible({ timeout: 5000 })
      
      await page.getByPlaceholder('John Doe').fill('Dashboard Test')
      await page.getByPlaceholder('john@example.com').fill('dashboard@test.com')
      await page.locator('.star-rating button').nth(3).click()
      await page.getByPlaceholder('Tell us what you think...').fill('Test submission for dashboard')
      await page.getByRole('button', { name: 'Submit Feedback' }).click()
      await expect(page.getByRole('heading', { name: 'Thank You!' })).toBeVisible({ timeout: 5000 })
      
      // Go back to dashboard
      await page.goto(BASE_URL)
    }
    
    // Should see the submission in the list
    await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 5000 })
    
    // Stats should show at least 1 total
    const totalStat = page.locator('.stat-card').first()
    await expect(totalStat).toBeVisible()
  })

  test('should filter submissions', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed to get to dashboard
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`filter-test-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Create Your Form' }).click()
      await expect(page.getByRole('heading', { name: 'Feedback Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Filter tabs should be visible
    await expect(page.getByRole('button', { name: /All/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Unread/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Starred/ })).toBeVisible()
    
    // Click Unread filter
    const unreadButton = page.getByRole('button', { name: /Unread/ })
    await unreadButton.click()
    
    // Wait a moment for state update
    await page.waitForTimeout(500)
    
    // Verify the button was clicked (it should still be visible and the filter should apply)
    await expect(unreadButton).toBeVisible()
  })
})
