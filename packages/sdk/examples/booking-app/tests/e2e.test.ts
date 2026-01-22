/**
 * Booking App E2E Tests
 * 
 * Tests the Shogo SDK patterns:
 * - Service management
 * - Time slot availability
 * - Booking workflow with status enums
 */

import { test, expect } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000'

test.describe('Booking App - Shogo SDK Example', () => {

  test('should display the app', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Should show either setup or dashboard
    const setupTitle = page.getByRole('heading', { name: 'Booking App' })
    const dashboardTitle = page.getByRole('heading', { name: 'Dashboard' })
    
    const hasSetup = await setupTitle.isVisible().catch(() => false)
    const hasDashboard = await dashboardTitle.isVisible().catch(() => false)
    
    expect(hasSetup || hasDashboard).toBe(true)
  })

  test('should create user if on setup', async ({ page }) => {
    await page.goto(BASE_URL)
    
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`booking-${Date.now()}@example.com`)
      await page.getByPlaceholder('Your name / Business name').fill('Test Business')
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 })
    }
  })

  test('should navigate to services page', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`services-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Click Services button
    await page.getByRole('button', { name: 'Services' }).click()
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible({ timeout: 10000 })
  })

  test('should create a service', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`create-service-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Navigate to services
    await page.getByRole('button', { name: 'Services' }).click()
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible({ timeout: 10000 })
    
    // Create new service
    await page.getByRole('button', { name: '+ New Service' }).click()
    
    // Fill form
    await page.getByLabel('Service Name *').fill('Consultation')
    await page.getByLabel('Duration (minutes) *').fill('60')
    await page.getByLabel('Price').fill('99')
    
    // Submit
    const createBtn = page.getByRole('button', { name: 'Create Service' })
    await expect(createBtn).toBeEnabled({ timeout: 2000 })
    await createBtn.click()
    
    // Service should appear
    await expect(page.getByText('Consultation')).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to availability page', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`avail-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Click Availability button
    await page.getByRole('button', { name: 'Availability' }).click()
    await expect(page.getByRole('heading', { name: 'Availability' })).toBeVisible({ timeout: 10000 })
  })

  test('should navigate to bookings page', async ({ page }) => {
    await page.goto(BASE_URL)
    
    // Setup user if needed
    const setupForm = page.getByPlaceholder('Your email address')
    if (await setupForm.isVisible().catch(() => false)) {
      await setupForm.fill(`bookings-${Date.now()}@example.com`)
      await page.getByRole('button', { name: 'Get Started' }).click()
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({ timeout: 10000 })
    }
    
    // Click All Bookings button
    await page.getByRole('button', { name: 'All Bookings' }).click()
    await expect(page.getByRole('heading', { name: 'All Bookings' })).toBeVisible({ timeout: 10000 })
  })
})
